import {
  createNativeBootstrapController,
  discardRetiredCopilotState,
  prepareRetiredCopilotState,
} from "./modules/native-bootstrap.js";
import { createPopupMessageHandler } from "./modules/popup-background.js";
import {
  handleFarmingSidePanelMessage,
  registerFarmingSidePanel,
} from "./modules/farming-side-panel.js";
import { createRelayCommandHandler } from "./modules/relay-command-handler.js";
import { openAuthenticatedRelaySocket } from "./modules/relay-connection.js";
// Farming extension service worker.
//
// Thin transport between the Farming extension relay (loopback WebSocket) and
// chrome.debugger. All CDP target synthesis lives server-side in the relay
// bridge; this worker owns tab eligibility/access and forwards allowed frames.
// The Farming tab group is the ACL in selected mode and an ownership marker
// in all-tabs mode.
import {
  ACCESS_MODE_SELECTED,
  FARMING_TAB_GROUP_COLOR,
  FARMING_TAB_GROUP_TITLE,
  createPairingConfigStore,
  reconnectDelayMs,
  toRelayTabInfo,
} from "./modules/relay-core.js";
import { findFarmingGroups, isTabSelected } from "./modules/relay-tab-groups.js";
import { registerTabAccessEvents } from "./modules/tab-access-events.js";
import { createTabAccessPolicy } from "./modules/tab-access.js";

const BADGE = {
  off: { text: "", color: "#000000" },
  connecting: { text: "", color: "#F59E0B" },
  on: { text: "", color: "#0F9D58" },
  error: { text: "", color: "#B91C1C" },
};
const RELAY_WATCHDOG_ALARM = "farming-relay-watchdog";
const RELAY_OPENING_DEADLINE_ALARM = "farming-relay-opening-deadline";
const RELAY_AUTH_TIMEOUT_MS = 10_000;
const AUTO_RECONNECT_KEY = "autoReconnectEnabled";

/** @type {WebSocket|null} */
let relayWs = null;
let relayState = "off"; // off | connecting | on | error
let reconnectAttempt = 0;
let reconnectTimer = null;
let relayOpeningDeadlineAt = 0;
let relayOpeningDeadlineTimer = null;
let relayAuthenticatedSocket = null;
let relayStatusHint = "";
let reconciledPairingInvalidationRevision = 0;
let relayConnectionGeneration = 0;
let relayConnectionsSuspended = false;
let nativeBootstrap = null;
let autoReconnectEnabled = true;
// Start blocked: no runtime path may outrun the retired-state storage read.
let retiredCopilotCustodyBlocked = true;
/** Tab ids with an active chrome.debugger attachment. */
const attachedTabs = new Set();
/** Access epoch proven for each attachment; debugger events use this synchronously. */
const attachedAccessEpochs = new Map();
/** In-flight attach promises per tab id (coalesces concurrent attaches). */
const attachingTabs = new Map();
/** Debounce handle for tab-list refreshes. */
let tabsSyncTimer = null;
let accessMutationChain = Promise.resolve();
const pairingConfigStore = createPairingConfigStore(chrome.storage.local);
const autoReconnectReady = chrome.storage.local.get(AUTO_RECONNECT_KEY).then((stored) => {
  autoReconnectEnabled = stored[AUTO_RECONNECT_KEY] !== false;
});
const tabAccessPolicy = createTabAccessPolicy({ isSelectedTab: isTabSelected });
const tabAccessReady = (async () => {
  const retiredState = await prepareRetiredCopilotState();
  retiredCopilotCustodyBlocked = retiredState.blocked;
  const config = await pairingConfigStore.read();
  await tabAccessPolicy.initialize(
    config.accessMode,
    Boolean(config.relayUrl) && !retiredCopilotCustodyBlocked,
  );
  if (retiredCopilotCustodyBlocked) {
    tabAccessPolicy.setEnabled(false);
    await detachAllDebuggerSessions();
  }
})();

const custodyError = () =>
  new Error(
    "Automation is paused to protect a pre-upgrade copilot session. Open Settings to disconnect before reconnecting.",
  );

