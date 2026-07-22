# Architecture

## Completion flow (Codex)

1. Codex invokes `codex-attention-notify.ps1` for a completed turn.
2. The bridge walks its ancestor process IDs and contacts live extension pipes registered under `%TEMP%\codex-attention-pipes`.
3. Each VS Code window attempts to resolve those process IDs to one of its terminals. Only the owning window accepts the event.
4. The extension waits for the originating terminal's focus-conditioned BEL through the proposed `terminalDataWriteEvent` API.
5. On BEL, the extension shows the VS Code alert/status indicator and launches the Windows notifier.
6. The injected workbench renderer independently subscribes to each xterm `onBell` event and marks the containing pane.

## Completion flow (Claude Code)

1. Claude Code invokes `claude-attention-notify.ps1` from a `Stop` hook in `~/.claude/settings.json`, passing the event JSON on stdin.
2. The bridge walks ancestor process IDs and contacts the same pipe registry, tagging the message `source: "claude"`.
3. The owning window resolves the terminal by process ID exactly as for Codex.
4. Claude cannot emit a focus-conditioned BEL, so the extension does not wait for one: it checks focus itself (window focused and originating terminal active means suppress) and otherwise delivers immediately. This path avoids the proposed API entirely.
5. The pane marker needs a bell inside the pane's xterm. The primary source is Claude Code itself: `"preferredNotifChannel": "terminal_bell"` in `~/.claude.json` makes the CLI (which owns the terminal) ring the bell on turn completion. The bridge also writes a best-effort BEL, but on Windows Claude Code spawns hooks into a detached invisible console (verified: the hook's console process list contains only the hook shells, not the CLI), so that write usually cannot reach the terminal.
6. A Stop hook that exits with code 2 would block Claude from stopping, so the bridge swallows all errors and always exits 0.

The pipe registry is essential after `Developer: Reload Window`: persistent terminal processes retain the old `CODEX_ATTENTION_PIPE` environment value, while the restarted extension host owns a new pipe.

## Pane targeting

Renderer v3 resolves the pane at bell time:

- Terminal panel split: `.terminal-split-pane`
- Terminal opened in the editor grid: `.editor-instance`

Resolving at event time also supports terminals moved between the panel and editor area after startup.

The marker is the `codex-attention-waiting` class. The stylesheet supplies the animated border and badge. Focusing the pane removes the marker.

## Unsupported surfaces

VS Code's public extension API cannot style one specific terminal pane. This project therefore patches:

- `workbench.html` to load the renderer JavaScript and CSS.
- `product.json` to allow `jordan.codex-attention` to use `terminalDataWriteEvent` without restarting a long-running VS Code main process.

`%APPDATA%\Code\argv.json` also enables that proposal for normal future application starts.

The renderer asset URLs include the renderer version as a query parameter. Increment the JavaScript `VERSION` and both installer URL query strings together whenever renderer behaviour changes; otherwise Chromium may reuse an older module from cache across window reloads.

## Known maintenance hazards

- VS Code updates replace patched application files.
- DOM classes such as `.editor-instance`, `.terminal-wrapper`, and the exposed `wrapper.xterm` property are internal implementation details.
- Proposed API names or enablement rules may change.
- The Windows notifier is discovered under `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node` (newest runtime wins); a Codex update that relocates it entirely breaks the fallback notification.
- The integrity warning is expected and does not by itself indicate a broken patch.

Keep per-build pristine backups. If loader anchors or internal terminal DOM structure changes, stop and inspect the new build rather than forcing the old patch.
