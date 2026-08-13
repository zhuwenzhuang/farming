# Connect an Existing Chrome

> 中文：[chrome-extension-browser.zh_cn.md](./chrome-extension-browser.zh_cn.md)

Farming Browser is the browser capability. Farming Browser Connector is the connection extension
installed in Chrome. Install it only when Farming Browser should use pages and signed-in state from
the user's current Chrome.
The extension is included with Farming; there is nothing else to download.

## First-Time Setup

1. In **Plugins → Browser**, choose **Your existing Chrome** and copy
   the **Bundled extension directory**.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load
   unpacked**. In the macOS picker, press `Cmd+Shift+G` to paste the path.
3. Return to the Farming page and click **Farming Browser Connector** in
   Chrome's **Extensions** menu.

The extension pairs, enables Browser, and selects itself automatically. Later
sessions reconnect without setup or per-tab approval.

## Use And Remove

After pairing, Farming can operate ordinary pages in this Chrome. Incognito,
`chrome://`, and other restricted pages remain unavailable. To remove the
extension, open `chrome://extensions`, find **Farming Browser Connector**, click
**Remove**, and confirm. **Disconnect** only disconnects Farming; it does not
remove the extension.

Chrome requires the user to confirm installation and removal. The CLI
`extension path` and `extension status` commands only show the bundled directory
and current connection state.

Pair only with a trusted Farming instance.

## Source

The connector adapts the MIT-licensed OpenClaw Browser extension and relay. The
pinned revision and license are under `extensions/browser/chrome-extension/upstream/`.
Farming uses separate extension identity, storage, protocol, key, native host,
and tab group, so it can coexist with OpenClaw.
