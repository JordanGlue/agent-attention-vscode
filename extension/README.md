# Codex Attention

A personal, dependency-free VS Code extension for dramatic Codex CLI completion alerts.

When the Codex notification bridge reports a completed turn, the extension:

- pulses a warning-colored `CODEX READY` status item three times;
- keeps an unread count until the terminal is revisited;
- shows a VS Code warning notification with a **Jump to terminal** action;
- clears the corresponding alert when that terminal becomes active; and
- leaves VS Code's native per-terminal visual bell in place.

The bridge forwards only event type, working directory, turn ID, thread ID, timestamp, and ancestor process IDs. Prompt and response contents are not forwarded to the extension.
