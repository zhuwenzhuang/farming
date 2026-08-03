# Farming Code

> Chinese version: [README.zh_cn.md](./README.zh_cn.md)

Farming Code is the default desktop and mobile workspace for following one or
more coding Agents, reading their work, and intervening when needed.

![Farming Code workspace](assets/01-code-workspace.png)

## Start

Install Farming, open its authenticated URL, and choose **New Agent**. See
[Getting started](../../getting-started.md) for the first-run flow.

## Main Workflows

### Desktop And Remote Backends

The Electron MVP reuses Farming Code as a local desktop interface and connects
it to saved local or SSH-reached Farming backends. See
[Farming Desktop MVP](desktop-app.md).

### Agents, Chat, And Terminal

Read structured Agent results in Chat or work directly with the CLI in Terminal.

### Files And Review

Browse project files, inspect changes, make a focused edit, and open Review
without leaving the task.

The same editor can start managed language servers on the Project host for
navigation, symbols, call/type hierarchy, and diagnostics. See [Language Server](language-server.md).

### Search And History

Find live work or resume a supported earlier Agent session.

### Browser

People and Agents can use the same project Browser. See
[Farming Browser](browser-agent-cli.md).

### Computer

An Agent can operate an isolated Linux desktop while the user watches or
explicitly takes control in Farming. See [Farming Computer](computer-use.md).

### Phone

Open the authenticated Farming URL on your phone. Use the drawer to switch
Projects and Agents; Chat, Terminal, and Files each use the full screen. Phone
access is best for checking progress and sending short follow-ups.

### Content Text Size

**Settings → Interface → Content text size** changes the readable content in
Chat and its composer, Terminal, Markdown previews, and the file editor and
diff. Navigation, buttons, status labels, and other system UI keep their fixed
size. Farming Code and Farming CRT store this preference separately.

### Farming Pet

Farming Pet is an optional break reminder based on foreground use of the
current Farming tab. It supports configurable work intervals, postponement,
and several rest styles without interrupting first use.

### Agent Notifications

**Settings → Agent → Allow message notifications** enables browser-local
completion notifications while Farming is in the background. Permission is
requested only after this explicit choice, older events are not replayed after
reload or reconnect, and selecting a notification returns to the matching
Agent. Browser notification support normally requires HTTPS or localhost.

## More

- [Farming CRT](../crt/README.md)
- [Documentation home](../../README.md)
