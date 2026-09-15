# Agent Attention for VS Code

A personal Windows/VS Code integration that makes a completed Codex CLI or Claude Code turn request attention from the exact terminal pane where it is running.

The working setup supports a six-terminal editor-grid layout as well as ordinary terminal panel splits.

## Behaviour

- Skips the notification when the originating agent terminal already has focus.
- Shows a VS Code alert with a **Jump to terminal** action.
- Sends the existing Windows `boop` notification (Codex only).
- Adds a pulsing pink/gold border and `AGENT READY` badge to the exact waiting pane.
- Clears the visual marker when that pane receives focus.
- Preserves routing across `Developer: Reload Window` by rediscovering the restarted extension host.

## Claude Code support

Claude Code events arrive through a `Stop` hook rather than Codex's `notify` hook:

- `scripts/claude-attention-notify.ps1` reads the hook payload from stdin, walks its ancestor process IDs, and reuses the same named-pipe protocol (`source: "claude"`).
- Both Codex and Claude completion hooks deliver directly, with a focus check in the extension. Neither requires terminal-output forwarding or a proposed API.
- The pane border/badge relies on a terminal bell reaching the pane's xterm. On Windows, Claude Code spawns hooks into a detached invisible console, so the bridge's own BEL write is best-effort only. The reliable source is the CLI ringing its own bell — set `"preferredNotifChannel": "terminal_bell"` in `~/.claude.json`. The renderer ignores bells in focused panes, so the always-on bell still behaves focus-aware visually.

Wire it up in `~/.claude/settings.json`. Use forward slashes and an absolute path: Claude Code may run hook commands through a POSIX shell, which strips single backslashes and does not expand `%VAR%`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:/Users/<you>/.claude/bin/claude-attention-notify.ps1\""
          }
        ]
      }
    ]
  }
}
```

## Source of truth

Edit files in this repository, not the deployed copies under `~/.agent-attention`, `~/.codex`, `~/.claude`, `~/.vscode`, or the VS Code installation.

| Repository source | Deployed location |
|---|---|
| `extension/*` | `~/.vscode/extensions/local.agent-attention-0.2.0/` |
| `renderer/*` | `~/.agent-attention/` and the active VS Code workbench directory |
| `scripts/codex-attention-notify.ps1` | `~/.codex/bin/` |
| `scripts/claude-attention-notify.ps1` | `~/.claude/bin/` |
| `scripts/install-agent-attention-renderer.ps1` | `~/.agent-attention/` |
| `docs/MAINTENANCE.md` | `~/.agent-attention/MAINTENANCE.md` |

## Editing workflow

```powershell
cd C:\code\codex-attention-vscode
& .\scripts\verify.ps1
& .\scripts\sync-to-profile.ps1
```

Then run **Developer: Reload Window** in VS Code. Local terminal processes reconnect and the split/editor layout is restored.

After editing only the extension, **Developer: Restart Extension Host** is sufficient. Renderer, CSS, workbench-loader, or product-allowlist changes require **Developer: Reload Window**.

## After a VS Code update

Run:

```powershell
& C:\code\codex-attention-vscode\scripts\sync-to-profile.ps1
```

The deployment script copies the canonical sources into the profile and invokes the workbench installer for the newest installed VS Code build. The installer creates pristine per-build backups before patching.

VS Code will report that its installation appears corrupt because its workbench loader and product metadata are intentionally modified. This warning is expected for this unsupported customization.

## Verification

```powershell
& .\scripts\verify.ps1 -CheckInstalled
```

This parses all PowerShell scripts, checks JavaScript syntax, runs workbench-health regression tests, validates the extension manifest, and verifies the renderer/cache-buster version coupling. `-CheckInstalled` also compares deployed profile and workbench assets with the source and checks that the newest VS Code build actually loads the renderer. Use `-AppRoot <resources/app path>` to check a specific build.

At startup, the extension checks the running VS Code build and shows a repair warning with a link to the maintenance guide when an update has removed the pane renderer.

See [architecture](docs/ARCHITECTURE.md) for the event flow and [maintenance](docs/MAINTENANCE.md) for operational recovery notes.

## VS Code memory crashes

The September 2026 investigation found an upstream main-process terminal-output
buffer leak in the installed VS Code 1.108.0 build. See the
[diagnosis, tested local repair, and rollback instructions](docs/VSCODE-MEMORY-REPAIR.md).
This repair is separate from the Agent Attention extension and requires a full
VS Code restart.
