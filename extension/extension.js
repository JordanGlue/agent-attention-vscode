'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const BELL_PAIR_WINDOW_MS = 2500;
const RECENT_BELL_WINDOW_MS = 1000;
const PIPE_REGISTRY_DIR = path.join(os.tmpdir(), 'codex-attention-pipes');

/** @type {Map<string, {id: string, terminal?: import('vscode').Terminal, terminalName: string, cwd?: string, project: string, createdAt: Date}>} */
const unread = new Map();

/** @type {import('vscode').StatusBarItem | undefined} */
let statusItem;
/** @type {NodeJS.Timeout | undefined} */
let pulseTimer;
/** @type {Map<import('vscode').Terminal, Array<{message: any, timeout: NodeJS.Timeout}>>} */
const pendingByTerminal = new Map();
/** @type {WeakMap<import('vscode').Terminal, number>} */
const recentBellAt = new WeakMap();

function countLabel() {
  return unread.size === 1 ? '1 READY' : `${unread.size} READY`;
}

function renderStatus(pulseOn = true) {
  if (!statusItem) {
    return;
  }

  if (unread.size === 0) {
    statusItem.hide();
    return;
  }

  statusItem.text = pulseOn
    ? `$(bell-dot) CODEX ${countLabel()}`
    : `$(alert) CODEX ${countLabel()}`;
  statusItem.backgroundColor = pulseOn
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  statusItem.tooltip = buildTooltip();
  statusItem.show();
}

function buildTooltip() {
  const lines = ['Codex is waiting in:'];
  for (const item of unread.values()) {
    lines.push(`• ${item.terminalName} — ${item.project}`);
  }
  lines.push('', 'Click to jump to a waiting terminal.');
  return lines.join('\n');
}

function startPulse() {
  if (pulseTimer) {
    clearInterval(pulseTimer);
  }

  let ticks = 0;
  renderStatus(true);
  pulseTimer = setInterval(() => {
    ticks += 1;
    if (ticks >= 6 || unread.size === 0) {
      clearInterval(pulseTimer);
      pulseTimer = undefined;
      renderStatus(true);
      return;
    }
    renderStatus(ticks % 2 === 0);
  }, 300);
}

async function resolveTerminal(ancestorPids) {
  const ids = new Set((ancestorPids || []).map(Number));
  for (const terminal of vscode.window.terminals) {
    try {
      const processId = await terminal.processId;
      if (processId && ids.has(processId)) {
        return terminal;
      }
    } catch {
      // A terminal can disappear while its process ID is resolving.
    }
  }
  return undefined;
}

function projectName(cwd) {
  if (!cwd) {
    return 'unknown project';
  }
  const normalized = cwd.replace(/[\\/]+$/, '');
  return path.basename(normalized) || cwd;
}

function removeAlert(id) {
  unread.delete(id);
  renderStatus(true);
}

function clearTerminal(terminal) {
  for (const [id, item] of unread) {
    if (item.terminal === terminal) {
      unread.delete(id);
    }
  }
  const pending = pendingByTerminal.get(terminal) || [];
  for (const item of pending) {
    clearTimeout(item.timeout);
  }
  pendingByTerminal.delete(terminal);
  renderStatus(true);
}

async function jumpToAlert(item) {
  if (item.terminal) {
    item.terminal.show(false);
  } else {
    await vscode.commands.executeCommand('workbench.action.terminal.focus');
  }
  removeAlert(item.id);
}

async function showUnreadPicker() {
  if (unread.size === 0) {
    vscode.window.setStatusBarMessage('$(check) No Codex terminals are waiting.', 2500);
    return;
  }

  const choices = Array.from(unread.values()).map(item => ({
    label: `$(bell-dot) ${item.terminalName}`,
    description: item.project,
    detail: `Turn completed at ${item.createdAt.toLocaleTimeString()}`,
    item
  }));

  const choice = await vscode.window.showQuickPick(choices, {
    title: 'Codex Attention',
    placeHolder: 'Choose a terminal to resume'
  });
  if (choice) {
    await jumpToAlert(choice.item);
  }
}

