# Farming 2 Mobile Guide

> Chinese version: [mobile-guide.zh_cn.md](./mobile-guide.zh_cn.md)

Farming 2 on mobile is a pocket-sized remote workbench. It is not trying to fit a full desktop IDE into a phone. It lets the user return to the same Linux-hosted workspace, check whether agents are still running, read terminal output, send a short input, open project files, search a key location, or inspect git blame.

The current mobile and desktop skins use a light appearance.

## Quick Start

Prerequisites:

- Farming 2 is running on a Linux machine reachable from the phone.
- `bash` or `zsh` works on that machine.
- Codex / Claude Code is installed and logged in if those agents will be launched.

Steps:

1. Find the `Network` URL in the server log, for example:

   ```text
   http://linux-host:6694/farming?token=<startup-token>
   ```

2. Open the full URL in the phone browser.
3. After the first successful visit, the browser stores the `farming_token` cookie.
4. To use Farming like an app on iPhone, open the page in a system browser and choose **Add to Home Screen**. The installed app icon and manifest are public branding assets; workspaces, sessions, and APIs still require the Farming token.
5. Tap the top-left menu button to open Projects / Agents.
6. Select an existing agent or start a new `bash`, `zsh`, Codex, or Claude Code agent.

## Layout

Mobile has three primary regions:

- top bar: connection state, current project / file, and main actions;
- drawer: Projects, Agents, Files, Search, History, New Agent;
- main area: one focused terminal, search result, or editor at a time.

The sidebar starts collapsed so the main content is not squeezed. The user can reopen it when switching projects or agents.

## Terminal Workflow

Expected:

- Terminal output remains readable at phone width.
- Tapping terminal output should not accidentally summon the keyboard.
- The input area remains visible when the keyboard appears.
- Long output should scroll inside the terminal experience without causing page-wide horizontal overflow.
- Live Codex work stays collapsed to a compact status row by default; expand a step only when its detail is needed.
- Mobile uses the device keyboard's dictation instead of a separate web speech button.

## Files Workflow

Expected:

- The user can expand Files from the target project.
- Search supports `path:line`.
- Opening a file switches the main area to the editor.
- The mobile top bar shows enough file context.
- Git blame can be inspected without breaking layout.

## Recommended Mobile Use

Good mobile tasks:

- check whether an agent is still running;
- read recent output;
- send a short steering message;
- start a simple shell agent;
- search and inspect one file;
- check blame for one line.

Desktop is still better for:

- multi-file editing;
- long code review;
- wide blame inspection;
- complex terminal UI.

## Acceptance Story

1. Open the token URL on a phone.
2. Open the drawer and select a running agent.
3. Read recent terminal output.
4. Send a short input.
5. Expand the project Files section.
6. Search `README.md:2`.
7. Open the file.
8. Show git blame.
9. Refresh the page and confirm the same remote agent is still visible.
