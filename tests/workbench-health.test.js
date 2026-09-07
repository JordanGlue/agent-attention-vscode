'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { checkWorkbench } = require('../extension/workbench-health');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-health-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'out/vs/code/electron-browser/workbench');
  fs.mkdirSync(directory, { recursive: true });
  const write = (name, content) => fs.writeFileSync(path.join(directory, name), content);
  write('workbench.html', '<link href="./agent-attention-renderer.css?v=0.5.0"><script src="./agent-attention-renderer.js?v=0.5.0"></script>');
  write('agent-attention-renderer.js', 'const VERSION = "0.5.0";');
  write('agent-attention-renderer.css', '.agent-attention-waiting {}');
  return { root, directory, write };
}

test('a complete patched workbench passes', t => {
  assert.deepEqual(checkWorkbench(fixture(t).root), []);
});

test('a VS Code update replacing the loader is detected even when assets remain', t => {
  const { root, write } = fixture(t);
  write('workbench.html', '<script src="./workbench.js"></script>');
  assert.equal(checkWorkbench(root).length, 2);
});

test('a loader pointing to a missing renderer fails', t => {
  const { root, directory } = fixture(t);
  fs.unlinkSync(path.join(directory, 'agent-attention-renderer.js'));
  assert.match(checkWorkbench(root).join(';'), /Missing agent-attention-renderer.js/);
});

test('stale renderer cache URLs fail', t => {
  const { root, write } = fixture(t);
  write('agent-attention-renderer.js', 'const VERSION = "0.6.0";');
  assert.match(checkWorkbench(root).join(';'), /cache versions do not match/);
});

test('an unreadable or relocated workbench reports a problem without throwing', t => {
  const { root } = fixture(t);
  assert.match(checkWorkbench(path.join(root, 'missing')).join(';'), /Could not inspect/);
});
