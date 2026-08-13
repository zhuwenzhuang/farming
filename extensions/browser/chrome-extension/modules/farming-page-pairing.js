async function requestFromCurrentFarming(operation) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:/u.test(tab.url ?? "")) {
    throw new Error("Open your Farming page in this tab, then click the extension again.");
  }
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
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
        const response = await fetch(
          requestedOperation === "activate" ? `${basePath}/api/settings` : endpoint,
          requestedOperation === "activate"
            ? {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({
                  browserExtensionEnabled: true,
                  browserSource: "extension",
                }),
              }
            : { credentials: "same-origin", headers: { Accept: "application/json" } },
        );
        const result = await response.json().catch(() => ({}));
        return response.ok
          ? {
              ok: true,
              connected: result.connected === true,
              pairingString: result.pairingString ?? "",
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

async function waitForCurrentFarmingConnection() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await requestFromCurrentFarming("status");
    if (status.connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome paired, but Farming did not observe the connection in time.");
}

export async function pairCurrentFarmingPage() {
  const pairing = await requestFromCurrentFarming("pair");
  if (!pairing.pairingString) {
    throw new Error("Farming did not return Browser pairing information.");
  }
  const paired = await chrome.runtime.sendMessage({
    type: "pair",
    pairingString: pairing.pairingString,
    accessMode: "all",
  });
  if (!paired?.ok) {
    throw new Error(paired?.error ?? "Could not pair this Chrome with Farming.");
  }
  await waitForCurrentFarmingConnection();
  await requestFromCurrentFarming("activate");
}
