# Composer Input

> Chinese version: [composer-input.zh_cn.md](composer-input.zh_cn.md)

Chat and Terminal input share one editing contract. Drafts, attachments and
submission state belong to the existing Agent composer owner. Expanding the
editor is local presentation state, never another draft or submission path.

On desktop, a new Terminal defaults to a collapsed Composer and opening the
Agent directs focus to the terminal. Explicit expand/collapse choices persist in
the browser; missing or unavailable storage defaults to collapsed. Chat-to-Terminal
runtime switching retains its existing visible-Composer continuity. Compact/touch
layouts keep the input available without automatically opening the software keyboard.

Chat and Terminal toolbar labels share a line box that preserves complete glyphs, including descenders. Horizontal truncation must not clip text vertically or change the surrounding button height; this applies to model, reasoning and approval labels in regular and compact layouts.

Chat submission immediately moves the exact text, media and context snapshot into
an Agent-owned outbox and releases the editor for the next draft. Local staging
is not an acceptance acknowledgement. Main and side conversations use the same
owner and pending-row feedback family, with a maximum of 32 outbox messages per
composer; saturation keeps the draft intact. Terminal retains its existing
acknowledgement and draft handling.

The outbox transitions from queued to submitting, then to accepted, definite
failure or unknown. Only the FIFO head may be dispatched; an unknown or failed
head blocks later messages. Prompt delivery also waits for the current Turn to
finish. Each attempt keeps its request ID, payload and delivery mode. Retrying a
definite zero-effect failure creates a fresh ID so late frames cannot settle the
new attempt; an unknown outcome must keep its original ID.
Acceptance removes only that item and records its input history. A definite
failure restores the snapshot only when no successors are waiting and the editor
is empty with no newer media, references or mode; otherwise the failed row remains available for retry or
explicit discard. Timeouts and disconnects preserve an unknown row, never a
new editable copy that could accidentally be sent twice.

Reloaded outbox items require explicit reconciliation, including items formerly
shown as queued: a checkpoint may predate dispatch. Reconciliation only queries the
original request ID. An accepted request returns its known result; recovered intent,
unknown effects and missing records remain unresolved and are never replayed.
Completed admission records have bounded retention, so absence is not proof of
zero effect. Restored follow-up queues use the same conservative recovery rule. Late definitive acknowledgements reconcile the
exact retained item without touching newer drafts. Runtime changes, shared
panes and queue flushes cannot bypass the per-composer in-flight admission.

Message submission and acknowledgement never wait for persistence. Runtime memory
owns request identity, ordering and admission outcomes; the provider submission
callback confirms acceptance. Small recovery metadata snapshots are coalesced and
written asynchronously, with no synchronous fallback on the send path. Snapshot
failure cannot downgrade acceptance or permit a duplicate delivery. Abrupt process
loss can leave an older or missing snapshot; reconciliation remains conservative
and never treats missing evidence as permission to replay.

An explicit Chat send follows the latest transcript immediately, including while acknowledgement is pending. The jump-to-latest control appears only after the reader scrolls away from the latest content and sits at the bottom of the transcript viewport on compact layouts.

Transcript content and viewport resizing preserve the current reading intent.
When following the latest content, growing or shrinking the Composer keeps the
latest answer and its actions visible. When reading older content or selecting
text, those geometry changes must not resume following or pull the reader to the
bottom; only existing explicit catch-up actions restore following.

## Quoting Chat Text

The selection toolbar uses a contrasting surface and follows the selected text
within its transcript viewport as scrolling or layout changes move the anchor.
It flips below the selection when needed and hides while the anchor is clipped.
Clearing the selection, leaving the conversation, or dismissing the toolbar ends
that presentation; quoting never sends a message by itself.

Quoted text is a captured context reference in the owning Composer, separate from
the editable question. A compact block shows a two-line excerpt, expands to the
full snapshot, and can be removed without changing the draft. Existing context
persistence and submission handling retain the quote across recovery or failed
sends and include it with the question on submission. Main and side conversations
use the same presentation and retain independent drafts.

## Long Text Paste

