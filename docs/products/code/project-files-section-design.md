# Project Files Design

> Chinese version: [project-files-section-design.zh_cn.md](./project-files-section-design.zh_cn.md)

Files supports inspection and light editing while supervising Agents. It is not
a second IDE. This document owns product boundaries; the
[Workspace File State Model](workspace-file-state-model.md) owns versions,
working-copy consistency and mutation recovery, and the
[Workspace Transport Protocol](workspace-transport-protocol.md) owns delivery,
cancellation and large-content limits.

## Ownership And Placement

| Owner | Responsibility |
| --- | --- |
| Project composition | Persisted workspace membership, Agents, Open Editors, Files, Changes and History; one sidebar scroll surface |
| Explorer | Expansion, focus, selection, keyboard navigation and bounded row projection |
| Workspace backend | Authorized canonical paths, filesystem/Git truth, versions, bounded reads and mutation reconciliation |
| Editor and viewers | Drafts, tabs, reading position, conflicts and bounded previews |

A Project remains mounted when its last Agent/editor closes. Explicit removal
reconciles dependants in order: archive Agents, remove main-page session
memberships, close editors, then unmount. Failure stops subsequent stages and
keeps membership; retry rereads current state, without undoing completed cleanup
or blindly replaying an uncertain removal.

Agent creation and new workspace discovery establish membership before reporting
success. Concurrent discovery of the same absent Project shares one mount;
ordinary opens within a mounted Project do not remount it. An explicitly selected
repository subdirectory remains the Project boundary, even when Git operations
belong to its containing worktree. Git owns worktrees; Farming owns only their
membership and display order.

## Identity And Navigation

Files are identified by canonical workspace and relative path, independently of
Agent selection. A source-Agent association is navigation metadata, not file
ownership. URI boundaries encode/decode once; free-form terminal text cannot
reinterpret arbitrary whitespace as a path.

Absolute-file entry points share backend worktree resolution. A proven containing
worktree uses the normal Project file path; files outside repositories use bounded
read-only global access. An external file has no invented Explorer target. Desktop
Reveal requires authoritative local-backend capability, not a hostname guess.

Every file-open entry point shares one navigation intent across Projects. Repeated
opens of the same pending file share its read and merge current viewing intent;
pinning is monotonic. A newer different-file intent invalidates the older one.
Only the current intent may mount its view, change focus or commit the main pane.
Late results may refresh data but cannot override newer navigation.

Selection, keyboard focus and active editor identity are separate. The Explorer
owns one selection surface; an active file cannot paint another selected row.
Reveal changes navigation without reopening the file or changing its draft.
A newer reveal or direct user interaction revokes earlier scroll work. Restored
view memory follows authoritative Project/Agent recovery and ignores stale targets.

Directory loads have absent/loading/loaded/failed states and are workspace-generation
fenced. Expansion is user-owned browser state: late reads cannot reopen a collapsed
directory. Restored expansion does not start I/O while Files is hidden. Compact
single-child chains remain depth-bounded and do not automatically cross symlinks.

## Working Copies And Mutations

The filesystem is authoritative. A working copy holds baseline, draft and revision;
saving one revision cannot mark a newer draft clean. Clean files adopt authoritative
external changes; dirty files preserve their draft and expose a conflict. Exact
open-file watches trigger bounded rereads, not a recursive Project watch.

Save/create/rename/move/delete validate authorized identity and expected version.
Conflicts require an explicit reload or overwrite choice. Uncertain mutations are
reconciled from disk or directory state without automatic replay. Farming does not
claim transactions over independent Agents, shells, editors or other instances.
The detailed state machine belongs to the linked file-state contract.

Clipboard actions retain exact file/model ownership. Cut removes text only after
confirmed clipboard success; a late completion cannot modify a replacement model.
Menus, dialogs and asynchronous capability reads lose publication rights on
navigation or dismissal.

## Search And Tree Context

Project search is scoped to the Project unless the user explicitly chooses a
directory. Global Search covers mounted non-Main Projects only. Results preserve
root and relative path, distinguish directories/files and duplicate basenames,
and expose bounded counts plus loading, incomplete and failure states. A name
match does not implicitly include all descendants. Selection never broadens to
an arbitrary filesystem or a fuzzy replacement.

Changing query/filter, closing Search or navigating elsewhere invalidates pending
opens. Only an exact, current successful read activates a file or directory;
failure keeps Search visible. Directory activation expands the existing tree and
never opens an arbitrary child, mounts a Project or resumes an Agent.

The Files header's ancestor context comes from visible tree position, not selection.
It is metadata in a stable header slot, not a duplicate sticky directory row, and
must not change geometry, expansion, search scope or scrolling. Search and context
share that slot explicitly; hover does not switch modes. Escape first dismisses
suggestions, then closes search; IME composition retains its Escape ownership.

Search uses the Farming-owned pinned native ripgrep path with one absolute deadline
across enumeration and matching. Cancellation reaches the subprocess. A missing or
invalid artifact fails explicitly instead of selecting another search implementation.
Directory structure loads independently of Git/ignore decoration, so decoration
failure cannot block tree navigation.

