# Farming 2 Acceptance Dogfood Plan

> Chinese version: [acceptance-dogfood-plan.zh_cn.md](./acceptance-dogfood-plan.zh_cn.md)

This document defines the acceptance strategy for Farming 2. The goal is not only to run fixed assertions, but to let senior-user-style agents exercise isolated Farming instances across features, realistic scenarios, duration, and stress level.

## Acceptance Questions

Each acceptance round should answer:

1. Can a user enter a remote workspace from desktop or mobile and supervise multiple agents?
2. Do Codex / Claude Code start, input, resume, history, usage, file, and terminal paths work with real CLI behavior?
3. Are long-running sessions, weak network, backend restart, agent exit, archive, and recovery paths understandable?
4. Does the UI reduce context switching instead of creating anxiety or confusion?

## Test Layers

| Layer | Default Frequency | Agent Source | Goal |
| --- | --- | --- | --- |
| Static / unit | every commit | no real agent | backend helpers, state normalization, config, wiring |
| Playwright fake e2e | major UI changes | fake Codex / fake Claude / real bash | deterministic browser paths |
| Agent dogfood fake | daily or major changes | test agents + fake coding agents | deep UI and edge-case exploration |
| Real Codex / Claude smoke | daily or before merge | real Linux CLI agents | real CLI, login state, session resume |
| Real long soak | manual or overnight | a few real agents | duration, reconnect, usage, mobile revisit |

Real Codex / Claude tests must be explicit, low-volume, and isolated. They must not reset quotas, rewrite login configuration, or launch broad real tasks.

## Linux-First Targets

The primary real acceptance environment is Linux or a Linux container. macOS is useful for docs, fake e2e, and CLI probing, but should not be the only release conclusion.

Recommended target classes:

| Target | Connection | Purpose | Required Checks |
| --- | --- | --- | --- |
| Primary Linux | `ssh user@primary-linux` | Node + Codex + Claude | real smoke, `/farming`, mobile, usage, history |
| Claude-ready Linux | `ssh user@claude-linux` | Node + Claude | Claude settings, slash, usage |
| Compatibility Linux | `ssh user@compat-linux` | older / thinner environment | CLI release, packaged runtime, fail-fast PTY |
| Linux container | local or remote | clean repeatable path | install, port, base path, token, cold start |

Record for every real target:

- `hostname`, `uname -srm`;
- `node --version`, `npm --version`;
- `command -v codex`, `codex --version`;
- `command -v claude`, `claude --version`;
- Farming start command, port, base path, token state.

## macOS Desktop Human-Story Gate

Electron changes also require a real macOS desktop round. The operator must use visible controls,
keyboard input, dialogs, and normal window lifecycle just as a user would. Do not pass a story by
calling backend APIs, editing persisted state, or manipulating the renderer through developer
tools. Diagnostic logs may explain a failure only after the visible path has reproduced it.

Run at least these stories, with the local Mac as the default backend and a reusable SSH target for
the remote stories:

| # | Human story | Pass evidence |
| --- | --- | --- |
| 1 | Launch from a source checkout or packaged app | A useful local workspace appears without an SSH decision or white screen. |
| 2 | Open the built-in Connections surface | This Mac is ready by default; remote management is optional. |
| 3 | Add an SSH remote with only a name and OpenSSH Host | No port, listener, token, platform, or architecture fields are required. |
| 4 | Submit missing or invalid SSH input, then edit or remove it | Validation and recovery remain visible and actionable. |
| 5 | Cancel a connection during discovery or download | The exact attempt stops and the row returns to a stable disconnected state. |
| 6 | Install a missing matching Server | Download progress is visible, checksum is verified, and failure is bounded. |
| 7 | Connect to a legacy-glibc Linux target | A discovered compatible runtime starts without modifying system or VS Code files. |
| 8 | Inspect a connected remote | Version, platform/architecture, runtime, and Farming Home are visible. |
| 9 | Switch remote → local → remote | Window identity and data follow only the latest selection; a live Server is reused. |
| 10 | Quit and relaunch the Mac app | Local starts usable and saved remotes remain available without a modal decision. |
| 11 | Create a Bash Agent through the workspace chooser | The chosen workspace becomes the active project and terminal. |
| 12 | Type a command in the terminal | Keystrokes, Enter, output, cwd, and exit status remain understandable. |
| 13 | Expand Files and open a text file | The authoritative tree appears and the editor opens without leaving the app. |
| 14 | Open History, search, clear, and return | Loading, no-match, results, and navigation are bounded and reversible. |
| 15 | Archive the disposable test Agent | It leaves the live list; only genuinely resumable provider sessions appear as resumable history. |
| 16 | Change appearance in Settings and restore System | The setting applies immediately and the previous navigation remains recoverable. |
| 17 | Search projects and Agents globally | Results appear while typing and selecting an Agent exits Search normally. |
| 18 | Enter and leave Focus mode | Electron toggles fullscreen directly and never shows browser-install guidance. |
| 19 | Collapse and expand the sidebar | Essential navigation remains reachable and the previous surface is preserved. |
| 20 | Open and close Share current page | The QR/link popover is readable, dismissible, and does not replace the current surface. |