A plain-text paste longer than 1,000 Unicode characters becomes a captured text
reference in the same Agent draft. Short pastes keep native editing behavior;
media pastes retain their attachment path. Chat, Terminal Composer and side chat
share this rule. The card uses the shared quoted-context surface, shows an excerpt,
and supports full preview, removal and “Show in text field”. That action moves the
complete snapshot to the end of the current draft without duplicating it.

The composer state owns both the draft and snapshots. Paste atomically replaces
the selected draft range with a reference; repeated pastes have independent
identities. Preview changes presentation only. Removal deletes only that reference.
Restoring a card atomically removes it and appends its full text; repeated restore
events are harmless. No paste or restore sends a message or needs a network request.
Pastes above 250,000 UTF-16 code units are rejected with an actionable error,
leaving the draft unchanged; snapshots use the existing bounded checkpoints.
Submission includes the complete snapshot as referenced material, separately from
the user's request. Queue editing and failed/uncertain sends retain the snapshot;
acceptance cannot clear a newer draft or reference. Agent switching preserves
ownership. No provider-specific file path or upload is required.

Pasted previews and quote excerpts support native mouse selection and copying;
only the disclosure label toggles expansion. Clipboard HTML supplies bounded,
validated presentation ranges for card previews. Source colors adapt to the
appearance. Source HTML and executable content are never mounted.

Every Composer uses native plain-text editing. Short pastes insert the clipboard's
plain text at the current selection, retaining indentation and line breaks through
native undo/redo. Clipboard HTML never adds Markdown delimiters, code fences or
link destinations to the draft. Explicitly typed or copied Markdown source remains
literal text. Long pasted cards retain that same source text; “Show in text field”
restores it atomically and removes the card exactly once. Existing persisted cards
with an editable Markdown representation retain that representation for recovery
and submission compatibility. Shift+Cmd/Ctrl+V bypasses folding for that paste.

Sent Chat input follows the same literal-text contract: initial requests, accepted
Steer messages and incoming Agent requests preserve their source, indentation and
line breaks, including after reload. Markdown delimiters, Shell comments and HTML
remain visible text; the renderer must not interpret them or add code fences.
Structured attachments keep their own presentation. Assistant output retains its
rich-content rendering.

The Agent draft string is the sole editing and submission owner. The same native
textarea owns visible text, caret, selection, IME, scrolling and undo; no transparent
text or syntax overlay may replace its rendering. Markdown-like content must not
change its font, line height or color. Main Chat, side Chat, Terminal and expanded
editing share this rule in every appearance. HTML-derived presentation is limited
to non-editable context-card previews, never the input.

Typing, selection, undo, history, queue editing, reload and Agent switches keep the
existing draft transitions. IME owns Enter/Escape while composing; editing and
presentation changes never send. Agent switches preserve separate drafts; explicit
submission snapshots the current draft through the existing admission owner.
Card removal, recovery, submission acknowledgements and newer-draft fencing retain
their existing ownership and failure semantics.

## Attachment Intake And Recovery

Paste, file selection and drop share one intake owner and preserve the exact
Agent draft captured at initiation, including side chat. Mixed clipboard text and
files retain both. Workspace file-tree drops retain authorized root/path identity;
OS files are uploaded, never interpreted as paths on a remote backend. Global
file paste targets the last focused visible conversation and yields to text
editors, terminals, menus and dialogs. Desktop may supply an image from its native
clipboard only for an explicit paste with no browser text or files.

Intake reserves each item's identity and order before asynchronous processing.
Items transition from processing to ready or a visible error within a bounded
deadline. Processing and failed items block submission; removing an item cancels
its pending work and fences late completion. Reload keeps unfinished items as
errors rather than silently discarding them. Switching Agents never redirects
results. Retrying an uncertain upload is never automatic.

The backend stores original document bytes in the instance attachment root and
extracts bounded text in isolated workers. Documents are limited to 20 MB; combined
document text is limited to 250,000 characters, with explicit errors rather than
truncation. UTF-8/UTF-16 text, PDF, DOCX, PPTX and
XLSX/XLS are supported. PDF pages, slides and sheets retain boundaries; document
previews identify extracted text, which does not represent embedded pictures,
visual layout or OCR. Empty scans, encryption, unsupported binaries, oversized
archives and extraction timeout fail explicitly. Original files remain available
for download. Every provider receives the same labeled extracted snapshot and
stored original location through existing context submission.

