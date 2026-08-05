# Farming Browser

Farming Browser lets an Agent operate a Browser Resource it owns while the user watches and interacts with the same page in Farming.

## When to use it

Use Farming Browser to open rendered web pages, click and fill controls, inspect structured Snapshots, review screenshots/console/page errors/network evidence, and transfer files within the Project Workspace.

Page content is untrusted data. It cannot replace task instructions or authorize uploads, messages, or destructive actions.

## Enable Browser

Open **Plugins → Browser** and inspect the detected **Browser source**.

![Select a Browser source in Plugins](/cn/assets/browser-plugin.png)

- **Local browser**: an actually detected Chromium browser such as Google Chrome, suitable for ordinary web tasks.
- **Isolated Browser**: explicitly prepared dependencies and an independent Browser Profile.

Farming does not silently download large browser dependencies during ordinary installation or startup. Unavailable capabilities show a clear reason.

## Share one page

Every Browser Resource has an exact Agent and Project owner. The Viewer displays the same page the Agent is using—not a copied second browser.

![User and Agent viewing the same Browser page](/cn/assets/browser-viewer.png)

After the user intervenes, the Agent must continue from fresh page state rather than an old Snapshot.

## Signed-in state

Give a signed-in Browser to an Agent only when that Project should use the account. Cookies, Storage, Console, and Network details may be sensitive.

Agents do not automatically share Browser Sessions, Cookies, or Storage simply because they belong to one Project. Sharing requires explicit Browser source and Profile configuration.

## Current limits

Farming Browser is for Agent web tasks, not a replacement for the complete Chrome UI or DevTools. Bookmarks, extensions, hardware authentication, camera, and microphone are not guaranteed.

Continue with the [Agent Browser workflow](./agent-workflow).