For each failure, record the last visible state and the owning lifecycle state before changing code.
Fix the state-transition contract when ownership, cancellation, reordering, or recovery is involved;
do not accept a timing delay as the product fix.

## Isolation

Each dogfood story should use:

- isolated `HOME`;
- isolated `FARMING_CONFIG_DIR`;
- isolated workspace;
- isolated port;
- isolated server log;
- isolated browser context;
- an artifact directory for screenshots, traces, console logs, transcripts, and reports.

The Playwright server must replace any inherited `FARMING_CONFIG_DIR` with its
own temporary config root. This remains mandatory when tests are launched from
inside a live Farming Agent, so the test backend cannot reconcile or stop the
parent server's ACP processes.

Recommended layout:

```text
.tmp/dogfood/runs/<run-id>/
├── <story-id>/
│   ├── home/
│   ├── workspace/
│   ├── server.log
│   ├── browser-trace.zip
│   ├── screenshots/
│   ├── agent-transcript.md
│   └── report.json
└── summary.md
```

## Feature Areas

### 1. Startup And Connection

Cover first screen, token URL, WebSocket, heartbeat state, Main Agent / New Agent startup, workspace defaults, invalid workspace handling, base path, port conflicts, and restart.

### 2. Agent Launch Profiles

Cover executable discovery, Codex model / reasoning / speed, Claude settings summary, launch permissions, and launch profile merging. An invalid empty workspace must remain immediately editable without entering the duplicate-start lock. A new Codex Chat Agent must publish its first-task fallback title while the first Turn is still active; a later explicit Provider title may replace it. Running permission changes should restart with the selected flags, resume when a stable provider session id exists, start fresh when it does not, and preserve the selected agent plus Chat / Terminal view throughout the replacement.

### 3. Composer And Input

Cover plain text, Enter, Shift+Enter, Ctrl/Cmd+Enter, busy-agent follow-up queue, steer, slash commands, skill mentions, attachments, paste image, and keyboard shortcut boundaries. Every open Composer menu must close on Escape and restore focus to the Composer input, including when the menu trigger retains focus.

Do not treat the bottom composer as the only input path. Real-agent smoke must also focus the embedded terminal itself and type directly into the CLI prompt, because Qoder / Claude Code / OpenCode users often work that way.

Terminal input cases must include:

- ASCII direct terminal typing and Enter submission;
- non-ASCII committed text such as Chinese;
- IME composition behavior, using the same hidden-textarea / composition event model as xterm.js and VS Code;
- paste / committed text that contains mixed Chinese and ASCII;
- verification that normal ASCII input is not duplicated by IME fallbacks.

### 4. Terminal And Session Output

Cover native `node-pty`, packaged `node-pty`, canvas rendering, URL hit-test, `path:line` hit-test, scroll stability, jump-to-latest, focus, copy cwd, multi-terminal switching, and agent exit.

For terminal IME bugs, prefer the xterm.js / VS Code principle: let browser composition events complete in the xterm helper textarea, then send only the committed text to the PTY. Do not invent a parallel input method, and do not rely only on synthetic paste tests; capture screenshots of the real CLI prompt before and after Enter.

### 5. Project / Sidebar / History

Cover project grouping, Files section, active agent, pinned / unread sessions, rename, archive, archived runs, chats, duplicate titles, and continue behavior. Arrow keys from an independent pagination or row action must not enter Agent navigation. Simultaneous Agent and session pagination controls must expose distinct accessible names with their hidden counts. Escape from the focused History search field must return to the workspace just like the global Search surface. Closing Settings or an Extension detail must restore focus to its opening control. Within an expanded Files section, Changes, Untracked, History, and root file-tree rows must share the same text size, line height, row rhythm, and root-level chevron / label alignment; counts and review actions may retain semantic emphasis.

### 6. Files / Editor

Cover Files expansion, lazy loading, search, `path:line`, text / image / binary / large file handling, edit, save, external changes, dirty close, git blame, and context menus.

### 7. Usage And System Status

Cover provider-reported local usage summaries, the compact 24-hour heatmap with whole-hour buckets and axis labels, the 52-week daily token heatmap with a visually distinct recent seven days, compact token totals, and exact token readouts on cell hover. Clicking either chart must open the matching larger heatmap; the 52-week detail defaults to today and shows today's compact token total prominently, then temporarily switches the prominent value to any hovered or keyboard-focused day while preserving the exact readout below. Its lower chart must lazily switch to that day's zero-based 24-hour histogram, with every hourly bar aggregating exact provider-session attribution by Agent type; rapid day changes must cancel stale requests, and leaving a transient selection must return to today. Clip the whole Token King day cell into a crown silhouette and every non-king day above one billion tokens into a flame silhouette, preserving each cell's heat color instead of embedding an icon inside a square. The detail analysis must expose peak activity plus bounded comparisons derived from the same local token data, including recent-versus-previous seven days and cache share when daily breakdowns exist. Also cover token rate, CPU, memory, collapsed state, no-data state, and read failures. An expanded Usage panel must collapse on Escape while focus is inside it. Providers without usable token telemetry and quota fields without real quota data must be omitted instead of rendered as unavailable placeholders. Never run reset actions.

