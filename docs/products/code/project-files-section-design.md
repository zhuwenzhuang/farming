# Project Files Design

> Chinese version: [project-files-section-design.zh_cn.md](./project-files-section-design.zh_cn.md)

Project Files lets a user inspect and lightly edit a Project while supervising
its Agents. It is not intended to replace a full IDE.

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

Project Agent rows use progressive disclosure to keep large Agent groups
scannable. A Project initially shows five Agents, the first Show more action
reveals up to five more, later actions reveal up to ten more, and Show less
returns to the initial five. Selection, search, and active-Agent changes may
replace a row within the current capacity, but only Show more and Show less may
change that capacity.

## Project And Workspace Identity

A Project is a persisted workspace mounted in Farming. Agent creation, file
opening, restored Project sessions, and Git worktree selection all refer to that
same workspace identity. Losing the last Agent or editor does not silently
remove the Project; explicit removal is the unmount action.

Git owns repository and worktree identity. Farming presents each worktree as an
ordinary Project and owns only its membership and order in the workspace.

Files identity is derived from the canonical workspace, never from whichever
Agent currently happens to reference it. An optional source-Agent association
may support returning from a file to an Agent, but it is not file ownership.

## Directory And Navigation State

Directory loading is absent, loading, loaded, or failed. A workspace identity
change invalidates pending loads. A response from an older workspace generation
cannot commit data or leave a loading state that blocks retry.

Directory expansion is browser-local navigation state scoped to the workspace.
Each accepted pointer or keyboard action changes the desired expansion state
once; a later directory response cannot reopen a directory the user closed.

The Explorer keeps active file, keyboard focus, and selection as distinct
concepts. Opening a file from Chat, Terminal, search, History, Plugins, or a URL
has one reveal owner so the tree and Project list do not compete for focus or
scroll. Workspace back/forward history treats a Plugins location as a first-class
entry and restores its tab, Agent Home, extension kind, query, detail, and scroll
position after opening a source file.

## Working Copies And Mutations

The filesystem is authoritative. A browser working copy keeps a disk baseline,
a draft, and a revision. Saving one revision must not mark a newer draft clean.
Unsaved drafts may have bounded browser-local recovery, but they do not become a
second filesystem authority.

Save, create, rename, move, and delete validate the exact workspace and expected
object or content version. Conflicts preserve the user's draft and present
reload or overwrite choices rather than silently replacing external changes.

An ambiguous timeout or transport failure is an uncertain outcome. Farming
re-reads the authoritative file or parent directory and converges only when the
requested end state can be proven. It does not automatically replay a mutation.

Late browser responses may refresh authoritative data, but cannot close a newer
dialog, move focus, open a replacement file, or overwrite a newer error.

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

Keep Monaco syntax diagnostics but disable Monaco's isolated semantic and
suggestion diagnostics. Project-level diagnostics appear through the managed
Language Server path for saved files.

Semantic code navigation is delegated to the managed Language Server for saved
files. Dirty drafts do not receive cross-file results that describe an older
disk version as current.

The source editor status bar reports the active Monaco language, non-zero error
and warning markers already published for that model, and the source cursor
position. Marker counts describe current editor evidence; an omitted count is
not proof that Project analysis completed without problems. Shared Language
Server results use an adaptive dock that reduces the editor viewport instead of
covering it: the dock is on the right when the editor is wide enough and below
the editor in a narrow container.

## Git And Review

Working-copy Changes and committed Git History live inside Files. History is
Project-scoped and loads bounded pages; expanding a commit reveals its changed
files and parent comparison without implementing a second diff viewer.

Line changes explain a local hunk near the current line. Full Review uses the
main comparison surface and stable Review identity. These are different
interaction levels and should not be collapsed into one narrow sidebar panel.

Git operations use deterministic, path-safe input and treat truncation or
timeouts as visible partial results, never as proof of a clean workspace.

Blame annotations load bounded Git porcelain output and keep commit details
interactive. Commit hashes link to the repository web view when the remote can
be mapped safely. Handle-shaped GitLab authors link to their profile on the
same remote host; ambiguous display names remain plain text. Commit-message
issue references follow the workspace's IntelliJ
`IssueNavigationConfiguration` from `.idea/vcs.xml`; unsupported, oversized,
non-HTTP(S), or invalid rules remain plain text.

## Visual And Interaction Rules

- Rows remain compact, stable, keyboard-accessible, and single-line.
- On pointer layouts, the Files search and refresh controls use progressive
  disclosure on header hover. A focused or non-empty search remains visible;
  compact touch layouts keep search visible without requiring hover.
- Open Editors appears only when needed and stays separate from the tree.
- Single-child directory chains may compact into one stable row.
- Dirty, external-change, and Git state remain visible without turning the tree
  into a high-noise warning surface.
- Preview and pinned tabs preserve per-file editor position and distinguish
  transient inspection from intentional multi-file work.
- Narrow layouts prioritize viewing and short edits; long-form mobile coding is
  not a goal.

## Performance Boundary

File reads, previews, searches, Git output, directory loads, History pages,
editor models, and caches are bounded. Trees and expensive details load on
demand. Background preparation may improve first open, but failure must fall
back to the same authoritative path and must not reload the page or block Agent
work.

## Acceptance Criteria

Verification must cover empty Projects, multiple Agents sharing a workspace,
Git worktrees, deep trees, keyboard navigation, reload restoration, symlinks,
search and location links, dirty and external changes, uncertain mutations,
read-only viewers, Git History, Review, mobile viewing, and large workspaces.
