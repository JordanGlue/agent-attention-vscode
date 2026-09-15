'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const fix = require('./fix-vscode-terminal-memory.cjs');

const installedApp = path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/resources/app');
const installedSource = fs.readFileSync(path.join(installedApp, 'out/main.js'), 'utf8');
const original = fix.sha256(installedSource) === fix.ORIGINAL_SHA256
  ? installedSource : fix.originalFromPatched(installedSource);
const patched = fix.patch(original);

// Execute the actual buffer and ProxyChannel functions extracted from the
// installed bundle, without starting Electron or accessing personal terminals.
class Emitter {
  constructor(options = {}) {
    this.options = options;
    this.listeners = new Set();
    this.event = callback => {
      const first = this.listeners.size === 0;
      if (first) this.options.onWillAddFirstListener?.();
      this.listeners.add(callback);
      if (first) this.options.onDidAddFirstListener?.();
      return { dispose: () => {
        if (this.listeners.delete(callback) && !this.listeners.size) this.options.onDidRemoveLastListener?.();
      } };
    };
  }
  fire(event) { for (const listener of this.listeners) listener(event); }
  dispose() { this.listeners.clear(); }
}

function fixture(source, options) {
  const bufferStart = source.indexOf('function b(H,R=!1,q=[],W){');
  assert.ok(bufferStart >= 0);
  const bufferSource = source.slice(bufferStart, source.indexOf('t.buffer=b;', bufferStart));
  const proxyStart = source.indexOf('function e(n,o,a){const c=n');
  assert.ok(proxyStart >= 0);
  const proxySource = source.slice(proxyStart, source.indexOf('t.fromService=e;', proxyStart));
  const buffer = vm.runInNewContext(`(${bufferSource})`, { P: Emitter, setTimeout });
  const fromService = vm.runInNewContext(`(${proxySource})`, {
    x: { buffer }, s: name => /^on[A-Z]/.test(name), r: name => /^onDynamic[A-Z]/.test(name),
    Ts: Error, fr: value => value
  });
  const lifecycle = ['onPtyHostStart', 'onPtyHostExit', 'onPtyHostResponsive', 'onPtyHostUnresponsive', 'onPtyHostRequestResolveVariables'];
  const emitters = Object.fromEntries([...fix.PROCESS_EVENTS, ...lifecycle].map(name => [name, new Emitter()]));
  const service = Object.fromEntries(Object.entries(emitters).map(([name, emitter]) => [name, emitter.event]));
  service.getProfiles = () => ['PowerShell'];
  const disposables = [];
  const channel = fromService(service, { add(item) { disposables.push(item); return item; } }, options);
  return { emitters, lifecycle, channel, service, dispose() { disposables.forEach(item => item.dispose()); } };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('original shipped code retains 20,000 terminal chunks with no consumer', async () => {
  const f = fixture(original);
  assert.equal(f.emitters.onProcessData.listeners.size, 1);
  for (let i = 0; i < 20000; i++) f.emitters.onProcessData.fire({ id: 1, event: `frame ${i}` });
  let received = 0;
  const listener = f.channel.listen(null, 'onProcessData')(() => received++);
  await tick();
  assert.equal(received, 20000);
  listener.dispose();
  f.dispose();
});

test('backport leaves zero unused process-event subscriptions after terminal flood', async () => {
  // Read the applied call-site configuration, rather than just testing a
  // manually supplied option that the installed app might not actually use.
  const optionText = patched.match(/const I=Ge\.fromService\(e\.get\(im\),r,(\{unbufferedEvents:\[[^\]]+\]\})\)/)[1];
  const f = fixture(patched, vm.runInNewContext(`(${optionText})`));
  for (const name of fix.PROCESS_EVENTS) assert.equal(f.emitters[name].listeners.size, 0, name);
  for (let i = 0; i < 20000; i++) f.emitters.onProcessData.fire({ id: 1, event: `frame ${i}` });
  const first = [], second = [];
  const a = f.channel.listen(null, 'onProcessData')(data => first.push(data));
  const b = f.channel.listen(null, 'onProcessData')(data => second.push(data));
  await tick();
  assert.equal(first.length, 0, 'must not replay unconsumed terminal output');
  f.emitters.onProcessData.fire('live one');
  a.dispose();
  f.emitters.onProcessData.fire('live two');
  b.dispose();
  assert.deepEqual(first, ['live one']);
  assert.deepEqual(second, ['live one', 'live two']);
  assert.equal(f.emitters.onProcessData.listeners.size, 0);
  f.dispose();
});

