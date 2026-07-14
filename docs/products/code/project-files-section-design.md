# Project Files Section Design

> Chinese version: [project-files-section-design.zh_cn.md](./project-files-section-design.zh_cn.md)

This document describes how the Project Files section should fit into Farming Code. It focuses on product behavior and integration boundaries, not on replacing a full IDE.

## Positioning

Files is a project-level section. It belongs beside concrete project agents, not beside Main Agent. The purpose is to let the human inspect and lightly edit files while supervising an agent.

Inside an expanded project, the sidebar order is the concrete agent row first, optional Open Editors second, and Files third. Open Editors is a separate section, not a child of Files. It appears only after the user has opened at least one file and is collapsed by default.

Files should feel close to a lightweight VS Code Explorer:

- stable directory rows;
- clear chevrons;
- file-type icons;
- subtle git decorations;
- active file highlight;
- smooth scrolling;
- parent context when scrolling deeply.

## Scroll Model

The Files section should expand into the outer project scroll flow. It should not create a second nested scrollbar inside the project sidebar. When many rows are visible, the whole project list scrolls as one surface.

Long trees may use a lightweight sticky ancestor overlay and subtle shadow to show parent context, but that overlay must not change the scroll model.

## Tree Behavior

The tree should not be a hand-rolled recursive list forever. The important behavior is not just icon mapping; it is the whole explorer interaction model:

- stable node ids;
- parent / child path model;
- lazy directory loading;
- expand / collapse state;
- keyboard focus;
- selection and active-file separation;
- rename support;
- git decoration slots;
- hover actions;
- accessible list/tree semantics.

The current implementation uses `react-arborist`, which is reasonable for the first version because it provides virtualization, selection, keyboard navigation, and rename primitives. `@headless-tree/react` is a future candidate if Farming needs deeper control over async tree semantics and accessibility.

Directly copying VS Code workbench sources is not recommended because the explorer is deeply coupled to the VS Code platform.

Current implementation boundaries:

- `react-arborist` owns tree mechanics such as virtualization, focus, selection, and expand/collapse.
- `useWorkspaceFiles` and `/api/files/*` are the Farming file adapter for lazy directories, file events, git state, text IO, and conflict checks.
- `ProjectFilesSection` is the composition shell for the project sidebar section; row rendering, search results, sticky context, tree mechanics, file operations, and context-menu behavior live in focused components or controllers.
- `FileSectionBody` owns the expanded Files body: status rows, search results, tree view, and the named view models passed into that body.
- `FileSectionOverlays` owns Files floating UI such as the file context menu and file-operation dialog.
- `useWorkspaceFileSectionController` owns Files/Open Editors collapse state, agent-change cleanup, reveal requests, search-focus requests, and tree refresh scheduling for the expanded section.
- `useWorkspaceFileTreeController` owns tree refs, row-frame rendering, layout refresh, open-state synchronization, and last-focused path tracking.
- `FileTreeView` owns the tree viewport, sticky context, Arborist `Tree` wiring, and `FileTreeRow` node renderer.
- `FileTreeRow` owns single-row rendering and decoration slots, while `useWorkspaceFileMenuController` and `useWorkspaceFileOperationController` own file-management interaction state.
- `FileEditorPane` remains the Monaco composition shell for the active file, save/reload/conflict flow, and blame integration.
- `FileEditorHeader` owns the editor tab strip composition, breadcrumbs, and save/reload/overwrite action bar.
- `useFileEditorWorkingCopyController` owns save, reload, conflict response, and save-before-close behavior for open editor files.
- `FileEditorTabs`, `FileEditorTabContextMenu`, and `useFileEditorTabsController` own editor tab rendering, tab menu actions, keyboard navigation, close intents, and active-tab focus restoration.
- `FileEditorOverlays` owns editor floating UI composition, including `FileEditorContextMenu`, `FileEditorTabContextMenu`, `FileEditorSaveConfirmDialog`, and blame status toasts; `FileEditorPane` keeps only the action handlers and state transitions that affect Monaco or open-file state.
- `FileEditorBlameDetail` and `FileEditorBlameToast` own blame detail/status presentation; `FileEditorPane` still owns blame loading, capability checks, and visible-range overlay placement.
- `FileEditorMarkdownPreview` owns rendered Markdown source previews in the editor pane.
- `FileEditorPreviewPanel` owns image/binary preview rendering, and `FileEditorInlineBlameLayer` owns inline blame annotation rows.

## Visual Rules