function launchWindowsNotifier(message) {
  if (!message.windowsNotifierPath) {
    return;
  }

  const payload = JSON.stringify({
    type: message.type,
    'thread-id': message.threadId,
    'turn-id': message.turnId,
    cwd: message.cwd,
    'input-messages': [],
    'last-assistant-message': 'Codex turn finished.'
  });

  try {
    const process = childProcess.spawn(
      message.windowsNotifierPath,
      ['turn-ended', payload],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    process.on('error', error => {
      console.error('Codex Attention Windows notifier failed:', error);
    });
    process.unref();
  } catch (error) {
    console.error('Codex Attention could not launch the Windows notifier:', error);
  }
}

async function deliverNotification(message, terminal) {
  const id = message.turnId || `${Date.now()}-${crypto.randomUUID()}`;
  const cwd = message.cwd || undefined;
  const item = {
    id,
    terminal,
    terminalName: terminal ? terminal.name : 'Codex terminal',
    cwd,
    project: projectName(cwd),
    createdAt: new Date()
  };

  unread.set(id, item);
  startPulse();
  launchWindowsNotifier(message);

  const action = await vscode.window.showWarningMessage(
    `Codex finished in ${item.terminalName} — ${item.project}.`,
    'Jump to terminal',
    'Dismiss'
  );

  if (action === 'Jump to terminal') {
    await jumpToAlert(item);
  } else if (action === 'Dismiss') {
    removeAlert(item.id);
  }
}

function queueNotification(message, terminal) {
  const recentBell = recentBellAt.get(terminal) || 0;
  if (Date.now() - recentBell <= RECENT_BELL_WINDOW_MS) {
    recentBellAt.delete(terminal);
    void deliverNotification(message, terminal);
    return;
  }

  const entry = {
    message,
    timeout: setTimeout(() => {
      const pending = pendingByTerminal.get(terminal) || [];
      const remaining = pending.filter(candidate => candidate !== entry);
      if (remaining.length > 0) {
        pendingByTerminal.set(terminal, remaining);
      } else {
        pendingByTerminal.delete(terminal);
      }
    }, BELL_PAIR_WINDOW_MS)
  };
  const pending = pendingByTerminal.get(terminal) || [];
  pending.push(entry);
  pendingByTerminal.set(terminal, pending);
}

function handleTerminalData(event) {
  if (!event.data.includes('\x07')) {
    return;
  }

  recentBellAt.set(event.terminal, Date.now());
  const pending = pendingByTerminal.get(event.terminal) || [];
  if (pending.length === 0) {
    return;
  }

  pendingByTerminal.delete(event.terminal);
  recentBellAt.delete(event.terminal);
  for (const item of pending) {
    clearTimeout(item.timeout);
    void deliverNotification(item.message, event.terminal);
  }
}

async function acceptNotification(socket, message, supportsTerminalData) {
  if (!supportsTerminalData) {
    socket.end('fallback\n');
    return;
  }

  const terminal = await resolveTerminal(message.ancestorPids);
  if (!terminal) {
    socket.end('fallback\n');
    return;
  }

  socket.end('accepted\n');
  queueNotification(message, terminal);
}

function createPipeServer(pipeName, supportsTerminalData) {
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;

    socket.on('data', chunk => {
      if (handled) {
        return;
      }
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }

      handled = true;
      const line = buffer.slice(0, newline).trim();
      try {
        const message = JSON.parse(line);
        void acceptNotification(socket, message, supportsTerminalData).catch(error => {
          console.error('Codex Attention rejected a notification:', error);
          if (!socket.destroyed) {
            socket.end('fallback\n');
          }
        });
      } catch (error) {
        console.error('Codex Attention rejected a notification:', error);
        socket.end('fallback\n');
      }
    });
  });

  server.on('error', error => {
    console.error('Codex Attention pipe server failed:', error);
    vscode.window.showErrorMessage(`Codex Attention could not start: ${error.message}`);
  });
  server.listen(pipePath);
  return server;
}

function registerPipe(pipeName) {
  try {
    fs.mkdirSync(PIPE_REGISTRY_DIR, { recursive: true });
    const registrationPath = path.join(PIPE_REGISTRY_DIR, `${process.pid}.json`);
    fs.writeFileSync(registrationPath, JSON.stringify({
      pipeName,
      processId: process.pid,
      updatedAt: new Date().toISOString()
    }), 'utf8');

    return new vscode.Disposable(() => {
      try {
        const current = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
        if (current.pipeName === pipeName) {
          fs.unlinkSync(registrationPath);
        }
      } catch {
        // Missing or replaced registrations do not need cleanup.
      }
    });
  } catch (error) {
    console.error('Codex Attention could not register its pipe:', error);
    return new vscode.Disposable(() => {});
  }
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.name = 'Codex Attention';
  statusItem.command = 'codexAttention.showUnread';
  context.subscriptions.push(statusItem);

  const supportsTerminalData = typeof vscode.window.onDidWriteTerminalData === 'function';
  if (supportsTerminalData) {
    context.subscriptions.push(vscode.window.onDidWriteTerminalData(handleTerminalData));
  } else {
    console.warn('Codex Attention terminal-data API is unavailable; notifications will fail open.');
  }

  const pipeName = `codex-attention-${crypto.randomUUID()}`;
  const server = createPipeServer(pipeName, supportsTerminalData);
  context.subscriptions.push(new vscode.Disposable(() => server.close()));
  context.subscriptions.push(registerPipe(pipeName));

  const environment = context.environmentVariableCollection;
  environment.replace('CODEX_ATTENTION_PIPE', pipeName);
  environment.description = 'Routes Codex completion events to the Codex Attention extension.';

  context.subscriptions.push(
    vscode.commands.registerCommand('codexAttention.showUnread', showUnreadPicker),
    vscode.commands.registerCommand('codexAttention.clearAll', () => {
      unread.clear();
      renderStatus(true);
      vscode.window.setStatusBarMessage('$(check) Cleared all Codex alerts.', 2500);
    }),
    vscode.window.onDidChangeActiveTerminal(terminal => {
      if (terminal) {
        clearTerminal(terminal);
      }
    }),
    vscode.window.onDidCloseTerminal(clearTerminal)
  );
}

function deactivate() {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = undefined;
  }
  for (const pending of pendingByTerminal.values()) {
    for (const item of pending) {
      clearTimeout(item.timeout);
    }
  }
  pendingByTerminal.clear();
}

module.exports = { activate, deactivate };
