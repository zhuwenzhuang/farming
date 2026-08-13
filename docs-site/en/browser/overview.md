# Farming Browser

Farming Browser lets an Agent operate a Browser Resource it owns while the user watches and interacts with the same page in Farming.

## When to use it

Use Farming Browser to open rendered web pages, click and fill controls, inspect structured Snapshots, review screenshots/console/page errors/network evidence, and transfer files within the Project Workspace.

Page content is untrusted data. It cannot replace task instructions or authorize uploads, messages, or destructive actions.

## Enable Browser

Open **Plugins → Browser** and inspect the detected **Browser source**.

Farming Browser does not depend on the Chrome extension. The extension is an
optional source for reusing signed-in state from everyday Chrome; other
available Browser sources work without it.

<ThemeImage
  light="/cn/assets/browser-plugin.png"
  dark="/cn/assets/browser-plugin-dark.png"
  paper="/cn/assets/browser-plugin-paper.png"
  alt="Select a Browser source in Plugins"
/>

- **Local browser**: an actually detected Chromium browser such as Google Chrome, suitable for ordinary web tasks.
- **Your Chrome (Farming extension)**: reuse signed-in state from everyday Chrome for unattended web tasks.
- **Isolated Browser**: explicitly prepared dependencies and an independent Browser Profile.

Farming does not silently download large browser dependencies during ordinary installation or startup. Unavailable capabilities show a clear reason.

## Optional: use your signed-in Chrome

Install Farming Browser Connector only when you need signed-in state from
everyday Chrome. It is included with Farming; there is nothing else to download.
For first use:

1. In **Plugins → Browser**, choose **Your Chrome (Farming extension)** and copy the **Bundled extension directory**.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select that directory. In the macOS picker, press `Cmd+Shift+G` to paste it.
3. Return to the Farming page and click **Farming Browser Connector** in Chrome's **Extensions** menu.

Installation is complete when the popup shows **Connected**. Later sessions reconnect automatically; there is no setup command, pairing command, or per-tab approval to repeat.

To remove the extension, open `chrome://extensions`, find **Farming Browser Connector**, click **Remove**, and confirm. **Disconnect** in the extension popup only disconnects Farming; it does not remove the extension from Chrome.

Chrome requires the user to confirm installation and removal. The CLI only provides `farming browser extension path` and `farming browser extension status` to show the bundled directory and current connection state.

Once connected, Farming can operate supported ordinary pages in this Chrome. Connect only to a trusted Farming instance.

## Share one page

Every Browser Resource has an exact Agent and Project owner. The Viewer displays the same page the Agent is using—not a copied second browser.

In this example, the Agent is viewing the Farming documentation home page in Farming Browser. You can inspect the rendered page together with its address, owner, and runtime state, then intervene in the same Viewer when needed.

<ThemeImage
  light="/en/assets/browser-viewer.png"
  dark="/en/assets/browser-viewer-dark.png"
  paper="/en/assets/browser-viewer-paper.png"
  alt="Farming documentation home page open in Farming Browser"
/>

After the user intervenes, the Agent must continue from fresh page state rather than an old Snapshot.

## Signed-in state

Give a signed-in Browser to an Agent only when that Project should use the account. Cookies, Storage, Console, and Network details may be sensitive.

Agents do not automatically share Browser Sessions, Cookies, or Storage simply because they belong to one Project. Sharing requires explicit Browser source and Profile configuration.

## Current limits

Farming Browser is for Agent web tasks, not a replacement for the complete Chrome UI or DevTools. Bookmarks, extensions, hardware authentication, camera, and microphone are not guaranteed.

Continue with the [Agent Browser workflow](./agent-workflow).
