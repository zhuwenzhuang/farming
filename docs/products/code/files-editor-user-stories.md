# Files / Editor User Stories

> Chinese version: [files-editor-user-stories.zh_cn.md](./files-editor-user-stories.zh_cn.md)

This document describes the human workflows for the Project Files section and the Monaco editor. It is a user-story validation guide rather than a component design spec.

## Goal

A user is supervising an agent in a concrete project. When the agent mentions a file, path, or code location, the user should be able to stay in the Farming project context, expand Files, locate the file, inspect or lightly edit it, and understand git / external-change state.

Main Agent is for coordination and observation. It should not show a Files section. Files belongs to concrete project agents.

The project sidebar should read like a compact VS Code Explorer. The concrete agent row is the first project section. When at least one file is open, an `Open Editors` section appears after the agent and before `Files`; it is collapsed by default and expands on click. `Open Editors` is absent when no file has been opened. `Files` remains the directory-tree section, with compact single-child folder paths such as `tmp/ata2/assets` shown on one row where possible.

## Core Workflows

### 1. Expand Project Files

Prerequisites:

- a Main Agent exists;
- a non-main agent has been started in a workspace.

Steps:

1. Expand the project.
2. Click the `Files` header.

Expected:

- Files and agent rows belong to the same project area.
- The project order is agent row, optional `Open Editors`, then `Files`.
- `Open Editors` is not rendered before the user opens a file.
- Files can collapse and expand.
- The tree participates in the outer project scroll flow instead of creating a second nested scrollbar.
- File icons, directory chevrons, git status dots, and active-file highlights remain stable.
- Single-child directory chains are compacted into one visible row rather than over-indenting each segment.

### 2. Open And Preview Files

Steps:

1. Double-click a text file.
2. Open a Markdown file and toggle Markdown preview from the editor toolbar.
3. Double-click an image file.
4. Double-click a binary file or a very large text file.

Expected:

- Text opens in the Monaco editor with a tab and breadcrumb.
- Markdown files can switch between source editing and rendered preview in the same editor tab.
- Opening the first file creates an `Open Editors` section above `Files`, collapsed by default.
- Expanding `Open Editors` shows the open file list; selecting a row switches back to that file.
- Images open as readonly previews.
- Binary files show metadata previews.
- Very large text opens as a readonly preview and does not enter the save path.
- Project / agent / Files context stays visible.
- A missing editor or application chunk never leaves a blank screen: Farming retries once, then shows a compact reload state with a bounded error type, failed request path, available status, and reason if recovery still fails. Reloading the page does not stop running agents.
- Visual QA has a stable `/farming/error-preview` route. Query previews remain available through `?farming-error-preview=light` or `?farming-error-preview=dark`; append `&farming-error-language=zh` for Chinese copy. The reload action returns to Farming.

### 3. Search And Jump

Steps:

1. Focus the Files search box.
2. Search by content.
3. Enter `path:line` or `path:line:column`.
4. Use `Cmd/Ctrl+P` from the editor to return to Files search.

Expected:

- Search input accepts normal typing and is not stolen by focus retry logic.
- Results expose listbox / option semantics.
- Arrow keys move the active result.
- Selecting a result opens the file and moves the editor cursor to the target line.
- If a search stops early, the result panel shows the active timeout. Change it with a live preset slider in **Settings → File Search** (3 seconds to 3 minutes; default 3 seconds).

### 4. Edit And Save

Steps:

1. Insert text in Monaco.
2. Observe dirty state in the tab and Files tree.
3. Save through the save button, keyboard shortcut, or editor context menu.

Expected:

- Dirty state is visible but not noisy.
- Saving shows a transient saving state.
- After save, dirty state disappears.
- The file is actually written to the workspace.
- If the file changed externally, the user sees reload / overwrite choices instead of silently overwriting disk changes.

### 5. Editor Context Menu

Expected menu items:

- Cut
- Copy
- Paste
- Select All
- Save

Readonly and preview files should disable write actions. Blame should be triggered from the toolbar or non-text gutter area, not from the normal text context menu.

### 6. Git Blame

Expected:

- Blame is offered only when the file can be blamed.
- The blame view shows line author and date near the code.
- Selecting a line shows commit details in the lower details area.
- No extra refresh action is needed in the user-facing menu.

### 7. Line Changes And Review Diff

Expected:

- Gutter context menu can open line changes against the previous revision or the current working file.
- Line changes are a local explanation panel for the current line, not a full review surface.
- The project-scoped `Changes` list opens full-file Monaco diff in the main editor pane.
- Full-file review does not stay squeezed inside the agent/chat column.
- Deleted-file review opens as a readonly diff-only state instead of a writable editor.

### 8. Close Dirty Files

When closing a dirty tab, Farming should ask whether to save, discard, or cancel. The dialog should be lightweight and Farming-branded.

### 9. External Changes

Expected:

- Files changed outside Farming should update tree decoration.
- Open editors should show an external-change state.
- The user can reload without losing the current project context.

### 10. Symbolic Links

Expected:

- A symbolic link keeps its target type: directory links expand and file links open in place, with a small link decoration like VS Code Explorer.
- Links that resolve inside the project retain normal editing behavior.
- Links to another workspace already allowed by Farming's global Files roots remain under their project alias and are read-only.
- Broken links and links outside the allowed roots stay visible but cannot be opened.
- Rename and delete operate on the link entry itself. Farming must never delete or move an external target through its project alias.
- Git status remains scoped to the project entry and does not merge the external target repository into the project repository.

### 11. Restore The Workspace View After Reload

Expected:

- Reloading the page restores the last Projects surface: either the selected Agent terminal or the file that was open in the editor.
- File restoration is scoped by workspace, reopens the latest saved disk content, restores an optional cursor location, and reveals the file's parent directories in Files.
- Each workspace remembers whether Files was collapsed and which directory paths were expanded, even when the Agent terminal was the active surface at reload time.
- Missing Agents, workspaces, or files never trap the user in a broken editor; Farming clears the stale target and falls back to an available Projects surface.
- This is browser-local navigation state, not editor hot exit. Unsaved editor drafts are not persisted across a full page reload.

### 12. URL Location Targets

Expected:

- Agent, file, and folder locations share one URL target contract.
- A file target opens the editor and restores its optional line and column.
- A folder target opens a representative file from that directory when available: `README.md`, then another Markdown file, then the first file. If the directory has no direct files, Files loads its ancestors, places the folder near the top, and temporarily highlights it until the user clicks elsewhere.
- Global `/` file and folder targets use the existing global Files identity and allowed-root checks; they are not treated as terminal agents.
- Symbolic-link locations keep their visible alias path in the URL, such as `reference/lobe-icons`, rather than exposing the resolved external path.
- File and folder context menus expose `Copy Share URL`; it reuses the same authenticated long URL produced by the QR share flow.

## Human Acceptance Script

1. Start a project agent in a temporary git repository.
2. Expand Files.
3. Open `README.md`.
4. Search for a known marker.
5. Open `README.md:4`.
6. Edit a line and save.
7. Modify the same file externally and verify external-change handling.
8. Open blame for a tracked file.
9. Open line changes from the gutter context menu.
10. Open a changed file from `Changes` and verify the main pane shows Monaco diff.
11. Close a dirty file and verify the save/discard/cancel dialog.
12. Repeat the path on a narrow mobile viewport.
13. Add internal and allowed external file/directory links; verify inline navigation, read-only external files, and link-only deletion.
14. Expand nested directories, open a file, and reload; verify the same file and directory path are restored. Return to the Agent terminal, reload again, and verify the terminal stays active while the Files expansion remains unchanged.