- Files header is at the same project-content level as agent rows.
- Open Editors is at the same project-content level as Files and sits between the agent row and Files.
- Open Editors is absent when no file has been opened, then defaults to collapsed when the first file opens.
- Files owns the search box and directory tree only; it should not contain the Open Editors list.
- Changes is a project-scoped lightweight review entry inside the Files/editor boundary. It summarizes the current workspace changes and opens review targets in the main editor pane.
- The standalone `/review?agentId=...` surface is a working-copy reviewer for the selected agent's workspace. `/review?agentId=...&base=...&head=...` uses the same surface for a Git commit range. It is intentionally separate from the main workspace: it provides a Gerrit-like multi-file diff, per-file Reviewed state, and diff preferences without changing the Files / Monaco review boundary. Git-backed diffs retain character-level edit ranges and explicitly warn when either side has no newline at end of file, so visually identical replacement lines still have an explainable change. Patch generation remains a backend capability, but the provisional download and final-change selectors are not exposed while their product roles are still unclear. Its persisted review state is scoped by stable workspace identity plus the current structured-diff revision, never by the transient agent id. Controls that require server-side change metadata (for example rebase or included-in) are not shown for a local working copy. `/review` is the only product route; deterministic tests use the explicit `fixture=1` query instead of a separate prototype route.
- The header is clickable and collapsible.
- The search box must keep enough input width on narrow sidebars.
- Header actions should not stay visible when row-level context menus already cover the operation.
- File rows use single-line truncation.
- Native `title` should expose the full relative path.
- Active file uses a subtle background and a thin left marker.
- Open file identity is `workspaceRoot + path`; two agents pointing at the same workspace path share one working copy and editor tab while preserving the latest source agent for returning to the terminal.
- Dirty and externally changed files should update both editor tabs and tree decoration.
- Single-child directory chains should be compacted into one visible directory row, for example `tmp/ata2/assets`, to avoid over-indenting a path that carries no branching information.
- Expanding a directory should hydrate compactable single-child chains below its immediate children in the same interaction, so a click on `src` can reveal stable rows such as `main/java` without first showing `main` and then morphing after a second click.
- Directory icons should prefer stable content signals from loaded descendant file extensions. When no content signal is available, the fallback must use a stable path for the visible row rather than the changing basename of a compacted path.

## Search And Jump

Search reuses `/api/files/search`. It supports:

- content search;
- file path search;
- `path:line`;
- `path:line:column`.

Search results must expose keyboard active state to the DOM. `aria-activedescendant` should point at the active result where possible.

## Editor Integration

The right pane is a lightweight editor surface:

- Monaco for text files;
- in-editor Markdown preview toggled from Markdown source files;
- preview for image and binary files;
- readonly mode for oversized files;
- tabs with mature `tablist` semantics;
- transient preview tabs for mouse clicks in the Explorer tree; search results, `path:line`, keyboard Enter, and review/diff opens create pinned tabs, and editing pins a transient tab;
- per-file Monaco model and view state;
- breadcrumb as lightweight context;
- dirty close confirmation.
- a project-scoped Changes list for working-tree review;
- VS Code-style line change inspection from the editor context menu;
- a full-file diff surface for review when a file has working-tree changes.

The editor should not always show a permanent `Saved` state. Save controls should be visible only when useful: dirty, saving, error, external changed, or explicitly available in context.

## Git Blame And Line Changes

Blame should be offered only when it is applicable. Unsupported files should not show a blame action that immediately errors.

Blame can be opened from the non-text gutter area. The text editor's normal context menu should stay focused on editing commands.

Line changes follow the VS Code dirty-diff mental model: Farming asks Git for the original or historical resource, locates the hunk that contains the current line, and shows that hunk in a temporary editor panel. This is for local, line-level explanation.

Review uses a different boundary. When the user needs to inspect a patch, Farming opens a full-file Monaco diff surface and gives the main pane to the comparison instead of forcing the review into a narrow agent/chat column. The Changes list is intentionally scoped to the current project workspace; Farming should not become a global cross-project review workbench. The backend should remain thin: it exposes Git diff content and file snapshots, while the frontend delegates comparison rendering to Monaco rather than implementing its own diff engine.

## Backend Boundary

The backend remains intentionally thin:

- workspace-root safety;
- directory tree and file metadata;
- read / save with version checks;
- create / rename / delete / move;
- search through `rg` where available;
- git status / diff / blame / line changes through `git`;
- optional bounded watcher events.

Farming should reuse mature tools instead of building a full custom IDE backend.

## Performance Boundary

Large workspaces should stay usable through bounded operations:

- file reads and writes keep size caps;
- directory trees load lazily by directory;
- search and git operations use limits, timeouts, or truncation instead of unbounded output;
- live terminal output is streamed in bounded chunks and coalesced before WebSocket fanout;
- exited terminal sessions release screen workers and remove session state after the final output is flushed;
- large Codex / Claude histories are scanned with recent-file and directory budgets, with index data used as fallback.
