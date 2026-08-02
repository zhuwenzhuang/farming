# Voice Interaction Architecture

> Chinese version: [voice-interaction.zh_cn.md](./voice-interaction.zh_cn.md)

This document is the implementation contract for Farming voice. The first
Codex Realtime Direct slice and a visible Codex Voice Main Agent path are
implemented; the provider-neutral local engine and hidden Voice Supervisor
remain planned.

## Product Decision

Farming voice has two conversation modes over pluggable audio engines:

- **Direct** targets the Agent that was explicitly selected when the voice turn
  began. A local text engine submits its final transcript through Composer;
  Codex Realtime attaches the live voice conversation to that exact Codex
  Session. Neither path inserts another supervisor model.
- **Supervisor** sends the transcript to a system-owned hidden voice
  conversation. The Voice Supervisor can inspect Farming state and invoke
  typed Farming actions across Agents. Coding Agents still own code work.

The Supervisor reuses the Farming Main Agent's attention-steward operating
contract, but not its visible conversation. Voice conversation, tool results,
and short spoken replies must not pollute a coding Session or require the user
to keep a visible Main Agent running.

The Codex Realtime engine captures and plays audio on the user's device while
Codex owns endpointing, recognition, conversation, and generated speech. Its
media uses a browser-to-Codex WebRTC connection; Farming carries only SDP
signaling and bounded status/transcript events. A future provider-neutral
local engine will keep recognition and synthesis on device and send only final
text through Farming.

## Architecture

```text
microphone
   |
   v
Voice Controller
capture -> engine adapter -> playback / transcript
                         |
             +-----------+-----------+
             |                       |
             v                       v
       Codex Realtime           local voice engine
       WebRTC media             on-device STT/TTS
             |                       |
             +-----------+-----------+
                         |
                   +--------------+--------------+
                   |                             |
                   v                             v
             Direct mode                 Supervisor mode
       existing Composer admission       hidden voice conversation
                   |                             |
                   +--------------+--------------+
                                  v
                       typed Voice Action Gateway
                                  |
                                  v
                   authoritative Farming backend state
                                  |
                                  v
                    Codex / Claude / OpenCode / ...
```

The Desktop renderer owns microphone capture and the Voice Controller. The
Electron shell grants microphone permission only to the exact loopback
desktop-gateway origin. It does not expose Node.js or upstream credentials to
the renderer. A normal browser can use the same runtime on a trustworthy HTTPS
or localhost origin.

## Current Codex Realtime Slice

The pinned Codex ACP adapter advertises a versioned WebRTC capability and maps
Farming's `_codex/session/realtime/start` and `stop` extensions to app-server
`thread/realtime/start` and `stop`. The browser creates the offer, the backend
forwards signaling through the exact live ACP Session, and SDP, transcript,
error, and closed notifications return over the existing Farming WebSocket.
These ephemeral notifications never enter the persisted ACP transcript.

Farming enables Codex's `realtime_conversation` feature for the Session, but
the upstream service may still reject an account without Realtime voice
entitlement. That rejection is a visible failure; it is not silently replaced
with browser dictation. Other providers continue to use the existing Web
Speech adapter until a negotiated local engine is available. Because browser
microphone capture is involved, the page must still run as Desktop loopback,
`localhost`, or a trusted HTTPS origin.

Realtime start explicitly requests protocol v3 with
`gpt-live-1-boulder-alpha` and asks Codex to build its native bounded startup
context from the current thread. Farming does not synthesize or duplicate that
context. It also does not retry the legacy v1 route: older Codex executables
fail with an upgrade instruction, while a v3 403 remains an account, rollout,
or workspace entitlement failure.

For the first Main Agent implementation, restarting Main Agent as Codex starts
it in Chat/ACP mode. Opening that Main Agent and selecting its microphone
attaches Realtime to the same visible Main Agent Session. The voice model can
therefore receive bounded recent thread context and use the Main Agent's
existing instructions and tools to coordinate work. A Realtime handoff becomes
an ordinary turn on that same Codex thread, while permissions and tool activity
remain visible in the ordinary Chat audit trail. It does not create the planned
hidden Supervisor Session.

When the selected Codex Chat advertises Realtime, the Composer presents a
circular waveform control instead of the dictation microphone. Its connecting
state pulses, its live state animates the waveform, and pressing it again ends
the conversation. Non-Realtime speech input retains the ordinary microphone
and one-shot dictation semantics.

The backend remains authoritative for Agent identity, lifecycle, runtime
state, attention, messages, permissions, and mutations. Voice must not infer
those facts from terminal text.

