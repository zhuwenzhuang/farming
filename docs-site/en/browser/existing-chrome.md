# Connect an existing Chrome

**Farming Browser** is the browser capability. **Farming Browser Connector** is the connection
extension installed in Chrome. Install it only when the Agent should operate pages already open in
your Chrome, including their existing signed-in state.

## Install

1. In Farming, open **Plugins → Browser**, choose **Your existing Chrome**, and
   copy the **Bundled extension directory**.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select that directory. In the macOS picker, press `Cmd+Shift+G` to paste it.
3. Return to the Farming page and click **Farming Browser Connector** in Chrome's
   **Extensions** menu.

The connection is ready when the popup shows **Connected**. Later sessions
reconnect automatically; there is no setup or per-page approval to repeat.

## Disconnect or remove

- Disconnect temporarily: click Farming Browser Connector and choose
  **Disconnect**.
- Remove it from Chrome: open `chrome://extensions`, find Farming Browser
  Connector, click **Remove**, and confirm.

Chrome requires the user to confirm installation and removal.
`farming browser extension path` shows the bundled directory, and
`farming browser extension status` shows the connection state.

Connect only to a trusted Farming instance.
