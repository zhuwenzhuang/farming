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

Farming Pet offers an optional break reminder without interrupting a new user
on entry. Its invitation appears after 30 minutes of foreground Farming use.
Once enabled, the reminder counts foreground time in the current tab and
resets a work cycle after five minutes away. The default cycle is 50 minutes
of use followed by a five-minute break; intervals of 90 minutes or longer use
a ten-minute break. Reminder styles can be previewed without saving a choice.
The black-hole scene captures the visible workspace once at break entry, then
runs its lensing and accretion animation on the GPU without repeatedly
recapturing the page.

### Agent Notifications

**Settings → Agent → Allow message notifications** enables browser-local system
notifications while no Farming tab receiving the event is active. Farming
requests browser permission only from that explicit setting. Initial hydration
and reconnect establish an attention baseline without replaying older events.
The notification body uses a bounded plain-text excerpt of the Agent's latest
visible message instead of a generic completion label. Clicking a notification
returns to the matching Agent. The authenticated Farming URL must use a browser
context that supports system notifications, normally HTTPS or localhost.

ACP sessions request a notification when `session/prompt` settles with a
standard non-cancelled stop reason. Terminal sessions instead follow the Agent
TUI's own notification timing: Farming recognizes OSC 9, OSC 99, OSC 777
notification, and BEL sequences written to the PTY. Farming's inferred Terminal
busy-to-idle state still owns unread completion tracking, but does not create
system notifications.

## More

- [Farming CRT](../crt/README.md)
- [Documentation home](../../README.md)
