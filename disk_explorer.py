#!/usr/bin/env python3
"""Disk Explorer - browse directory sizes as a live treemap or tree in the browser.

You give it a path; it measures every immediate child of that path and streams
the sizes to the page as they are computed, so the view fills in live instead of
after a long silence. Click a tile (or expand a row in tree view) to descend.

Measurement notes - both matter for the numbers being trustworthy:

* Symlinks are never followed (``du -P``). A symlink therefore contributes only
  its own size, so content reachable through a link is not counted twice. The
  page marks links explicitly because "0 bytes" would otherwise look like an
  empty folder.
* Hard links are counted once. That requires the whole level to be measured by
  a *single* ``du`` process: running one ``du`` per child makes each process
  blind to what the others already counted, and any file linked between two
  siblings is then charged twice. The default ``dedup`` mode does the single
  streaming pass; ``parallel`` restores the older fan-out if you want speed
  over accuracy.

Only the Python standard library is used, so this runs in any Python 3.9+
environment without installing anything.

    python3 disk_explorer.py --port 8765
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")

DEFAULT_BULK_THRESHOLD = 400


# --------------------------------------------------------------------- cache
class LevelCache:
    """Caches a whole directory level, invalidated when the folder's mtime moves.

    Caching the level as one unit matters: with hard links a child's size
    depends on which siblings were already counted, so per-child entries would
    be inconsistent.
    """

    def __init__(self, ttl_seconds):
        self._records = {}
        self._lock = threading.Lock()
        self._ttl = ttl_seconds

    def get(self, path, mtime_ns):
        with self._lock:
            record = self._records.get(path)
        if not record:
            return None
        stored_mtime, stored_time, sizes, total = record
        if stored_mtime != mtime_ns:
            return None
        if self._ttl > 0 and time.time() - stored_time > self._ttl:
            return None
        return sizes, total

    def put(self, path, mtime_ns, sizes, total):
        with self._lock:
            self._records[path] = (mtime_ns, time.time(), sizes, total)

    def entries(self):
        with self._lock:
            return len(self._records)


# --------------------------------------------------------------- child lists
def list_children(path, allowed_roots):
    """Return the immediate children of `path`, with symlink metadata attached."""
    children = []
    with os.scandir(path) as iterator:
        for entry in iterator:
            try:
                stat_result = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            is_link = entry.is_symlink()
            link_target = ""
            link_exists = False
            link_reachable = False
            if is_link:
                try:
                    link_target = os.readlink(entry.path)
                except OSError:
                    link_target = ""
                try:
                    link_exists = os.path.exists(os.path.realpath(entry.path))
                    link_reachable = _inside_roots(
                        os.path.realpath(entry.path), allowed_roots
                    )
                except OSError:
                    link_exists = False
            children.append({
                "name": entry.name,
                "path": entry.path,
                # is_dir follows symlinks so the page knows a link to a folder
                # can be expanded; is_link tells it the size is only the link.
                "is_dir": entry.is_dir(),
                "is_link": is_link,
                "link_target": link_target,
                "link_exists": link_exists,
                "link_reachable": link_reachable,
                "mtime_ns": stat_result.st_mtime_ns,
            })
    children.sort(key=lambda child: child["name"].lower())
    return children


def _inside_roots(real_path, allowed_roots):
    return any(
        real_path == root or real_path.startswith(root + os.sep)
        for root in allowed_roots
    )


# ------------------------------------------------------------------ measuring
def _du_command(extra_arguments, path):
    """Build a du command, line-buffered through stdbuf when available."""
    command = ["du", "-B1", "-P"] + extra_arguments + ["--null", "--", path]
    if shutil.which("stdbuf"):
        command = ["stdbuf", "-oL"] + command
    return command


def _parse_record(record):
    """Split one `du --null` record (b"<size>\\t<path>") into (path, size)."""
    if not record:
        return None
    size_field, separator, path_bytes = record.partition(b"\t")
    if not separator:
        return None
    try:
        return path_bytes.decode("utf-8", "surrogateescape"), int(size_field)
    except ValueError:
        return None


def stream_level(path):
    """Yield (child_path, size) as du finishes each entry, then ("", total).

    The final record is du's own total for `path`, which is the authoritative
    figure: it includes the directory entry itself and has already collapsed
    every hard link inside the level.
    """
    try:
        process = subprocess.Popen(
            _du_command(["--max-depth=1"], path),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise OSError(f"无法启动 du：{error}")

    buffer = b""
    saw_output = False
    try:
        while True:
            chunk = process.stdout.read1(65536)
            if not chunk:
                break
            buffer += chunk
            while b"\0" in buffer:
                record, buffer = buffer.split(b"\0", 1)
                parsed = _parse_record(record)
                if parsed:
                    saw_output = True
                    yield parsed
        parsed = _parse_record(buffer)
        if parsed:
            saw_output = True
            yield parsed
    finally:
        process.stdout.close()
        process.wait()

    if not saw_output and process.returncode != 0:
        raise OSError(f"du 无法读取该目录（退出码 {process.returncode}）")


def measure_one(path):
    """On-disk size of a single path, never following it if it is a link."""
    try:
        completed = subprocess.run(
            _du_command(["-s"], path),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    for record in completed.stdout.split(b"\0"):
        parsed = _parse_record(record)
        if parsed:
            return parsed[1]
    return None


def stream_children_parallel(children, worker_count):
    """Measure children with a fan-out of du processes (fast, double-counts links)."""
    executor = ThreadPoolExecutor(max_workers=worker_count)
    try:
        futures = {
            executor.submit(measure_one, child["path"]): child["path"]
            for child in children
        }
        for future in as_completed(futures):
            child_path = futures[future]
            try:
                size = future.result()
            except Exception:
                size = None
            yield child_path, (size if size is not None else 0)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def scan_directory(path, allowed_roots, cache, use_cache, mode, worker_count,
                   bulk_threshold):
    """Yield progress events for one directory level.

    Events are dicts consumed as newline-delimited JSON by the browser:
    ``start`` (the child list), ``size`` (one measurement), ``done`` (totals).
    """
    started_at = time.time()
    try:
        directory_stat = os.stat(path)
        children = list_children(path, allowed_roots)
    except OSError as error:
        yield {"type": "error", "message": f"无法读取 {path}：{error.strerror or error}"}
        return

    yield {
        "type": "start",
        "path": path,
        "parent": os.path.dirname(path),
        "children": [
            {
                "name": child["name"],
                "path": child["path"],
                "isDir": child["is_dir"],
                "isLink": child["is_link"],
                "linkTarget": child["link_target"],
                "linkExists": child["link_exists"],
                "linkReachable": child["link_reachable"],
            }
            for child in children
        ],
    }

    mtime_ns = directory_stat.st_mtime_ns
    sizes = {}
    total = None

    cached = cache.get(path, mtime_ns) if use_cache else None
    if cached is not None:
        sizes, total = cached
        for child in children:
            yield {
                "type": "size",
                "path": child["path"],
                "size": sizes.get(child["path"], 0),
                "cached": True,
                "done": len(sizes),
                "total": len(children),
            }
    else:
        # A symlink has no size of its own for du, so it never shows up in the
        # level listing; treat "missing" as zero rather than as unmeasured.
        use_parallel = mode == "parallel" and len(children) <= bulk_threshold
        try:
            if use_parallel:
                stream = stream_children_parallel(children, worker_count)
            else:
                stream = stream_level(path)
            for child_path, size in stream:
                if child_path == "":
                    total = size
                    continue
                if child_path == path:
                    total = size
                    continue
                sizes[child_path] = size
                yield {
                    "type": "size",
                    "path": child_path,
                    "size": size,
                    "done": len(sizes),
                    "total": len(children),
                }
        except OSError as error:
            yield {"type": "error", "message": str(error)}
            return

        # du omits entries that hold no blocks of their own - symlinks, and
        # empty folders on some filesystems. Report them as zero so the page
        # can finish rendering instead of leaving them "measuring" forever.
        for child in children:
            if child["path"] in sizes:
                continue
            sizes[child["path"]] = 0
            yield {
                "type": "size",
                "path": child["path"],
                "size": 0,
                "zero": True,
                "done": len(sizes),
                "total": len(children),
            }

        if total is None:
            total = sum(sizes.values())
        cache.put(path, mtime_ns, sizes, total)

    yield {
        "type": "done",
        "path": path,
        "total": total if total is not None else sum(sizes.values()),
        "count": len(children),
        "measured": len(sizes),
        "elapsed": round(time.time() - started_at, 3),
        "mode": mode,
    }


# -------------------------------------------------------------- http plumbing
def resolve_target_path(raw_path, allowed_roots):
    """Expand, absolutise and bounds-check a path typed by the user."""
    candidate = (raw_path or "~").strip()
    absolute = os.path.abspath(os.path.expanduser(candidate))
    was_link = os.path.islink(absolute)
    if os.path.isfile(absolute):
        absolute = os.path.dirname(absolute)
    real = os.path.realpath(absolute)
    if not _inside_roots(real, allowed_roots):
        if was_link:
            raise ValueError(
                f"这是一个符号链接，指向允许范围之外：{real}\n"
                f"链接本身不占用空间，所以它的大小显示为 0。"
            )
        raise ValueError(
            f"路径在允许浏览的范围之外：{real}\n"
            f"当前范围：{', '.join(allowed_roots)}（可用 --allow-root 扩大）"
        )
    if not os.path.isdir(real):
        raise ValueError(f"不是一个目录：{real}")
    return real


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "DiskExplorer/1.0"

    # Injected by main().
    allowed_roots = ()
    worker_count = 8
    cache = None
    bulk_threshold = DEFAULT_BULK_THRESHOLD
    measure_mode = "dedup"

    def log_message(self, format_string, *args):
        if self.server.verbose:
            sys.stderr.write(
                "%s - %s\n" % (self.address_string(), format_string % args)
            )

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/scan":
            self.handle_scan(query)
        elif parsed.path == "/api/config":
            self.handle_config()
        elif parsed.path in ("/", "/index.html"):
            self.serve_static("index.html")
        elif parsed.path.startswith("/static/"):
            self.serve_static(parsed.path[len("/static/"):])
        else:
            self.send_error(404, "not found")

    def handle_config(self):
        """Tell the page where home is, its bounds, and how sizes are measured."""
        self.send_json({
            "home": os.path.expanduser("~"),
            "allowedRoots": list(self.allowed_roots),
            "measureMode": self.measure_mode,
            "followsSymlinks": False,
        })

    def handle_scan(self, query):
        raw_path = (query.get("path") or ["~"])[0]
        force_refresh = (query.get("refresh") or ["0"])[0] == "1"
        try:
            target = resolve_target_path(raw_path, self.allowed_roots)
        except ValueError as error:
            self.send_json_error(str(error))
            return

        events = scan_directory(
            target,
            allowed_roots=self.allowed_roots,
            cache=self.cache,
            use_cache=not force_refresh,
            mode=self.measure_mode,
            worker_count=self.worker_count,
            bulk_threshold=self.bulk_threshold,
        )
        self.stream_ndjson(events)

    def stream_ndjson(self, events):
        """Stream events as chunked newline-delimited JSON."""
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            for event in events:
                payload = (json.dumps(event) + "\n").encode("utf-8")
                self.wfile.write(b"%x\r\n" % len(payload))
                self.wfile.write(payload)
                self.wfile.write(b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            # The browser navigated away or closed the tab; stop scanning.
            if hasattr(events, "close"):
                events.close()

    def send_json(self, payload, status=200):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def send_json_error(self, message):
        self.send_json({"type": "error", "message": message}, status=400)

    def serve_static(self, relative_name):
        safe_name = os.path.normpath("/" + relative_name).lstrip("/")
        full_path = os.path.join(STATIC_DIR, safe_name)
        if not os.path.isfile(full_path) or not os.path.abspath(
            full_path
        ).startswith(STATIC_DIR):
            self.send_error(404, "not found")
            return
        with open(full_path, "rb") as handle:
            payload = handle.read()
        content_type = mimetypes.guess_type(full_path)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type.endswith("javascript"):
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(payload)


def main():
    parser = argparse.ArgumentParser(
        description="Serve an interactive treemap / tree of directory sizes."
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind address")
    parser.add_argument("--port", type=int, default=8765, help="bind port")
    parser.add_argument(
        "--allow-root",
        action="append",
        default=None,
        metavar="DIR",
        help="directory the browser may browse (repeatable, default: $HOME)",
    )
    parser.add_argument(
        "--measure",
        choices=("dedup", "parallel"),
        default="dedup",
        help=(
            "dedup (default): one streaming du pass per level, hard links "
            "counted once; parallel: one du per child, faster but hard links "
            "shared between siblings are counted more than once"
        ),
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=min(16, (os.cpu_count() or 4)),
        help="du processes per level in parallel mode",
    )
    parser.add_argument(
        "--bulk-threshold",
        type=int,
        default=DEFAULT_BULK_THRESHOLD,
        help="in parallel mode, fall back to one pass above this many children",
    )
    parser.add_argument(
        "--cache-ttl",
        type=float,
        default=300.0,
        help="seconds a cached level stays valid (0 = never expire)",
    )
    parser.add_argument("--verbose", action="store_true", help="log requests")
    args = parser.parse_args()

    roots = args.allow_root or [os.path.expanduser("~")]
    allowed_roots = tuple(
        os.path.realpath(os.path.abspath(os.path.expanduser(root))) for root in roots
    )
    for root in allowed_roots:
        if not os.path.isdir(root):
            parser.error(f"--allow-root is not a directory: {root}")

    RequestHandler.allowed_roots = allowed_roots
    RequestHandler.worker_count = max(1, args.workers)
    RequestHandler.cache = LevelCache(args.cache_ttl)
    RequestHandler.bulk_threshold = max(1, args.bulk_threshold)
    RequestHandler.measure_mode = args.measure

    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    server.daemon_threads = True
    # A browser opens several connections at once (page, css, js, scan streams).
    server.request_queue_size = 64
    server.verbose = args.verbose

    shown_host = "localhost" if args.host in ("127.0.0.1", "0.0.0.0", "::") else args.host
    print(f"Disk Explorer serving on http://{shown_host}:{args.port}/", flush=True)
    print(f"  browsable roots : {', '.join(allowed_roots)}", flush=True)
    print(f"  measure mode    : {args.measure}", flush=True)
    print("  symlinks        : never followed (du -P), links are not double counted",
          flush=True)
    print("  press Ctrl+C to stop", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
