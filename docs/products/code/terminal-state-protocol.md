# Terminal State Protocol

[简体中文](terminal-state-protocol.zh_cn.md)

Farming Terminal follows the persistent-terminal model used by VS Code: a PTY process produces an ordered byte stream, a headless terminal reducer owns the authoritative display state, and browser renderers are replaceable views of that state. Farming adds an explicit controller lease because the same terminal may be open in several browser windows or skins.

## Authoritative State

For one live PTY runtime, display and control are two independent state machines.
The authoritative display state is:

```text
(runtimeEpoch, stateRevision, outputSeq, screen, cols, rows)
```

- `runtimeEpoch` identifies one concrete PTY process lifetime.
- `outputSeq` advances once for each committed PTY output transition.
- `stateRevision` advances for every committed display transition. Output advances both `outputSeq` and `stateRevision`; clear and resize advance only `stateRevision`.
- `screen`, `cols`, and `rows` come from the PTY host's headless xterm reducer.

The controller lease is separate:

```text
(claimedRuntimeEpoch, leaseId, fence, expiresAt, rendererReadyFence)
```

`leaseId` and `fence` invalidate input, resize, clear, and output acknowledgements from an older browser controller. `claimedRuntimeEpoch` is immutable for the lease: a PTY epoch change invalidates the lease instead of silently migrating it. Controller replies never carry or advance display revisions, output sequences, dimensions, or checkpoints.

The PTY host publishes an output transition only after the reducer has committed that exact transition. A checkpoint is valid only when its epoch, sequences, screen, and dimensions describe the same committed cut.

## `/session-view`

`GET /api/agents/:agentId/session-view` returns the current authoritative view of a session. It is a checkpoint API, not an event log and not a second terminal emulator.

A browser uses it when it first attaches, reconnects, returns from suspension, observes a sequence gap or queue overflow, or changes runtime epoch. It installs the checkpoint once, discards covered queued transitions, then accepts only contiguous later transitions from the same epoch. It does not poll `/session-view`; normal resize and clear do not fetch a checkpoint.

This is why resuming after a long absence does not replay old output second by second. The browser jumps to one proved current screen and continues from its exact sequence boundary.

Normal live display changes share one ordered transition log:

| Transition | `stateRevision` | `outputSeq` | Payload |
| --- | --- | --- | --- |
| output | +1 | +1 | PTY bytes |
| resize | +1 | unchanged | `cols`, `rows` |
| clear | +1 | unchanged | clear operation |

The active renderer resizes its local xterm immediately and then submits the fenced PTY resize, matching VS Code's live-resize order. Other viewers apply the committed resize transition. A rejection recovers from an authoritative checkpoint; it never turns a resize timer into a display commit.

## Input And Multiple Viewers

Terminal input remains a raw PTY byte stream, as in VS Code. Farming does not add per-keystroke or per-input ACK, deduplication, or automatic replay.

The browser uses xterm's `onData` event as the single input source, including IME commits and paste. There is no timing-based textarea fallback that can duplicate text while a checkpoint or takeover is pending. Input produced while a controller claim or renderer commit is pending is retained in a bounded, epoch-bound queue and is sent once only after the controller is ready; an epoch change discards it visibly.

Only one visible attachment owns the controller lease at a time. Code and CRT observers remain read-only until the user presses **Take control**. Input, resize, clear, and renderer output ACKs carry the lease id, fence, and expected runtime epoch; stale operations are rejected.

An ambiguous transport disconnect does not automatically resend terminal input because replaying an uncertain command can execute it twice. Display recovery is checkpointed; input delivery is direct and fail-visible.

## Output Flow Control

The PTY host separately tracks:

- bytes waiting for the authoritative reducer; and
- characters delivered to the owning browser renderer but not yet acknowledged.

The browser acknowledges output only after xterm's write callback. The host pauses the PTY above the high watermark and resumes below the low watermark. A controller takeover clears the previous owner's renderer debt, so one stalled or closed window cannot keep the shared PTY paused.

## Recovery Boundaries

| Event | Process identity | Display recovery |
| --- | --- | --- |
| Browser reconnect, reload, or hidden-page resume | Same PTY, same epoch | Install `/session-view`, then contiguous live output |
| Farming server restart with the compatible PTY host still alive | Same PTY, same epoch | Reattach to the host and checkpoint |
| Controlled incompatible PTY host rotation during an upgrade | New PTY, new epoch | Freeze mutations, drain reducer work, prepare a token-bound serialized checkpoint, stop the old host, start a new process, restore the serialized screen, and show `History restored` |
| Unexpected PTY host crash | Old PTY is lost | Report terminal loss; do not claim that the old process or uncommitted input survived |

Controlled rotation is transactional. New mutations are blocked during preparation, sessions that exit before the cut are excluded, serialization failure resumes the old host and aborts rotation, and shutdown requires the matching preparation token.

## Safety And Liveness

Safety obligations:

- a browser never combines transitions from different epochs;
- a duplicate or stale transition never mutates the display;
- a gap never advances the display without a checkpoint;
- every checkpoint corresponds to one reducer-committed cut;
- resize and clear occupy the same ordered revision space as output;
- an old controller cannot input, resize, clear, or acknowledge output after takeover;
- a controller lease never crosses a PTY runtime epoch;
- failed controlled rotation never deliberately destroys uncheckpointed live PTYs.

Liveness obligations:

- transport failures retry checkpoints with bounded backoff, while four identical responses that violate the same checkpoint invariant stop automatic retry and fail visibly until an explicit reconnect;
- reducer or renderer backlog pauses rather than drops PTY output;
- a healthy controller takeover releases stale renderer backpressure;
- every controlled rotation either commits to a new host or resumes the old host;
- unexpected process loss terminates visibly instead of leaving a permanently pending state.

Timers do not prove display correctness. The lease expiry scheduler and browser renew watchdog exist only for controller liveness; request deadlines only fail requests; batching and layout timers only affect performance. No timer creates a revision, accepts a gap, completes replay, or confirms renderer output.

## VS Code Reference

The terminology and recovery split follow VS Code's persistent terminal implementation:

- [`basePty.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/basePty.ts): process replay, `OverrideDimensions`, tracked renderer commits, and replay completion.
- [`localPty.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/electron-browser/localPty.ts): blocks input, resize, and output ACK while replay is active.
- [`ptyService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyService.ts): persistent terminal serialization, live resize ordering, process revival, and the `History restored` boundary.
- [`terminalInstance.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts): local xterm resize followed by PTY dimension update.

Farming's browser controller lease is an additional boundary required by its multi-window, multi-skin product model; it does not change the raw PTY input semantics.