Images infer missing MIME types from recognized file extensions. HEIC is converted
to PNG. PNG, JPEG and WebP images exceeding 2048 pixels on their longest edge are
automatically resized while preserving transparency. Other images use WebP only
when it reduces their size; otherwise they retain their original bytes.
Preview uses the shared full-screen content viewer with
keyboard dismissal and focus return. Long-paste folding and image preparation
are system defaults shared by every Composer, without menu preferences or legacy
browser overrides. Shift+Cmd/Ctrl+V bypasses folding for that paste.

History recalls text, captured references and ready media together. It preserves
an existing unsent attachment draft while browsing and restores that draft when
leaving history. Persistent history is bounded and stores no object URLs; media
previews resolve through the authenticated instance attachment endpoint. Queues,
failed sends and newer-draft fencing continue using the same snapshot owner.

## Compact And Expanded Editing

On compact layouts the textarea grows with its content to a bounded height
(approximately six lines, reduced when the visual viewport is short). Beyond
that bound it scrolls natively. A vertical gesture starting inside the input
stays with the input, including at its scroll boundary. Native selection,
composition and pinch zoom remain available.

The conversation reserves the Composer's measured height whether or not the
input is focused. Clearing or shortening a draft shrinks the input from its
content height; grid stretching must not retain the previous taller size.

The always-visible expand control opens an in-place editor page occupying the
current visual viewport. It retains the same textarea, draft, selection and
scroll position; collapsing preserves that state. The page uses the shared
Composer surface, controls, attachment and submission behavior in Light, Dark
and Paper. The conversation is temporarily hidden without losing its reading
position. Desktop input keeps its existing layout and keyboard behavior. The compact input
row reserves the full 44px expand hit area above the separate send/interrupt row,
including empty drafts and short keyboard viewports.

| Trigger | Effect |
| --- | --- |
| Expand / collapse | Change presentation; keep the textarea mounted and preserve selection |
| Type, paste, compose or delete | Update the same Agent draft; neither resize nor expansion sends it |
| Compact Enter | Insert a newline; the send control remains explicit |
| Escape | Shared interaction arbitration closes the top menu first, then the expanded editor; IME cancellation retains priority |
| Keyboard / viewport resize | Recompute bounded input geometry inside the visible viewport; keep send reachable |
| Agent changes, desktop layout, permission/error request or dictation | Leave expanded presentation; preserve the existing draft ownership and expose the required surface |
| Chat staged locally, or Terminal accepted | Collapse the current expanded editor after its owner captures the submission; retain newer drafts and later expansion sessions |
| Rejected/uncertain submit or interrupt | Preserve newer editing state; restore definite Chat failures only into an empty editor, retain unknown items in the outbox, and never retry from presentation state |

Expansion is a full-page editing view, not a dismissible modal. Background
content and compact navigation are hidden while editing; outside taps do not
discard or collapse the draft. Manual collapse remains explicit; accepted submissions also return to the conversation. No downward
gesture competes with scrolling or selection.

## Command Navigation

Chat and Terminal command menus keep keyboard selection visible using the shared
menu selection surface. Hover and selection use the same fill in every appearance.
Command names occupy the primary line; descriptions sit below and truncate before
the trailing source label. Long names retain the available primary-line width.
Arrow keys wrap through the filtered commands; Home and End select their bounds.
Opening the menu or changing its selected command reveals that row within the
scrollable menu without moving focus out of the input. Filtering resets selection
to the first result; dismissing the menu ends navigation without submitting.

## Verification

Exercise both Chat and Terminal input with long Chinese/Latin text, native
scrolling, selection, IME, attachments, menus, requests, short viewports and
Agent/layout changes. Verify the same DOM textarea survives expansion and that
Enter does not submit. Capture compact and expanded states in Light, Dark and
Paper. Browser-emulated viewport changes verify layout; they do not certify a
physical phone's keyboard, dictation or candidate UI.

Plain-text acceptance covers native copy from a rendered Chat answer, paste into
main Chat, Terminal and side Chat, middle-of-text replacement, Chinese composition
Enter handling, undo/redo, wrapping and scrolling, Agent switching, reload and exact
submitted content. Verify literal Markdown, code indentation and table separators,
plus long-card restoration. Compare focused screenshots in Light, Dark and Paper
on desktop Chromium and compact/expanded WebKit. Browser composition events test
application arbitration; they do not certify a physical OS candidate window.

