# Connect an existing Chrome

Install **Farming Browser Connector** to let Agents use pages and signed-in sessions already open in
your Chrome. Farming Browser can use its other browsers without this connector.

## Install

First click **Prepare extension folder** under **Plugins → Browser → My Chrome** in Farming.

![Prepare the connector in Farming](/en/assets/existing-chrome-install.png)

1. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
2. In the file picker, open your home folder, select **farming-browser-connector**, then click **Select**.

   ![Select farming-browser-connector](/en/assets/existing-chrome-select-folder.jpg)

3. Open Chrome's **Extensions** menu and click
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
