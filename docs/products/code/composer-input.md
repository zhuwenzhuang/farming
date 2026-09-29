# Composer Input

> Chinese version: [composer-input.zh_cn.md](composer-input.zh_cn.md)

Chat and Terminal input share one editing contract. Drafts, attachments and
submission state belong to the existing Agent composer owner. Expanding the
editor is local presentation state, never another draft or submission path.

The [Context and Commands design](composer-context-and-commands-design.md)
defines the implemented `@`, `/` and `$` first increment and its follow-up targets.

When submission returns a pending result, the send control immediately shows its sending state and prevents duplicate submissions for that Agent. The draft remains editable; acceptance clears only the submitted draft, while failure or an uncertain result preserves it. Changing Agents does not transfer the pending indicator or let an earlier completion clear the new draft.

An explicit Chat send follows the latest transcript immediately, including while acknowledgement is pending. The jump-to-latest control appears only after the reader scrolls away from the latest content and sits at the bottom of the transcript viewport on compact layouts.

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

Images infer missing MIME types from recognized file extensions. HEIC is converted to PNG; optional
image optimization bounds dimensions while keeping transparency. Original-size
delivery is the default. Preview uses the shared full-screen content viewer with
keyboard dismissal and focus return. Long-paste folding and image optimization
are browser preferences in the Composer menu; Shift+Cmd/Ctrl+V bypasses folding for that paste.

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
| Accepted submit or queue | Collapse the current expanded editor after the submission owner reports acceptance; retain newer drafts and later expansion sessions |
| Rejected/uncertain submit or interrupt | Preserve expansion and existing draft handling; never retry a mutation from presentation state |

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

`npm run release:fast-screen:mobile` checks draft shrinking, unfocused space
reservation and image-preview hit targets before the complete mobile matrix.
