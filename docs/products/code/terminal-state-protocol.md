# Terminal State Protocol

[简体中文](terminal-state-protocol.zh_cn.md)

Farming owns a checkpointed persistent-terminal protocol:

1. A PTY produces an ordered byte stream.
2. A headless xterm instance in the PTY host reduces that stream and can serialize the current screen.
3. A browser attach or reconnect receives one replay containing the serialized screen and its exact dimensions.
4. Live output continues only after xterm's replay write callback completes.

## Clickable Output

Terminal links follow VS Code's layered detector model. OSC 8 hyperlinks remain owned by xterm. Plain HTTP(S) output uses Monaco's link grammar with the same 2,048-character bound as xterm's web-link provider. The local-file layer is adapted from VS Code's terminal link parser and accepts POSIX, Windows drive, UNC, and `file://` paths plus its compiler and diagnostic suffix families, including `path:line[:column[-endColumn]]`, `path:line.column`, quoted paths, parentheses/brackets, non-breaking spaces, and multi-line ranges. Python, C/C++, Clang, and shell-prompt fallbacks cover paths containing spaces. Git diff prefixes are removed only in recognized diff headers.

Detection runs only across xterm logical lines joined by `isWrapped`; explicit line breaks are never guessed to be URL continuation. A separate VS Code-style multiline layer handles ripgrep/ESLint numeric result lines by binding the first preceding non-numeric logical line, and Git hunk headers by binding the preceding `+++ b/path`. Lexical recognition does not authorize an open: every file candidate is resolved against the captured Agent workspace before it becomes active, and unresolved candidates remain plain text. The fallback word layer splits with VS Code-compatible separators, caps words at 100 characters, and opens Project Files search only on modifier-click. URL activation remains modifier-protected; validated file targets open directly. Lines longer than 2,000 characters, paths longer than 1,024 characters, more than ten filesystem candidates per line, and multiline scans beyond 100 logical lines are rejected or bounded.

## Replay State

A replay carries:

```text
(runtimeEpoch, stateRevision, outputSeq, screen, cols, rows)
```

The epoch identifies one PTY lifetime. The revision and output sequence let Farming discard live messages already covered by the replay and detect a missing message. They are transport cursors, not a second business state machine.

`GET /api/agents/:agentId/session-view` returns the current replay. It is read when a browser first attaches, reconnects, resumes from a hidden page, or detects a stream gap. It is not polled.

Code and CRT use the same browser protocol implementation in `frontend/terminal-replay.js` for epoch ordering, contiguous-transition checks, replay targets, queue bounds, checkpoint validation, and retry policy. Each skin only adapts fetch and xterm operations; it does not implement a second replay state machine. Transport failures retry with bounded backoff. If the same checkpoint invariant fails repeatedly, recovery stops and reports a visible error instead of looping.

During a full replay, xterm is hidden until its write callback completes. A user returning after a long absence therefore sees the latest screen once instead of watching historical output paint from top to bottom.

If reconnect, reattach, page resume, or a newer bootstrap cut supersedes a checkpoint that is already inside xterm's ordered write queue, invalidation releases the old install latch immediately. The stale write may drain in queue order, but its completion remains sequence-fenced and cannot commit; the replacement checkpoint queues behind it and remains able to reach a visible authoritative cut.

Farming Code keeps that atomic paint boundary visible to the user with one centered recovery status owned by the terminal session pool. It distinguishes checkpoint request, screen installation, and retry backoff, and shows elapsed wait time plus the current attempt. The status has a 500 ms presentation grace: a normal attach that commits its authoritative cut inside that window shows only the final terminal frame, while a slower recovery still exposes its live phase. A parked xterm host is hidden before it returns to the live mount, so its previous buffer cannot flash during that grace period. Once shown, the status disappears only after the authoritative cut has committed to xterm; renderer or invariant failures continue to use the terminal's explicit failure card.

## Browser Attachment Ownership

The terminal session pool owns one `SessionRecord` per Agent. A browser attachment is identified only by the Agent id and its mount element. Changing either identity, unmounting the pane, reconnecting the transport, resuming a hidden page, or detecting a replay gap may enter recovery. Ordinary React renders may not.

The React boundary acquires an attachment lease instead of calling detach directly from effect cleanup. Its state model is `detached -> attached -> release-pending -> detached`. Cleanup only enters `release-pending`; a same-Agent, same-mount reacquire in the same commit cancels that release and stays `attached` without advancing the generation. A different Agent or mount releases the old owner before attaching the new one. A stale lease cannot release a newer owner, and a pending release with no reacquire commits on the next microtask. The pool also treats a duplicate attach for the current Agent and mount as idempotent, so bypassing the React coordinator still cannot accidentally start checkpoint recovery.

