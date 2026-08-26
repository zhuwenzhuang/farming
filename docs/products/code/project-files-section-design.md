# Project Files Design

> Chinese version: [project-files-section-design.zh_cn.md](./project-files-section-design.zh_cn.md)

Project Files lets a user inspect and lightly edit a Project while supervising
its Agents. It is not intended to replace a full IDE.

The detailed correctness, resolve, retention, concurrency, and recovery
contract is defined by the [Workspace File State Model](./workspace-file-state-model.md).
Interactive request multiplexing and the large-content boundary are defined by
the [Workspace Transport Protocol](./workspace-transport-protocol.md).

## Product Placement

Files belongs to a concrete Project, not Main Agent. An expanded Project shows:

```text
Project
  Agents
  Open Editors, when files are open
  Files
    Working-copy Changes
    Git History
    Directory tree
```

The Project sidebar has one outer scroll surface. Files, Open Editors, Changes,
History, and the directory tree must not create competing project-level
scrollbars. Deep directory paths may scroll out of view without changing that
ownership.

While a Project owns the top of that scroll surface, its Project row, Agent
rows, Open Editors, and Files header form one stacked sticky summary. Their
measured heights determine the next layer's offset. When the Project reaches
its trailing boundary, every visible layer releases with the same scroll
delta; a later layer must never slide over the Project name or branch first.
Directory rows scroll beneath this summary stack and do not add another
scroll-linked ancestor summary.

Project Agent rows use progressive disclosure to keep large Agent groups
scannable. A Project initially shows five Agents, the first Show more action
reveals up to five more, later actions reveal up to ten more, and Show less
returns to the initial five. Selection, search, and active-Agent changes may
replace a row within the current capacity, but only Show more and Show less may
change that capacity. When both live Agent rows and resumable session rows have
more entries, the Project shows one Show more action at a time and reveals the
remaining live Agents before additional sessions.
Selecting an Agent row that is already visible keeps the Project scroll surface
anchored. Navigation to an offscreen Agent may reveal it in that surface.

## Project And Workspace Identity

A Project is a persisted workspace mounted in Farming. Agent creation, file
opening, restored Project sessions, and Git worktree selection all refer to that
same workspace identity. Losing the last Agent or editor does not silently
remove the Project; explicit removal is the unmount action. Opening another file
inside an already mounted Project reuses that membership and must not replay the
Project-mount mutation on the file-open critical path. Concurrent opens that
discover the same absent Project share one mount mutation. Cancelling an
individual file-open waiter does not cancel or replay that mutation; its result
still updates authoritative browser membership, while only the current file-open
intent may commit the main pane.

Explicit removal is immediate only when the Project has no dependent resources.
When live Agents, main-page sessions, or open editor tabs remain, Remove opens a
confirmation inventory. Confirmation archives Agents first, removes the Project's
main-page session memberships second, closes its editor tabs third, and only then
unmounts the Project membership. Cancellation has no effect. Each stage is owned
by its existing lifecycle, session-membership, editor, or Project-membership
controller; a failed stage stops all later stages and leaves the Project mounted.
Completed cleanup is not rolled back, so retry rebuilds the inventory from current
authoritative state. An uncertain Project-removal result is reconciled from
authoritative membership and is never replayed blindly. While confirmation is in
progress, duplicate confirmation and cancellation are disabled; completion,
definitive failure, or bounded uncertain reconciliation terminates the attempt.

When a user explicitly selects a repository subdirectory while creating an
Agent, that directory is the Project boundary. The containing Git worktree
remains authoritative for repository operations, but it must not promote the
Agent into a broader mounted Project. Launching from an existing Project surface
may instead pass that Project workspace explicitly while using a deeper working
directory.

Git owns repository and worktree identity. Farming presents each worktree as an
ordinary Project and owns only its membership and order in the workspace.
Every absolute-file open entry point, including Chat links, Terminal links, and
shared URLs, first asks the backend for the nearest containing Git worktree through
one shared resolution boundary. A successful authoritative lookup mounts
that worktree and opens the repository-relative file through the normal Project
path, including Git blame; when no repository exists, the bounded read-only
global-file path remains the fallback. A global-file fallback opens the exact
file without attempting to reveal it in a Project tree that cannot contain it.

Filesystem paths are decoded internal identities. Structured URI boundaries such
as Markdown links, preview resources, share URLs, and file APIs encode a path once
and decode it once before workspace resolution. Free-form Terminal text remains a
separate lexical boundary: whitespace is not globally reinterpreted as part of a
path unless an explicit link or literal already establishes that identity.

