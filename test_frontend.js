'use strict';
/**
 * Frontend self-check. Loads static/tree.js + static/app.js under a small DOM
 * stub and asserts three things that have actually broken before:
 *
 *   1. the treemap layout tiles the canvas exactly, without overlaps, with
 *      area strictly proportional to value;
 *   2. the breadcrumb never anchors on a path the server will refuse;
 *   3. the directory tree expands and collapses and keeps row sizes in sync.
 *
 * Run with: node test_frontend.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------------------------------------------------ DOM stub */
class StubElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.style = {};
    this.title = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.clientWidth = 1000;
    this.clientHeight = 600;
    this.width = 1000;
    this.height = 600;
    this._className = '';
    this._text = '';
    this.listeners = {};
  }

  get className() { return this._className; }
  set className(value) { this._className = String(value); }

  get classList() {
    const element = this;
    const set = () => new Set(element._className.split(/\s+/).filter(Boolean));
    const write = (values) => { element._className = [...values].join(' '); };
    return {
      add(name) { const s = set(); s.add(name); write(s); },
      remove(name) { const s = set(); s.delete(name); write(s); },
      toggle(name, on) { const s = set(); if (on) s.add(name); else s.delete(name); write(s); },
      contains(name) { return set().has(name); },
    };
  }

  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); this.children = []; }

  get innerHTML() { return ''; }
  set innerHTML(value) { this._text = String(value); }

  get firstElementChild() { return this.children[0] || null; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get nextElementSibling() {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return this.parent.children[index + 1] || null;
  }

  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
    return child;
  }
  replaceChild(next, previous) {
    const index = this.children.indexOf(previous);
    if (index >= 0) { this.children[index] = next; next.parent = this; previous.parent = null; }
    return previous;
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }
  dispatch(type, event) {
    for (const handler of this.listeners[type] || []) handler(event);
  }

  closest(selector) {
    const wanted = selector.replace(/^\./, '');
    let node = this;
    while (node) {
      if (node._className.split(/\s+/).includes(wanted)) return node;
      node = node.parent;
    }
    return null;
  }

  /** Test helper: the rendered text of a row, flattened. */
  text() {
    const own = this.children.length ? this.children.map((child) => child.text()) : [this._text];
    return own.join(' ').trim();
  }
}

const stubCanvasContext = new Proxy({}, {
  get(target, property) {
    if (property === 'measureText') return () => ({ width: 10 });
    if (property in target) return target[property];
    return () => {};
  },
  set() { return true; },
});

const elementsById = new Map();
function elementById(id) {
  if (!elementsById.has(id)) {
    const element = new StubElement('div');
    element.id = id;
    if (id === 'treemap') {
      element.getContext = () => stubCanvasContext;
      element.parentElement = elementById('treemap-view');
    }
    elementsById.set(id, element);
  }
  return elementsById.get(id);
}

/* --------------------------------------------------------------- fake timers */
const pendingTimers = [];
let timerSequence = 0;

function flushTimers(limit = 50) {
  let rounds = 0;
  while (pendingTimers.length && rounds < limit) {
    const due = pendingTimers.splice(0, pendingTimers.length);
    for (const timer of due) timer.fn();
    rounds += 1;
  }
}

/* ------------------------------------------------------------------- sandbox */
const sandbox = {
  console,
  AbortController,
  Promise,
  Map,
  Set,
  JSON,
  Math,
  Date,
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
  setTimeout: (fn, ms) => {
    const handle = { id: ++timerSequence, fn };
    pendingTimers.push(handle);
    return handle.id;
  },
  clearTimeout: (id) => {
    const index = pendingTimers.findIndex((timer) => timer.id === id);
    if (index >= 0) pendingTimers.splice(index, 1);
  },
  addEventListener() {},
  TextDecoder: class { decode() { return ''; } },
  fetch: () => new Promise(() => {}),
  history: { pushState() {} },
  location: { hash: '' },
  localStorage: { store: {}, getItem(k) { return this.store[k] || null; }, setItem(k, v) { this.store[k] = v; } },
  ResizeObserver: class { observe() {} },
  document: {
    getElementById: elementById,
    createElement: (tag) => new StubElement(tag),
    addEventListener() {},
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);

function loadScript(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, 'static', relativePath), 'utf8');
  vm.runInContext(source, sandbox, { filename: relativePath });
}

