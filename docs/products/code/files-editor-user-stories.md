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