`npm run release:fast-screen:mobile` checks draft shrinking, unfocused space
reservation and image-preview hit targets before the complete mobile matrix.

## Context And Commands

Chat and Terminal share `@` file/directory lookup, editor selection snapshots,
categorized `/` commands and `$` skill selection. References are staged in the
existing draft and use its submission path. A reference does not add a workspace
root or grant filesystem access.

### Trigger Semantics

| Entry | Meaning | Selecting a candidate |
| --- | --- | --- |
| `@` | Add context from the current authorized workspace | Add a typed reference to the draft; never send |
| `/` | Discover Farming actions, Agent commands and skills | Run a local presentation action, or stage a command/skill for explicit send |
| `$` | Find skills directly | Select the same skill identity and draft representation as its `/` entry |
| File editor “quote selection” | Add the selected code with provenance | Add a selection snapshot with path and range; never send |

`@` and `$` activate at the start of text or after whitespace/opening punctuation,
at the caret. Email addresses, URL contents and known environment-variable tokens
such as `$HOME` must not become mentions. A pasted token does not create a typed
reference or select a skill. Keep ordinary text editable when no candidate is
chosen. `/` activates at the beginning of a line before command arguments, not
inside a filesystem path. Match Unicode queries and replace only the active
query span, preserving the text after the caret.

Escape suppresses completion for that occurrence until its query changes or a
new trigger is entered. Ordinary rerenders must not reopen a dismissed menu.

#### Context References

Selecting `@src/auth.ts` replaces the query with the
readable relative path `src/auth.ts` and adds a removable reference chip to the
existing attachment area. This deliberately preserves the native textarea and
its undo, selection, IME and expansion behavior. The inserted path is ordinary
prose; the chip is the authoritative attachment. Editing or deleting that prose
does not change the attachment, and removing the chip does not rewrite prose.
Typed or pasted paths alone never attach content. The visible chip makes this
distinction inspectable; no hidden token-to-resource binding is inferred.

References carry exact workspace/root identity, kind and normalized relative
path. Selection references also retain the selected text, original range and
source revision when available. Two identical references share one chip;
different selections of the same file remain distinct. Same-named files show
their parent paths. A chip opens a preview with its path, scope and remove action.

File and directory references mean “let the Agent inspect this location”; they
do not recursively inline file contents. Selection references deliver the
captured text, labeled with its original provenance, even if the file changes.
Preview clearly distinguishes a live location from a captured selection.
Preserve existing non-code quote and media attachment workflows.

The backend validates roots, paths and symlinks against existing workspace
authorization. References use the existing labeled path/selection text representation.
Skills instruct the Agent to read the exact discovered SKILL.md. A directory never
implies unlimited enumeration. Unsupported delivery is explicit before send;
the frontend must not silently drop context or manufacture provider syntax.
Terminal insertion likewise uses its adapter's supported representation and
does not execute a separate filesystem or shell command.

#### Commands And Skills

The `/` menu has three labeled groups: Farming actions, Agent commands and
Skills. Rows show the command name, short description, source/scope and argument
hint when supplied. Identity includes source and scope; equal names from
different sources remain distinguishable. Do not deduplicate by label alone.

Selecting a local presentation action, such as opening model settings, opens
the existing control and consumes only its trigger text. It preserves the rest
of the draft and attachments. Choosing a setting follows that control's existing
apply behavior. Actions that send work, change sessions or destroy data must not
execute merely because a completion row was accepted.

Agent commands are staged with their arguments for explicit send. Skills selected
through `/` or `$` use one identity and the same visible skill chip; their query
text is consumed, while ordinary surrounding text remains editable. Selecting
the same skill twice does not duplicate it. The catalog carries the exact skill
path together with its provider spelling and scope; dispatch rechecks all three
and never resolves a selected skill by display name alone. A selected skill does not
enable an integration, change permissions or create an Agent.

Agent commands come from the current session's authoritative advertised command
catalog. Skills require explicit catalog identity/metadata; do not guess that an
arbitrary slash command is a skill. Providers without a skill catalog still show
their advertised commands, while `$` explains that skills are unavailable.
Capability loss keeps selected items visible with an actionable unsupported
state. Recheck availability at submission admission; never silently substitute
a similarly named command from another source.

