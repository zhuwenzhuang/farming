---
description: Browse, search, edit, and inspect project files and Git changes in Farming Code.
---

# Files

Files lets you browse, search, and lightly edit Project files. Use it to verify code, configuration, and test evidence mentioned by an Agent.

<ThemeImage light="/cn/assets/files-relational-operators-20260806.png" dark="/cn/assets/files-relational-operators-20260806-dark.png" alt="Relational operator Markdown preview in Files" />

## Browse files

The file tree is bounded by the Project Workspace. Farming reads current content from the Project host and does not mix paths from another Project.

Use **Open Editors** to return to files already opened. File tabs and the active Agent can switch independently, so inspecting code does not discard Chat or Terminal state.

## Search

Search by file name, relative path, `path:line`, or text in code. Directory reads and search are bounded. Narrow the path or query when results are large instead of loading the whole repository into the browser.

## Edit and save

Files is intended for small, explicit edits. Before saving:

- confirm the file belongs to the current Project;
- avoid overwriting an area another Agent is editing;
- rerun relevant checks after saving;
- edit authoritative source files instead of generated output.

## Changes and Diff View

When the worktree changes, Files lists tracked and untracked files. Open a file for a quick view, or choose **Review changes** for a full Diff View with context and comments.

Diff View shows the selected comparison. It does not decide whether a change satisfies the task.

## Git History

Git History shows commit graphs, messages, and file changes for the current or all branches. Select a commit to open its Diff View.

Git History comes from the repository; Agent History is used to find and resume Agent Sessions.

## Blame and disk state

Blame is a useful investigation clue, not proof of current design intent. Combine it with code, tests, and current documentation.

Files shows actual files on the Farming Host. Experimental semantic features are described under [Language Server](../experimental/language-server).
