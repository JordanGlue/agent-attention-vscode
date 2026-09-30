'use strict';

// Reads the Claude Code session registry written by
// scripts/claude-session-registry.ps1 and decides which sessions to restore.
// Kept free of the vscode module so the rules are unit-testable.

const fs = require('fs');
const os = require('os');
const path = require('path');

const REGISTRY_DIR = path.join(os.homedir(), '.agent-attention', 'sessions');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const RESTORE_LOCK = path.join(os.homedir(), '.agent-attention', 'restore.lock');
const RESTORE_LOCK_MS = 2 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9-]+$/;
// Modes that are safe to reapply on resume; bypass-style modes need an
// explicit opt-in flag, so those sessions resume in their saved default.
const RESUMABLE_MODES = new Set(['acceptEdits', 'auto', 'plan']);

function readSessions(dir = REGISTRY_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }
  const sessions = [];
  for (const name of names) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/^﻿/, '');
      const record = JSON.parse(text);
      if (record && !record.headless && SESSION_ID.test(record.sessionId || '')) {
        sessions.push(record);
      }
    } catch {
      // A hook may be mid-write; the next read picks it up.
    }
  }
  return sessions;
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Sorts sessions into live (a claude process still owns them), restore
 * (open, recently active), parked (open but idle too long) and closed.
 */
function classifySessions(sessions, options = {}) {
  const now = options.now ?? Date.now();
  const bootTime = options.bootTime ?? now - os.uptime() * 1000;
  const isAlive = options.isAlive ?? processAlive;
  const parkAfterMs = (options.parkAfterDays ?? 5) * 24 * 60 * 60 * 1000;
  const groups = { live: [], restore: [], parked: [], closed: [] };

  for (const session of sessions) {
    const startedAt = Date.parse(session.claudeStartedAt || '');
    // A PID recorded before the last boot may now belong to anything.
    const sameBoot = Number.isFinite(startedAt) && startedAt >= bootTime;
    if (session.claudePid && sameBoot && isAlive(session.claudePid)) {
      groups.live.push(session);
    } else if (session.status === 'closed') {
      groups.closed.push(session);
    } else if (now - Date.parse(session.updatedAt || 0) > parkAfterMs) {
      groups.parked.push(session);
    } else {
      groups.restore.push(session);
    }
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  }
  return groups;
}

// Claude Code names a project folder after its launch directory with every
// non-alphanumeric character replaced by '-' (C:\code -> C--code).
function projectFolderName(dir) {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The directory the session was launched from. The recorded cwd follows the
 * agent's `cd`s, and resuming from a subdirectory switches the session to a
 * different project (its memory and settings), so walk up from the recorded
 * cwd to the directory that owns the transcript.
 */
function launchCwd(session, projectsDir = CLAUDE_PROJECTS_DIR) {
  if (!session.cwd) return undefined;
  let owners;
  try {
    owners = fs.readdirSync(projectsDir)
      .map(folder => {
        try {
          return { folder, mtimeMs: fs.statSync(path.join(projectsDir, folder, `${session.sessionId}.jsonl`)).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return session.cwd;
  }
  if (owners.length === 0) return session.cwd;
  for (let dir = session.cwd; ; dir = path.dirname(dir)) {
    if (projectFolderName(dir) === owners[0].folder) return dir;
    if (path.dirname(dir) === dir) return session.cwd;
  }
}

function resumeCommand(session) {
  if (!SESSION_ID.test(session.sessionId || '')) {
    throw new Error(`Invalid session id: ${session.sessionId}`);
  }
  const parts = ['claude', '--resume', session.sessionId];
  if (RESUMABLE_MODES.has(session.permissionMode)) {
    parts.push('--permission-mode', session.permissionMode);
  }
  return parts.join(' ');
}

function sessionLabel(session) {
  const title = session.title || 'untitled session';
  return session.card && !title.startsWith(session.card) ? `${session.card} - ${title}` : title;
}

function lastLine(message, maxChars = 160) {
  if (!message) return '';
  const lines = message.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const line = (lines[lines.length - 1] || '').replace(/[*`#>]/g, '');
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

function relativeAge(isoTime, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(isoTime || 0)) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Returns true when this window won the right to auto-restore. */
function claimRestore(lockPath = RESTORE_LOCK, now = Date.now()) {
  try {
    const stat = fs.statSync(lockPath);
    if (now - stat.mtimeMs < RESTORE_LOCK_MS) return false;
  } catch {
    // No lock yet.
  }
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function markClosed(session, dir = REGISTRY_DIR) {
  const file = path.join(dir, `${session.sessionId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  record.status = 'closed';
  record.endReason = 'closed-from-vscode';
  record.endedAt = new Date().toISOString();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

module.exports = {
  REGISTRY_DIR,
  claimRestore,
  classifySessions,
  lastLine,
  launchCwd,
  markClosed,
  readSessions,
  relativeAge,
  resumeCommand,
  sessionLabel
};
