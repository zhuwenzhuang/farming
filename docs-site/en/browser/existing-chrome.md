# Connect an existing Chrome

Install **Farming Browser Connector** to let Agents use pages and signed-in sessions already open in
your Chrome. Farming Browser can use its other browsers without this connector.

## Install

1. Open **Plugins → Browser** in Farming, click **Install connector**, and copy the extension folder.

   ![Farming Browser settings](/en/assets/existing-chrome-plugin.jpg)

2. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
   In the file picker, select the extension folder shown in Farming, then click **Select**.

   ![Select the extension folder](/en/assets/existing-chrome-select-folder.jpg)

3. Return to Farming, open Chrome's **Extensions** menu, and click
   **Farming Browser Connector**.

   ![Open the connector](/en/assets/existing-chrome-menu.jpg)

Farming opens in Chrome's side panel. Clicking the extension icon opens this panel again.

![Connected](/en/assets/existing-chrome-connected.jpg)

After connection, Agents can find and directly use any ordinary page already
open in this Chrome. No per-page click is required. Stopping Farming Browser
leaves the Chrome page open.

## Remove

Open `chrome://extensions`, find **Farming Browser Connector**, click **Remove**, then confirm.

![Remove Farming Browser Connector](/en/assets/existing-chrome-remove.jpg)
