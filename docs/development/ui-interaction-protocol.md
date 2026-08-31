# UI Interaction Protocol

> Chinese version: [ui-interaction-protocol.zh_cn.md](ui-interaction-protocol.zh_cn.md)

Farming interfaces share interaction ownership, not just appearance tokens.
Components declare their boundaries and product actions; shared infrastructure
arbitrates dismissal. Visual styling remains owned by the
[appearance contract](../products/code/appearance-themes.md).

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

Only the top modal owns the Tab loop. Overlapping modals hold background
isolation together; closing or unmounting one must not restore the background
until the last owner releases it. Focus restoration must not target an inert
background while another modal remains open.

## Opening An Agent

Search, History, and Project session activation share one navigation owner,
regardless of pointer or keyboard input. The backend owns resume admission and
the exact `(provider, providerHomeId, sessionId)` claim. The browser owns one
current viewing intent, independently of those operations.

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

Acceptance includes HTTP/state arrival in both orders, delayed history, stopped
Agents, exact Home identity, repeated activation, A/B completion reordering,
leaving while pending, known and uncertain failures, bounded waits, and return
from file/resource contexts. Exercise Search and History with mouse and keyboard,
including compact layouts and every supported appearance theme.

## Adoption And Verification

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
