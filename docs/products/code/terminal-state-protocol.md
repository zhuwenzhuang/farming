# Terminal State Protocol

[简体中文](terminal-state-protocol.zh_cn.md)

Farming follows VS Code's persistent-terminal model:

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

Code and CRT use the same browser protocol implementation in `frontend/terminal-replay.js` for epoch ordering, contiguous-transition checks, replay targets, queue bounds, checkpoint validation, and retry policy. Each skin only adapts fetch and xterm/DOM operations; it does not implement a second replay state machine. Transport failures retry with bounded backoff. If the same checkpoint invariant fails repeatedly, recovery stops and reports a visible error instead of looping.

During a full replay, xterm is hidden until its write callback completes. A user returning after a long absence therefore sees the latest screen once instead of watching historical output paint from top to bottom.

## Input And Resize

Input is xterm's raw `onData` stream and is written directly to the PTY. Farming does not add input acknowledgements, deduplication, automatic replay, controller leases, or takeover UI. Several Code or CRT views may write to the same PTY; the server serializes writes in arrival order.

Resize is also shared. Browsers send their current dimensions and the server coalesces pending resize work so the latest received size wins. A browser applies a committed remote resize without sending it back again.

## Backpressure And Recovery

The PTY host publishes output only after the headless reducer has committed it. Reducer backlog may pause PTY reads. Slow browser WebSockets are isolated from one another; there is no browser renderer-debt protocol.

A compatible Farming server restart reattaches to the existing native PTY host. An incompatible host rotation serializes the screen before replacement. An unexpected PTY-host crash is reported as process loss and is never presented as a successful replay.

## VS Code Reference

The corresponding VS Code mechanisms are:

- `basePty.ts`: applies replay dimensions and waits for each tracked xterm write.
- `ptyService.ts`: owns the headless xterm serializer and persistent process replay.
- `terminalInstance.ts`: acknowledges live output after xterm parses it.
- `terminalResizeDebouncer.ts`: coalesces resize work.

Farming uses the same replay boundary while retaining its HTTP/WebSocket transport.
