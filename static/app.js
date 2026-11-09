'use strict';

/* ------------------------------------------------------------------ config */
const MAX_RECTS = 500;          // more children than this are collapsed visually
const ANIMATION_MS = 260;       // tween duration when tiles move or resize
const REST_ID = '\u0000rest';   // id of the synthetic "everything else" tile
const RANKING_LIMIT = 40;
const AUTO_REFRESH_DELAY_MS = 8000;
const LIVE_UPDATE_MS = 120;     // minimum gap between redraws while streaming

const PALETTE = [
  '#4c78c8', '#c07a3c', '#4f9d63', '#b8555a', '#7f74b8',
  '#8d7d66', '#c08bb4', '#6d7b8d', '#b0a05a', '#5ba3ba',
  '#a2799b', '#6fafaa', '#c96f70', '#9c6b3f', '#5f8d4e',
  '#8a6fb0', '#b58a4a', '#4f8fa8', '#a85f7a', '#6b8f5a',
];

/* ------------------------------------------------------------------- state */
const state = {
  path: '',
  parent: '',
  home: '',
  allowedRoots: [],
  items: [],
  itemByPath: new Map(),
  itemById: new Map(),
  order: [],
  targets: new Map(),
  current: new Map(),
  animationFrom: new Map(),
  animationStart: 0,
  colorById: new Map(),
  hoveredId: null,
  pointerInside: false,
  scanning: false,
  finished: false,
  doneCount: 0,
  totalCount: 0,
  totalBytes: 0,
  elapsedSeconds: 0,
  errorMessage: '',
  viewWidth: 1,
  viewHeight: 1,
  provisional: 1,
  autoRefreshTimer: null,
  abortController: null,
};

/* ----------------------------------------------------------------- elements */
const canvas = document.getElementById('treemap');
const context = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const overlay = document.getElementById('overlay');
const pathInput = document.getElementById('path-input');
const pathForm = document.getElementById('path-form');
const homeButton = document.getElementById('home-button');
const upButton = document.getElementById('up-button');
const refreshButton = document.getElementById('refresh-button');
const autoRefreshToggle = document.getElementById('auto-refresh');
const breadcrumb = document.getElementById('breadcrumb');
const summaryBox = document.getElementById('summary');
const rankingBox = document.getElementById('ranking');
const rankingNote = document.getElementById('ranking-note');
const statusbar = document.getElementById('statusbar');

/* ---------------------------------------------------------------- utilities */
function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatPercent(part, whole) {
  if (!whole) return '0%';
  const percent = (part / whole) * 100;
  if (percent >= 10) return `${percent.toFixed(1)}%`;
  if (percent >= 1) return `${percent.toFixed(2)}%`;
  if (percent > 0) return '<1%';
  return '0%';
}

function displaySize(item) {
  return item.known ? item.size : 0;
}

function truncateText(text, width, fontSize) {
  const maxCharacters = Math.max(3, Math.floor(width / (fontSize * 0.58)));
  if (text.length <= maxCharacters) return text;
  return text.slice(0, maxCharacters - 1) + '…';
}

