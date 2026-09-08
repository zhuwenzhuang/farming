# Composer Input

> Chinese version: [composer-input.zh_cn.md](composer-input.zh_cn.md)

Chat and Terminal input share one editing contract. Drafts, attachments and
submission state belong to the existing Agent composer owner. Expanding the
editor is local presentation state, never another draft or submission path.

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
position. Desktop input keeps its existing layout and keyboard behavior.

| Trigger | Effect |
| --- | --- |
| Expand / collapse | Change presentation; keep the textarea mounted and preserve selection |
| Type, paste, compose or delete | Update the same Agent draft; neither resize nor expansion sends it |
| Compact Enter | Insert a newline; the send control remains explicit |
| Escape | Shared interaction arbitration closes the top menu first, then the expanded editor; IME cancellation retains priority |
| Keyboard / viewport resize | Recompute bounded input geometry inside the visible viewport; keep send reachable |
| Agent changes, desktop layout, permission/error request or dictation | Leave expanded presentation; preserve the existing draft ownership and expose the required surface |
| Submit, queue or interrupt | Use existing authoritative submission behavior; expansion itself never retries a mutation |

Expansion is a full-page editing view, not a dismissible modal. Background
content and compact navigation are hidden while editing; outside taps do not
discard or collapse the draft. Collapse remains explicit, and no downward
gesture competes with scrolling or selection.

## Verification

Exercise both Chat and Terminal input with long Chinese/Latin text, native
scrolling, selection, IME, attachments, menus, requests, short viewports and
Agent/layout changes. Verify the same DOM textarea survives expansion and that
Enter does not submit. Capture compact and expanded states in Light, Dark and
Paper. Browser-emulated viewport changes verify layout; they do not certify a
physical phone's keyboard, dictation or candidate UI.

`npm run release:fast-screen:mobile` checks draft shrinking, unfocused space
reservation and image-preview hit targets before the complete mobile matrix.
