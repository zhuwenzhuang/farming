# Composer Context And Commands

> Chinese version: [composer-context-and-commands-design.zh_cn.md](composer-context-and-commands-design.zh_cn.md)

Status: proposal, not an implemented feature. This document defines the next
Composer increment; [Composer input](composer-input.md) remains the contract for
existing editing, expansion and submission behavior.

## Direction And Scope

Use OpenCode as the primary reference for context completion and the distinction
between local actions and Agent commands. Use Zed as the reference for typed
context identity. These are design references from inspected source snapshots,
not claims of identical behavior or runtime acceptance of either product.

The first increment provides file/directory completion with `@`, typed editor
selection references, a categorized `/` menu, and `$` as a skill shortcut. Keep
the native textarea and the existing draft, attachment, queue and steering owners.
Chat and Terminal share completion interactions, while delivery remains bound to
their negotiated capabilities and existing submission paths.

Multi-root authorization, conversation/resource mentions, Agent dispatch, shell
mode through `!`, inline rich-text chips and large-paste conversion are later
work. A file reference never adds a workspace root or grants filesystem access.

## Trigger Semantics

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

### Context References

In the first increment, selecting `@src/auth.ts` replaces the query with the
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
authorization. Adapters encode supported references as ACP content/resource
parts or a documented, tested path/selection representation. A directory never
implies unlimited enumeration. Unsupported delivery is explicit before send;
the frontend must not silently drop context or manufacture provider syntax.
Terminal insertion likewise uses its adapter's supported representation and
does not execute a separate filesystem or shell command.

### Commands And Skills

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
the same skill twice does not duplicate it. Provider spellings are serialized at
the adapter boundary, not embedded in generic UI rules. A selected skill does not
enable an integration, change permissions or create an Agent.

Agent commands come from the current session's authoritative advertised command
catalog. Skills require explicit catalog identity/metadata; do not guess that an
arbitrary slash command is a skill. Providers without a skill catalog still show
their advertised commands, while `$` explains that skills are unavailable.
Capability loss keeps selected items visible with an actionable unsupported
state. Recheck availability at submission admission; never silently substitute
a similarly named command from another source.

## Search, Keyboard And Presentation

Empty `@` search shows recent eligible paths; queries search authorized files and
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

## Ownership And State Transitions

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

## Implementation Increments And Acceptance

1. Normalize completion identities, groups and selection effects; unify `/` and
   `$` discovery/navigation without changing submission ownership. Verify equal
   names, missing skills, disabled capabilities, IME and empty/error menus.
2. Add typed references to the existing draft/snapshot/persistence contract, then
   connect workspace search and editor selections. Verify adapter delivery before
   enabling each reference kind in Chat and Terminal. Retain plain legacy drafts.
3. Verify composed UI and asynchronous behavior with deterministic fake providers
   and production-shaped drafts containing text, media, selections and commands.
   Only then enable the completed surfaces together.

Acceptance must cover:

- Exact/prefix/Unicode queries, duplicate filenames and command names, invalid
  token boundaries, suffix preservation, Escape suppression and keyboard focus.
- Search responses arriving out of order, Agent/workspace/runtime changes,
  missing files, symlink escapes, capability loss, bounded failure and explicit retry.
- Skill alias equivalence; no immediate send on completion; ordinary path edits
  leaving chips unchanged; reference deduplication and selection provenance.
- Queue editing, steering, duplicate sends, delayed/uncertain acknowledgements,
  reconnect and restored drafts retaining every typed item without cross-Agent leakage.
- Light, Dark and Paper screenshots on desktop and compact layouts, including
  a short viewport, expanded editor, overflow references, active selection and
  loading/error states. Capture with focused checked-in scenarios and clean up
  their exact fixtures. Report physical IME/keyboard coverage separately.

Run focused state/adapter and browser checks first, then repository-required
typecheck, lint, tests and build for the affected implementation. Documentation
alone does not constitute feature or visual acceptance.
