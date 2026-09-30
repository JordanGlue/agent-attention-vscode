'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sessions = require('../extension/sessions');

const now = Date.parse('2026-09-30T10:00:00Z');
const bootTime = Date.parse('2026-09-30T08:00:00Z');
const hours = n => new Date(now - n * 60 * 60 * 1000).toISOString();

function session(overrides) {
  return {
    sessionId: 'aaaa-1111',
    status: 'open',
    updatedAt: hours(1),
    claudePid: 100,
    claudeStartedAt: hours(1),
    ...overrides
  };
}

test('classifies live, restorable, parked and closed sessions', () => {
  const alive = new Set([100]);
  const groups = sessions.classifySessions([
    session({ sessionId: 'live' }),
    session({ sessionId: 'dead', claudePid: 200 }),
    session({ sessionId: 'old', claudePid: 200, updatedAt: hours(24 * 6) }),
    session({ sessionId: 'done', claudePid: 200, status: 'closed' })
  ], { now, bootTime, isAlive: pid => alive.has(pid), parkAfterDays: 5 });

  assert.deepEqual(groups.live.map(s => s.sessionId), ['live']);
  assert.deepEqual(groups.restore.map(s => s.sessionId), ['dead']);
  assert.deepEqual(groups.parked.map(s => s.sessionId), ['old']);
  assert.deepEqual(groups.closed.map(s => s.sessionId), ['done']);
});

test('a PID recorded before the last boot is never treated as live', () => {
  const groups = sessions.classifySessions([
    session({ claudeStartedAt: hours(5) })
  ], { now, bootTime, isAlive: () => true });

  assert.equal(groups.live.length, 0);
  assert.equal(groups.restore.length, 1);
});

test('resume command reapplies only safe permission modes', () => {
  assert.equal(sessions.resumeCommand(session({ permissionMode: 'auto' })),
    'claude --resume aaaa-1111 --permission-mode auto');
  assert.equal(sessions.resumeCommand(session({ permissionMode: 'bypassPermissions' })),
    'claude --resume aaaa-1111');
  assert.throws(() => sessions.resumeCommand(session({ sessionId: 'x; rm -rf /' })));
});

test('labels lead with the tracked card once', () => {
  assert.equal(sessions.sessionLabel(session({ card: 'TRYB-1', title: 'Fix login' })), 'TRYB-1 - Fix login');
  assert.equal(sessions.sessionLabel(session({ card: 'TRYB-1', title: 'TRYB-1 - Fix login' })), 'TRYB-1 - Fix login');
});

test('reads registry files, skipping headless and malformed records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-sessions-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), '﻿' + JSON.stringify(session({ sessionId: 'a' })));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ sessionId: 'b', headless: true }));
    fs.writeFileSync(path.join(dir, 'c.json'), '{ not json');
    assert.deepEqual(sessions.readSessions(dir).map(s => s.sessionId), ['a']);

    sessions.markClosed({ sessionId: 'a' }, dir);
    assert.equal(sessions.readSessions(dir)[0].status, 'closed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resumes from the launch directory, not the last cd', () => {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-projects-'));
  try {
    const owner = path.join(projects, 'C--code');
    fs.mkdirSync(owner);
    fs.writeFileSync(path.join(owner, 'aaaa-1111.jsonl'), '');
    fs.mkdirSync(path.join(projects, 'C--code-repo'));

    const drifted = session({ cwd: 'C:\\code\\repo\\src' });
    assert.equal(sessions.launchCwd(drifted, projects), 'C:\\code');
    assert.equal(sessions.launchCwd(session({ sessionId: 'missing', cwd: 'C:\\x' }), projects), 'C:\\x');
    assert.equal(sessions.launchCwd(session({ cwd: 'D:\\elsewhere' }), projects), 'D:\\elsewhere');
  } finally {
    fs.rmSync(projects, { recursive: true, force: true });
  }
});

test('restore lock lets only one window restore at a time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-lock-'));
  const lock = path.join(dir, 'restore.lock');
  try {
    assert.equal(sessions.claimRestore(lock), true);
    assert.equal(sessions.claimRestore(lock), false);
    assert.equal(sessions.claimRestore(lock, Date.now() + 3 * 60 * 1000), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
