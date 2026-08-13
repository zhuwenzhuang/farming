# Use Your Chrome With Farming Browser

> Chinese version: [chrome-extension-browser.zh_cn.md](./chrome-extension-browser.zh_cn.md)

Farming Browser Connector lets Farming operate eligible tabs in the user's
already signed-in, headed Chrome. The page remains visible in Chrome and in the
normal Farming Browser Viewer; Agents keep using the existing `farming browser`
commands and Browser Resource ownership model.

## Install And Pair

First use takes three steps:

1. Open **Plugins → Browser**, choose **Your Chrome (Farming extension)**, and
   copy the displayed **Bundled extension directory**. The extension is already
   included with Farming and does not need another download.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load
   unpacked**, and select that directory. In the macOS picker, press
   `Cmd+Shift+G` to paste the full path. Chrome requires the user to perform this
   approval step.
3. Return to the open Farming page and click the Farming extension in Chrome's
   toolbar. It securely reads pairing information from the current Farming
   owner page, connects, and selects **Your Chrome (Farming extension)** as the
   Browser source.

There is no key to copy, Settings page to visit, or separate Apply action. The
first pairing defaults to the narrower **Selected tabs** access mode. Later
Chrome and Farming sessions reconnect automatically without another approval.

Farming prepares the packaged extension at a stable location during startup.
The CLI can prepare or print that directory again. Advanced manual pairing
remains in Settings as a recovery path when the extension cannot identify the
current Farming page:

```bash
farming browser extension path
farming browser extension pair
farming browser extension status
```

One-click pairing reads the active tab only after the user clicks the extension
and requires that page to have Farming owner access. Read-only shares and
ordinary websites cannot return pairing information. The complete pairing key
is stored in the extension's own Chrome storage and is not embedded in the
bundled extension directory.

The extension offers the same access modes as its OpenClaw upstream:

- **All tabs** exposes eligible ordinary tabs except tabs explicitly paused for
  the current browser session.
- **Selected tabs** uses the Farming tab group as the authorization boundary.
  Moving a tab into or out of that group grants or revokes access immediately.

Incognito, `chrome://`, `chrome-extension://`, and other ineligible tabs remain
unavailable. Agent-created tabs are placed in the Farming tab group. Farming
Browser Resources still own exact tabs; one Agent does not silently inherit
another Agent's Browser Resource.

## OpenClaw Provenance And Updates

Farming Browser Connector is adapted from the MIT-licensed OpenClaw Chrome
extension and extension-relay implementation. The pinned repository, commit,
source path, retained license, and deterministic transformation scope live in
`extensions/browser/chrome-extension/upstream/`. Farming intends to keep this
copy synchronized with upstream security and compatibility fixes.

Maintainers update the vendored extension from a reviewed OpenClaw checkout:

```bash
npm run sync:openclaw-browser-extension -- /path/to/openclaw
```

Every synchronization must review the upstream relay protocol and server-side
CDP bridge changes, run the Browser extension and Resource tests, and update the
pinned revision in the same change. Farming's changes are deliberately bounded
to product identity, protocol/native-host/alarm/tab-group namespaces, packaging,
and integration with Farming's existing Browser Resource and Viewer contracts.

## Coexistence With OpenClaw

Farming does not attach to, control, or modify an installed OpenClaw extension.
Both extensions can be installed in the same Chrome profile because Farming
uses its own:

- Chrome extension identity and `chrome.storage.local` namespace;
- `farming-extension-relay.v2` WebSocket subprotocol and Farming route;
- `ai.farming.browser_bootstrap` Native Messaging Host name;
- Farming alarm names and Farming tab-group title;
- Farming-owned pairing secret under the active Config directory.

An OpenClaw tab group grants no Farming access, and a Farming tab group grants
no OpenClaw access. Chrome may still show separate debugger banners when both
products attach to their own authorized tabs.

## State And Failure Contract

The Farming backend owns the pairing secret, selected Browser source, relay
connection, and Browser Resource lifecycle. The extension owns its persisted
pairing copy and tab-access policy. `paired but disconnected` is not runnable:
Plugins reports the connector unavailable and does not fall back to another
browser source.

Restarting Chrome or Farming preserves pairing and reconnects automatically.
The machine must remain awake, Chrome must remain running, and the Farming
WebSocket route must remain reachable. Changing Browser source stops running
Browser Resources but never terminates the user's Chrome process.

The connector grants automation access to signed-in browser state. Pair only a
trusted Farming instance, prefer **Selected tabs** for sensitive profiles, and
remove the extension or clear its pairing when access is no longer required.