## Editor And Preview Boundaries

Every viewer shares authorized file identity, versioning and access. Source/preview
switching preserves the same working copy and per-file reading state. Clean preview
tabs are transient; pinned tabs remain pinned until explicit closure.

Text up to 2 MiB is fully editable; 2–10 MiB is fully read-only; larger text shows
only its first 10 MiB with explicit truncation. Large trees and Markdown previews
keep a bounded mounted viewport, not a full-document DOM. Width/theme changes
preserve reading anchors.

Markdown supports safe GFM/math and bounded compatibility without rewriting source
or executing arbitrary HTML. Static HTML uses the existing preview isolation.
Images, PDFs and binary content remain read-only. Invalid or unsupported content
stays explicit. Syntax diagnostics remain local; saved-file semantic analysis and
navigation belong to the [Language Server](language-server.md). Dirty drafts do
not present older disk-version semantic results as current.

Spreadsheet previews are read-only, versioned workbook snapshots. Loading/refresh
owns cancellable fetch and Worker parse with bounded bytes, ZIP expansion and cells.
Replacement or close releases old work and rejects late results. Show formatted
values and missing formula-cache warnings without recalculation, macros or external
link refresh. Hidden sheets/rows/columns stay discoverable. Copy and Chat quotes
use the displayed selection with original sheet, coordinates and file version.

## Git And Review

Git reads resolve the nearest authorized initialized repository. Submodules own
their changes, index and Review scope; parent gitlink changes remain separate.
An unavailable repository or truncated/failed command never means a clean tree.
Read-only inspection does not write the Git index.

| Read | Consistency contract |
| --- | --- |
| Changes | Complete per-repository/category counts and bounded pages from an immutable inventory; no shared quota hiding categories |
| History | Captured HEAD, branch, tips and labels; continuation walks immutable commits rather than applying offsets to live refs |
| Blame | Immutable saved-file snapshot; annotations must match displayed line content, including exact historical sides of a diff |
| File Diff | Exact model pair; navigation follows computed changes and cannot override later user input |
| Review | Scoped comparison with its own identity; see [Review foundation](review-foundation.md) |

Cursors bind repository, scope and captured snapshot. Writes/watch events invalidate
relevant inventories, including in-flight captures. Expiry, eviction or restart
requires refresh, never mixed pages. Concurrent readers may share capture but
cannot cancel one another's work. A stale read has bounded recovery, then explicit
Retry. Dirty drafts suspend saved-file blame; superseded reads cannot publish.

Worktree creation starts with a fresh name/source preview and rechecks availability
at admission. A durable request ID binds source, naming policy and starting commit.
Duplicate delivery joins the original operation. Default names allocate collision
suffixes; custom names are exact. Minimizing/closing observation does not cancel
admitted Git work. Success publishes the exact Project; failure preserves the
input; unknown outcome reconciles the original operation without replay.

Branch switching is separate from opening another worktree. It requires a fresh
proof of a clean exact main worktree, an existing local branch unused elsewhere,
and no active/unverifiable Agent work. The backend fences new input, settles prior
admissions and rechecks ownership, expected branch and HEAD. It never fetches,
stashes, creates a tracking branch or forces changes. A failed/uncertain switch
rereads branch truth before any deliberate retry.

## Visual And Interaction Rules

Use the shared [UI design](../../development/ui-design-protocol.md) and
[interaction](../../development/ui-interaction-protocol.md) owners. Files, Open
Editors and Changes share geometry and state treatment; no page-local variant
should encode the same state differently.

- File rows are 24px desktop / 28px compact, with an 8px depth step. Compact
  Project/Agent navigation retains 44px rows. File icons and folder chevrons use
  the same leading slot; indentation leaves readable labels at every depth.
- One Project scroller owns physical movement. Virtualization selects mounted
  rows without a second scroller or scroll-linked translation. Project summary
  layers release together at their trailing boundary. Density changes retain
  row-relative reading position.
- Open Editors is a bounded list; appearance of its scrollbar cannot shift labels
  or actions. Files header actions retain stable slots; ancestor context cannot
  create a geometry feedback loop.
- Compact layouts keep primary save/source/conflict actions accessible and move
  secondary actions into the shared menu. Touch source views preserve native
  selection/copy and the same working-copy/conflict authority.
- Paper keeps tabs, breadcrumbs and editor on one continuous surface. Selection,
  menu focus and dirty/error states follow shared tokens in every appearance.

## Acceptance Criteria

Verify empty/multiple Projects, exact paths and symlinks, cross-Project navigation,
reload and cancelled/stale reads; dirty/external changes and uncertain writes;
submodules, immutable Git pagination and worktree races; large trees, files and
previews; keyboard and touch interaction. Production-shaped scenarios must bound
request time, mounted rows and rendering work while preserving reachability of
all content. Cover Light, Dark and Paper on desktop and narrow layouts.
