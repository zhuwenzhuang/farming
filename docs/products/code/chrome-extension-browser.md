# Use Your Chrome

> 中文：[chrome-extension-browser.zh_cn.md](./chrome-extension-browser.zh_cn.md)

Farming can operate the user's signed-in Chrome and show the same page in the
Farming Viewer.
The extension is included with Farming; there is nothing else to download.

## First-Time Setup

1. In **Plugins → Browser**, choose **Your Chrome (Farming extension)** and copy
   the **Bundled extension directory**.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load
   unpacked**. In the macOS picker, press `Cmd+Shift+G` to paste the path.
3. Return to the Farming page and click **Farming Browser Connector** in
   Chrome's **Extensions** menu.

The extension pairs, enables Browser, and selects itself automatically. Later
sessions reconnect without setup or per-tab approval.

## Use And Disconnect

After pairing, Farming can operate ordinary pages in this Chrome. Incognito,
`chrome://`, and other restricted pages remain unavailable. When access is no
longer needed, click the extension and choose **Disconnect**.

Pair only with a trusted Farming instance.

## Source

The connector adapts the MIT-licensed OpenClaw Browser extension and relay. The
pinned revision and license are under `extensions/browser/chrome-extension/upstream/`.
Farming uses separate extension identity, storage, protocol, key, native host,
and tab group, so it can coexist with OpenClaw.
