# Codex Attention

A personal, dependency-free VS Code extension for dramatic Codex CLI and Claude Code completion alerts.

When a notification bridge reports a completed turn, the extension:

- pulses a warning-colored `CODEX READY` / `CLAUDE READY` status item three times;
- keeps an unread count until the terminal is revisited;
- shows a VS Code warning notification with a **Jump to terminal** action;
- clears the corresponding alert when that terminal becomes active; and
- leaves VS Code's native per-terminal visual bell in place.

The bridges forward only event source, event type, working directory, turn ID, thread ID, timestamp, and ancestor process IDs. Prompt and response contents are not forwarded to the extension.

Codex delivery waits for Codex's focus-conditioned terminal BEL through the proposed terminal-data API. Claude Code cannot emit a focus-conditioned BEL, so Claude events are delivered directly and the extension suppresses them itself when the originating terminal is focused; that path uses only stable VS Code APIs.
