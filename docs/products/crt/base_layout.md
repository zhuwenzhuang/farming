# Farming CRT Layout

> Chinese version: [base_layout.zh_cn.md](./base_layout.zh_cn.md)

Farming CRT is a desktop, keyboard-first control room over the same backend
Agents and Sessions as Farming Code. Farming Code remains the supported mobile
surface.

## Regions

CRT has three persistent regions:

- **Top bar**: compact system and attention status;
- **Agent area**: live Agent summaries and opened Sessions;
- **Sidebar**: global actions and Main Agent access.

Only live or starting work occupies the Agent area. Stopped, dead, and archived
records belong in History. When no project Agent is live, CRT shows a clear New
Agent entry without hiding or restarting Main Agent.

## Attention And Layout

The dashboard helps the user find work that needs attention. The backend owns
Agent lifecycle and activity facts; CRT may use those facts for ordering and
emphasis, but must not invent completion, zombie, or health state.

Cards keep stable readable geometry. More important work may receive more area,
but rapid metadata updates must not cause distracting reorder or overlap.
Excess preview content clips or scrolls instead of shrinking text below a
readable size.

## Sessions

Opened Chat and Terminal Sessions use the same authoritative protocols as
Farming Code. CRT does not implement another ACP reducer, Terminal replay state
machine, or Agent lifecycle.

Terminal is the primary focus surface. Structured Chat preserves ordered user,
process, and result information without reconstructing ACP entries. Session
headers use the same Agent-title priority as Farming Code.

## Keyboard And Dialogs

Primary actions are keyboard reachable and remain visible as concise hints.
Focus, Escape, confirmation, cancellation, and return-to-opener behavior must be
consistent across dashboard, Search, History, Settings, New Agent, and opened
Sessions.

Dialogs use compact headers, visible focus, keyboard-confirmable actions, and
minimal nesting.

## Visual Contract

CRT uses a restrained monochrome control-room style:

- compact information density;
- low visual noise and stable alignment;
- readable monospace content;
- subtle scan effects that never reduce legibility;
- no permanent controls for unimplemented actions;
- no animation that implies a backend state not actually reported.

## Data And Failure Boundaries

Current capability, inventory, usage, and health views perform fresh
authoritative reads with visible loading and failure. Existing complete data may
remain visible during a refresh, but stale data cannot be presented as a new
successful read.

All same-origin routing follows the Server-provided base path. Missing routing,
protocol incompatibility, renderer failure, and Session recovery failure remain
explicit; CRT does not silently switch to an untested fallback.

## Acceptance Criteria

Verification must cover keyboard-only operation, empty and dense dashboards,
Agent ordering stability, Code/CRT switching, Chat and Terminal continuity,
Search, History, Settings, capability failure, renderer failure, reconnect,
restart, and large live-Agent inventories on desktop viewports.
