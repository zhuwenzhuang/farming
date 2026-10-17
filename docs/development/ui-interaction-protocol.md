# UI Interaction Protocol

> Chinese version: [ui-interaction-protocol.zh_cn.md](ui-interaction-protocol.zh_cn.md)

Farming interfaces share interaction ownership, not just appearance tokens.
Components declare their boundaries and product actions; shared infrastructure
arbitrates dismissal. The [UI design protocol](ui-design-protocol.md) owns shared
control equivalence and specifications; the
[appearance contract](../products/code/appearance-themes.md) owns palette and
surface roles. Sharing visual parts does not merge distinct interaction roles.

## Surface Ownership

A surface includes its full scroll container, padding, scrollbar, trigger, and
any portalled content. The content column alone is not an interaction boundary.
Use element references and the event's composed path. A scrollbar press, touch,
or pen interaction inside the surface must not be treated as an outside click.
Scroll and resize gestures stay with the surface that receives their initial
pointer event; releasing a gesture elsewhere is not a second dismissal action.

## Dismissal State Model

The component owns whether its view, menu, popover, or dialog is open. The shared
interaction-layer registry owns event arbitration within each document.

| State / trigger | Guard | Effect |
| --- | --- | --- |
| Open / mount | Component enables the layer | Register its current boundaries and actions |
| Render / refresh | Same open interval | Update callbacks and boundaries without changing activation order |
| Pointer down inside | Event path includes an owned surface | Keep the layer open; preserve native interaction |
| Pointer down outside | Top layer allows outside dismissal | Close that layer; preserve the destination click and focus |
| Escape | Top layer allows Escape dismissal | Consume once, close that layer, and restore its return target without scrolling |
| Escape while busy | Top layer disallows dismissal | Consume without closing or falling through to its parent |
| IME Escape | Composition is in progress | Leave composition cancellation to the input |
| Repeated Escape | Key is held down | Consume without cascading through underlying layers |
| Close / unmount | Registration exists | Remove it; detach document listeners when no layers remain |

Nested surfaces outrank their ancestors, including when React mounts the child
first. Independent surfaces use activation order. One event dismisses at most
one layer. A registered trigger is inside its layer, so clicking it is handled
by that control's toggle rather than by an outside handler followed by a reopen.
Hidden, detached, or inert ownership must not intercept another surface's input.

Dismissal is synchronous local UI state, not a backend mutation. It must not
replay save, delete, launch, or network actions. Async work keeps its existing
generation, cancellation, timeout, and error contracts. Re-rendering a component
must not restart work or change which layer owns the next interaction.

## Focus And Surface Differences

Escape returns focus to the invoking control, when it is still connected and
interactive, using `preventScroll`. An outside pointer never restores focus:
the newly clicked control owns it. A delayed focus retry must not overwrite a
later pointer or keyboard decision.

Menus retain their arrow-key and selection semantics. Modal dialogs additionally
own a focus loop and background isolation; disabling dismissal while saving
must not expose a lower layer to Escape. Full-page views retain navigation and
scroll ownership rather than adopting a modal focus trap. Text editors and
Terminals retain their domain keyboard protocols. These are explicit roles,
not separate implementations of outside-click detection.

Only the top modal owns the Tab loop. Control-specific Tab actions, such as
path completion, run first; the modal moves focus only for unconsumed Tab events. Overlapping modals hold background
isolation together; closing or unmounting one must not restore the background
until the last owner releases it. Focus restoration must not target an inert
background while another modal remains open.
The shared modal scope exclusively owns background `inert` and `aria-hidden`;
components must not also toggle those attributes for the same open interval,
or scope cleanup can restore a stale isolated state after dismissal.

Settings follows the same modal focus and dismissal contract as other dialogs,
including a visible initial focus target in compact layouts. File search and
inline file operations register their visible surfaces with the shared layer;
IME Enter/Escape must not submit or discard an edit. A submitting file operation
consumes Escape without discarding its pending result. After completion or failure,
its existing operation owner determines the next state; dismissal never retries a
filesystem mutation. Deferred focus recovery must preserve the user's current
selection when an inline editor already owns focus.

## Reversible Display Changes

The backend owns saved metadata and configuration. The browser overlays admitted
user intent immediately for row ordering, pinning, follow-up/read markers, names,
and preference values. This projection never claims a runtime has started or a
filesystem operation has succeeded.

The minimal state model is idle, saving, reconciling, and settled. Admission
updates the projection before transport; conflicting writes retain user order.
Successful responses confirm only their own fields. Incoming state and older
responses cannot erase later intent. A definite rejection removes only that
operation and rebases later intent over current authoritative state. A failed
superseded operation needs no notification. Read projections acknowledge the
observed attention/output cut, so later output remains unread.

