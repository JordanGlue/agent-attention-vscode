'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { checkWorkbench } = require('./workbench-health');

const MAX_PIPE_MESSAGE_CHARS = 64 * 1024;
const PIPE_SOCKET_TIMEOUT_MS = 5000;
const PIPE_REGISTRY_DIR = path.join(os.tmpdir(), 'agent-attention-pipes');

/** @type {Map<string, {id: string, terminal?: import('vscode').Terminal, terminalName: string, cwd?: string, project: string, agent: string, createdAt: Date}>} */
const unread = new Map();

/** @type {import('vscode').StatusBarItem | undefined} */
let statusItem;
/** @type {NodeJS.Timeout | undefined} */
let pulseTimer;
// Track unresolved prompts separately from unread alerts: focusing a terminal
// clears unread state but does not dismiss VS Code's notification promise.
const promptByTerminal = new WeakMap();
const MAX_OPEN_PROMPTS = 8;
let openPromptCount = 0;
/** @type {WeakMap<import('vscode').Terminal, string>} */
const alertIdByTerminal = new WeakMap();

function countLabel() {
  return unread.size === 1 ? '1 READY' : `${unread.size} READY`;
}

function messageAgent(message) {
  return message.source === 'claude' ? 'Claude' : 'Codex';
}

function agentLabel() {
  const agents = new Set(Array.from(unread.values(), item => item.agent));
  return agents.size === 1 ? agents.values().next().value.toUpperCase() : 'AGENTS';
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
    ? `$(bell-dot) ${agentLabel()} ${countLabel()}`
    : `$(alert) ${agentLabel()} ${countLabel()}`;
  statusItem.backgroundColor = pulseOn
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  statusItem.tooltip = buildTooltip();
  statusItem.show();
}

function buildTooltip() {
  const lines = ['Agent turns are waiting in:'];
  for (const item of unread.values()) {
    lines.push(`• ${item.terminalName} — ${item.project} (${item.agent})`);
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
    vscode.window.setStatusBarMessage('$(check) No agent terminals are waiting.', 2500);
    return;
  }

  const choices = Array.from(unread.values()).map(item => ({
    label: `$(bell-dot) ${item.terminalName}`,
    description: item.project,
    detail: `Turn completed at ${item.createdAt.toLocaleTimeString()}`,
    item
  }));

  const choice = await vscode.window.showQuickPick(choices, {
    title: 'Agent Attention',
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
      console.error('Agent Attention Windows notifier failed:', error);
    });
    process.unref();
  } catch (error) {
    console.error('Agent Attention could not launch the Windows notifier:', error);
  }
}

async function deliverNotification(message, terminal) {
  let id = terminal ? alertIdByTerminal.get(terminal) : undefined;
  if (!id) {
    id = terminal
      ? `terminal-${crypto.randomUUID()}`
      : message.turnId || `${Date.now()}-${crypto.randomUUID()}`;
    if (terminal) {
      alertIdByTerminal.set(terminal, id);
    }
  }
  const cwd = message.cwd || undefined;
  const agent = messageAgent(message);
  const item = {
    id,
    terminal,
    terminalName: terminal ? terminal.name : `${agent} terminal`,
    cwd,
    project: projectName(cwd),
    agent,
    createdAt: new Date()
  };

  unread.set(id, item);
  startPulse();
  launchWindowsNotifier(message);

  const existingPrompt = promptByTerminal.get(terminal);
  if (existingPrompt) {
    existingPrompt.item = item;
    return;
  }
  if (openPromptCount >= MAX_OPEN_PROMPTS) return;
  const prompt = { item };
  promptByTerminal.set(terminal, prompt);
  openPromptCount += 1;
  try {
    const action = await vscode.window.showWarningMessage(
      `${item.agent} finished in ${item.terminalName} — ${item.project}.`,
      'Jump to terminal',
      'Dismiss'
    );

    if (action === 'Jump to terminal') {
      await jumpToAlert(prompt.item);
    } else if (action === 'Dismiss') {
      removeAlert(prompt.item.id);
    }
  } finally {
    promptByTerminal.delete(terminal);
    openPromptCount -= 1;
  }
}

async function acceptNotification(socket, message) {
  const terminal = await resolveTerminal(message.ancestorPids);
  if (socket.destroyed) return;
  if (!terminal) {
    socket.end('fallback\n');
    return;
  }

  socket.end('accepted\n');
  // Hook payloads already identify the terminal. Do not subscribe to the
  // output of every terminal just to find a bell (which also replays data).
  if (vscode.window.state.focused && vscode.window.activeTerminal === terminal) return;
  void deliverNotification(message, terminal).catch(error => {
    console.error('Agent Attention could not show a notification:', error);
  });
}

function createPipeServer(pipeName) {
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.setTimeout(PIPE_SOCKET_TIMEOUT_MS, () => socket.destroy());
    let buffer = '';
    let handled = false;

    socket.on('data', chunk => {
      if (handled) {
        return;
      }
      buffer += chunk;
      if (buffer.length > MAX_PIPE_MESSAGE_CHARS) {
        handled = true;
        socket.end('fallback\n');
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }

      handled = true;
      const line = buffer.slice(0, newline).trim();
      buffer = '';
      try {
        const message = JSON.parse(line);
        void acceptNotification(socket, message).catch(error => {
          console.error('Agent Attention rejected a notification:', error);
          if (!socket.destroyed) {
            socket.end('fallback\n');
          }
        });
      } catch (error) {
        console.error('Agent Attention rejected a notification:', error);
        socket.end('fallback\n');
      }
    });
  });

  server.on('error', error => {
    console.error('Agent Attention pipe server failed:', error);
    vscode.window.showErrorMessage(`Agent Attention could not start: ${error.message}`);
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
    console.error('Agent Attention could not register its pipe:', error);
    return new vscode.Disposable(() => {});
  }
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  const workbenchIssues = checkWorkbench(vscode.env.appRoot);
  if (workbenchIssues.length) {
    console.warn('Agent Attention workbench check:', workbenchIssues.join('; '));
    void vscode.window.showWarningMessage(
      'Agent Attention terminal borders need repair, usually after a VS Code update. Reapply the renderer, then reload this window.',
      'Open repair guide'
    ).then(action => {
      if (action === 'Open repair guide') {
        return vscode.commands.executeCommand('markdown.showPreview',
          vscode.Uri.file(path.join(os.homedir(), '.agent-attention', 'MAINTENANCE.md')));
      }
    });
  }

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.name = 'Agent Attention';
  statusItem.command = 'agentAttention.showUnread';
  context.subscriptions.push(statusItem);

  const pipeName = `agent-attention-${crypto.randomUUID()}`;
  const server = createPipeServer(pipeName);
  context.subscriptions.push(new vscode.Disposable(() => server.close()));
  context.subscriptions.push(registerPipe(pipeName));

  const environment = context.environmentVariableCollection;
  environment.replace('AGENT_ATTENTION_PIPE', pipeName);
  environment.description = 'Routes agent completion events to the Agent Attention extension.';

  context.subscriptions.push(
    vscode.commands.registerCommand('agentAttention.showUnread', showUnreadPicker),
    vscode.commands.registerCommand('agentAttention.clearAll', () => {
      unread.clear();
      renderStatus(true);
      vscode.window.setStatusBarMessage('$(check) Cleared all agent alerts.', 2500);
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
  unread.clear();
}

module.exports = { activate, deactivate };
