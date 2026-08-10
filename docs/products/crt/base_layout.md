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
readable size. Chat previews keep the newest messages visible when the card
cannot display the complete bounded preview.

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

Dashboard Chat previews use the same external-media transcript delivery as
Farming Code, use bounded concurrent reads, and retry transient read failures
for a limited time. A failed preview remains explicit without turning one
temporary transport interruption into a permanent card state.

All same-origin routing follows the Server-provided base path. Missing routing,
protocol incompatibility, renderer failure, and Session recovery failure remain
explicit; CRT does not silently switch to an untested fallback.

## Billing Controller

CRT Billing is a vertical owner (`frontend/skins/crt/billing-controller.ts`)
that exclusively holds all billing mutable state, fetching, scheduling,
animation, and rendering. The app shell wires narrow lifecycle and navigation
ports; it does not hold duplicate billing state.

State model:

- A monotonic **generation** counter fences every async operation, timer, and
  animation frame. Any settle or callback whose captured generation differs from
  the current value is discarded silently.
- **Summary** (15 s poll) and **live-day detail** (5 s poll) each own an
  AbortController, a bounded deadline, and a request sequence. A deadline abort
  forcibly releases the owner so the next scheduled poll can proceed even if the
  fetch ignores AbortSignal.
- **Top-bar token rate** (60 s poll) owns an AbortController and a bounded
  deadline. It uses a controller-presence guard (skip if already in-flight)
  instead of a request sequence.
- Each fetch+JSON operation owns an exact **operation token**. When a deadline
  fires and the generation still matches, it invalidates the token BEFORE
  aborting and releasing the owner. Every success, cache write, render,
  day-followup start, error, and finally cleanup requires the current token, so
  a late fetch settle or late `response.json()` completion after a timeout,
  leave, suspend, or dispose is a no-op even though releasing the owner does not
  bump the request sequence.
- Each deadline is owned per-operation: a superseded request's finally block
  cannot clear a newer request's armed deadline.
- One-shot scroll, draw, and navigation frames are registered through a tracked
  helper that cancels them on leave, suspend, and dispose and additionally
  discards them by generation; they are not self-rescheduling. The scope canvas
  frame is cancelled explicitly on those same transitions.
- **Day detail cache** is pruned to the authoritative date set on every
  successful summary response. An authoritative empty summary prunes all cached
  entries.

Failure and recovery:

- Day detail retries only network errors, HTTP 408, 429, and 5xx, up to four
  retries (five total attempts) with exponential backoff. Validation errors and
  ordinary 4xx responses are terminal for that request. A `200` day-detail
  response that temporarily omits hourly bins after the controller already holds
  hourly bins for that day is treated as a proven transient regression and keeps
  the same bounded retry path instead of clearing the existing hourly detail.
- Switching from Days to Live mode aborts and fences any pending Days summary
  and day-detail requests, then always starts a Live summary load. A late Days
  response cannot render into the Live view.
- Page suspend (visibilitychange hidden, pagehide) aborts all in-flight
  requests and clears all timers. Resume restarts schedules and performs a
  fresh load if the billing view is active.
- Leaving the billing view (Escape, navigation) stops summary/day polling,
  aborts in-flight billing requests, and cancels animations and tracked frames.
  The global 60 s top-bar token rate poll continues independently.
- Page/controller dispose bumps the generation, aborts all requests including
  topbar, and cancels all animations and tracked frames. A stale in-flight
  response that settles after dispose is discarded by the generation fence.

The backend usage API (`GET /api/usage`, `GET /api/usage/day`) remains the
authoritative source. The controller never reconstructs usage truth from
terminal text or stale UI data.

## Acceptance Criteria

Verification must cover keyboard-only operation, empty and dense dashboards,
Agent ordering stability, Code/CRT switching, Chat and Terminal continuity,
Search, History, Settings, capability failure, renderer failure, reconnect,
restart, and large live-Agent inventories on desktop viewports.
