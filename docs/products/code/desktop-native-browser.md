# Desktop Native Browser View

> Chinese version: [desktop-native-browser.zh_cn.md](./desktop-native-browser.zh_cn.md)

Farming Desktop may present an Agent-owned Browser Resource through an Electron
native web contents view. This is an additional Desktop presentation/runtime
adapter for the existing Browser Resource contract, not a second Browser
authority.

## Ownership

- The Farming backend remains authoritative for Browser Resource identity,
  Agent and Project ownership, session binding, leases, lifecycle, tool
  authorization, and persisted resource state.
- The Desktop adapter owns only the Electron-native tabs, views, native input,
  navigation surface, and operating-system integration for the exact Resource
  generation it has leased.
- The shared Browser Resource protocol remains the only Agent tool contract.
  Chat and Terminal use the same instance-exact Farming CLI. No provider name
  selects the native path.
- A web client continues to use the existing streamed Browser Viewer and
  remote Browser Resource semantics for its existing Browser sources. If it
  opens a Resource explicitly leased to Desktop, it receives an explicit
  native-view-only state instead of a lossy streamed fallback.

An exact Desktop adapter identity is selected when a native Resource is
created. If more than one eligible Desktop adapter exists and no exact adapter
was selected, creation fails visibly rather than attaching the Resource to an
arbitrary Desktop. A Desktop-native Resource never silently falls back to a
system, isolated, or Connector browser.
The adapter identity belongs to one Desktop user-data profile, not one renderer
document. Renderer reload and a subsequent Desktop relaunch re-register that
same exact adapter identity, while pre-relaunch native tabs still remain lost
leases and are never adopted by guesswork.
The Desktop renderer reconciles the backend's authoritative server epoch before
registering that adapter on a new WebSocket. Until reconciliation succeeds, the
backend cannot route a new command to retained native views.
The backend acknowledges successful registration before Desktop refreshes its
Browser capability inventory, so the first visible Desktop availability state is
an authoritative read rather than a renderer-side guess about startup timing.

## Native Tab And View State

The backend Resource lifecycle and the Desktop presentation lifecycle are
separate:

```text
Backend Resource:
  stopped -> starting -> running -> stopping -> stopped
                         |              |
                         +-> failed <---+

Desktop tab/view for one exact Resource generation:
  absent -> creating -> hidden | visible -> closing -> absent
                 |                 |
                 +----> failed <---+
```

`visible` means the native view is mounted over the matching Desktop Browser
Viewer viewport. `hidden` retains the exact native tab so Agent work can
continue while the user supervises another Farming surface. A view mount,
resize, focus, or unmount is presentation-only and never creates a Browser
Resource, changes Agent ownership, or changes a Browser Session binding.
Before mounting a tab, the Desktop Viewer asks the backend to select that exact
Resource binding; native IPC refuses to mount a non-selected tab. Presentation
therefore cannot bypass the Backend Session queue or make one tab visible while
the Backend considers another tab active.

The Desktop adapter accepts a command only when its adapter identity, Browser
Resource id, generation, and current lease all match. It rejects stale,
ambiguous, stopped, or replaced commands. The backend serializes Browser
actions through the existing Resource session action queue; a late adapter
result cannot update a newer generation.

## Control And Operations

The native toolbar provides address entry, back, forward, reload or stop,
title/URL/loading/error feedback, tab selection and closure, zoom, and normal
keyboard focus. Browser navigation accepts only `http`, `https`, and
`about:blank`; unsafe schemes are blocked with an explicit error.

Control is an explicit per-Resource state, persisted with a monotonically
increasing `controlEpoch`:

```text
agent / epoch N -- take control --> user / epoch N + 1
user  / epoch N -- return       --> agent / epoch N + 1
```

Starting a new native generation, tab exit, stop, and restart recovery reset
control to the Agent and advance the epoch. Agent action admission records the
owner and epoch before it enters the Browser Session queue, then verifies both
again immediately before execution. A handoff that wins the intervening race
rejects the queued Agent action as stale; it is never replayed. Human toolbar
mutations use the same backend queue with a `user` admission. The React Viewer
does not navigate or mutate Electron content directly: its direct native IPC is
only presentation mount, unmount, focus, and backend-epoch reconciliation. The
authenticated Desktop adapter transport executes only backend-addressed commands
with the exact Resource, Session, generation, and control admission; it cannot
choose that authority itself.