async function requireAutomationAllowed() {
  await tabAccessReady;
  if (retiredCopilotCustodyBlocked) {
    throw custodyError();
  }
}

function closeRelaySocket() {
  const socket = relayWs;
  if (!socket) {
    return;
  }
  relayWs = null;
  if (relayAuthenticatedSocket === socket) {
    relayAuthenticatedSocket = null;
  }
  socket.close();
}

function suspendRelayConnections() {
  relayConnectionsSuspended = true;
  relayConnectionGeneration += 1;
}

function resumeRelayConnections() {
  relayConnectionsSuspended = false;
  relayConnectionGeneration += 1;
}

async function reconcilePairingInvalidation() {
  if (reconciledPairingInvalidationRevision === pairingConfigStore.invalidationRevision) {
    return;
  }
  reconciledPairingInvalidationRevision = pairingConfigStore.invalidationRevision;
  clearRelayOpeningDeadline();
  await syncTabsToRelay();
  closeRelaySocket();
  setBadge("off");
  await detachAllDebuggerSessions();
}

function setBadge(kind) {
  relayState = kind;
  const cfg = BADGE[kind] ?? BADGE.off;
  void chrome.action.setBadgeText({ text: cfg.text });
  void chrome.action.setBadgeBackgroundColor({ color: cfg.color });
}

async function getConfig() {
  await tabAccessReady;
  const config = await pairingConfigStore.read();
  if (retiredCopilotCustodyBlocked || !config.relayUrl) {
    tabAccessPolicy.setEnabled(false);
  }
  if (config.pairingStatusHint) {
    relayStatusHint = config.pairingStatusHint;
  }
  return config;
}

function runAccessMutation(task) {
  const pending = accessMutationChain.then(task, task);
  accessMutationChain = pending.catch(() => undefined);
  return pending;
}

// ---------------------------------------------------------------------------
// Tab group management (selected-mode ACL; all-mode ownership marker)
// ---------------------------------------------------------------------------

async function updateFarmingTabGroup(groupId) {
  await chrome.tabGroups.update(groupId, {
    title: FARMING_TAB_GROUP_TITLE,
    color: FARMING_TAB_GROUP_COLOR,
  });
}

async function syncFarmingTabGroupAppearance() {
  const groups = await findFarmingGroups();
  await Promise.all(groups.map((group) => updateFarmingTabGroup(group.id)));
}

async function addTabToFarmingGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const groups = await findFarmingGroups();
  const sameWindowGroup = groups.find((group) => group.windowId === tab.windowId);
  if (sameWindowGroup) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: sameWindowGroup.id });
    await updateFarmingTabGroup(sameWindowGroup.id);
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await updateFarmingTabGroup(groupId);
}

async function focusWindowForTab(tab) {
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

async function removeTabFromFarmingGroup(tabId) {
  try {
    await chrome.tabs.ungroup([tabId]);
  } catch {
    // tab may already be gone
  }
}

function scheduleTabsSync() {
  if (tabsSyncTimer) {
    return;
  }
  tabsSyncTimer = setTimeout(() => {
    tabsSyncTimer = null;
    void syncTabsToRelay();
  }, 150);
}

async function syncTabsToRelay() {
  if (retiredCopilotCustodyBlocked) {
    return;
  }
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN || relayAuthenticatedSocket !== relayWs) {
    return;
  }
  const accessible = await tabAccessPolicy.listAccessibleTabs();
  const accessibleIds = new Set(accessible.map((tab) => tab.id));
  for (const tabId of attachedTabs) {
    if (!accessibleIds.has(tabId)) {
      void detachDebugger(tabId);
    }
  }
  send({ type: "tabs", tabs: accessible.map(toRelayTabInfo) });
}

// ---------------------------------------------------------------------------
// chrome.debugger transport
// ---------------------------------------------------------------------------