Files identity is derived from the canonical workspace, never from whichever
Agent currently happens to reference it. An optional source-Agent association
may cross Project boundaries to support returning from a file to its originating
Agent, but it is not file ownership.

## Directory And Navigation State

Directory loading is absent, loading, loaded, or failed. A workspace identity
change invalidates pending loads. A response from an older workspace generation
cannot commit data or leave a loading state that blocks retry.

Directory expansion is browser-local navigation state scoped to the workspace.
Each accepted pointer or keyboard action changes the desired expansion state
once; a later directory response cannot reopen a directory the user closed.
Persisted expansion state does not start directory I/O while Files is collapsed.
When Files becomes visible, missing restored directories hydrate with bounded
concurrency; a workspace change or unmount aborts the obsolete loads.
When the first expansion discovers a single-child directory chain, the Explorer
may load and compact that chain, then transfers the same expansion intent to
the final visible directory. This continuation is depth-bounded, detects
repeated paths, never crosses a symbolic link automatically, and stops on a
branch, file, empty directory, load failure, workspace change, or intervening
user collapse.
Direct pointer or keyboard expansion keeps the current row anchored in the
single Project scroll surface. A toggle does not write Project scroll or start
a reveal operation; only navigation to a different target owns reveal.

The Explorer keeps active file, keyboard focus, and selection as distinct
concepts. Opening a file from Chat, Terminal, search, History, Plugins, or a URL
has one reveal owner so the tree and Project list do not compete for focus or
scroll. A revealed file is anchored in the upper-middle of the visible file area
rather than merely exposed at its lower edge. Returning from a file to its source
Agent expands that Agent's Project and Agent group, then reveals the exact Agent
row even when the file and source Agent belong to different Projects. While the
file owns the main pane, that source association does not mark an Agent row as
active. The Explorer selection is the sole owner of its row selection surface:
an active editor path may keep navigation state, but it cannot paint a second row
after the user selects a directory or another file. After the main pane returns to
an Agent, the Explorer may retain its last selection for keyboard continuity, but
it does not paint that file as selected or active until the tree or editor owns the
interaction again. Workspace back/forward
history treats a Plugins location as a first-class
entry and restores
its tab, Agent Home, extension kind, query, detail, and scroll position after
opening a source file.

Every programmatic reveal on the shared Project scroll surface holds one
generation lease. A newer file or Agent reveal, or direct pointer, wheel, or
keyboard intent, revokes the older lease before it can write another scroll
position. A reveal stops once its measured target position is satisfied; fixed
delayed replays must not overwrite later navigation or user input.

## Workspace View Memory

Remember stable user choices that help a user continue where they left off.
Do not remember transient interaction, loading, error, or responsive state.

Authoritative Project and Agent state restores first. A valid active Agent or
file owns the final reveal; stale remembered targets are ignored.

## Working Copies And Mutations

The filesystem is authoritative. A browser working copy keeps a disk baseline,
a draft, and a revision. Saving one revision must not mark a newer draft clean.
Unsaved drafts may have bounded browser-local recovery, but they do not become a
second filesystem authority.

Open files watch only their exact workspace-relative paths and use filesystem
events to trigger an authoritative re-read. Opening files must not introduce a
recursive Project watcher. Exact paths share one incrementally updated watcher
per workspace, while re-reads use bounded concurrency and timeouts. A clean
working copy adopts the new disk content so source and every Viewer refresh
together. A dirty working copy preserves its draft and becomes an explicit
external-change conflict. Event bursts are coalesced, and a stale read cannot
replace a newer accepted baseline. Resources referenced by Markdown, HTML, or
SVG, as well as external or symbolic-link files, are not added to the watch
set; the explicit reload action refreshes those files or preview dependencies.

Save, create, rename, move, and delete validate the exact workspace and expected
object or content version. Conflicts preserve the user's draft and present
reload or overwrite choices rather than silently replacing external changes.

An ambiguous timeout or transport failure is an uncertain outcome. Farming
re-reads the authoritative file or parent directory and converges only when the
requested end state can be proven. It does not automatically replay a mutation.

Late browser responses may refresh authoritative data, but cannot close a newer
dialog, move focus, open a replacement file, or overwrite a newer error.

