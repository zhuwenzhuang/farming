async function waitForTabReady(chromeApi, tabId, timeoutMs = 5_000) {
  if ((await chromeApi.tabs.get(tabId)).status === "complete") return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chromeApi.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chromeApi.tabs.onUpdated.addListener(onUpdated);
    void chromeApi.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }, finish);
  });
}

async function reloadDiscardedTab(chromeApi, tabId, timeoutMs) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chromeApi.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(() => {
      finish(new Error(`Chrome did not finish restoring discarded tab ${tabId}`));
    }, timeoutMs);
    // Subscribe before reload: a discarded tab can transition from unloaded to
    // complete before chrome.tabs.reload() resolves.
    chromeApi.tabs.onUpdated.addListener(onUpdated);
    void chromeApi.tabs.reload(tabId).catch(finish);
  });
}

/** Restore a Chrome Memory Saver tab before opening its debugger session. */
export async function restoreDiscardedTab({
  chromeApi = chrome,
  tabId,
  initialTab,
  revalidate,
  timeoutMs = 15_000,
}) {
  if (initialTab?.discarded !== true) {
    return initialTab;
  }
  const initialUrl = initialTab.pendingUrl || initialTab.url || "";
  await reloadDiscardedTab(chromeApi, tabId, timeoutMs);
  const restored = await revalidate();
  if (restored?.discarded === true) {
    throw new Error(`Chrome could not restore discarded tab ${tabId}`);
  }
  const restoredUrl = restored?.pendingUrl || restored?.url || "";
  if (restoredUrl !== initialUrl) {
    throw new Error(`Chrome tab ${tabId} changed while it was being restored`);
  }
  return restored;
}

/** Build the authenticated application-command dispatcher for the relay socket. */
export function createRelayCommandHandler({
  send,
  attachDebugger,
  detachDebugger,
  addTabToFarmingGroup,
  focusWindowForTab,
  scheduleTabsSync,
  captureAccess,
  requireAccessibleTab,
  chromeApi = chrome,
}) {
  return async (message) => {
    const { seq } = message;
    try {
      switch (message.type) {
        case "ping":
          send({ type: "pong" });
          return;
        case "attach":
          {
            const epoch = captureAccess(message.tabId);
            const tab = await requireAccessibleTab(message.tabId, epoch);
            await restoreDiscardedTab({
              chromeApi,
              tabId: message.tabId,
              initialTab: tab,
              // Reloading intentionally produces a URL update event, which
              // retires the pre-reload authority epoch. Re-prove access only
              // after the exact tab has completed restoring; restoreDiscardedTab
              // also verifies that its URL did not change.
              revalidate: () => requireAccessibleTab(
                message.tabId,
                captureAccess(message.tabId),
              ),
            });
          }
          send({ type: "result", seq, result: await attachDebugger(message.tabId) });
          return;
        case "detach":
          await detachDebugger(message.tabId);
          send({ type: "result", seq, result: {} });
          return;
        case "cdp": {
          const epoch = captureAccess(message.tabId);
          await requireAccessibleTab(message.tabId, epoch);
          const target = message.sessionId
            ? { tabId: message.tabId, sessionId: message.sessionId }
            : { tabId: message.tabId };
          const result = await chromeApi.debugger.sendCommand(
            target,
            message.method,
            message.params ?? {},
          );
          await requireAccessibleTab(message.tabId, epoch);
          send({ type: "result", seq, result: result ?? {} });
          return;
        }
        case "createTab": {
          const url = message.url === "about:blank"
            ? "data:text/html,<title>Farming</title>"
            : message.url;
          const tab = await chromeApi.tabs.create({
            url,
            active: message.background !== true,
          });
          await waitForTabReady(chromeApi, tab.id);
          await addTabToFarmingGroup(tab.id);
          if (message.focus === true) {
            await focusWindowForTab(tab);
          }
          scheduleTabsSync();
          send({ type: "result", seq, result: { tabId: tab.id } });
          return;
        }
        case "closeTab": {
          const epoch = captureAccess(message.tabId);
          await requireAccessibleTab(message.tabId, epoch);
          await detachDebugger(message.tabId);
          await requireAccessibleTab(message.tabId, epoch);
          await chromeApi.tabs.remove(message.tabId);
          send({ type: "result", seq, result: {} });
          return;
        }
        case "activateTab": {
          const epoch = captureAccess(message.tabId);
          const tab = await requireAccessibleTab(message.tabId, epoch);
          await chromeApi.tabs.update(message.tabId, { active: true });
          await requireAccessibleTab(message.tabId, epoch);
          await focusWindowForTab(tab);
          await requireAccessibleTab(message.tabId, epoch);
          send({ type: "result", seq, result: {} });
          return;
        }
        default:
          if (typeof seq === "number") {
            send({ type: "error", seq, message: `unknown relay command: ${message.type}` });
          }
      }
    } catch (error) {
      if (typeof seq === "number") {
        send({
          type: "error",
          seq,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}