### Search, Keyboard And Presentation

Empty `@` search shows eligible entries in the current workspace root; queries search authorized files and
directories. Rank exact matches, name prefixes, path/word prefixes and then fuzzy
matches, with stable tie ordering. Commands and skills use the same text matching
rules within their groups. Fetch and render bounded results and explicitly show
when more matches require a narrower query. Loading, no matches and read failure
are distinct states; a failed read must not look like an authoritative empty list.

Keyboard priority is IME, active completion, existing editor/history shortcuts,
then existing submit behavior. During composition, Enter and Escape belong to
the IME. In a completion menu, arrows navigate, Home/End select bounds, Enter/Tab
accept a selectable candidate, and Escape dismisses without changing the draft.
An open loading/empty/error menu consumes Enter/Tab without sending. Outside
pointer dismissal preserves the draft and the destination click. With no menu,
keep existing desktop, compact, queue and steering shortcuts; Tab is not a new
global queue shortcut. Focus stays in the input and the active row stays visible.

Use the shared completion listbox and dismissible-surface interaction owner.
Expose the active option and loading/error state to assistive technology; local
action effects are stated in row descriptions. Do not add component-local global
keyboard or outside-pointer listeners.

The menu is anchored to the Composer, bounded by the visible viewport and
scrolls independently. Reuse shared menu row typography, icons, geometry and
spacing. Use one selection/hover fill and no left-edge marker. References and
skills share the compact attachment strip; keep one visible row with a counted
disclosure for overflow, not an expanding stack of cards. Paper uses the shared
surface fills, and Light/Dark use their existing surface/border rules. The input
boundary remains recognizable in every appearance. Compact and expanded editors
retain the same textarea and keep send reachable above the software keyboard.

### Ownership And State Transitions

Draft checkpoints retain bounded typed references in drafts, queued messages and
failed submissions. Reference-only drafts survive refresh and Agent replacement.
Main and side Chat submit the same complete snapshot. Context preparation reserves
the existing per-Agent submission owner across both surfaces and has an eight-second
read deadline; failed preparation leaves the draft intact.

The Agent composer owner holds text, references, selected skills and attachments
as one draft revision. Menus own only presentation/query state. The backend owns
authorization, capability and submission admission. Provider adapters own wire
encoding. Reuse existing persistence boundaries; do not create another draft
store, retry loop or submission queue.

| State / trigger | Guard and effect | Failure, cancellation and recovery |
| --- | --- | --- |
| Closed → query | Capture Agent, workspace, runtime/catalog generation, query and caret span | IME and invalid boundaries do not open completion |
| Query → loading → ready/empty/error | Only matching generations may publish results; use the existing bounded read deadline | New query aborts the old read where possible; late results are ignored; timeout is visible and explicitly retryable |
| Accept candidate | Verify the active span, candidate identity and current owner, then update one draft revision | Stale or disabled candidates cannot mutate another draft; closing the menu never sends |
| Add/preview reference | Backend validates exact scope; pending validation is visible and blocks sending that item | Missing/inaccessible/unsupported items show retry/remove; removal cancels the read and fences late results |
| Edit / switch Agent / expand | Preserve the owning draft; expansion changes presentation only | Agent/runtime changes close completion and invalidate asynchronous work; references never migrate to another Agent |
| Restore draft / reconnect | Restore typed identities and revalidate current location access and capability | Missing items remain visible as invalid; legacy text/media drafts restore without invented references; menus do not reopen automatically |
| Explicit submit / queue / steer | Snapshot text, references, selections, skills and attachments together using the existing request identity | Block unresolved/invalid items; a prepared request is immutable; queued edits create a replacement draft revision under existing queue rules |
| Accepted submission | Clear only the submitted revision and its owned items | A late acknowledgement cannot remove newer text or attachments |
| Rejected / uncertain submission | Preserve the complete submitted snapshot and existing reconciliation status | Reconcile through the current owner; never automatically replay or retry through another transport |

Location references remain live locations when queued; selection text stays a
snapshot. Revalidate authorization and current capability before actual dispatch
as well as queue admission. A failure blocks that item visibly instead of sending
only the prose. Closing preview/search cancels the read, not the running Agent.