A Browser Session may contain several native tabs, but every tab has its own
Browser Resource identity and generation. **New tab** is a backend-mediated
operation: it creates and binds an exact Resource in the existing Session
before assigning user control. Closing a tab stops only that Resource and the
Session remains available to its remaining exact bindings. This preserves
Agent/Project ownership and makes tab recovery or cleanup auditable.
An Agent-created additional Resource is bound before it accepts commands,
starts hidden, and never replaces a user's currently selected native tab.

The native adapter executes the same structured Browser commands used by
Agents. User input and Agent tool input therefore target the same native tab
and retain the backend's ordered Browser Session semantics. Human input does
not become a second authority or a best-effort mirrored page.
While the Agent owns control, a native input shield remains above the visible
web contents view and absorbs pointer, wheel, touch, context-menu, and keyboard
input. A handoff first prepares the native tab: it blocks direct input and
rejects delayed commands carrying the prior owner/epoch. The backend then
commits the next owner and epoch before Electron commits the visible handoff.
Taking control removes the shield only after that backend commit; returning
control installs it before the Agent becomes eligible again. A failed or
uncertain commit leaves the Resource explicitly failed rather than guessing
which side owns input.
The adapter fails closed when Electron cannot provide an equivalent structured
operation: it does not manufacture empty network or console evidence, fake a
pointer success, or pretend to switch a frame or dialog. The caller receives a
bounded `BROWSER_DESKTOP_OPERATION_UNSUPPORTED` result and may choose an
explicitly capable Browser source.

Downloads and file selection remain Project-workspace operations. Native
adapter transfers are bounded and validated at the backend workspace boundary;
the adapter does not acquire broad filesystem authority. Manual page file
pickers are blocked from a sandboxed preload in every page frame before page
scripts run, and any selected or dropped host files are cleared before page
handlers receive them. Structured Agent uploads read exact workspace files,
transfer bounded bytes to the native tab, and do not disclose arbitrary host
paths. A structured download admits only its exact Electron `DownloadItem`,
captures it into adapter-private temporary storage without cancelling the
transfer, and is published to the requested workspace path only after backend
validation; every unadmitted page download is rejected.
Native page permission and basic-auth challenges fail explicitly; the adapter
never forwards host credentials, host device permissions, or a general
Electron/Node bridge into page content.

## Replacement, Restart, And Uncertain Outcomes

Chat/Terminal and permission replacement retain the Browser Resource through
the existing exact Agent-owner transfer. The Desktop tab remains associated
with the Resource id and generation, not with a transient runtime Agent id.

Desktop process loss, adapter disconnect, native view destruction, and a
bounded command timeout are explicit failures. A timeout is an uncertain
outcome: Farming re-reads authoritative Resource state and does not replay an
input, navigation, download, tab, or other mutation automatically. Command
responses and asynchronous native metadata/loading/error events are accepted
only when the same adapter connection, Resource, Session, and generation still
match.
When the Desktop renderer's adapter transport closes, it invalidates and
destroys every retained native lease before that adapter can register again.
The backend's failed Resource rows are therefore never silently reattached to
an old Electron view after a renderer reload or connection replacement.

After a backend restart, a native tab from the preceding backend generation is
not adopted by guesswork. The backend reconciles the persisted Resource into a
stopped or explicit failed state, and the adapter removes its stale native
lease. A new start creates one new exact generation. After Desktop restart,
the same rule applies: native views are not silently recreated as if their
previous operation completed.

Stopping or deleting an Agent follows the existing Browser Resource lifecycle.
The adapter receives exact tab cleanup only after backend ownership proves that
the selected Resource must stop or delete. A Desktop adapter may not retain or
reuse an Agent-owned native tab after that cleanup.

Deleting the final Resource in one exact Desktop adapter/session first clears
only that Electron persistent partition's storage, cache, and authentication
state. The backend serializes final-delete decisions by the exact
adapter/session key, so two concurrently deleted tabs cannot both conclude
that another tab will clear the profile. The persisted Resource row is removed
only after that cleanup succeeds. A cleanup failure or uncertain timeout keeps
the Resource stopped with an explicit error; Farming never deletes the row or
automatically retries an uncertain profile cleanup.

## Acceptance

Native Desktop verification covers manual browsing; Agent multi-step Browser
tools; user handoff; tab creation, close, and recovery; Chat/Terminal
replacement; Desktop and backend abrupt restart; timeout/error reconciliation;
parallel Desktop/Agent isolation; downloads, file selection, permissions,
dangerous schemes, and authentication; and Light, Dark, and Paper at supported
Desktop sizes. The equivalent web-only Browser journey remains covered through
the existing remote Viewer protocol.
