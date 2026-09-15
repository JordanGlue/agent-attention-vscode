# VS Code main-process memory repair

## Diagnosis (16 September 2026)

The local crash dump from 15 September at 20:10:42 identifies the crashing
process as `browser` (VS Code's main process), with exception `0xe0000008`
and `CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`.
This confirms heap exhaustion, but a minidump alone does not identify the
objects retaining memory. No user terminal contents or full dumps were exported.

The installed build is VS Code 1.108.0, commit
`94e8ae2b28cb5cc932b86e1070569c4463565c37`. Its main-process terminal channel
eagerly buffers process events that the window consumes through a different
connection. The unused buffer can therefore retain terminal output indefinitely.
The installed code matches the defect addressed by Microsoft's
[merged fix #323980](https://github.com/microsoft/vscode/pull/323980/files),
merged on 14 September 2026. This is the leading explanation for this crash;
an end-to-end soak test after restarting is still needed to confirm resolution.

At diagnosis time, Agent Attention's installed sources matched repository
commit `03881fd`. That version's terminal-data
subscription already expires after 2.5 seconds, and its unread entries are
deduplicated per terminal. The confirmed main-process defect exists independently
of Agent Attention. No extension or renderer changes are part of this repair.
Newer Agent Attention commits remove terminal-output forwarding separately;
this backport addresses the underlying VS Code main-process buffer.

## Local backport

`scripts/fix-vscode-terminal-memory.cjs` makes three exact substitutions in
the installed `resources/app/out/main.js`:

1. Add the upstream `unbufferedEvents` option to the older IPC implementation.
2. Return those events directly when a consumer subscribes.
3. Apply the upstream seven-event list only to the main-process `localPty`
   channel. Management events keep their existing buffering.

The script checks the exact application version, commit, and original SHA-256
before changing anything. It also validates the patched JavaScript syntax,
keeps a byte-for-byte backup, uses atomic replacement, and refuses unknown or
partially modified bundles. It does not change the application's integrity
metadata or suppress integrity warnings.

Run from the repository:

```powershell
node .\scripts\fix-vscode-terminal-memory.cjs --check
node .\scripts\test-vscode-terminal-memory.cjs
node .\scripts\fix-vscode-terminal-memory.cjs --install
```

**Fully exit all VS Code windows and reopen VS Code when ready.** Save work and
finish or arrange to resume running terminal tasks first. `Developer: Reload
Window` does not replace the main process and cannot activate this repair.
The installer deliberately leaves running VS Code processes alone.

Backup:

```text
~/.agent-attention/backups/vscode-main/1.108.0-94e8ae2b28cb5cc932b86e1070569c4463565c37/main.js.original
```

To roll back this repair, then fully exit and reopen VS Code:

```powershell
node .\scripts\fix-vscode-terminal-memory.cjs --remove
```

This is an unsupported local backport for one specific build. A VS Code update
will replace it. Prefer an official release containing the merged fix when
available; do not force this script onto a newer bundle. This repair is separate
from `sync-to-profile.ps1` and the Agent Attention renderer installer.

## Verification

Six tests execute the actual `Event.buffer` and `ProxyChannel.fromService`
functions extracted from the inspected application bundle in an isolated
harness, and exercise installation against temporary files:

- Original code retains and later replays 20,000 unconsumed terminal chunks.
- Patched code has zero subscriptions for unused process events; it delivers
  live output to multiple consumers and releases subscriptions when they leave.
- Early and live management events are preserved.
- Other IPC channels retain their existing buffering behavior.
- The full patched bundle parses and reverses byte-for-byte.
- Installation is idempotent, validates backups, rejects modified bundles,
  and rolls back correctly.

These tests validate the repair mechanism, not a long-running interactive
VS Code session. After a full restart, use `code --status` or VS Code's Process
Explorer to watch the main `code` process during normal agent terminal use.
It should no longer accumulate terminal-output history throughout the day.