function readableTextColor(hexColor) {
  const red = parseInt(hexColor.slice(1, 3), 16);
  const green = parseInt(hexColor.slice(3, 5), 16);
  const blue = parseInt(hexColor.slice(5, 7), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? '#10151b' : '#ffffff';
}

function mixWithWhite(hexColor, amount) {
  const red = parseInt(hexColor.slice(1, 3), 16);
  const green = parseInt(hexColor.slice(3, 5), 16);
  const blue = parseInt(hexColor.slice(5, 7), 16);
  const blend = (channel) => Math.round(channel + (255 - channel) * amount);
  return `rgb(${blend(red)}, ${blend(green)}, ${blend(blue)})`;
}

/* ------------------------------------------------------- treemap algorithm */
function squarifyLayout(values, x, y, width, height) {
  const count = values.length;
  const rects = new Array(count);
  const total = values.reduce((sum, value) => sum + value, 0);

  if (!(total > 0) || width <= 0 || height <= 0) {
    for (let index = 0; index < count; index += 1) {
      rects[index] = { x, y, w: Math.max(0, width), h: Math.max(0, height) };
    }
    return rects;
  }

  // Guard against zero-sized entries producing degenerate rows and stalls.
  const epsilon = total * 1e-9;
  const scale = (width * height) / total;
  const scaled = values.map((value) => (value > 0 ? value * scale : epsilon));

  let cursor = { x, y, w: width, h: height };
  let index = 0;
  while (index < scaled.length) {
    let rowLength = 1;
    while (
      index + rowLength < scaled.length &&
      worstRatio(scaled.slice(index, index + rowLength), cursor) >=
        worstRatio(scaled.slice(index, index + rowLength + 1), cursor)
    ) {
      rowLength += 1;
    }
    const row = scaled.slice(index, index + rowLength);
    const laidOut = layRow(row, cursor);
    for (let offset = 0; offset < laidOut.length; offset += 1) {
      rects[index + offset] = laidOut[offset];
    }
    cursor = leftoverRect(row, cursor);
    index += rowLength;
    if (cursor.w <= 0.01 || cursor.h <= 0.01) {
      for (; index < scaled.length; index += 1) {
        rects[index] = { x: cursor.x, y: cursor.y, w: 0, h: 0 };
      }
    }
  }
  return rects;
}

function layRow(row, rect) {
  const covered = row.reduce((sum, value) => sum + value, 0);
  const out = [];
  if (rect.w >= rect.h) {
    const stripWidth = rect.h > 0 ? covered / rect.h : 0;
    let cursorY = rect.y;
    for (const value of row) {
      const stripHeight = stripWidth > 0 ? value / stripWidth : 0;
      out.push({ x: rect.x, y: cursorY, w: stripWidth, h: stripHeight });
      cursorY += stripHeight;
    }
  } else {
    const stripHeight = rect.w > 0 ? covered / rect.w : 0;
    let cursorX = rect.x;
    for (const value of row) {
      const stripWidth = stripHeight > 0 ? value / stripHeight : 0;
      out.push({ x: cursorX, y: rect.y, w: stripWidth, h: stripHeight });
      cursorX += stripWidth;
    }
  }
  return out;
}

function leftoverRect(row, rect) {
  const covered = row.reduce((sum, value) => sum + value, 0);
  if (rect.w >= rect.h) {
    const stripWidth = rect.h > 0 ? covered / rect.h : 0;
    return {
      x: rect.x + stripWidth,
      y: rect.y,
      w: Math.max(0, rect.w - stripWidth),
      h: rect.h,
    };
  }
  const stripHeight = rect.w > 0 ? covered / rect.w : 0;
  return {
    x: rect.x,
    y: rect.y + stripHeight,
    w: rect.w,
    h: Math.max(0, rect.h - stripHeight),
  };
}

function worstRatio(row, rect) {
  let worst = 0;
  for (const item of layRow(row, rect)) {
    if (item.w <= 0 || item.h <= 0) return Infinity;
    worst = Math.max(worst, item.w / item.h, item.h / item.w);
  }
  return worst;
}

/* ------------------------------------------------------------------ layout */
function layoutItems() {
  if (state.items.length <= MAX_RECTS) return state.items;
  const sorted = [...state.items].sort(
    (left, right) => displaySize(right) - displaySize(left)
  );
  const kept = sorted.slice(0, MAX_RECTS - 1);
  const rest = sorted.slice(MAX_RECTS - 1);
  const restSize = rest.reduce((sum, item) => sum + displaySize(item), 0);
  return kept.concat([{
    id: REST_ID,
    name: `（其余 ${rest.length} 项）`,
    path: '',
    isDir: false,
    known: rest.every((item) => item.known),
    size: restSize,
    synthetic: true,
  }]);
}

function updateLayout() {
  const items = layoutItems();
  const knownSizes = items.filter((item) => item.known).map((item) => item.size);
  const meanKnown = knownSizes.length
    ? knownSizes.reduce((sum, value) => sum + value, 0) / knownSizes.length
    : 0;
  state.provisional = Math.max(meanKnown * 0.35, 1);

  const padding = 6;
  const values = items.map((item) =>
    item.known && item.size > 0 ? item.size : state.provisional
  );
  const rects = squarifyLayout(
    values,
    padding,
    padding,
    Math.max(1, state.viewWidth - padding * 2),
    Math.max(1, state.viewHeight - padding * 2)
  );

  state.animationFrom = new Map(state.current);
  state.animationStart = performance.now();
  state.targets = new Map();
  state.order = [];
  state.itemById = new Map();

  items.forEach((item, index) => {
    state.itemById.set(item.id, item);
    state.targets.set(item.id, rects[index]);
    state.order.push(item.id);
    if (!state.colorById.has(item.id)) {
      state.colorById.set(item.id, PALETTE[index % PALETTE.length]);
    }
  });

  requestDraw();
}

/* --------------------------------------------------------------- rendering */
let drawScheduled = false;

function requestDraw() {
  if (drawScheduled) return;
  drawScheduled = true;
  requestAnimationFrame(drawFrame);
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function drawFrame() {
  drawScheduled = false;
  const elapsed = performance.now() - state.animationStart;
  const progress = Math.min(1, elapsed / ANIMATION_MS);
  const eased = easeOutCubic(progress);

  state.current = new Map();
  for (const id of state.order) {
    const target = state.targets.get(id);
    const previous = state.animationFrom.get(id) || {
      x: target.x + target.w / 2,
      y: target.y + target.h / 2,
      w: 0,
      h: 0,
    };
    state.current.set(id, {
      x: previous.x + (target.x - previous.x) * eased,
      y: previous.y + (target.y - previous.y) * eased,
      w: previous.w + (target.w - previous.w) * eased,
      h: previous.h + (target.h - previous.h) * eased,
    });
  }

  paint();

  if (progress < 1) requestDraw();
}

function paint() {
  const dpr = window.devicePixelRatio || 1;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, state.viewWidth, state.viewHeight);
  context.fillStyle = '#0d1117';
  context.fillRect(0, 0, state.viewWidth, state.viewHeight);

  const total = state.totalBytes || 1;

  for (const id of state.order) {
    const rect = state.current.get(id);
    const item = state.itemById.get(id);
    if (!rect || !item || rect.w < 0.6 || rect.h < 0.6) continue;

    const baseColor = state.colorById.get(id) || PALETTE[0];
    const isFile = !item.isDir && !item.synthetic;
    let fill = item.known ? baseColor : mixWithWhite(baseColor, 0.55);
    if (isFile) fill = mixWithWhite(baseColor, 0.42);
    if (!item.known) fill = mixWithWhite(baseColor, 0.6);
    if (state.hoveredId === id) fill = mixWithWhite(baseColor, isFile ? 0.2 : 0);

    context.fillStyle = fill;
    context.fillRect(rect.x, rect.y, rect.w, rect.h);

    context.strokeStyle = 'rgba(13, 17, 23, 0.85)';
    context.lineWidth = 1;
    context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    // A symlink occupies (almost) nothing on its own, so outline it rather than
    // fill it - otherwise a 0-byte tile reads as an empty folder.
    if (item.isLink && rect.w > 8 && rect.h > 8) {
      context.save();
      context.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      context.lineWidth = 1.4;
      context.setLineDash([4, 3]);
      context.strokeRect(rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4);
      context.restore();
    }

    drawTileLabel(rect, item, fill, total);
  }

  if (state.hoveredId) {
    const rect = state.current.get(state.hoveredId);
    if (rect && rect.w > 0.6) {
      context.strokeStyle = '#ffffff';
      context.lineWidth = 2;
      context.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
    }
  }
}

function drawTileLabel(rect, item, fillColor, total) {
  if (rect.w < 44 || rect.h < 24) return;

  const textColor = readableTextColor(
    fillColor.startsWith('#') ? fillColor : '#808080'
  );
  const nameFont = Math.max(10, Math.min(14, rect.w / 9, rect.h / 3.4));
  const sizeFont = Math.max(9, Math.min(12, nameFont - 1.5));
  const nameText = truncateText(item.name, rect.w - 12, nameFont);
  const sizeText = item.known ? formatBytes(item.size) : '测量中…';

  const centerX = rect.x + rect.w / 2;
  const showSize = rect.h >= 40 && rect.w >= 64;
  const blockHeight = showSize ? nameFont * 1.2 + sizeFont * 1.2 : nameFont * 1.2;
  let cursorY = rect.y + rect.h / 2 - blockHeight / 2;

  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.fillStyle = textColor;
  context.font = `600 ${nameFont}px ui-monospace, Menlo, Consolas, monospace`;
  context.fillText(nameText, centerX, cursorY + nameFont * 0.1);

  if (showSize) {
    cursorY += nameFont * 1.2;
    context.font = `${sizeFont}px ui-monospace, Menlo, Consolas, monospace`;
    context.globalAlpha = 0.8;
    context.fillText(
      item.known ? `${sizeText} · ${formatPercent(item.size, total)}` : sizeText,
      centerX,
      cursorY + sizeFont * 0.1
    );
    context.globalAlpha = 1;
  }
}

/* -------------------------------------------------------------- hit testing */
function hitTest(pointerX, pointerY) {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const id = state.order[index];
    const rect = state.current.get(id);
    if (!rect) continue;
    if (
      pointerX >= rect.x && pointerX <= rect.x + rect.w &&
      pointerY >= rect.y && pointerY <= rect.y + rect.h
    ) {
      return id;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ tooltip */
function showTooltip(item, pointerX, pointerY) {
  const total = state.totalBytes || 1;
  const share = item.known ? formatPercent(item.size, total) : '测量中…';
  const lines = [
    `<div class="tt-name">${escapeHtml(item.name)}</div>`,
    item.path
      ? `<div class="tt-path">${escapeHtml(item.path)}</div>`
      : '<div class="tt-path">（汇总项，无单独路径）</div>',
    `<div><span class="tt-size">${item.known ? formatBytes(item.size) : '测量中…'}</span>` +
      ` <span class="tt-hint">占当前目录 ${share}</span></div>`,
  ];

  if (item.isLink) {
    lines.push(`<div class="tt-path">链接目标 → ${escapeHtml(item.linkTarget || '?')}</div>`);
    if (!item.linkExists) {
      lines.push('<div class="tt-hint">符号链接（目标不存在，未计入大小）</div>');
    } else if (!item.linkReachable) {
      lines.push('<div class="tt-hint">符号链接（目标在允许范围外，未计入大小）</div>');
    } else {
      lines.push('<div class="tt-hint">符号链接：本身不占空间，点击可跳到目标目录</div>');
    }
  } else if (item.isDir) {
    lines.push('<div class="tt-hint">点击进入该目录</div>');
  } else if (!item.synthetic) {
    lines.push('<div class="tt-hint">文件</div>');
  }

  tooltip.innerHTML = lines.join('');

  tooltip.hidden = false;
  const panelWidth = state.viewWidth;
  const panelHeight = state.viewHeight;
  const box = tooltip.getBoundingClientRect();
  let left = pointerX + 14;
  let top = pointerY + 14;
  if (left + box.width > panelWidth - 8) left = Math.max(8, pointerX - box.width - 14);
  if (top + box.height > panelHeight - 8) top = Math.max(8, pointerY - box.height - 14);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------ ui rendering */
function showOverlay(message, isError) {
  overlay.textContent = message;
  overlay.classList.toggle('error', Boolean(isError));
  overlay.hidden = false;
}

function hideOverlay() {
  overlay.hidden = true;
  overlay.classList.remove('error');
  overlay.textContent = '';
}

function renderBreadcrumb() {
  breadcrumb.innerHTML = '';
  const path = state.path || '';
  if (!path) return;

  const root = breadcrumbRoot(path);
  const rootLabel = root === state.home
    ? '⌂ 家目录'
    : (root.split('/').filter(Boolean).pop() || '/');
  const segments = path.slice(root.length).split('/').filter(Boolean);

  const addCrumb = (label, targetPath, isCurrent) => {
    const button = document.createElement('button');
    button.className = 'crumb' + (isCurrent ? ' current' : '');
    button.textContent = label;
    button.title = targetPath;
    if (!isCurrent) button.addEventListener('click', () => navigate(targetPath));
    breadcrumb.appendChild(button);
  };
  const addSeparator = () => {
    const separator = document.createElement('span');
    separator.className = 'crumb-sep';
    separator.textContent = '/';
    breadcrumb.appendChild(separator);
  };

  addCrumb(rootLabel, root, segments.length === 0);
  let accumulated = root === '/' ? '' : root;
  segments.forEach((segment, index) => {
    addSeparator();
    accumulated += '/' + segment;
    addCrumb(segment, accumulated, index === segments.length - 1);
  });

  const canGoUp = root !== path && Boolean(state.parent);
  upButton.disabled = !canGoUp;
}

// The outermost directory the user is allowed to see, used as the breadcrumb
// anchor so the top crumb can never point at an unreadable path like "/".
function breadcrumbRoot(path) {
  const roots = state.allowedRoots.length ? state.allowedRoots : ['/'];
  let best = '/';
  for (const root of roots) {
    if (path === root || path.startsWith(root + '/')) {
      if (best === '/' || root.length > best.length) best = root;
    }
  }
  return best;
}

/* --------------------------------------------------------------- data flow */
/**
 * Read one directory level as a stream of events. Shared by the treemap (which
 * shows a single level) and the tree (which keeps one stream per open folder).
 */
async function streamScan(path, refresh, onEvent, signal) {
  const url = `/api/scan?path=${encodeURIComponent(path)}${refresh ? '&refresh=1' : ''}`;
  const response = await fetch(url, { signal });
  if (response.status !== 200) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload && payload.message ? payload.message : `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer.trim()));
}

async function navigate(path, options = {}) {
  const { pushHistory = true, refresh = false } = options;

  if (state.abortController) state.abortController.abort();
  const controller = new AbortController();
  state.abortController = controller;

  clearTimeout(state.autoRefreshTimer);
  clearTimeout(liveUpdateTimer);
  liveUpdateTimer = null;
  lastLiveUpdate = 0;
  state.items = [];
  state.itemByPath = new Map();
  state.itemById = new Map();
  state.order = [];
  state.targets = new Map();
  state.current = new Map();
  state.animationFrom = new Map();
  state.colorById = new Map();
  state.hoveredId = null;
  state.scanning = true;
  state.finished = false;
  state.doneCount = 0;
  state.totalCount = 0;
  state.totalBytes = 0;
  state.elapsedSeconds = 0;
  state.errorMessage = '';
  state.path = path;

  tooltip.hidden = true;
  hideOverlay();
  pathInput.value = path;
  renderBreadcrumb();
  renderSummary();
  renderRanking();
  renderStatus();

  if (pushHistory) {
    history.pushState({ path }, '', '#' + encodeURIComponent(path));
  }

  try {
    await streamScan(path, refresh, handleEvent, controller.signal);
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.scanning = false;
    state.errorMessage = error.message || String(error);
    showOverlay(
      `无法读取该路径\n${state.errorMessage}\n\n` +
      `可以点右上角「⌂ 家目录」回到允许浏览的目录。`,
      true
    );
    renderStatus();
    return;
  }

  state.scanning = false;
  state.finished = true;
  hideOverlay();
  updateLayout();
  renderSummary();
  renderRanking();
  renderStatus();
  scheduleAutoRefresh();
}

function handleEvent(event) {
  if (event.type === 'error') {
    state.errorMessage = event.message;
    showOverlay(event.message, true);
    return;
  }

  if (event.type === 'start') {
    state.path = event.path;
    state.parent = event.parent;
    pathInput.value = event.path;
    hideOverlay();
    state.items = event.children.map((child) => ({
      id: child.path,
      name: child.name,
      path: child.path,
      isDir: child.isDir,
      isLink: Boolean(child.isLink),
      linkTarget: child.linkTarget || '',
      linkExists: child.linkExists !== false,
      linkReachable: child.linkReachable !== false,
      known: false,
      size: 0,
    }));
    state.itemByPath = new Map(state.items.map((item) => [item.path, item]));
    state.totalCount = state.items.length;
    treeView.setRoot(event.path, state.items, 0);
    if (state.items.length === 0) {
      showOverlay('这个目录是空的', false);
    }
    renderBreadcrumb();
    renderSummary();
    renderRanking();
    renderStatus();
    return;
  }

  if (event.type === 'size') {
    const item = state.itemByPath.get(event.path);
    if (item) {
      item.size = event.size;
      item.known = true;
    }
    state.doneCount = event.done != null ? event.done : state.doneCount + 1;
    state.totalBytes += event.size;
    scheduleLiveUpdate();
    return;
  }

  if (event.type === 'done') {
    state.totalBytes = event.total;
    state.elapsedSeconds = event.elapsed;
    state.doneCount = event.count;
    state.finished = true;
    treeView.setRootSize(event.total);
    updateLayout();
    renderSummary();
    renderRanking();
    renderStatus();
  }
}

// Measurements arrive in bursts; redraw at a steady rate instead of on every
// single event so the tween animations stay smooth and the CPU stays quiet.
let liveUpdateTimer = null;
let lastLiveUpdate = 0;

function scheduleLiveUpdate() {
  treeView.invalidate();
  const sinceLast = performance.now() - lastLiveUpdate;
  if (sinceLast >= LIVE_UPDATE_MS) {
    lastLiveUpdate = performance.now();
    updateLayout();
    renderSummary();
    renderRanking();
    renderStatus();
    return;
  }
  renderStatus();
  if (liveUpdateTimer) return;
  liveUpdateTimer = setTimeout(() => {
    liveUpdateTimer = null;
    lastLiveUpdate = performance.now();
    updateLayout();
    renderSummary();
    renderRanking();
    renderStatus();
  }, LIVE_UPDATE_MS - sinceLast);
}

function scheduleAutoRefresh() {
  if (!autoRefreshToggle.checked) return;
  state.autoRefreshTimer = setTimeout(() => {
    navigate(state.path, { pushHistory: false, refresh: true });
  }, AUTO_REFRESH_DELAY_MS);
}

/* ------------------------------------------------------------ ui rendering */
function renderSummary() {
  const measured = state.items.filter((item) => item.known).length;
  const rows = [
    ['路径', state.path || '—'],
    ['合计', formatBytes(state.totalBytes)],
    ['条目', `${state.items.length} 项`],
    ['已测量', `${measured} / ${state.items.length}`],
  ];
  if (state.elapsedSeconds) rows.push(['用时', `${state.elapsedSeconds.toFixed(2)} s`]);
  if (state.items.length) {
    const biggest = state.items.reduce(
      (best, item) => (displaySize(item) > displaySize(best) ? item : best),
      state.items[0]
    );
    if (biggest && biggest.known) {
      rows.push(['最大项', `${biggest.name}（${formatPercent(biggest.size, state.totalBytes)}）`]);
    }
  }

  summaryBox.innerHTML = rows
    .map(([key, value]) => {
      const cls = key === '合计' ? 'value big' : 'value';
      return `<div class="summary-row"><span class="key">${escapeHtml(key)}</span>` +
        `<span class="${cls}">${escapeHtml(String(value))}</span></div>`;
    })
    .join('');
}

function renderRanking() {
  const sorted = [...state.items].sort(
    (left, right) => displaySize(right) - displaySize(left)
  );
  const total = state.totalBytes || 1;
  rankingNote.textContent = state.items.length > RANKING_LIMIT
    ? `前 ${RANKING_LIMIT} / ${state.items.length}`
    : '';

  rankingBox.innerHTML = sorted
    .slice(0, RANKING_LIMIT)
    .map((item) => {
      const share = item.known ? (item.size / total) * 100 : 0;
      const barWidth = Math.max(share, item.known ? 0.6 : 0.2);
      const nameClass = item.isDir ? 'name' : 'name is-file';
      return `<div class="rank-row" data-path="${escapeHtml(item.isDir ? item.path : '')}">` +
        `<span class="${nameClass}" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</span>` +
        `<span class="size">${item.known ? formatBytes(item.size) : '…'}</span>` +
        `<span class="rank-bar"><span style="width:${barWidth.toFixed(2)}%"></span></span>` +
        `</div>`;
    })
    .join('');

  for (const row of rankingBox.querySelectorAll('.rank-row')) {
    const target = row.dataset.path;
    if (!target) continue;
    row.addEventListener('click', () => navigate(target));
  }
}

function renderStatus() {
  const percent = state.totalCount
    ? Math.round((state.doneCount / state.totalCount) * 100)
    : (state.finished ? 100 : 0);
  const parts = [];
  parts.push(
    state.scanning
      ? `<span>测量中 ${state.doneCount} / ${state.totalCount}</span>`
      : `<span>就绪</span>`
  );
  parts.push(
    `<span class="progress"><span style="width:${percent}%"></span></span>`
  );
  parts.push(`<span>合计 ${formatBytes(state.totalBytes)}</span>`);
  if (state.elapsedSeconds) parts.push(`<span>用时 ${state.elapsedSeconds.toFixed(2)}s</span>`);
  if (state.errorMessage) parts.push(`<span class="bad">${escapeHtml(state.errorMessage)}</span>`);
  parts.push('<span class="grow"></span>');
  parts.push('<span>点击色块进入子目录 · 悬停查看详情 · Backspace 返回上一级</span>');
  statusbar.innerHTML = parts.join('');
}

/* -------------------------------------------------------------- interaction */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  state.viewWidth = Math.max(1, canvas.clientWidth);
  state.viewHeight = Math.max(1, canvas.clientHeight);
  const pixelWidth = Math.round(state.viewWidth * dpr);
  const pixelHeight = Math.round(state.viewHeight * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  updateLayout();
}

function canvasPointerPosition(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

canvas.addEventListener('mousemove', (event) => {
  const position = canvasPointerPosition(event);
  const id = hitTest(position.x, position.y);
  const item = id ? state.itemById.get(id) : null;

  if (id !== state.hoveredId) {
    state.hoveredId = id;
    requestDraw();
  }
  canvas.classList.toggle('pointer', Boolean(item && item.isDir));
  if (item) {
    showTooltip(item, position.x, position.y);
  } else {
    tooltip.hidden = true;
  }
});

canvas.addEventListener('mouseleave', () => {
  state.hoveredId = null;
  tooltip.hidden = true;
  canvas.classList.remove('pointer');
  requestDraw();
});

canvas.addEventListener('click', (event) => {
  const position = canvasPointerPosition(event);
  const id = hitTest(position.x, position.y);
  const item = id ? state.itemById.get(id) : null;
  if (item && item.isDir && item.path) navigate(item.path);
});

pathForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = pathInput.value.trim();
  if (value) navigate(value);
});

upButton.addEventListener('click', () => {
  if (state.parent && state.parent !== state.path) navigate(state.parent);
});

homeButton.addEventListener('click', () => {
  if (state.home) navigate(state.home);
});

refreshButton.addEventListener('click', () => {
  if (state.path) navigate(state.path, { pushHistory: false, refresh: true });
});

autoRefreshToggle.addEventListener('change', () => {
  if (autoRefreshToggle.checked) {
    if (!state.scanning) scheduleAutoRefresh();
  } else {
    clearTimeout(state.autoRefreshTimer);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.target === pathInput) return;
  if (event.key === 'Backspace') {
    event.preventDefault();
    if (state.parent && state.parent !== state.path) navigate(state.parent);
  } else if (event.key === 'r' || event.key === 'R') {
    if (state.path) navigate(state.path, { pushHistory: false, refresh: true });
  }
});

window.addEventListener('popstate', (event) => {
  const path = (event.state && event.state.path) || readPathFromHash() || state.home;
  if (path) navigate(path, { pushHistory: false });
});

// The error panel is only a notice; clicking it clears the message so the
// treemap underneath becomes usable again.
overlay.addEventListener('click', hideOverlay);

function readPathFromHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return '';
  try {
    return decodeURIComponent(hash);
  } catch (error) {
    return '';
  }
}

/* ------------------------------------------------------------- view switch */
const VIEW_STORAGE_KEY = 'diskExplorerView';
const treemapPane = document.getElementById('treemap-view');
const treePane = document.getElementById('tree-view');
const treemapTab = document.getElementById('view-treemap');
const treeTab = document.getElementById('view-tree');

let currentView = 'treemap';

const treeView = createTreeView({
  streamScan,
  formatBytes,
  onNavigate: (path) => navigate(path),
});

function applyView(mode) {
  currentView = mode;
  treemapPane.hidden = mode !== 'treemap';
  treePane.hidden = mode !== 'tree';
  treemapTab.classList.toggle('active', mode === 'treemap');
  treeTab.classList.toggle('active', mode === 'tree');
  if (mode === 'treemap') {
    resizeCanvas();
  } else {
    treeView.show();
  }
  renderStatus();
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch (error) {
    // Private-mode browsers reject storage; the default view still works.
  }
}

treemapTab.addEventListener('click', () => applyView('treemap'));
treeTab.addEventListener('click', () => applyView('tree'));

new ResizeObserver(() => resizeCanvas()).observe(canvas.parentElement);
window.addEventListener('resize', resizeCanvas);

/* --------------------------------------------------------------- bootstrap */
async function bootstrap() {
  resizeCanvas();
  try {
    const response = await fetch('/api/config');
    if (response.ok) {
      const config = await response.json();
      state.home = config.home || '';
      state.allowedRoots = Array.isArray(config.allowedRoots) ? config.allowedRoots : [];
    }
  } catch (error) {
    // Without the config we still work; "~" resolves to the same place.
  }
  const initialPath = readPathFromHash() || state.home || '~';
  let savedView = 'treemap';
  try {
    savedView = localStorage.getItem(VIEW_STORAGE_KEY) || 'treemap';
  } catch (error) {
    savedView = 'treemap';
  }
  applyView(savedView === 'tree' ? 'tree' : 'treemap');
  navigate(initialPath, { pushHistory: false });
}

bootstrap();

/* --------------------------------------------------------------- bootstrap */
resizeCanvas();
navigate(readPathFromHash() || '~', { pushHistory: false });
