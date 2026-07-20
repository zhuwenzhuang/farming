# Terminal State Protocol

[简体中文](terminal-state-protocol.zh_cn.md)

Farming owns a checkpointed persistent-terminal protocol:

1. A PTY produces an ordered byte stream.
2. A headless xterm instance in the PTY host reduces that stream and can serialize the current screen.
3. A browser attach or reconnect receives one replay containing the serialized screen and its exact dimensions.
4. Live output continues only after xterm's replay write callback completes.

## Replay State

A replay carries:

```text
(runtimeEpoch, stateRevision, outputSeq, screen, cols, rows)
```

The epoch identifies one PTY lifetime. The revision and output sequence let Farming discard live messages already covered by the replay and detect a missing message. They are transport cursors, not a second business state machine.

`GET /api/agents/:agentId/session-view` returns the current replay. It is read when a browser first attaches, reconnects, resumes from a hidden page, or detects a stream gap. It is not polled.

Code and CRT use the same browser protocol implementation in `frontend/terminal-replay.js` for epoch ordering, contiguous-transition checks, replay targets, queue bounds, checkpoint validation, and retry policy. Each skin only adapts fetch and xterm operations; it does not implement a second replay state machine. Transport failures retry with bounded backoff. If the same checkpoint invariant fails repeatedly, recovery stops and reports a visible error instead of looping.

During a full replay, xterm is hidden until its write callback completes. A user returning after a long absence therefore sees the latest screen once instead of watching historical output paint from top to bottom.

Live WebSocket output uses a leading-edge, frame-bounded batch: the first transition after an idle period is sent immediately for responsive typing, while sustained output is coalesced without dropping its individual transition indexes. The browser still validates and commits every index separately, but gives each contiguous output / clear run to xterm in one write. Resize is an ordered batch boundary: after committing it, the browser holds its following redraw until 50 ms of output quiet, with a 300 ms maximum, and then paints that burst once. Normal non-resize output keeps the low-latency path.

## Supported Browser Renderer

Code and CRT use xterm.js WebGL as the single supported product renderer. The renderer lifecycle is deliberately small: `pending -> webgl -> failed`. WebGL initialization failure or an unrecoverable context loss produces a visible terminal failure; retry reconstructs the same WebGL path, and a live terminal never silently changes to the DOM renderer.

Continuous browser-test capacity is finite, so the architecture must not accumulate alternate renderer paths that cannot be held to the same acceptance bar. A path that is not exercised continuously is not a reliable fallback. Tests and product code therefore target this one renderer state machine instead of maintaining fallback-specific behavior. Ghostty remains an explicit developer diagnostic mode and is outside the supported product renderer state machine.

## Input And Resize

Input is xterm's raw `onData` stream and is written directly to the PTY. Farming does not add input acknowledgements, deduplication, automatic replay, controller leases, or takeover UI. Several Code or CRT views may write to the same PTY; the server serializes writes in arrival order. Selecting an existing Agent is a local view change, not an excuse to refresh the full state document. The focused terminal receives live output before its delayed lightweight activity projection, and its preview omits the already-authoritative screen snapshot.

The release gate `npm run test:pre-release:terminal-input` uses two deterministic local Bash sessions. It switches between existing Agents, types and deletes through xterm, rejects a full `state` frame after focus, requires focused previews to stay below 8 KiB, and enforces a loopback key-to-`session-output` p95 of at most 250 ms. This is a regression bound for the local product path, not a claim about arbitrary remote network latency; the release checklist separately requires a human-like remote dogfood smoke.

Resize is also shared. Every browser-layout-driven geometry change trailing-coalesces as one complete `cols + rows` update, preventing a sustained window drag from repeatedly reflowing xterm and retriggering a full-screen TUI redraw. This rule does not branch on output length or normal/alternate buffer state. Explicit attach and recovery fits bypass that delay. The server then keeps at most one resize in flight and the latest pending size. A browser applies a committed remote resize without sending it back again.

## Backpressure And Recovery

The PTY host publishes output only after the headless reducer has committed it. Reducer backlog may pause PTY reads. Slow browser WebSockets are isolated from one another; there is no browser renderer-debt protocol.

A compatible Farming server restart reattaches to the existing native PTY host. An incompatible host rotation serializes the screen before replacement. An unexpected PTY-host crash is reported as process loss and is never presented as a successful replay.