async function attachDebugger(tabId) {
  await requireAutomationAllowed();
  const accessEpoch = tabAccessPolicy.capture(tabId);
  const assertAccess = async () => {
    await tabAccessPolicy.requireTab(tabId, accessEpoch);
  };
  await assertAccess();
  // Coalesce concurrent attaches for one tab. Two relay attach commands (or an
  // auto-attach racing an explicit share) would otherwise both call
  // chrome.debugger.attach and the second throws "Another debugger is already
  // attached". The bridge and this worker can also disagree after an MV3 restart.
  const inFlight = attachingTabs.get(tabId);
  if (inFlight) {
    const result = await inFlight;
    try {
      await assertAccess();
    } catch (error) {
      await detachDebugger(tabId);
      throw error;
    }
    return result;
  }
  const attach = (async () => {
    await assertAccess();
    if (!attachedTabs.has(tabId)) {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch (err) {
        // Treat an existing attachment as success; our own debugger is already on.
        if (!String(err?.message ?? err).includes("Another debugger is already attached")) {
          throw err;
        }
      }
      try {
        await assertAccess();
      } catch (error) {
        await detachDebugger(tabId);
        throw error;
      }
      attachedTabs.add(tabId);
    }
    const targets = await chrome.debugger.getTargets();
    try {
      await assertAccess();
    } catch (error) {
      await detachDebugger(tabId);
      throw error;
    }
    const target = targets.find((candidate) => candidate.tabId === tabId && candidate.attached);
    // The attachment is authorized only by the epoch proven across the whole
    // attach. Never replace it with a fresh post-await capture: that would let
    // a revocation during async unwind authorize later debugger events.
    if (!tabAccessPolicy.epochIsCurrent(tabId, accessEpoch)) {
      await detachDebugger(tabId);
      throw new Error(`tab ${tabId} access was revoked`);
    }
    attachedAccessEpochs.set(tabId, accessEpoch);
    return { targetId: target?.id ?? `tab-${tabId}` };
  })();
  attachingTabs.set(tabId, attach);
  try {
    return await attach;
  } finally {
    attachingTabs.delete(tabId);
  }
}

async function detachDebugger(tabId) {
  // Always call Chrome: an attach can complete before attachedTabs records it.
  // The unconditional detach closes that revocation race.
  attachedTabs.delete(tabId);
  attachedAccessEpochs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached or tab gone
  }
}

async function detachAllDebuggerSessions() {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  const tabIds = new Set(attachedTabs);
  for (const target of targets) {
    if (target.attached && typeof target.tabId === "number") {
      tabIds.add(target.tabId);
    }
  }
  await Promise.allSettled(attachingTabs.values());
  for (const tabId of attachedTabs) {
    tabIds.add(tabId);
  }
  await Promise.allSettled([...tabIds].map((tabId) => detachDebugger(tabId)));
}

async function reconcileAccessMode(nextMode, { transitioning = false } = {}) {
  await tabAccessReady;
  const previousMode = tabAccessPolicy.mode;
  const mode = tabAccessPolicy.setMode(nextMode);
  if (mode === previousMode) {
    if (transitioning) {
      tabAccessPolicy.endTransition();
    }
    return mode;
  }
  await Promise.allSettled(attachingTabs.values());
  if (mode === ACCESS_MODE_SELECTED) {
    const selectedIds = new Set(
      (
        await tabAccessPolicy.listAccessibleTabs({
          allowDuringTransition: transitioning,
        })
      ).map((tab) => tab.id),
    );
    await Promise.allSettled(
      [...attachedTabs]
        .filter((tabId) => !selectedIds.has(tabId))
        .map((tabId) => detachDebugger(tabId)),
    );
  }
  if (transitioning) {
    tabAccessPolicy.endTransition();
  }
  for (const tabId of attachedTabs) {
    const epoch = tabAccessPolicy.capture(tabId);
    const state = await tabAccessPolicy.inspectTab(tabId, epoch);
    if (!tabAccessPolicy.epochIsCurrent(tabId, epoch)) {
      // A post-transition tab event owns the newer revision. Keep this
      // attachment fail-closed until that handler reconciles it.
      continue;
    }
    if (!state.accessible) {
      await detachDebugger(tabId);
    } else if (attachedTabs.has(tabId)) {
      attachedAccessEpochs.set(tabId, epoch);
    }
  }
  await syncTabsToRelay();
  return mode;
}