Event callbacks, input enablement, cursor suppression, and newer bootstrap data are live options. They update the existing `SessionRecord` in place and cannot detach its host, advance its attachment generation, or publish a `requesting` recovery state. Browser controllers likewise expose stable command functions so their collection updates do not churn downstream callback identities. The responsive browser test repeatedly changes between desktop and phone geometry and requires the same attachment generation with no recovery overlay throughout.

Live WebSocket output uses a leading-edge, frame-bounded batch: the first transition after an idle period is sent immediately for responsive typing, while sustained output is coalesced without dropping its individual transition indexes. The browser still validates and commits every index separately, but gives each contiguous output / clear run to xterm in one write. Resize is an ordered batch boundary: after committing it, the browser holds its following redraw until 50 ms of output quiet, with a 300 ms maximum, and then paints that burst once. Normal non-resize output keeps the low-latency path.

## Supported Browser Renderer

Code and CRT use xterm.js WebGL as the single supported product renderer. The renderer lifecycle is deliberately small: `pending -> webgl -> failed`. WebGL initialization failure or an unrecoverable context loss produces a visible terminal failure; retry reconstructs the same WebGL path, and a live terminal never silently changes to the DOM renderer.

Continuous browser-test capacity is finite, so the architecture must not accumulate alternate renderer paths that cannot be held to the same acceptance bar. A path that is not exercised continuously is not a reliable fallback. Tests and product code therefore target this one renderer state machine instead of maintaining fallback-specific behavior. Ghostty remains an explicit developer diagnostic mode and is outside the supported product renderer state machine.

## Input And Resize

Every non-main coding Terminal receives the shared Farming bootstrap and a runtime-scoped title token. After understanding the task, the Agent uses `farming title` to publish a concise adaptive title through the authenticated control API. Codex, Claude Code, OpenCode, Qoder, and Qwen use the same path; Farming does not parse terminal prose to infer the title. Runtime replacement rotates the token and rejects late writes from the old PTY process. User renames remain authoritative, and title failure never blocks terminal input.

Input is xterm's raw `onData` stream and is written directly to the PTY. Farming does not add input acknowledgements, deduplication, automatic replay, controller leases, or takeover UI. Several Code or CRT views may write to the same PTY; the server serializes writes in arrival order. Selecting an existing Agent is a local view change, not an excuse to refresh the full state document. The focused terminal receives live output before its delayed lightweight activity projection, and its preview omits the already-authoritative screen snapshot.

The release gate `npm run test:pre-release:terminal-input` uses two deterministic local Bash sessions. It switches between existing Agents, types and deletes through xterm, rejects a full `state` frame after focus, requires focused previews to stay below 8 KiB, and enforces a loopback key-to-`session-output` p95 of at most 250 ms. This is a regression bound for the local product path, not a claim about arbitrary remote network latency; the release checklist separately requires a human-like remote dogfood smoke.

Resize is also shared. Every browser-layout-driven geometry change trailing-coalesces as one complete `cols + rows` update, preventing a sustained window drag from repeatedly reflowing xterm and retriggering a full-screen TUI redraw. This rule does not branch on output length or normal/alternate buffer state. Explicit attach and a layout change observed during recovery bypass that delay. The server then keeps at most one resize in flight and the latest pending size. A browser applies a committed remote resize without sending it back again. In particular, completing an ordinary checkpoint recovery does not unconditionally reclaim that browser's previously requested geometry: doing so lets different-sized viewers alternate resize, full-screen redraw, backpressure disconnect, and recovery forever.

## Backpressure And Recovery

The PTY host publishes output only after the headless reducer has committed it. Reducer backlog may pause PTY reads. Slow browser WebSockets are isolated from one another; there is no browser renderer-debt protocol.

The explicit remote chaos smoke is run with `FARMING_REMOTE_URL=... FARMING_REMOTE_TOKEN=... npm run test:remote-terminal:chaos`. It creates and later removes two isolated shell Agents, drives the same redraw-heavy terminal from independent desktop and mobile browser contexts without waiting for readiness between actions, and injects latency, offline recovery, viewport churn, reload, switching, and input. Its acceptance boundary is user-visible and bounded: no unexplained blank may persist, recovery must settle, redraw state must stop advancing, and post-recovery input from each viewer must arrive exactly once. The run keeps a deterministic action trace and failure screenshots under `.tmp/remote-terminal-chaos/`.

A compatible Farming server restart reattaches to the existing native PTY host. An incompatible host rotation serializes the screen before replacement. An unexpected PTY-host crash is reported as process loss and is never presented as a successful replay.
