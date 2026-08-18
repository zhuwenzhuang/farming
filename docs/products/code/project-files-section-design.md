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
scrollbars. Deep trees may show compact ancestor context without changing that
ownership.

While a Project owns the top of that scroll surface, its Project row, Agent
rows, Open Editors, and Files header form one stacked sticky summary. Their
measured heights determine the next layer's offset. When the Project reaches
its trailing boundary, every visible layer releases with the same scroll
delta; a later layer must never slide over the Project name or branch first.
Directory ancestor context remains below this summary stack.

Project Agent rows use progressive disclosure to keep large Agent groups
scannable. A Project initially shows five Agents, the first Show more action
reveals up to five more, later actions reveal up to ten more, and Show less
returns to the initial five. Selection, search, and active-Agent changes may
replace a row within the current capacity, but only Show more and Show less may
change that capacity. When both live Agent rows and resumable session rows have
more entries, the Project shows one Show more action at a time and reveals the
remaining live Agents before additional sessions.

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
global-file path remains the fallback.

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
active. Workspace back/forward history treats a Plugins location as a first-class
entry and restores
its tab, Agent Home, extension kind, query, detail, and scroll position after
opening a source file.

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

The single sticky directory context is a fixed one-row navigation control with
a compact path. It appears only when the first uncovered visible row has a real
expanded ancestor that has scrolled above the sticky boundary. A collapsed
directory or a preceding sibling is never sticky. The control reveals its
ancestor in the tree; it does not present an expansion chevron or pretend to be
a second tree row.

When the visible rows share a deep offscreen ancestor represented by that
sticky context, the Explorer may reclaim the ancestor indentation with one
uniform, scroll-linked horizontal offset. The offset is derived from fixed row
geometry, changes continuously at viewport boundaries, and never changes the
authoritative tree depth or vertical scroll position. As the sticky context
enters or leaves, it and the tree below may continuously reclaim or restore the
enclosing Files inset as one surface; switching sticky paths does not reset that
surface offset.

Text uses the lightweight editor. Markdown and static HTML may switch between
source and bounded preview within the same file identity. Images, PDFs, binary
files, and oversized text use read-only viewers. Every Viewer uses the same
Project authorization; it must not create a separate file-access path.

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