test('management events still replay early events and deliver live events', async () => {
  const f = fixture(patched, { unbufferedEvents: fix.PROCESS_EVENTS });
  const received = {};
  const listeners = [];
  for (const name of f.lifecycle) {
    assert.equal(f.emitters[name].listeners.size, 1);
    f.emitters[name].fire('early');
    received[name] = [];
    listeners.push(f.channel.listen(null, name)(value => received[name].push(value)));
  }
  await tick();
  for (const name of f.lifecycle) {
    f.emitters[name].fire('late');
    assert.deepEqual(received[name], ['early', 'late']);
  }
  assert.deepEqual(await f.channel.call(null, 'getProfiles', []), ['PowerShell']);
  listeners.forEach(listener => listener.dispose());
  f.dispose();
  for (const name of f.lifecycle) assert.equal(f.emitters[name].listeners.size, 0);
});

test('other IPC channels keep existing buffering behaviour', async () => {
  const f = fixture(patched);
  f.emitters.onProcessData.fire('early');
  const received = [];
  const listener = f.channel.listen(null, 'onProcessData')(value => received.push(value));
  await tick();
  assert.deepEqual(received, ['early']);
  listener.dispose();
  f.dispose();
});

test('exact bundle patch passes JavaScript parser and restores byte-for-byte', () => {
  fix.validateSyntax(patched);
  assert.equal(fix.originalFromPatched(patched), original);
  assert.throws(() => fix.patch(`${original}\n`), /hash differs/);
  assert.throws(() => fix.originalFromPatched(`${patched}\n`), /unexpected changes/);
});

test('installer is idempotent, preserves backup, refuses unknown builds, and rolls back', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-memory-test-'));
  try {
    const appDir = path.join(temp, 'app');
    const backupDir = path.join(temp, 'backup');
    fs.mkdirSync(path.join(appDir, 'out'), { recursive: true });
    const mainPath = path.join(appDir, 'out/main.js');
    fs.writeFileSync(mainPath, original);
    for (const name of ['package.json', 'product.json']) fs.copyFileSync(path.join(installedApp, name), path.join(appDir, name));
    assert.equal(fix.run('--check', appDir, backupDir).installed, false);
    fix.run('--install', appDir, backupDir);
    fix.run('--install', appDir, backupDir);
    assert.equal(fs.readFileSync(mainPath, 'utf8'), patched);
    assert.equal(fs.readFileSync(path.join(backupDir, 'main.js.original'), 'utf8'), original);
    assert.equal(fix.run('--check', appDir, backupDir).installed, true);
    fix.run('--remove', appDir, backupDir);
    assert.equal(fs.readFileSync(mainPath, 'utf8'), original);
    fs.writeFileSync(mainPath, `${original}\n`);
    assert.throws(() => fix.run('--install', appDir, backupDir), /Unsupported/);
    assert.equal(fs.readFileSync(mainPath, 'utf8'), `${original}\n`);
    fs.writeFileSync(mainPath, original);
    fs.writeFileSync(path.join(backupDir, 'main.js.original'), 'invalid backup');
    assert.throws(() => fix.run('--install', appDir, backupDir), /Backup does not match/);
    assert.equal(fs.readFileSync(mainPath, 'utf8'), original);
  } finally {
    // Only the unique temporary fixture created above is removed.
    assert.equal(path.dirname(temp), os.tmpdir());
    assert.ok(path.basename(temp).startsWith('agent-attention-memory-test-'));
    fs.rmSync(temp, { recursive: true });
  }
});
