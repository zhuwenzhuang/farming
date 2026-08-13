# Connect an existing Chrome

Install **Farming Browser Connector** to let Agents use pages and signed-in sessions already open in
your Chrome. Farming Browser can use its other browsers without this connector.

## Install

1. Open **Plugins → Browser** in Farming, click **Install connector**, and copy the extension folder.

   ![Farming Browser settings](/en/assets/existing-chrome-plugin.jpg)

2. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
   In the macOS picker, press `Cmd+Shift+G`, paste the extension folder, and click **Select**.

   ![Select the extension folder](/en/assets/existing-chrome-select-folder.jpg)

3. Confirm that the extension is installed and shows version `0.0.1`.

   ![Extension installed](/en/assets/existing-chrome-installed.jpg)

4. Return to Farming, open Chrome's **Extensions** menu, and click
   **Farming Browser Connector**.

   ![Open the connector](/en/assets/existing-chrome-menu.jpg)

The connection is ready when the popup shows **Connected**. It reconnects automatically when you
open Farming again.

![Connected](/en/assets/existing-chrome-connected.jpg)

## Remove

Open `chrome://extensions`, find **Farming Browser Connector**, click **Remove**, and confirm.

The CLI can show the extension folder and connection status:

```bash
farming browser extension path
farming browser extension status
```