Transport ambiguity triggers a bounded read, never an automatic mutation replay.
If that read confirms the intended value, settle silently. Otherwise present
current state with one short, neutral save-status notice; never report a known
rollback when the write outcome is uncertain. A confirmed rejection that changes
the visible result gives one lightweight restoration notice. Successful routine
saves are silent. Completion cannot restore focus after a later user decision.

Acceptance holds writes pending while users click and drag again, delivers old
state between admission and confirmation, rejects earlier and latest writes,
loses a response after a successful save, and introduces new unread activity.
Verify composed rows/counts and all supported appearances.

## Opening An Agent

New Agent creation retains its exact request identity and parameters after a
transport failure, timeout, or uncertain server response, including when its
dialog is dismissed and reopened. Explicit retry of the same intent reuses that
identity through backend Create admission and the durable lifecycle journal;
there is no automatic retry. Confirmed success settles the intent, while an
initial definitive rejection permits a corrected attempt. A later rejection
cannot erase an earlier uncertain outcome. HTTP creation preserves the custom
title supplied by History and the Project boundary supplied by file-menu creation,
just as the WebSocket creation path does.

Search, History, and Project session activation share one navigation owner,
regardless of pointer or keyboard input. The backend owns resume admission and
the exact `(provider, providerHomeId, sessionId)` claim. The browser owns one
current viewing intent, independently of those operations.

Permission and runtime replacements preserve selection and drafts across the
confirmed lineage. Inventory fallback must reconcile the inventory and transient
selection from the same state snapshot, including chained replacements while a
request remains pending; it must not select an unrelated Agent between them.

The target page composes the shared side-view Back control (a labeled variant
retains the source name) and the same recovery-action recipe as Search errors.
It does not define a separate set of button states for session recovery.

| State / trigger | Effect and exit |
| --- | --- |
| Activate a running Agent | Open its existing view without restarting its runtime |
| Activate a cold or historical session | Immediately show the target title, workspace, and a bounded resume status; hide the previous content |
| Resume returns an Agent identity | Wait for that exact Agent in authoritative state, with a deadline; then let the transcript view own history loading and its errors |
| Known rejection | Keep the target page and an explicit retry action |
| Transport failure, timeout, or ambiguous server failure | Keep an uncertain outcome; offer a bounded, read-only status check, never automatically repeat the mutation |
| Another activation or navigation away | Revoke the old viewing intent, without stopping the Agent; late operations may reconcile membership but cannot navigate |
| Back to Search or History | Restore the source query, filter/page, selection, and scroll; restore focus only as part of this explicit return |

Same-session concurrent resumes join one operation. Different sessions may
complete in any order, but only the current viewing intent can activate a pane.
Leaving the page does not cancel backend work. Unmounting releases browser timers
and requests. A status check reporting no current claim does not prove an earlier
mutation failed, especially across backend restart; uncertainty must remain
visible. A fresh status check can publish current Agent state for reconnect
reconciliation, but cannot start or resume an Agent.

A status read may establish failure only from the latest persisted terminal
Create failure for that exact Session, with no pending resume or live claim.
It returns the recorded error, clears browser uncertainty, and exposes explicit
Retry without submitting another mutation. Pending admission and live claims
take precedence over old failures; an absent claim alone remains uncertain.

Acceptance includes HTTP/state arrival in both orders, delayed history, stopped
Agents, exact Home identity, repeated activation, A/B completion reordering,
leaving while pending, known and uncertain failures, bounded waits, and return
from file/resource contexts. Exercise Search and History with mouse and keyboard,
including compact layouts and every supported appearance theme.

## Adoption And Verification

Connection feedback describes observed connectivity and workspace synchronization,
not an inferred fault location. A lost browser connection does not prove a Server
failure. Reconnecting and terminal connection failures retain distinct copy, and
only an actual retrying state may claim that reconnection is underway.

New dismissible surfaces use the shared interaction layer. Existing domain
hooks delegate dismissal to it instead of installing another global pointer or
Escape listener. A component must have one dismissal owner. Global shortcuts
yield when an interaction layer owns Escape, regardless of listener order.

Migration is incremental. Sharing dismissal does not certify every existing
focus loop, drag controller, selection model, hover timer, or async operation.
Keep those owners explicit; migrate them with their own state and acceptance
evidence instead of folding them into a generic event handler.

Acceptance includes native scrollbar dragging, padding, trigger toggles, nested
menus inside dialogs, portalled surfaces, pointer focus transfer, IME Escape,
key repeat, re-rendering while open, and unmount cleanup. Test the same
interaction in Light, Dark, and Paper with real composed interfaces. Browser
automation must expose native scrollbars when testing their hit area.