For Codex and Claude, verify the first TypeScript Worker scan creates `usage-history-v2.sqlite3`, an unchanged refresh reads no JSONL content, an appended session reads only bytes after the stored offset, and a server restart reuses the same cache. Exercise a large non-usage tool-output line to prove the token-only adapter remains memory-bounded. Confirm long-term Codex rows scale with active session-hours rather than token events; copied forks and interleaved cumulative counters do not inflate totals; a bounded cold rebuild withholds incomplete Codex totals while the background Worker continues; and an incompatible cache recreates the database and WAL/SHM sidecars. Totals and hourly/session attribution must remain identical before and after a warm-cache refresh. Verify the same Node-only path on macOS and Linux and confirm no Python executable is probed or launched.

### 8. Mobile

Cover first screen, default collapsed sidebar, top bar, more menu, History, Search, New Agent, terminal, Files, keyboard behavior, refresh, and reconnect.

## Personas

| Persona | Main Goal |
| --- | --- |
| Remote Operator | treat Farming as a remote workbench |
| Codex Power User | exercise real Codex deeply |
| Claude Power User | exercise real Claude Code deeply |
| History Archivist | manage many sessions and archived runs |
| Terminal Heavy User | read output for a long time and intervene |
| Files Editor User | inspect and lightly edit without leaving Farming |
| Mobile Supervisor | supervise from a phone |
| Failure Hunter | break and recover edge paths |

## Report Format

Each story writes a `report.json`:

```json
{
  "storyId": "real-codex-smoke",
  "persona": "Codex Power User",
  "agentMode": "real-codex",
  "status": "pass",
  "coverage": ["start", "send prompt", "history", "usage"],
  "findings": [
    {
      "severity": "P2",
      "title": "Provider without token telemetry is still visible",
      "steps": ["Start real Codex", "Send one-line prompt", "Open usage row"],
      "expected": "The provider and unavailable quota placeholders are omitted",
      "actual": "The provider is rendered with unavailable and zero-value rows",
      "evidence": ["screenshots/usage.png", "server.log"]
    }
  ],
  "artifacts": ["browser-trace.zip", "agent-transcript.md"],
  "notes": "Subjective UX notes from a senior user"
}
```

## Pass Criteria

- Zero P0 / P1 issues.
- Real Codex and real Claude smoke either complete startup or return clear actionable failures.
- Mobile core path is not blocked.
- Archive / History concepts do not blur live agents with archived runs.
- Every P2+ issue has screenshot, trace, or log evidence.

## PR Visual Comparison

UI pull requests run a Linux Chromium comparison against the exact immutable base and head SHAs. After the initial rollout, each revision uses its own checked-in visual capture contract and fixtures on the same runner and browser executable; only a base revision without that contract falls back to the head contract. A head-only scene is reported as added, while removing a base scene fails the capture contract. The workflow uploads an artifact containing `base/`, `head/`, `diff/`, `index.html`, `manifest.json`, logs, and a Markdown job summary.

The capture contract covers a small information-rich matrix: Agent and Project row hover controls, wide and narrow queued follow-ups, the Changes hierarchy with its diff open, and Plugins in dark appearance. It uses anonymous workspaces, fake coding agents, fixed viewports, reduced motion, hidden carets and volatile age labels, plus two consecutive captures of every scene.

Pixel differences are review evidence and do not fail the pull request because intentional UI work is expected to change pixels. The job fails only when capture fails twice, a base scene is deleted, required images are missing, dimensions differ, or consecutive captures differ by more than 0.1%. The exact SHA pair is the baseline; there is no mutable screenshot cache and no manual baseline-update operation. Re-running the same SHA pair is therefore idempotent.

Local checks:

```bash
npm run test:e2e:visual:self-test
FARMING_VISUAL_OUTPUT_DIR=.tmp/visual-capture npm run test:e2e:visual:capture
```

## Entry Points

```bash
npm run typecheck
npm test
npm run test:e2e:playwright -- tests/e2e/display-flows.spec.ts --project=chromium
```

Real-agent dogfood should be run manually or through an explicit runner:

```bash
FARMING_DOGFOOD_REAL_AGENTS=1 node scripts/dogfood/run-swarm.js \
  --target user@primary-linux \
  --stories real-codex-smoke-linux,real-claude-smoke-linux
```