A file-open transaction moves through selected, reading, optional Project
mounting, committed, cancelled, or failed. Project composition owns one
browser-side open-intent generation across every Project Files section; a
section-local request may own its loading feedback, but it cannot independently
claim the main pane. Repeated opens of the same in-flight file share the read
and transaction: the latest intent replaces view, cursor, focus, and reveal
fields, while pinning is monotonic. A newer different-file intent revokes the
older transaction even when it comes from another Project. Transport abort is
best effort; the current intent lease is the final admission check before and
after an optional mount and before committing the editor state.

Farming does not claim transactions with arbitrary external writers. Shells,
Agents, Git, editors, and other Farming instances remain independent clients of
the same filesystem.

## Explorer And Editor Boundaries

Four responsibilities remain separate:

- **Project composition** owns Files, Open Editors, Changes, History, and the
  single sidebar scroll surface.
- **Explorer behavior** owns rows, focus, selection, keyboard navigation,
  virtualization, and projection of expansion state.
- **Workspace access** owns authorization, bounded filesystem and Git reads,
  version checks, mutation reconciliation, and refresh.
- **Editor and Viewers** own working copies, tabs, editor state, conflicts, and
  bounded previews.

The Explorer preserves one Project-sidebar scroll surface even when many
directories remain expanded. Its complete row projection keeps keyboard
navigation and persisted expansion stable, while only a bounded
viewport neighborhood is mounted. The outer Project scroller owns the complete
logical tree height; the virtual tree window follows that scroll offset without
introducing a second scrollbar. The cost of a large restored tree is therefore
bounded by the visible neighborhood rather than the complete projection.
A scroll frame must not enumerate the complete expanded tree or read layout
from every mounted file row.

The directory tree renders no scroll-linked duplicate of an offscreen ancestor.
Actual virtualized tree rows are the only directory and file rows. Logical depth
still owns keyboard navigation, expansion, accessibility level, and full-path
identity, but visual indentation is capped by the current row width. Indentation
and guide rails may consume at most one quarter of the row, and the label column
reserves at least 48 CSS pixels before trailing status. Deeper levels may share
the capped inset and long names may ellipsize; the file name itself must retain
visible space. The row's accessible label continues to expose the full path.

Text uses the lightweight editor. Markdown and static HTML may switch between
source and bounded preview within the same file identity. Images, PDFs, binary
files, and oversized text use read-only viewers. Every Viewer uses the same
Project authorization; it must not create a separate file-access path.
Markdown previews remember their per-file scroll position when switching source
or files. PDF previews retain a bounded set of browser viewer contexts so the
viewer page, zoom, and scroll state survive ordinary file switching.

Large Markdown preview is segmented at major headings and a bounded block
count. It preserves ordinary continuous scrolling while mounting only the
viewport-adjacent sections and representing distant sections with measured or
estimated space. Syntax highlighting remains disabled so scrolling to a
distant part of the document does not mount or highlight the complete
document. Source view remains available.

Keep Monaco syntax diagnostics but disable Monaco's isolated semantic and
suggestion diagnostics. Project-level diagnostics appear through the managed
Language Server path for saved files.

Semantic code navigation is delegated to the managed Language Server for saved
files. Dirty drafts do not receive cross-file results that describe an older
disk version as current.

The source editor status bar is absent until the active model has at least one
published error or warning marker. When present, it reports the active Monaco
language, the non-zero marker counts, and the source cursor position. Marker
counts describe current editor evidence; an absent status bar is not proof that
Project analysis completed without problems. Shared Language Server results use
an adaptive dock that reduces the editor viewport instead of covering it: the
dock is on the right when the editor is wide enough and below the editor in a
narrow container.

## Git And Review

Working-copy Changes and committed Git History live inside Files. History is
Project-scoped and loads bounded pages; expanding a commit reveals its changed
files and parent comparison without implementing a second diff viewer.

Line changes explain a local hunk near the current line. Full Review uses the
main comparison surface and stable Review identity. These are different
interaction levels and should not be collapsed into one narrow sidebar panel.

Git operations use deterministic, path-safe input and treat truncation or
timeouts as visible partial results, never as proof of a clean workspace.

The existing Project worktree control keeps the Project row compact and owns
two explicit operations inside its popover: opening an already registered
worktree and switching the current repository main worktree to an existing
local branch. Worktree rows never imply a branch switch. Branch switching
requires a fresh server-side read that proves the exact main worktree is clean,
the target branch is not checked out elsewhere, and no live Farming Agent owns
that workspace. It never fetches, creates a tracking branch, stashes, or forces
through changes. The server serializes the mutation with other Project
operations, fences it with the expected branch and HEAD, and reconciles the
authoritative branch after a timeout or command failure without automatically
replaying the switch. Blocked and uncertain outcomes remain visible in the
popover; success refreshes the worktree, Files, Changes, and History views.

