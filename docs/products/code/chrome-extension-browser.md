# Connect an Existing Chrome

> 中文：[chrome-extension-browser.zh_cn.md](./chrome-extension-browser.zh_cn.md)

Farming Browser is the browser capability. Farming Browser Connector is the connection extension
installed in Chrome. Install it only when Farming Browser should use pages and signed-in state from
the user's current Chrome.
The extension is included with Farming; there is nothing else to download.

## First-Time Setup

1. In Farming, open **Plugins → Browser → My Chrome** and click **Prepare Chrome extension folder**. Only then does
   Farming prepare the **farming-browser-connector** directory; repeated clicks reuse the same
   directory. **Installation steps** is a separate action and does not open automatically.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select **farming-browser-connector** in the user's home folder.
4. Click **Farming Browser Connector** in Chrome's **Extensions** menu.

The extension pairs and enables Browser automatically. Later sessions reconnect
without setup or per-tab approval.

## Use And Remove

After pairing, an Agent can list the ordinary pages already open in this Chrome,
select the page that fits its task, and manage it directly. Stopping or deleting
the Farming Browser Resource leaves the user's Chrome tab open. Incognito,
`chrome://`, and other restricted pages remain unavailable.

The connector requests all-sites host access so Chrome presents its site access as
**Full access**, matching its product contract: after pairing, an Agent can intervene in
any ordinary HTTP or HTTPS tab without per-site or per-tab approval. Pairing still accepts
only authenticated Farming pages on localhost or `127.0.0.1`; page automation continues
through Chrome's debugger channel.
If Chrome Memory Saver has discarded a listed tab, attaching restores that tab before the
debugger session starts and revalidates its access before continuing.

To remove the extension, open `chrome://extensions`, find **Farming Browser
Connector**, click **Remove**, and confirm.
Then return to **Plugins → Browser → My Chrome** and click **Remove Chrome extension folder**. This removes only
the Farming-created folder link; it is safe to prepare again later. This is not a temporary folder: Chrome continues loading the
extension from it, so remove the extension from Chrome first.

Farming does not create this directory at startup. After the user clicks **Prepare Chrome extension folder**, Farming creates
a visible link to the bundled extension without copying a second code tree. CLI `extension path`
and `extension status` commands expose the path and connection state. After preparation, the My Chrome row shows
the copyable `chrome://extensions` address, folder path, size, integrity, and a short installation hint. Chrome installation and
removal still require user confirmation. While the Farming plug-ins page is visible, it checks the Connector handshake every two
seconds and automatically changes My Chrome between **Available** and **Currently unavailable**. The check pauses when the page is
hidden or the user leaves the Farming tab.

Pair only with a trusted Farming instance.

## Source

The connector adapts the MIT-licensed OpenClaw Browser extension and relay. The
pinned revision and license are under `extensions/browser/chrome-extension/upstream/`.
Farming uses separate extension identity, storage, protocol, key, native host,
and tab group, so it can coexist with OpenClaw.