async function pauseTab(tabId) {
  let storageError = null;
  try {
    await tabAccessPolicy.pause(tabId);
  } catch (error) {
    storageError = error;
  }
  await Promise.allSettled([attachingTabs.get(tabId)]);
  await detachDebugger(tabId);
  await syncTabsToRelay();
  if (storageError) {
    throw storageError instanceof Error
      ? storageError
      : new Error("Could not persist the tab pause.");
  }
}

// ---------------------------------------------------------------------------
// Relay connection
// ---------------------------------------------------------------------------

function send(message) {
  if (
    !retiredCopilotCustodyBlocked &&
    relayWs &&
    relayWs.readyState === WebSocket.OPEN &&
    relayAuthenticatedSocket === relayWs
  ) {
    relayWs.send(JSON.stringify(message));
  }
}

function clearRelayOpeningDeadline() {
  relayOpeningDeadlineAt = 0;
  if (relayOpeningDeadlineTimer) {
    clearTimeout(relayOpeningDeadlineTimer);
    relayOpeningDeadlineTimer = null;
  }
  void chrome.alarms.clear(RELAY_OPENING_DEADLINE_ALARM);
}

function armRelayOpeningDeadline() {
  clearRelayOpeningDeadline();
  relayOpeningDeadlineAt = Date.now() + RELAY_AUTH_TIMEOUT_MS;
  relayOpeningDeadlineTimer = setTimeout(handleRelayOpeningDeadline, RELAY_AUTH_TIMEOUT_MS);
  chrome.alarms.create(RELAY_OPENING_DEADLINE_ALARM, { when: relayOpeningDeadlineAt });
}

function failRelayAuthentication(ws, error) {
  if (relayWs !== ws) {
    return;
  }
  relayStatusHint =
    "Relay authentication v2 failed. Update Farming, or re-pair after a relay key rotation.";
  try {
    ws.close(4001, error instanceof Error ? error.message.slice(0, 120) : "authentication failed");
  } catch {
    closeRelaySocket();
    setBadge("error");
    scheduleReconnect();
  }
}

const handleRelayCommand = createRelayCommandHandler({
  send,
  attachDebugger,
  detachDebugger,
  addTabToFarmingGroup,
  focusWindowForTab,
  scheduleTabsSync,
  captureAccess: (tabId) => tabAccessPolicy.capture(tabId),
  requireAccessibleTab: (tabId, epoch) => tabAccessPolicy.requireTab(tabId, epoch),
});

async function sendHello() {
  const accessible = await tabAccessPolicy.listAccessibleTabs();
  const uaMatch = /Chrom(?:e|ium)\/[\d.]+/.exec(navigator.userAgent);
  send({
    type: "hello",
    userAgent: navigator.userAgent,
    browserVersion: uaMatch ? uaMatch[0] : "Chrome/unknown",
    extensionVersion: chrome.runtime.getManifest().version,
    tabs: accessible.map(toRelayTabInfo),
  });
}

