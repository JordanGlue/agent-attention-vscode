'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function extension() {
  const prompts = [];
  const window = {
    terminals: [], state: { focused: false },
    showWarningMessage: () => new Promise(resolve => prompts.push(resolve))
  };
  Object.defineProperty(window, 'onDidWriteTerminalData', {
    get() { throw new Error('Terminal output must never be forwarded'); }
  });
  const context = vm.createContext({
    require: name => name === 'vscode' ? { window } :
      name === './workbench-health' ? { checkWorkbench: () => [] } : require(name),
    module: { exports: {} }, console, process,
    setInterval: () => 1, clearInterval() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/extension.js'), 'utf8'), context);
  const api = vm.runInContext('({ acceptNotification, deliverNotification, clearTerminal, unread, get count() { return openPromptCount; } })', context);
  return { api, window, prompts };
}

test('10,000 completion/focus cycles retain one prompt per terminal', async () => {
  const { api, prompts } = extension();
  const terminal = { name: 'Agent' };
  const first = api.deliverNotification({}, terminal);
  for (let n = 0; n < 10000; n++) {
    api.clearTerminal(terminal);
    await api.deliverNotification({ cwd: `project-${n}` }, terminal);
  }
  assert.equal(prompts.length, 1);
  assert.equal(api.count, 1);
  assert.equal(api.unread.size, 1);
  prompts[0]('Dismiss');
  await first;
  assert.equal(api.count, 0);
  assert.equal(api.unread.size, 0);
  const next = api.deliverNotification({}, terminal);
  assert.equal(prompts.length, 2);
  prompts[1]();
  await next;
});

test('closing and replacing 1,000 terminals cannot accumulate unbounded prompts', async () => {
  const { api, prompts } = extension();
  const pending = [];
  for (let n = 0; n < 1000; n++) {
    const terminal = { name: `Agent ${n}` };
    pending.push(api.deliverNotification({}, terminal));
    api.clearTerminal(terminal);
  }
  assert.equal(prompts.length, 8);
  assert.equal(api.unread.size, 0);
  for (const resolve of prompts) resolve();
  await Promise.all(pending);
  assert.equal(api.count, 0);
});

test('both agent hooks route and suppress focus without reading terminal output', async () => {
  const { api, prompts, window } = extension();
  const terminal = { name: 'Agent', processId: Promise.resolve(123) };
  window.terminals = [terminal];
  window.activeTerminal = terminal;
  for (const source of ['codex', 'claude']) {
    window.state.focused = true;
    let response;
    const socket = { end: value => { response = value; } };
    await api.acceptNotification(socket, { source, ancestorPids: [123] });
    assert.equal(response, 'accepted\n');
    assert.equal(api.unread.size, 0);
    window.state.focused = false;
    await api.acceptNotification(socket, { source, ancestorPids: [123] });
    assert.equal(api.unread.size, 1);
    prompts.at(-1)('Dismiss');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(api.unread.size, 0);
    await api.acceptNotification(socket, { source, ancestorPids: [999] });
    assert.equal(response, 'fallback\n');
  }
});

test('renderer bounds discovery work and releases replaced and closed terminals', () => {
  let scans = 0, focusHandler, timer, timerCount = 0;
  let wrappers = [];
  let marked = false, focused = false;
  const pane = {
    classList: { add: () => { marked = true; }, remove: () => { marked = false; } },
    setAttribute() {}, removeAttribute() {},
    querySelector: () => focused ? {} : null
  };
  const terminal = () => {
    const handlers = new Set();
    return { handlers, onBell: handler => {
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    } };
  };
  const first = terminal();
  const wrapper = { xterm: first, closest: () => pane };
  wrappers = [wrapper];
  const context = vm.createContext({
    window: {},
    document: {
      querySelectorAll: selector => {
        scans++;
        return selector === '.terminal-wrapper' ? wrappers : marked ? [pane] : [];
      },
      addEventListener: (_, callback) => { focusHandler = callback; },
      removeEventListener: () => { focusHandler = undefined; }
    },
    MutationObserver: class { constructor() { throw new Error('No workbench-wide observer'); } },
    requestAnimationFrame() { throw new Error('No output-driven frame scans'); },
    setInterval: (callback, delay) => { assert.equal(delay, 1000); timer = callback; timerCount++; return 1; },
    clearInterval: () => { timerCount--; }
  });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/agent-attention-renderer.js'), 'utf8');
  vm.runInContext(source, context);
  assert.equal(first.handlers.size, 1);
  assert.equal(scans, 2);
  for (const bell of first.handlers) bell();
  assert.equal(marked, true);
  focused = true;
  focusHandler({ target: wrapper });
  assert.equal(marked, false);
  focused = false;
  for (let n = 0; n < 10000; n++) timer();
  assert.equal(first.handlers.size, 1);
  assert.equal(scans, 20002);
  const replacement = terminal();
  wrapper.xterm = replacement;
  timer();
  assert.equal(first.handlers.size, 0);
  assert.equal(replacement.handlers.size, 1);
  vm.runInContext(source, context);
  assert.equal(timerCount, 1);
  wrappers = [];
  timer();
  assert.equal(replacement.handlers.size, 0);
  context.window.__agentAttentionRenderer.destroy();
  assert.equal(timerCount, 0);
  assert.equal(focusHandler, undefined);
});