Blame annotations load bounded Git porcelain output and keep commit details
interactive. Commit hashes link to the repository web view when the remote can
be mapped safely. Handle-shaped GitLab authors link to their profile on the
same remote host; ambiguous display names remain plain text. Commit-message
issue references follow the workspace's IntelliJ
`IssueNavigationConfiguration` from `.idea/vcs.xml`; unsupported, oversized,
non-HTTP(S), or invalid rules remain plain text.

## Visual And Interaction Rules

- Rows remain compact, stable, keyboard-accessible, and single-line.
- Every tree row has three explicit layout slots: leading icon or chevron,
  label and label decorations, and trailing state. Optional decorations never
  create implicit grid rows, and inline rename occupies the label and state
  slots without moving the label origin.
- At every layout width and one tree depth, a file icon occupies the same
  leading slot as a directory chevron; files do not reserve an additional empty
  chevron column.
- On pointer layouts, the Files search and refresh controls use progressive
  disclosure on header hover. A focused or non-empty search remains visible;
  compact touch layouts keep search visible without requiring hover.
- Open Editors appears only when needed and stays separate from the tree.
- Single-child directory chains may compact into one stable row.
- Dirty, external-change, and Git state remain visible without turning the tree
  into a high-noise warning surface.
- Preview and pinned tabs preserve per-file editor position and distinguish
  transient inspection from intentional multi-file work. A single click may
  create a clean preview, but selecting an existing pinned tab never demotes it
  to preview; double click pins. Repeated opens of the same pending file share
  one read and merge the latest intent, while a newer different-file intent
  cancels the superseded open and keeps bounded loading feedback until settle.
- Paper appearance keeps the tab strip, breadcrumbs, and editor on one
  continuous paper surface. Only the active tab receives a local tonal fill;
  selection does not add a full-width chrome band, border, shadow, or seam.
- Narrow layouts prioritize viewing and short edits; long-form mobile coding is
  not a goal.

## Performance Boundary

File reads, previews, searches, Git output, directory loads, History pages,
editor models, and caches are bounded. Trees and expensive details load on
demand. Background preparation may improve first open, but failure must fall
back to the same authoritative path and must not reload the page or block Agent
work.

Project Files search has one production execution path: the Farming-owned,
version-pinned native ripgrep artifact. Path enumeration, directory-name
matching, and content matching share one absolute deadline instead of receiving
independent timeout budgets. Browser or WebSocket cancellation propagates to
the active search and terminates its ripgrep subprocess; a final browser
watchdog guarantees that visible loading settles. A missing, corrupt, or
unsupported managed artifact is an explicit bounded failure, not a trigger for
system `rg`, WebAssembly, Git, or another automatic fallback.

A directory `tree` request is the interactive structure path and does not wait
for Git status, ignore checks, or descendant decoration. Git and ignored state
load through the independent background `tree-decorations` operation and
publish only changed paths; decoration arrival does not replace directory
snapshots or rebuild an unchanged tree projection. An unchanged structural
refresh reuses node identity, while a changed path replaces only that node and
the ancestors needed to reach it. Large directories split decoration reads at
both protocol-message and subprocess-argument boundaries; no directory size may
turn background decoration into an invalid or indefinitely pending request.

The automated large-workspace gate uses production-shaped trees rather than a
single synthetic click. A 2,000-row projection must keep fewer than 100 file
rows mounted and retain Home/End navigation. Cold expansion across multiple
directories records both request and visible-paint p50/p95, bounds request p95
below 750 ms and paint p95 below 1,000 ms, and also bounds mounted rows and row
renders. These are regression ceilings, not promises that routine interaction
should approach the limits.

Subject to the existing workspace ownership and read-only constraints, text
files up to 2 MiB open completely and remain editable. Text files between 2 MiB
and 10 MiB open completely in a read-only viewer. Larger text files show only
the first 10 MiB in that viewer. The interface must distinguish a complete
read-only file from a truncated prefix; partial content is never presented as
the complete file.

## Acceptance Criteria

Verification must cover empty Projects, multiple Agents sharing a workspace,
Git worktrees, deep trees, keyboard navigation, reload restoration, symlinks,
search and location links, dirty and external changes, uncertain mutations,
read-only viewers, Git History, Review, mobile viewing, and large workspaces.
