# Codex Attention for VS Code

A personal Windows/VS Code integration that makes a completed Codex CLI or Claude Code turn request attention from the exact terminal pane where it is running.

The working setup supports Jordan's six-terminal editor-grid layout as well as ordinary terminal panel splits.

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
- Claude cannot emit Codex's focus-conditioned BEL, so the extension delivers Claude events directly and performs the focus check itself. This path needs no proposed API.
- The bridge rings the terminal bell itself (best-effort, via the attached console) so the injected pane renderer still marks the exact pane.

Wire it up in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\\.claude\\bin\\claude-attention-notify.ps1"
          }
        ]
      }
    ]
  }
}
```

## Source of truth

Edit files in this repository, not the deployed copies under `~/.codex`, `~/.vscode`, or the VS Code installation.

| Repository source | Deployed location |
|---|---|
| `extension/*` | `~/.vscode/extensions/jordan.codex-attention-0.1.0/` |
| `renderer/*` | `~/.codex/bin/` and the active VS Code workbench directory |
| `scripts/codex-attention-notify.ps1` | `~/.codex/bin/` |
| `scripts/claude-attention-notify.ps1` | `~/.claude/bin/` |
| `scripts/install-codex-attention-renderer.ps1` | `~/.codex/bin/` |
| `docs/MAINTENANCE.md` | `~/.codex/CODEX_ATTENTION.md` |

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

This parses both PowerShell scripts, checks both JavaScript files, validates the extension manifest, verifies the renderer/cache-buster version coupling, and optionally compares repository files with deployed profile copies.

See [architecture](docs/ARCHITECTURE.md) for the event flow and [maintenance](docs/MAINTENANCE.md) for operational recovery notes.
