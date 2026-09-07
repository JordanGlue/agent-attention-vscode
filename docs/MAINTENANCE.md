# Agent Attention notifications in VS Code

This setup makes a finished Codex CLI or Claude Code turn request attention from the exact VS Code terminal split where the agent is running.

## Normal behaviour

- If the agent's terminal is already focused, no notification is shown.
- If it is unfocused, VS Code shows a notification with a button that focuses the correct terminal.
- The correct terminal split gets a pulsing pink/gold border and an `AGENT READY` badge.
- Focusing that split acknowledges and clears the visual marker.
- Window reloads preserve terminal processes. The notification bridge discovers the newly restarted extension host instead of relying only on the terminal's now-stale pipe environment variable.

To test it, run or resume an agent in one terminal split, focus another split, and ask it: `Boop me.`

## After a VS Code update

VS Code updates replace the patched workbench files. Reapply the visual pane marker from PowerShell:

```powershell
& "$HOME\.agent-attention\install-agent-attention-renderer.ps1"
```

Then open the Command Palette (`Ctrl+Shift+P`) and run `Developer: Reload Window`.
VS Code's persistent-terminal support reconnects the existing local terminal processes and restores the split layout, so the running Codex sessions should survive the brief UI reload. This profile uses the default `terminal.integrated.enablePersistentSessions: true` setting.

Only fully quit VS Code if `Developer: Reload Window` fails to load the marker.

VS Code may report that the installation is modified or corrupt. This is expected because the visual pane marker injects a small local stylesheet and renderer script into VS Code's workbench. Dismiss the warning if the installed files and paths below are still trusted.

## Removing the visual pane marker

```powershell
& "$HOME\.agent-attention\install-agent-attention-renderer.ps1" -Remove
```

Run `Developer: Reload Window` afterward. This removes only the unsupported renderer/CSS layer; the ordinary notification extension remains installed.

## Files

- Codex notification bridge: `~/.codex/bin/codex-attention-notify.ps1`
- Claude Code notification bridge: `~/.claude/bin/claude-attention-notify.ps1` (wired via a `Stop` hook in `~/.claude/settings.json`)
- Reapply/remove script: `~/.agent-attention/install-agent-attention-renderer.ps1`
- Durable renderer source: `~/.agent-attention/agent-attention-renderer.js`
- Durable renderer styles: `~/.agent-attention/agent-attention-renderer.css`
- VS Code extension: `~/.vscode/extensions/local.agent-attention-0.2.0`
- Per-build pristine backups: `~/.agent-attention/backups/vscode-renderer/<build>/workbench.html.original`
- Per-build product backups: `~/.agent-attention/backups/vscode-renderer/<build>/product.json.original`
- Codex notify configuration: `~/.codex/config.toml`
- VS Code proposed-API opt-in: `~/.vscode/argv.json` (older setups: `%APPDATA%/Code/argv.json`)

## Troubleshooting

The extension checks the running workbench at startup. If an update removed the patch, it shows **Agent Attention terminal borders need repair** with an **Open repair guide** action. Reapply using the command above, then reload the window.

From the source repository, `scripts/verify.ps1 -CheckInstalled` checks the actual workbench loader and installed renderer assets as well as the profile copies. A successful profile comparison alone does not mean the workbench patch survived an update.

1. Confirm ordinary notifications still appear. If not, check the extension and notification bridge first.
2. If notifications work but the pane border does not, run the reapply command above and fully restart VS Code.
3. If the installer says its VS Code loader anchors changed, do not patch manually from memory. The new VS Code build changed its workbench structure and the installer needs updating.
4. If the wrong pane is highlighted, inspect the renderer against the new build. The renderer subscribes directly to each terminal's exposed xterm `onBell` event and marks either its panel split (`.terminal-split-pane`) or editor-grid pane (`.editor-instance`). Its workbench asset URLs include a version query so window reloads cannot reuse an older cached renderer.

After changing the notification extension itself, run `Developer: Restart Extension Host` from the Command Palette. This reloads extensions without reloading the workbench or terminating local terminal processes.

This visual layer deliberately uses unsupported VS Code workbench injection because the public extension API cannot style one specific terminal split. It may require maintenance after VS Code updates.

The installer also allowlists `local.agent-attention` for VS Code's proposed `terminalDataWriteEvent` in that build's `product.json`. This keeps terminal-aware delivery available after a window reload even when the long-running VS Code main process predates the `argv.json` startup flag.
