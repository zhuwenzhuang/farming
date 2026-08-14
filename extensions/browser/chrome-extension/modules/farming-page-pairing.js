async function requestFromFarmingTab(operation, requestedTabId) {
  const [activeTab] = requestedTabId
    ? []
    : await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = requestedTabId ?? activeTab?.id;
  if (!tabId) {
    throw new Error("Open your Farming page in this tab, then click the extension again.");
  }
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (requestedOperation) => {
      try {
        const configuredBase = typeof window.__FARMING_BASE_PATH__ === "string"
          ? window.__FARMING_BASE_PATH__
          : "";
        const basePath = configuredBase && configuredBase !== "/"
          ? configuredBase.replace(/\/+$/u, "")
          : "";
        const endpoint = `${basePath}/api/browsers/extension`;
        const sidePanelEndpoint = `${basePath}/api/share/qr-ticket`;
        const response = await fetch(
          requestedOperation === "activate"
            ? `${basePath}/api/settings`
            : requestedOperation === "side-panel"
              ? sidePanelEndpoint
              : endpoint,
          requestedOperation === "activate"
            ? {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({
                  browserExtensionEnabled: true,
                }),
              }
            : requestedOperation === "side-panel"
              ? {
                  method: "POST",
                  credentials: "same-origin",
                  headers: { "Content-Type": "application/json", Accept: "application/json" },
                  body: "{}",
                }
            : { credentials: "same-origin", headers: { Accept: "application/json" } },
        );
        const result = await response.json().catch(() => ({}));
        return response.ok
          ? {
              ok: true,
              connected: result.connected === true,
              pairingString: result.pairingString ?? "",
              pageUrl: window.location.href,
              sidePanelUrl: result.fullAccessUrl ?? "",
            }
          : { ok: false, error: result.error ?? `Farming returned HTTP ${response.status}` };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    args: [operation],
  });
  const result = execution?.result;
  if (!result?.ok) {
    throw new Error(result?.error ?? "This is not an available Farming owner page.");
  }
  return result;
}

async function waitForCurrentFarmingConnection(tabId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await requestFromFarmingTab("status", tabId);
    if (status.connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome paired, but Farming did not observe the connection in time.");
}

export async function pairCurrentFarmingPage({
  waitForConnection = true,
  applyPairing,
  tabId,
} = {}) {
  const pairing = await requestFromFarmingTab("pair", tabId);
  if (!pairing.pairingString) {
    throw new Error("Farming did not return Browser pairing information.");
  }
  const pairRequest = {
    pairingString: pairing.pairingString,
    accessMode: "all",
  };
  const paired = typeof applyPairing === "function"
    ? await applyPairing({ ...pairRequest, source: "manual" })
    : await chrome.runtime.sendMessage({ type: "pair", ...pairRequest });
  if (!paired?.ok) {
    throw new Error(paired?.error ?? "Could not pair this Chrome with Farming.");
  }
  if (waitForConnection) {
    await waitForCurrentFarmingConnection(tabId);
  }
  await requestFromFarmingTab("activate", tabId);
  return { pageUrl: pairing.pageUrl };
}

export async function sidePanelUrlForFarmingTab(tabId) {
  const sidePanel = await requestFromFarmingTab("side-panel", tabId);
  if (!sidePanel.sidePanelUrl) {
    throw new Error("Farming did not return a side panel link.");
  }
  return sidePanel.sidePanelUrl;
}