loadScript('tree.js');
loadScript('app.js');

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`);
    return true;
  }
  failures += 1;
  console.log(`FAIL ${label}${detail ? `  (${detail})` : ''}`);
  return false;
}

/* --------------------------------------------------- 1. treemap layout maths */
const squarifyLayout = sandbox.squarifyLayout;
if (typeof squarifyLayout !== 'function') {
  console.error('FAIL: squarifyLayout is not reachable in the sandbox');
  process.exit(1);
}

function checkLayout(label, values, x, y, width, height) {
  const rects = squarifyLayout(values, x, y, width, height);
  const problems = [];

  if (rects.length !== values.length) {
    problems.push(`expected ${values.length} rects, got ${rects.length}`);
  }

  let areaSum = 0;
  for (const rect of rects) {
    areaSum += rect.w * rect.h;
    if (!Number.isFinite(rect.w) || !Number.isFinite(rect.h) || rect.w < 0 || rect.h < 0) {
      problems.push(`bad rect ${JSON.stringify(rect)}`);
    }
    const epsilon = 1e-6;
    if (rect.x < x - epsilon || rect.y < y - epsilon ||
        rect.x + rect.w > x + width + epsilon ||
        rect.y + rect.h > y + height + epsilon) {
      problems.push(`rect escapes canvas: ${JSON.stringify(rect)}`);
    }
  }

  const coverage = areaSum / (width * height);
  if (coverage < 0.999) problems.push(`coverage only ${(coverage * 100).toFixed(3)}%`);

  for (let i = 0; i < rects.length && problems.length < 6; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const overlapWidth = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapHeight = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (overlapWidth > 1e-6 && overlapHeight > 1e-6) {
        problems.push(`rect ${i}/${j} overlap by ${(overlapWidth * overlapHeight).toFixed(3)}`);
        break;
      }
    }
  }

  // Zero-valued entries legitimately collapse to a hairline, so skip them.
  const total = values.reduce((sum, value) => sum + value, 0);
  const expectedScale = (width * height) / total;
  let worstError = 0;
  values.forEach((value, index) => {
    if (value <= 0) return;
    const expected = value * expectedScale;
    worstError = Math.max(worstError, Math.abs(rects[index].w * rects[index].h - expected) / expected);
  });
  if (worstError > 0.02) problems.push(`area error up to ${(worstError * 100).toFixed(2)}%`);

  const status = problems.length ? 'FAIL' : 'ok  ';
  console.log(
    `${status} layout: ${label}  coverage=${(coverage * 100).toFixed(2)}% ` +
    `worstAreaError=${(worstError * 100).toFixed(3)}%`
  );
  for (const problem of problems) console.log(`       - ${problem}`);
  if (problems.length) failures += 1;
}

for (const [label, values] of [
  ['single item', [100]],
  ['two items', [70, 30]],
  ['classic 4', [40, 30, 20, 10]],
  ['the 00_LLM level', [281, 139, 5.9, 5.8, 1.0, 0.6]],
  ['many tiny', [1000, 3, 3, 2, 2, 1, 1, 1, 1, 0.5, 0.5]],
  ['one dominant', [10000, 1, 1, 1]],
  ['equal 40', new Array(40).fill(1)],
  ['with zeros', [50, 0, 25, 0, 25]],
]) {
  checkLayout(label, values, 0, 0, 1000, 600);
}
checkLayout('wide canvas', [40, 30, 20, 10], 6, 6, 1600, 120);

/* ----------------------------------------------------- 2. breadcrumb anchoring */
function checkBreadcrumbRoot(label, allowedRoots, home, target, expected) {
  vm.runInContext(
    `state.allowedRoots = ${JSON.stringify(allowedRoots)};` +
    `state.home = ${JSON.stringify(home)};`,
    sandbox
  );
  const actual = vm.runInContext(`breadcrumbRoot(${JSON.stringify(target)})`, sandbox);
  check(`breadcrumb: ${label}`, actual === expected, `got ${actual}, expected ${expected}`);
}

checkBreadcrumbRoot('inside home', ['/home/me'], '/home/me', '/home/me/workspace/00_LLM', '/home/me');
checkBreadcrumbRoot('at home', ['/home/me'], '/home/me', '/home/me', '/home/me');
checkBreadcrumbRoot('deepest matching root', ['/data', '/data/projects'], '/home/me', '/data/projects/a', '/data/projects');
checkBreadcrumbRoot('outside every root', ['/home/me'], '/home/me', '/etc/passwd', '/');

/* ---------------------------------------------------------- 3. directory tree */
const GB = 1024 ** 3;
const treeBody = elementById('tree-body');

const scanLog = [];
const fakeLevels = {
  '/home/me/proj': {
    children: [
      { name: 'weights', path: '/home/me/proj/weights', isDir: true, isLink: false },
      { name: 'notes.txt', path: '/home/me/proj/notes.txt', isDir: false, isLink: false },
    ],
    total: 3 * GB,
  },
};

function fakeStreamScan(path, refresh, onEvent) {
  scanLog.push(path);
  const level = path === '/home/me'
    ? {
        children: [
          { name: 'proj', path: '/home/me/proj', isDir: true, isLink: false },
          { name: 'link', path: '/home/me/link', isDir: true, isLink: true, linkTarget: '/elsewhere', linkExists: true, linkReachable: false },
        ],
        total: 10 * GB,
      }
    : fakeLevels[path];
  onEvent({ type: 'start', path, parent: path.slice(0, path.lastIndexOf('/')), children: level.children });
  level.children.forEach((child, index) => {
    onEvent({ type: 'size', path: child.path, size: (index + 1) * GB, done: index + 1, total: level.children.length });
  });
  onEvent({ type: 'done', path, total: level.total, count: level.children.length, elapsed: 0.1 });
  return Promise.resolve();
}

const treeView = sandbox.createTreeView({
  streamScan: (target, refresh, onEvent) => fakeStreamScan(target, refresh, onEvent),
  formatBytes: sandbox.formatBytes,
  onNavigate: () => {},
});

const rootItems = [
  { id: '/home/me/proj', path: '/home/me/proj', name: 'proj', isDir: true, isLink: false, known: true, size: 10 * GB },
  { id: '/home/me/link', path: '/home/me/link', name: 'link', isDir: true, isLink: true, linkTarget: '/elsewhere', linkExists: true, linkReachable: false, known: true, size: 0 },
];

treeView.setRoot('/home/me', rootItems, 10 * GB);
flushTimers();

const rowsAfterRoot = () => treeBody.children.filter((row) => row._className.includes('tree-row'));
check('tree: root renders itself plus its children', rowsAfterRoot().length === 3,
  `got ${rowsAfterRoot().length} rows`);
check('tree: root row is marked current', rowsAfterRoot()[0]._className.includes('current'));
check('tree: unreachable symlink row is flagged', rowsAfterRoot()[2]._className.includes('is-link'));

// Expand the first folder. The tree listens on the container (event
// delegation), so the click has to be dispatched there.
const projRow = rowsAfterRoot().find((row) => row.dataset.path === '/home/me/proj');
treeBody.dispatch('click', { target: projRow });
flushTimers();

const rowsAfterExpand = rowsAfterRoot();
check('tree: expanding added the folder children', rowsAfterExpand.length === 5,
  `got ${rowsAfterExpand.length} rows`);
check('tree: expansion triggered exactly one scan of that folder',
  scanLog.filter((entry) => entry === '/home/me/proj').length === 1, scanLog.join(', '));
check('tree: the root level was not re-scanned',
  scanLog.filter((entry) => entry === '/home/me').length === 0,
  'setRoot must reuse the already-measured items');

const weightsRow = rowsAfterExpand.find((row) => row.dataset.path === '/home/me/proj/weights');
check('tree: child size arrived from the stream', Boolean(weightsRow) && weightsRow.text().includes('GB'),
  weightsRow ? weightsRow.text() : 'missing row');

// Collapse again.
treeBody.dispatch('click', { target: projRow });
flushTimers();
check('tree: collapsing removed the children again', rowsAfterRoot().length === 3,
  `got ${rowsAfterRoot().length} rows`);

// Sizes pushed onto the shared root items must show up after invalidate().
rootItems[0].size = 42 * GB;
treeView.invalidate();
flushTimers();
check('tree: shares sizes with the caller without re-scanning',
  rowsAfterRoot().some((row) => row.text().includes('42')),
  rowsAfterRoot().map((row) => row.text()).join(' | '));

console.log(failures ? `\n${failures} check(s) failed` : '\nall frontend checks passed');
process.exit(failures ? 1 : 0);