### Codex Realtime connection state

The browser Voice Controller owns exactly one foreground Realtime operation.
Each operation snapshots `{ generation, agentId, operationId }` before the
first asynchronous microphone step. `generation` increases on every start,
stop, Agent change, and disposal. Every continuation after `getUserMedia`, SDP
creation, ICE gathering, the start response, and remote SDP installation must
still match all three owner fields before it can publish state or retain local
media resources.

The browser tracks the start outcome separately from presentation state:

```text
not-sent -> uncertain -> accepted
                    \-> rejected
```

`not-sent` can be cancelled locally. `uncertain` means the request crossed the
mutation boundary but no authoritative response has been observed. Both
`uncertain` and `accepted` require an idempotent backend stop/reconcile; local
peer cleanup alone is never sufficient. Timeout, peer failure, remote SDP
failure, Agent change, and component disposal all follow that rule.

The backend is the ordering authority for `{ agentId, operationId }`. A stop
that arrives before its start records a cancellation tombstone for the full
ACP binding-owner lifetime, so an arbitrarily late start cannot create a
conversation. Authoritative binding termination releases those tombstones. A replacement start for the same
Agent waits for the prior operation to finish reconciliation. A late stop for
an older operation is a no-op and cannot stop the newer conversation. The
browser may therefore repeat stop after a reordered or uncertain start result
without replaying the start mutation.

Browser protocol v4 keeps `operationId` optional when parsing incoming
`acp-realtime` WebSocket events so the shared v4 schema remains tolerant during
staged deployment. This does not enable Voice against an older backend: without
the extension acknowledgement described below, the Voice UI stays disabled and
Realtime events are ignored. New backends always emit a non-empty operation ID.
After negotiation, the Voice Controller still ignores an event whose operation
ID is missing or does not match its current operation, so a malformed or stale
event cannot mutate a new voice conversation. HTTP Realtime start and stop
mutations are not backward-compatible: both require a valid operation ID and
return `400` before reaching Agent mutation code when it is absent. This parser
compatibility exception does not change any Terminal or Chat protocol field.

Realtime events are also gated by the versioned `acp-realtime-v1` Browser
protocol extension without changing protocol v4 itself. The initial Server
hello advertises `availableExtensions`; the Client hello requests
`requestedExtensions`; after recording their per-socket intersection, the
Server sends a second compatible hello with `negotiatedExtensions`. The Voice
UI remains disabled until that acknowledgement arrives. Events emitted before
acknowledgement are dropped for that socket and are not replayed. An old Client
does not request the extension and receives no Realtime events; a new Client
connected to an old Server receives no acknowledgement and keeps Voice
disabled. Closing a socket destroys its negotiated set, so every reconnect
must negotiate again.

Codex app-server Realtime notifications do not contain an operation ID. The
reviewed ACP adapter therefore records the operation owner before forwarding
start, captures that exact owner when each notification arrives, and includes
it in the ACP event delivered to Farming. Stop retains the old owner and does
not resolve until the app-server `thread/realtime/closed` boundary has also
been published to Farming. Only then may the backend send a replacement start.
If that boundary cannot be observed within the bounded stop interval, the
fence fails closed: replacement starts remain blocked until the authoritative
ACP Session is closed or recovered.

The backend operation owner also includes the ACP binding generation, not only
the Agent ID. A stale stop closure presents its captured generation to the ACP
runtime; if the Agent now has a replacement binding, the stop is a no-op and
cannot reach the new Session. Coordinator state is reset only at authoritative
old-owner termination points: successful explicit Session close, the
`onProcessStopped` boundary during reconnect, verified unregister, an exact
persisted ACP process-group stop during kill, and a verified ACP startup
rollback. A transport error or manual acknowledgement of an unproven legacy
process exit is not such a boundary and never clears a poisoned fence.

The bounded terminal states are `idle`, `failed`, and `disposed`. Transient
`requesting-permission`, `connecting`, `live`, and `stopping` states always
either retain the exact operation owner or transition through stop/reconcile.

## Voice Action Gateway

Voice, UI, CLI, and future MCP tools should share one typed action layer rather
than implementing parallel mutation paths. The initial action set is:

- `agent.list` and `agent.status.get`;
- `agent.message.send`, using the existing Composer admission and request ID;
- `agent.interrupt`, fenced to the current runtime/turn;
- `attention.list`, using stable event identities and cursors.

Later guarded actions are:

- `agent.create`;
- `agent.archive`;
- `permission.list` and `permission.respond`;
- elicitation and other user-action responses.

Every action validates exact Agent identity at execution time. Mutations carry
a request ID. A transport timeout or disconnect is an uncertain result and is
never automatically replayed. The Supervisor receives a bounded structured
result and produces a separate short spoken response.

The current control API cannot yet serve as this gateway: its `send` path is
raw Terminal input and rejects structured ACP Agents. The first backend slice
must add a provider-neutral message action backed by
`AgentManager.sendComposerMessage`, while retaining raw Terminal input as an
explicitly different operation.

## Voice Turn State Model

One controller owns at most one foreground voice turn:

```text
idle
  -> requesting_permission
  -> listening
  -> transcribing
  -> routing
  -> dispatching
  -> speaking
  -> idle
```

Any transient state has a bounded path to `idle`, `cancelled`, or a visible
`failed` result. Starting a new push-to-talk turn cancels current playback.
It does not replay, cancel, or replace a mutation whose outcome is uncertain.

Direct mode snapshots the target `{ backendId, agentId }` when listening
starts and revalidates it before dispatch. A later UI focus change cannot
silently redirect the transcript. Supervisor mode may resolve a different
target only from authoritative action results; ambiguous references require
one short clarification.

## Permissions And Safety

The Voice Supervisor cannot directly edit files or execute shell commands. It
acts only through the advertised action catalog.

Voice never approves a permission request autonomously. A spoken allow or deny
is executable only when it identifies exactly one current request for one
exact Agent. Farming briefly repeats the target and risk before executing. A
stale request ID, multiple matches, or an Agent/runtime replacement fails
closed and asks for disambiguation.

The UI keeps the final transcript, resolved target, action status, and spoken
reply visible. Speech is a second presentation channel, not the only audit
record.

## Delivery Plan

### Slice 1: shared actions

Add and test provider-neutral list, status, message, and interrupt actions.
Update the `farming send` command to use the message action for both ACP and
Terminal Agents. Preserve Composer request idempotency and uncertain-outcome
handling.

### Slice 2: useful local voice

Allow microphone access from the trusted Desktop origin. Introduce a small
Voice Controller with push-to-talk, transcript preview, Direct/Supervisor
selection, cancellation, and device TTS. Keep the existing Web Speech path as
an explicitly bounded adapter, not as the only supported engine.

### Slice 3: hidden Voice Supervisor

Run a separate hidden voice conversation with the Main Agent's
attention-steward prompt and only the initial Voice Action Gateway tools. Keep
its response to one speakable sentence by default. Show its transcript and
tool results in a reversible voice activity panel.

### Slice 4: attention and guarded actions

Add a durable typed attention stream with event IDs and cursors, then support
proactive completion/blocker narration. Add permission responses only after
the exact-request confirmation contract is tested.

### Slice 5: reliable hands-free audio

Add local neural STT/TTS, VAD/end-of-turn detection, streaming playback, and
barge-in. Model downloads are explicit, cached, cancellable, and never a
silent fallback. Inactive Desktop backends join voice supervision only after
cross-backend attention subscriptions identify every event by backend and
Agent.

## Verification

Focused automation covers both halves of the current Codex path:

```bash
npx tsx backend/tests/test-codex-acp-realtime.ts
npm run test:voice-main-agent
```

The protocol test verifies the reviewed Realtime v3 request, including native
startup context, SDP, transcript, and close ordering. The explicit real-Codex
case creates a synthetic local microphone track, completes the upstream WebRTC
SDP exchange, then submits a Realtime handoff-shaped turn to the visible Main
Agent and proves that it creates a Farming child Agent with the exact parent,
task, and workspace. It requires a Realtime-v3-capable authenticated Codex
binary; `FARMING_REALTIME_CODEX_BIN` overrides automatic discovery.

The first production-shaped acceptance case uses Farming Desktop connected by
SSH to a remote backend:

1. Push-to-talk works without HTTPS on the remote backend because capture is
   local to the Desktop loopback origin.
2. Direct mode sends one transcript to the Agent selected when recording
   began, even if UI focus changes before transcription completes.
3. Supervisor mode can report all current Agent states and send one message to
   an explicitly resolved Agent without exposing opaque IDs in speech.
4. Disconnect after dispatch produces an uncertain visible result and does not
   resend the message.
5. Barge-in stops speech immediately without cancelling already accepted Agent
   work.
6. A permission response with zero, multiple, stale, or replaced-runtime
   matches is rejected without side effects.