async function connectRelay(isConnectionAllowed = () => true) {
  await tabAccessReady;
  if (retiredCopilotCustodyBlocked) {
    tabAccessPolicy.setEnabled(false);
    clearRelayOpeningDeadline();
    closeRelaySocket();
    setBadge("off");
    return;
  }
  const connectionGeneration = relayConnectionGeneration;
  const connectionIsCurrent = () =>
    !relayConnectionsSuspended &&
    connectionGeneration === relayConnectionGeneration &&
    isConnectionAllowed();
  const { relayUrl, token } = await getConfig();
  if (!connectionIsCurrent()) {
    return;
  }
  await reconcilePairingInvalidation();
  if (!connectionIsCurrent()) {
    return;
  }
  if (!relayUrl || !token) {
    clearRelayOpeningDeadline();
    setBadge("off");
    return;
  }
  if (
    relayWs &&
    (relayWs.readyState === WebSocket.OPEN || relayWs.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  // Pair revocation can race either awaited config step above. Keep the final
  // cancellation check adjacent to socket creation so a stale pair cannot reconnect.
  if (!connectionIsCurrent()) {
    return;
  }
  if (!await relayIsReachable(relayUrl)) {
    if (!connectionIsCurrent()) {
      return;
    }
    relayStatusHint = "Waiting for Farming to become reachable.";
    setBadge("error");
    scheduleReconnect();
    return;
  }
  if (!connectionIsCurrent()) {
    return;
  }
  setBadge("connecting");
  let ws;
  try {
    ws = openAuthenticatedRelaySocket({
      relayUrl,
      token,
      isCurrent: (socket) => relayWs === socket,
      onAuthenticated: async (socket) => {
        relayAuthenticatedSocket = socket;
        relayStatusHint = "";
        clearRelayOpeningDeadline();
        reconnectAttempt = 0;
        setBadge("on");
        await sendHello();
      },
      onApplicationMessage: (socket, msg) => {
        void handleRelayCommand(msg);
      },
      onAuthenticationFailure: (socket, error) => failRelayAuthentication(socket, error),
      onClose: (socket, authenticated) => {
        if (relayWs !== socket) {
          return;
        }
        clearRelayOpeningDeadline();
        relayWs = null;
        if (authenticated) {
          relayAuthenticatedSocket = null;
        } else if (!relayStatusHint) {
          relayStatusHint =
            "Relay authentication v2 failed. Update Farming, or re-pair after a relay key rotation.";
        }
        setBadge("error");
        scheduleReconnect();
      },
    });
  } catch {
    setBadge("error");
    scheduleReconnect();
    return;
  }
  relayWs = ws;
  relayAuthenticatedSocket = null;
  armRelayOpeningDeadline();
  // onclose follows onerror and drives the reconnect, so no error handler needed.
}

function handleRelayOpeningDeadline() {
  // Unit-test module isolation can outlive the mocked Chrome global. The real
  // MV3 worker always has chrome; a detached test timer has no owner to mutate.
  if (typeof chrome === "undefined") {
    relayOpeningDeadlineAt = 0;
    relayOpeningDeadlineTimer = null;
    return;
  }
  const ws = relayWs;
  if (!ws) {
    clearRelayOpeningDeadline();
    return;
  }
  if (relayAuthenticatedSocket === ws) {
    clearRelayOpeningDeadline();
    return;
  }
  if (relayOpeningDeadlineAt === 0 || Date.now() < relayOpeningDeadlineAt) {
    return;
  }

  // Clear ownership before close so a delayed close/open event from this
  // socket cannot mutate the replacement connection's badge or deadline.
  relayWs = null;
  relayAuthenticatedSocket = null;
  clearRelayOpeningDeadline();
  try {
    ws.close(4001, "relay authentication timed out");
  } catch {
    // The socket may have changed state while the alarm event was queued.
  }
  setBadge("error");
  relayStatusHint = "Relay authentication v2 timed out. Make sure Farming is up to date.";
  scheduleReconnect();
}

function scheduleReconnect() {
  if (!autoReconnectEnabled || reconnectTimer) {
    return;
  }
  const delay = reconnectDelayMs(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startAutomationSafely();
  }, delay);
}

function clearReconnectTimer() {
  if (!reconnectTimer) {
    return;
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function armRelayWatchdog() {
  chrome.alarms.create(RELAY_WATCHDOG_ALARM, { periodInMinutes: 0.5 });
}

async function getAutoReconnectEnabled() {
  await autoReconnectReady;
  return autoReconnectEnabled;
}

async function setAutoReconnectEnabled(enabled) {
  await autoReconnectReady;
  await chrome.storage.local.set({ [AUTO_RECONNECT_KEY]: enabled });
  autoReconnectEnabled = enabled;
  if (!enabled) {
    clearReconnectTimer();
    await chrome.alarms.clear(RELAY_WATCHDOG_ALARM);
    return false;
  }
  armRelayWatchdog();
  reconnectAttempt = 0;
  startAutomationSafely();
  return true;
}

async function relayIsReachable(relayUrl, timeoutMs = 1_000) {
  const probeUrl = new URL(relayUrl);
  probeUrl.protocol = probeUrl.protocol === "wss:" ? "https:" : "http:";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(probeUrl, {
      cache: "no-store",
      credentials: "omit",
      mode: "no-cors",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function startAutomation() {
  await autoReconnectReady;
  if (!autoReconnectEnabled) {
    return;
  }
  await tabAccessReady;
  await syncFarmingTabGroupAppearance();
  if (retiredCopilotCustodyBlocked) {
    return;
  }
  await nativeBootstrap.attempt();
  await connectRelay();
}

function startAutomationSafely() {
  void startAutomation().catch((error) => {
    relayStatusHint = error instanceof Error ? error.message : String(error);
    setBadge("error");
    scheduleReconnect();
  });
}

// ---------------------------------------------------------------------------
// Popup messaging + lifecycle
// ---------------------------------------------------------------------------

const handlePopupMessage = createPopupMessageHandler({
  pairingConfigStore,
  policy: tabAccessPolicy,
  accessReady: tabAccessReady,
  getConfig,
  getRelayState: () => relayState,
  getRelayStatusHint: () => relayStatusHint,
  getAutoReconnectEnabled,
  setAutoReconnectEnabled,
  getNativeBootstrapStatus: async () => {
    await tabAccessReady;
    return await nativeBootstrap.status();
  },
  enableNativeBootstrap: async (enabled) => {
    await requireAutomationAllowed();
    return enabled ? await nativeBootstrap.enable() : await nativeBootstrap.disableSynchronously();
  },
  onManualPairing: () => nativeBootstrap.enable({ attemptNow: false }),
  onUnpairStart: () => nativeBootstrap.disableSynchronously(),
  isRetiredCopilotCustodyBlocked: () => retiredCopilotCustodyBlocked,
  requireAutomationAllowed,
  discardRetiredCopilotCustody: async () => {
    retiredCopilotCustodyBlocked = true;
    tabAccessPolicy.setEnabled(false);
    tabAccessPolicy.invalidateAll();
    await discardRetiredCopilotState();
    retiredCopilotCustodyBlocked = false;
  },
  resetRelayState: () => {
    relayStatusHint = "";
    reconnectAttempt = 0;
  },
  suspendRelayConnections,
  resumeRelayConnections,
  reconcilePairingInvalidation,
  reconcileAccessMode,
  runAccessMutation,
  detachAllDebuggerSessions,
  syncTabsToRelay,
  clearRelayOpeningDeadline,
  closeRelaySocket,
  connectRelay,
  setBadge,
  attachingTabs,
  detachDebugger,
  removeTabFromFarmingGroup,
  addTabToFarmingGroup,
  scheduleTabsSync,
  pauseTab,
});
nativeBootstrap = createNativeBootstrapController({
  getPairing: getConfig,
  applyPairing: async (request) => await handlePopupMessage.applyPairing(request),
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => (
  handleFarmingSidePanelMessage(msg, reply, {
    applyPairing: handlePopupMessage.applyPairing,
  }) || handlePopupMessage(msg, reply)
));
registerFarmingSidePanel();

registerTabAccessEvents({
  accessReady: tabAccessReady,
  policy: tabAccessPolicy,
  attachedTabs,
  attachedAccessEpochs,
  attachingTabs,
  send,
  scheduleTabsSync,
  detachDebugger,
  pauseTab,
  removeTabFromFarmingGroup,
  runAccessMutation,
});

// Watchdog: MV3 can stop this worker; the alarm revives it and re-connects.
void autoReconnectReady.then(() => {
  if (autoReconnectEnabled) {
    armRelayWatchdog();
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RELAY_WATCHDOG_ALARM) {
    startAutomationSafely();
  } else if (alarm.name === RELAY_OPENING_DEADLINE_ALARM) {
    handleRelayOpeningDeadline();
  }
});
chrome.runtime.onStartup.addListener(() => {
  startAutomationSafely();
});
chrome.runtime.onInstalled.addListener(() => {
  startAutomationSafely();
});
startAutomationSafely();
