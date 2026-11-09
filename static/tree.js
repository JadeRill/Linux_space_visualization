'use strict';

/**
 * Directory tree view - the "ncdu / tree -du" style companion to the treemap.
 *
 * Rows expand lazily: opening a folder starts its own streaming scan, so its
 * children appear immediately and fill in with sizes as du reports them. Several
 * folders can be scanning at once. Sizes come straight from the server, which
 * measures each level with a single deduplicated `du` pass.
 *
 * Created by app.js:  createTreeView({ streamScan, formatBytes, onNavigate })
 */
function createTreeView(config) {
  const MAX_CHILD_ROWS = 500;   // beyond this, siblings collapse into one row
  const MAX_TOTAL_ROWS = 2500;  // hard ceiling on rendered rows
  const INDENT_PX = 15;
  const RENDER_INTERVAL_MS = 150;

  const body = document.getElementById('tree-body');
  const statusBar = document.getElementById('tree-status');
  const sortButton = document.getElementById('tree-sort');

  const nodesByPath = new Map();
  const controllersByPath = new Map();
  let rootPath = '';
  let sortMode = 'size';
  let renderTimer = null;
  let rowPool = [];

  /* ------------------------------------------------------------- node model */
  function makeNode(data, depth, parentPath) {
    return {
      path: data.path,
      name: data.name,
      isDir: Boolean(data.isDir),
      isLink: Boolean(data.isLink),
      linkTarget: data.linkTarget || '',
      linkExists: data.linkExists !== false,
      linkReachable: data.linkReachable !== false,
      depth,
      parentPath,
      size: 0,
      known: false,
      children: [],
      childByPath: new Map(),
      loaded: false,
      loading: false,
      measured: 0,
      error: '',
      expanded: false,
      synthetic: false,
      resolvedPath: data.path,
    };
  }

  /**
   * The root level is measured by app.js for the treemap already, so its item
   * objects are adopted as-is instead of re-scanned. They are shared by
   * reference, so sizes arriving on the treemap's stream show up here too.
   */
  function decorateItem(item, depth, parentPath) {
    if (!item.children) {
      item.children = [];
      item.childByPath = new Map();
      item.loaded = false;
      item.loading = false;
      item.measured = 0;
      item.error = '';
      item.expanded = false;
      item.synthetic = false;
      item.resolvedPath = item.path;
    }
    item.depth = depth;
    item.parentPath = parentPath;
    nodesByPath.set(item.path, item);
    return item;
  }

  function isExpandable(node) {
    if (!node.isDir) return false;
    // A link to a folder outside the allowed roots cannot be opened, and a
    // dangling link cannot be opened either.
    if (node.isLink && (!node.linkExists || !node.linkReachable)) return false;
    return true;
  }

  /* ------------------------------------------------------------ scan engine */
  async function scanNode(node, refresh) {
    if (node.loading) return;
    node.loading = true;
    node.error = '';
    const controller = new AbortController();
    controllersByPath.set(node.path, controller);
    scheduleRender();

    try {
      await config.streamScan(
        node.path,
        refresh,
        (event) => handleNodeEvent(node, event),
        controller.signal
      );
    } catch (error) {
      if (error.name !== 'AbortError') node.error = error.message || String(error);
    } finally {
      node.loading = false;
      controllersByPath.delete(node.path);
      scheduleRender();
    }
  }

  function handleNodeEvent(node, event) {
    if (event.type === 'start') {
      node.resolvedPath = event.path;
      node.children = event.children.map((child) => {
        const childNode = makeNode(child, node.depth + 1, node.path);
        nodesByPath.set(childNode.path, childNode);
        return childNode;
      });
      node.childByPath = new Map(node.children.map((child) => [child.path, child]));
      node.measured = 0;
      scheduleRender();
      return;
    }

    if (event.type === 'size') {
      const child = node.childByPath.get(event.path);
      if (child) {
        child.size = event.size;
        child.known = true;
      }
      node.measured = event.done != null ? event.done : node.measured + 1;
      scheduleRender();
      return;
    }

    if (event.type === 'error') {
      node.error = event.message;
      node.loading = false;
      scheduleRender();
      return;
    }

    if (event.type === 'done') {
      node.loaded = true;
      node.measured = event.count;
      if (node === nodesByPath.get(rootPath)) {
        node.size = event.total;
        node.known = true;
      }
      scheduleRender();
    }
  }

  function toggleNode(node) {
    if (!isExpandable(node)) return;
    node.expanded = !node.expanded;
    if (node.expanded && !node.loaded && !node.loading) scanNode(node, false);
    scheduleRender();
  }

  /* ------------------------------------------------------------- flattening */
  function sortedChildren(node) {
    const children = node.children.slice();
    if (sortMode === 'name') {
      children.sort((left, right) => left.name.localeCompare(right.name));
    } else {
      children.sort(
        (left, right) =>
          (right.known ? right.size : 0) - (left.known ? left.size : 0) ||
          left.name.localeCompare(right.name)
      );
    }
    return children;
  }

  function aggregateRow(node, rest) {
    const size = rest.reduce((sum, child) => sum + (child.known ? child.size : 0), 0);
    return {
      path: `${node.path}#rest`,
      name: `（其余 ${rest.length} 项）`,
      depth: node.depth + 1,
      isDir: false,
      isLink: false,
      size,
      known: true,
      synthetic: true,
      parentPath: node.path,
    };
  }

  function flattenRows() {
    const rows = [];
    const root = nodesByPath.get(rootPath);
    if (!root) return rows;

    const visit = (node) => {
      if (rows.length >= MAX_TOTAL_ROWS) return;
      rows.push(node);
      if (!node.expanded) return;
      const children = sortedChildren(node);
      const visible = children.slice(0, MAX_CHILD_ROWS);
      for (const child of visible) visit(child);
      if (children.length > MAX_CHILD_ROWS) {
        rows.push(aggregateRow(node, children.slice(MAX_CHILD_ROWS)));
      }
    };
    visit(root);
    return rows;
  }

  /* ---------------------------------------------------------------- drawing */
  function rowClasses(node) {
    const classes = ['tree-row'];
    classes.push(node.isDir ? 'is-dir' : 'is-file');
    if (node.isLink) classes.push('is-link');
    if (node.synthetic) classes.push('is-synthetic');
    if (node.path === rootPath) classes.push('current');
    return classes.join(' ');
  }

  function buildRow(node) {
    const row = document.createElement('div');

    const name = document.createElement('span');
    name.className = 'tree-name';
    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    const label = document.createElement('span');
    label.className = 'tree-label';
    name.appendChild(caret);
    name.appendChild(label);

    const bar = document.createElement('span');
    bar.className = 'tree-bar';
    const fill = document.createElement('span');
    bar.appendChild(fill);

    const size = document.createElement('span');
    size.className = 'tree-size';
    const share = document.createElement('span');
    share.className = 'tree-share';

    row.appendChild(name);
    row.appendChild(bar);
    row.appendChild(size);
    row.appendChild(share);
    return row;
  }

  function updateRow(row, node, parentSize) {
    row.className = rowClasses(node);
    row.dataset.path = node.path;

    const name = row.children[0];
    const caret = name.children[0];
    const label = name.children[1];

    name.style.paddingLeft = `${12 + node.depth * INDENT_PX}px`;

    const expandable = isExpandable(node);
    caret.textContent = node.synthetic
      ? ''
      : expandable
        ? (node.expanded ? '▾' : '▸')
        : (node.isDir ? '' : '·');
    caret.className = 'tree-caret' + (expandable ? ' expandable' : '');
    label.textContent = node.name;

    // Drop any previously appended link annotations, then rebuild them.
    while (name.children.length > 2) name.removeChild(name.lastChild);
    if (node.isLink) {
      const badge = document.createElement('span');
      badge.className = 'tree-badge';
      if (!node.linkExists) {
        badge.classList.add('broken');
        badge.textContent = '链接失效';
      } else if (!node.linkReachable) {
        badge.classList.add('outside');
        badge.textContent = '链接→范围外';
      } else {
        badge.textContent = '符号链接';
      }
      name.appendChild(badge);

      const target = document.createElement('span');
      target.className = 'tree-target';
      target.textContent = `→ ${node.linkTarget}`;
      name.appendChild(target);
    }
    if (node.loading) {
      const spinner = document.createElement('span');
      spinner.className = 'tree-badge';
      spinner.textContent = node.measured ? `测量 ${node.measured}` : '测量中';
      name.appendChild(spinner);
    } else if (node.error) {
      const spinner = document.createElement('span');
      spinner.className = 'tree-badge broken';
      spinner.textContent = '无法读取';
      name.appendChild(spinner);
    }
    row.title = node.error
      ? node.error
      : node.path + (node.isLink ? `  →  ${node.linkTarget}` : '');

    const fill = row.children[1].firstChild;
    const shareValue = parentSize > 0 && node.known ? node.size / parentSize : 0;
    fill.style.width = `${(Math.max(node.known ? shareValue : 0, 0) * 100).toFixed(2)}%`;

    const sizeCell = row.children[2];
    sizeCell.textContent = node.known ? config.formatBytes(node.size) : '…';
    if (node.isLink && node.known) {
      sizeCell.className = 'tree-size tree-pending';
      sizeCell.title = '符号链接本身不占用空间';
    } else {
      sizeCell.className = 'tree-size';
      sizeCell.title = '';
    }

    row.children[3].textContent = node.known
      ? `${(shareValue * 100).toFixed(shareValue >= 0.1 ? 1 : 2)}%`
      : '';
  }

  function render() {
    const root = nodesByPath.get(rootPath);
    const rows = flattenRows();
    const parentSizeByPath = new Map();

    // Each row's bar is its share of its parent, so look the parent up once.
    for (const node of rows) {
      const parent = nodesByPath.get(node.parentPath);
      parentSizeByPath.set(node.path, parent && parent.known ? parent.size : 0);
    }
    if (root) parentSizeByPath.set(root.path, root.known ? root.size : 0);

    let index = 0;
    let existing = body.firstElementChild;
    while (index < rows.length) {
      const node = rows[index];
      const parentSize = parentSizeByPath.get(node.path) || 0;
      if (!existing) {
        const fresh = buildRow(node);
        updateRow(fresh, node, parentSize);
        body.appendChild(fresh);
      } else if (existing.dataset.path === node.path) {
        updateRow(existing, node, parentSize);
        existing = existing.nextElementSibling;
      } else {
        const fresh = buildRow(node);
        updateRow(fresh, node, parentSize);
        body.replaceChild(fresh, existing);
        existing = fresh.nextElementSibling;
      }
      index += 1;
    }
    while (existing) {
      const next = existing.nextElementSibling;
      body.removeChild(existing);
      rowPool.push(existing);
      existing = next;
    }
    if (rowPool.length > 400) rowPool.length = 400;

    renderStatusBar(rows);
  }

  function renderStatusBar(rows) {
    let scanning = 0;
    for (const controllerPath of controllersByPath.keys()) {
      const node = nodesByPath.get(controllerPath);
      if (node) scanning += 1;
    }
    const root = nodesByPath.get(rootPath);
    const shown = rows.length >= MAX_TOTAL_ROWS ? `已截断到 ${MAX_TOTAL_ROWS} 行` : '';
    statusBar.textContent =
      `${rows.length} 行 · 展开 ${countExpanded()} 个目录` +
      (scanning ? ` · ${scanning} 个正在测量` : '') +
      (root && root.loading && !root.measured ? ' · 首层测量中…' : '') +
      (shown ? ` · ${shown}` : '') +
      ' · 单击展开/折叠，双击设为根目录';
  }

  function countExpanded() {
    let total = 0;
    for (const node of nodesByPath.values()) if (node.expanded) total += 1;
    return total;
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, RENDER_INTERVAL_MS);
  }

  /* ----------------------------------------------------------------- events */
  body.addEventListener('click', (event) => {
    const row = event.target.closest('.tree-row');
    if (!row) return;
    const node = nodesByPath.get(row.dataset.path);
    if (node && !node.synthetic) toggleNode(node);
  });

  body.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.tree-row');
    if (!row) return;
    const node = nodesByPath.get(row.dataset.path);
    if (node && !node.synthetic && isExpandable(node)) config.onNavigate(node.path);
  });

  sortButton.addEventListener('click', () => {
    sortMode = sortMode === 'size' ? 'name' : 'size';
    sortButton.textContent = sortMode === 'size' ? '按大小 ↓' : '按名称 A→Z';
    scheduleRender();
  });

  /* ------------------------------------------------------------------- api */
  return {
    /**
     * Point the tree at a new directory. The root's own children come from the
     * already-measured `items` array (shared by reference), so the level is
     * never scanned twice; only folders the user opens trigger a new scan.
     */
    setRoot(path, items, total) {
      for (const controller of controllersByPath.values()) controller.abort();
      controllersByPath.clear();
      nodesByPath.clear();
      rootPath = path;

      const root = makeNode({ path, name: path.split('/').filter(Boolean).pop() || '/' }, 0, '');
      root.expanded = true;
      root.loaded = true;
      root.size = total || 0;
      root.known = Boolean(total);
      nodesByPath.set(path, root);

      root.children = (items || []).map((item) => decorateItem(item, 1, path));
      root.childByPath = new Map(root.children.map((child) => [child.path, child]));

      body.textContent = '';
      render();
    },

    /** Re-render; the shared root items may have received new sizes. */
    invalidate() {
      if (!rootPath) return;
      scheduleRender();
    },

    /** The root's own total only arrives once its level finishes measuring. */
    setRootSize(total) {
      const root = nodesByPath.get(rootPath);
      if (!root) return;
      root.size = total || 0;
      root.known = true;
      scheduleRender();
    },

    /** Force a fresh measurement of every currently open folder. */
    refresh() {
      for (const node of nodesByPath.values()) {
        if (node.expanded) scanNode(node, true);
      }
    },

    show() {
      render();
    },
  };
}
