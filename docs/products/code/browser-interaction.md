# Browser Interaction

> Chinese version: [browser-interaction.zh_cn.md](browser-interaction.zh_cn.md)

## Remote Viewer Input

The backend owns the active Runtime target and accepted input. The Viewer owns
local focus and composition only. Physical key down/up, committed text, pointer
buttons, and clipboard transfers are different operations. Committed text must
not be reconstructed as keyboard shortcuts. Physical keys preserve modifiers,
repeat, location, and their matching release. Clipboard transfer is plain text;
it must not read the operating system clipboard on the execution host.

| Trigger | Guard and effect |
| --- | --- |
| Input | A connected Viewer and the same running Resource generation are required; invalid input fails visibly. |
| Composition | Local composition owns intermediate text; only committed text reaches the remote page. Cancelling composition sends no text. |
| Focus leaves, pointer cancels, or Viewer closes | Release that Viewer's held keys and buttons; do not navigate or replay text. |
| Runtime target or input Viewer changes | Release the previous input state before the new target receives input. |
| Disconnect | Disable input and discard unsent events. Backend cleanup releases held state when its transport is usable; no operation is automatically replayed. |
| Clipboard | Copy the selected plain text only; deny password selections. Cut may delete only the unchanged selection after local clipboard success. Unsupported selections fail explicitly. |

Pointer movement and wheel events may be coalesced only across equivalent
button/modifier states. Ordered key, button, and text events form barriers.
Native Desktop input remains Chromium-owned and is not routed through the
remote Viewer. The same user journeys apply to system, isolated, and borrowed
Chrome Browser sources.

Human input uses an acknowledged CDP connection to the existing Runtime; the
agent-browser stream carries frames. Input attachment verifies the selected tab
identity, including identical-URL tabs, and uses a private target session so
closing an input attachment cannot detach another relay client. Input connection
loss or a timed-out dispatch has an uncertain outcome: fail the Runtime, discard
queued input, and require an explicit Browser restart. Never replay a mutation.
This does not add a browser launcher or a second lifecycle owner.

## Shared Control

The Web Viewer accepts direct human input without a mandatory take-control or
return-control step. It is a shared interface to the Agent's Browser, not an
exclusive human lease. Input ordering and exact target identity prevent lost
state and cross-tab delivery; they do not make simultaneous human and Agent
edits semantically conflict-free.

For login or other manual assistance, the Agent should wait while the user
operates the page and read the current page again before continuing. Opening or
focusing the Viewer does not implicitly pause the Agent. Exclusive handoff and
multi-Viewer arbitration are deferred until observed conflicts justify them.
The Desktop native Browser keeps its existing control contract.

## Acceptance

Exercise punctuation, Chinese composition, selection replacement, undo/redo,
plain-text clipboard, special keys, double click, drag, and focus loss against
real Chromium inputs, contenteditable, and a browser code editor. Verify page
values and events, not merely sent messages. Exercise disconnect and target
switching with held keys/buttons. Visual checks cover Light, Dark, and Paper;
platform and mobile coverage must be reported explicitly.
