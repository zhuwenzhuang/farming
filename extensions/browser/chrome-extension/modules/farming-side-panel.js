import {
  pairCurrentFarmingPage,
  sidePanelUrlForFarmingTab,
} from "./farming-page-pairing.js";

function isLocalFarmingTab(tab) {
  if (!tab?.id || !/^https?:\/\//u.test(tab.url ?? "")) return false;
  const url = new URL(tab.url);
  return (
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    && url.pathname.includes("/farming")
  );
}

async function findFarmingTab(preferredTab, chromeApi) {
  if (isLocalFarmingTab(preferredTab)) return preferredTab;
  const tabs = await chromeApi.tabs.query({});
  return tabs
    .filter(isLocalFarmingTab)
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
}

async function prepareFarmingSidePanel(tab, chromeApi, applyPairing) {
  const farmingTab = await findFarmingTab(tab, chromeApi);
  if (!farmingTab) {
    await chromeApi.storage.session.remove("farmingSidePanelUrl");
    return false;
  }
  const sidePanelUrl = await sidePanelUrlForFarmingTab(farmingTab.id);
  await chromeApi.storage.session.set({ farmingSidePanelUrl: sidePanelUrl });
  void pairCurrentFarmingPage({
    waitForConnection: false,
    applyPairing,
    tabId: farmingTab.id,
  })
    .catch((error) => console.error("Could not connect this Chrome to Farming.", error));
  return true;
}

export function handleFarmingSidePanelMessage(
  msg,
  reply,
  { chromeApi = chrome, applyPairing } = {},
) {
  if (msg?.type !== "openFarmingSidePanel") return false;
  void chromeApi.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
    const opened = await prepareFarmingSidePanel(tab, chromeApi, applyPairing);
    reply({ ok: opened });
  }).catch((error) => {
    console.error("Could not open Farming in the side panel.", error);
    reply({ ok: false });
  });
  return true;
}

export function registerFarmingSidePanel({ chromeApi = chrome } = {}) {
  chromeApi.action.onClicked.addListener((tab) => {
    if (typeof tab.windowId !== "number") return;
    void chromeApi.sidePanel.open({ windowId: tab.windowId })
      .catch((error) => console.error("Could not open the Farming side panel.", error));
  });
}
