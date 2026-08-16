#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(process.argv[2] || '');
if (!sourceRoot || !fs.existsSync(path.join(sourceRoot, '.git'))) {
  throw new Error('Usage: npm run sync:openclaw-browser-extension -- /path/to/openclaw-checkout');
}

const upstreamRoot = path.join(sourceRoot, 'extensions', 'browser', 'chrome-extension');
const destinationRoot = path.join(repoRoot, 'extensions', 'browser', 'chrome-extension');
const rootFiles = ['background.js', 'manifest.json'];
const moduleFiles = [
  'native-bootstrap.js',
  'popup-background.js',
  'relay-auth-v2-crypto.js',
  'relay-auth-v2.js',
  'relay-command-handler.js',
  'relay-connection.js',
  'relay-core.js',
  'relay-tab-groups.js',
  'tab-access-events.js',
  'tab-access.js',
  'tab-eligibility.js',
];

function transform(source) {
  return source
    .replaceAll('OpenClaw', 'Farming')
    .replaceAll('openclaw', 'farming')
    .replaceAll('OPENCLAW', 'FARMING');
}

function transformIntegration(relativePath, source) {
  if (relativePath === 'background.js') {
    return source
      .replace(
        '  FARMING_TAB_GROUP_TITLE,',
        '  FARMING_TAB_GROUP_COLOR,\n  FARMING_TAB_GROUP_TITLE,',
      )
      .replace(
        'const RELAY_AUTH_TIMEOUT_MS = 10_000;',
        'const RELAY_AUTH_TIMEOUT_MS = 10_000;\nconst AUTO_RECONNECT_KEY = "autoReconnectEnabled";',
      )
      .replace(
        'let nativeBootstrap = null;',
        'let nativeBootstrap = null;\nlet autoReconnectEnabled = true;',
      )
      .replace(
        'const pairingConfigStore = createPairingConfigStore(chrome.storage.local);',
        'const pairingConfigStore = createPairingConfigStore(chrome.storage.local);\nconst autoReconnectReady = chrome.storage.local.get(AUTO_RECONNECT_KEY).then((stored) => {\n  autoReconnectEnabled = stored[AUTO_RECONNECT_KEY] !== false;\n});',
      )
      .replace(
        'async function addTabToFarmingGroup(tabId) {',
        'async function updateFarmingTabGroup(groupId) {\n  await chrome.tabGroups.update(groupId, {\n    title: FARMING_TAB_GROUP_TITLE,\n    color: FARMING_TAB_GROUP_COLOR,\n  });\n}\n\nasync function syncFarmingTabGroupAppearance() {\n  const groups = await findFarmingGroups();\n  await Promise.all(groups.map((group) => updateFarmingTabGroup(group.id)));\n}\n\nasync function addTabToFarmingGroup(tabId) {',
      )
      .replace(
        '    await chrome.tabs.group({ tabIds: [tabId], groupId: sameWindowGroup.id });\n    return;',
        '    await chrome.tabs.group({ tabIds: [tabId], groupId: sameWindowGroup.id });\n    await updateFarmingTabGroup(sameWindowGroup.id);\n    return;',
      )
      .replace('  const { groupColor } = await getConfig();\n', '')
      .replace(
        '  await chrome.tabGroups.update(groupId, {\n    title: FARMING_TAB_GROUP_TITLE,\n    color: groupColor,\n  });',
        '  await updateFarmingTabGroup(groupId);',
      )
      .replace(
        'function scheduleReconnect() {\n  if (reconnectTimer) {',
        'function scheduleReconnect() {\n  if (!autoReconnectEnabled || reconnectTimer) {',
      )
      .replace(
        '    void startAutomation();\n  }, delay);\n}\n\nasync function startAutomation() {',
        '    startAutomationSafely();\n  }, delay);\n}\n\nfunction clearReconnectTimer() {\n  if (!reconnectTimer) {\n    return;\n  }\n  clearTimeout(reconnectTimer);\n  reconnectTimer = null;\n}\n\nfunction armRelayWatchdog() {\n  chrome.alarms.create(RELAY_WATCHDOG_ALARM, { periodInMinutes: 0.5 });\n}\n\nasync function getAutoReconnectEnabled() {\n  await autoReconnectReady;\n  return autoReconnectEnabled;\n}\n\nasync function setAutoReconnectEnabled(enabled) {\n  await autoReconnectReady;\n  await chrome.storage.local.set({ [AUTO_RECONNECT_KEY]: enabled });\n  autoReconnectEnabled = enabled;\n  if (!enabled) {\n    clearReconnectTimer();\n    await chrome.alarms.clear(RELAY_WATCHDOG_ALARM);\n    return false;\n  }\n  armRelayWatchdog();\n  reconnectAttempt = 0;\n  startAutomationSafely();\n  return true;\n}\n\nasync function relayIsReachable(relayUrl, timeoutMs = 1_000) {\n  const probeUrl = new URL(relayUrl);\n  probeUrl.protocol = probeUrl.protocol === "wss:" ? "https:" : "http:";\n  const controller = new AbortController();\n  const timer = setTimeout(() => controller.abort(), timeoutMs);\n  try {\n    await fetch(probeUrl, {\n      cache: "no-store",\n      credentials: "omit",\n      mode: "no-cors",\n      signal: controller.signal,\n    });\n    return true;\n  } catch {\n    return false;\n  } finally {\n    clearTimeout(timer);\n  }\n}\n\nasync function startAutomation() {',
      )
      .replace(
        'async function startAutomation() {\n  await tabAccessReady;',
        'async function startAutomation() {\n  await autoReconnectReady;\n  if (!autoReconnectEnabled) {\n    return;\n  }\n  await tabAccessReady;\n  await syncFarmingTabGroupAppearance();',
      )
      .replace(
        '  // Pair revocation can race either awaited config step above. Keep the final\n  // cancellation check adjacent to socket creation so a stale pair cannot reconnect.\n  if (!connectionIsCurrent()) {\n    return;\n  }\n  setBadge("connecting");',
        '  // Pair revocation can race either awaited config step above. Keep the final\n  // cancellation check adjacent to socket creation so a stale pair cannot reconnect.\n  if (!connectionIsCurrent()) {\n    return;\n  }\n  if (!await relayIsReachable(relayUrl)) {\n    if (!connectionIsCurrent()) {\n      return;\n    }\n    relayStatusHint = "Waiting for Farming to become reachable.";\n    setBadge("error");\n    scheduleReconnect();\n    return;\n  }\n  if (!connectionIsCurrent()) {\n    return;\n  }\n  setBadge("connecting");',
      )
      .replace(
        '  await connectRelay();\n}\n\n// ---------------------------------------------------------------------------\n// Popup messaging + lifecycle',
        '  await connectRelay();\n}\n\nfunction startAutomationSafely() {\n  void startAutomation().catch((error) => {\n    relayStatusHint = error instanceof Error ? error.message : String(error);\n    setBadge("error");\n    scheduleReconnect();\n  });\n}\n\n// ---------------------------------------------------------------------------\n// Popup messaging + lifecycle',
      )
      .replace(
        'import { createPopupMessageHandler } from "./modules/popup-background.js";',
        'import { createPopupMessageHandler } from "./modules/popup-background.js";\nimport {\n  handleFarmingSidePanelMessage,\n  registerFarmingSidePanel,\n} from "./modules/farming-side-panel.js";',
      )
      .replace('connecting: { text: "…",', 'connecting: { text: "",')
      .replace('on: { text: "ON",', 'on: { text: "",')
      .replace('error: { text: "!",', 'error: { text: "",')
      .replace(
        'chrome.runtime.onMessage.addListener((msg, _sender, reply) => handlePopupMessage(msg, reply));',
        'chrome.runtime.onMessage.addListener((msg, _sender, reply) => (\n  handleFarmingSidePanelMessage(msg, reply, {\n    applyPairing: handlePopupMessage.applyPairing,\n  }) || handlePopupMessage(msg, reply)\n));\nregisterFarmingSidePanel();',
      )
      .replace(
        '    if (!retiredCopilotCustodyBlocked) {\n      await nativeBootstrap.attempt();\n    }\n    return await nativeBootstrap.status();',
        '    return await nativeBootstrap.status();',
      )
      .replace(
        '  getRelayStatusHint: () => relayStatusHint,',
        '  getRelayStatusHint: () => relayStatusHint,\n  getAutoReconnectEnabled,\n  setAutoReconnectEnabled,',
      )
      .replace(
        '// Watchdog: MV3 can stop this worker; the alarm revives it and re-connects.\nchrome.alarms.create(RELAY_WATCHDOG_ALARM, { periodInMinutes: 0.5 });',
        '// Watchdog: MV3 can stop this worker; the alarm revives it and re-connects.\nvoid autoReconnectReady.then(() => {\n  if (autoReconnectEnabled) {\n    armRelayWatchdog();\n  }\n});',
      )
      .replaceAll(
        'void startAutomation();',
        'startAutomationSafely();',
      );
  }
  if (relativePath === 'modules/popup-background.js') {
    return source
      .replace('nearestGroupColor,', 'FARMING_TAB_GROUP_COLOR,')
      .replace(
        'pairingConfigStore.save(parsed, nearestGroupColor(), normalizedMode)',
        'pairingConfigStore.save(parsed, FARMING_TAB_GROUP_COLOR, normalizedMode)',
      )
      .replace(
        'const { relayUrl, accessMode } = await getConfig();',
        'const { relayUrl, gatewayUrl, accessMode } = await getConfig();',
      )
      .replace(
        'relayUrl: relayUrl ?? "",',
        'relayUrl: relayUrl ?? "",\n              gatewayUrl: gatewayUrl ?? "",',
      )
      .replace(
        '  getRelayStatusHint,',
        '  getRelayStatusHint,\n  getAutoReconnectEnabled,\n  setAutoReconnectEnabled,',
      )
      .replace(
        '              state: getRelayState(),',
        '              state: getRelayState(),\n              autoReconnectEnabled: await getAutoReconnectEnabled(),',
      )
      .replace(
        '          case "setNativeBootstrapEnabled":',
        '          case "setAutoReconnectEnabled":\n            if (typeof msg.enabled !== "boolean") {\n              sendResponse({ ok: false, error: "Invalid automatic reconnect setting." });\n              return;\n            }\n            sendResponse({\n              ok: true,\n              autoReconnectEnabled: await setAutoReconnectEnabled(msg.enabled),\n            });\n            return;\n          case "setNativeBootstrapEnabled":',
      );
  }
  if (relativePath !== 'modules/relay-core.js') return source;
  return source
    .replace(
      'export const FARMING_TAB_GROUP_TITLE = "Farming";',
      'export const FARMING_TAB_GROUP_TITLE = "Farming";\nexport const FARMING_TAB_GROUP_COLOR = "green";',
    )
    .replace(
      'groupColor: typeof stored.groupColor === "string" ? stored.groupColor : "orange",',
      'groupColor: FARMING_TAB_GROUP_COLOR,',
    )
    .replace(
      '/** Exponential reconnect backoff: 1s, 2s, 4s ... capped at 30s. */\nexport function reconnectDelayMs(attempt) {\n  const capped = Math.min(Math.max(0, attempt), 5);\n  return Math.min(1000 * 2 ** capped, 30_000);\n}',
      '/** Exponential reconnect backoff: 1s, 2s, 4s ... capped at 5 minutes. */\nexport function reconnectDelayMs(attempt) {\n  const capped = Math.min(Math.max(0, attempt), 9);\n  return Math.min(1000 * 2 ** capped, 300_000);\n}',
    )
    .replace('relay.pathname !== "/browser/extension"', '!relay.pathname.endsWith("/browser/extension")')
    .replace('gateway.pathname = "/";', 'gateway.pathname = relay.pathname.slice(0, -"/browser/extension".length) || "/";')
    .replace(
      'isAllowedWebSocketUrl(relay) &&\n      relay.pathname !== "/browser/extension" &&\n      relay.pathname.endsWith("/browser/extension")',
      'isAllowedWebSocketUrl(relay) && !relay.pathname.endsWith("/browser/extension")',
    )
    .replace('relay.pathname === "/browser/extension";', 'relay.pathname.endsWith("/browser/extension");');
}

function syncFile(source, destination, relativePath) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    transformIntegration(relativePath, transform(fs.readFileSync(source, 'utf8'))),
  );
}

for (const file of rootFiles) syncFile(path.join(upstreamRoot, file), path.join(destinationRoot, file), file);
for (const file of moduleFiles) {
  const relativePath = path.join('modules', file);
  syncFile(path.join(upstreamRoot, relativePath), path.join(destinationRoot, relativePath), relativePath);
}

const manifestPath = path.join(destinationRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.name = 'Farming Browser Connector';
manifest.version = '0.0.1';
manifest.description = 'Let Agents in Farming use your browser.';
manifest.permissions = [...new Set([...manifest.permissions, 'scripting'])]
  .filter(permission => permission !== 'activeTab');
manifest.permissions = [...new Set([...manifest.permissions, 'sidePanel'])];
manifest.icons = {
  16: 'icons/farming-16.png',
  32: 'icons/farming-32.png',
  48: 'icons/farming-48.png',
  128: 'icons/farming-128.png',
};
manifest.action = {
  ...manifest.action,
  default_title: 'Farming',
  default_icon: {
    16: 'icons/farming-16.png',
    32: 'icons/farming-32.png',
  },
};
delete manifest.action.default_popup;
manifest.side_panel = { default_path: 'sidepanel.html' };
manifest.host_permissions = ['<all_urls>'];
delete manifest.options_ui;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

for (const file of [
  'sidepanel.html',
  'sidepanel.js',
  'modules/farming-page-pairing.js',
  'modules/farming-side-panel.js',
]) {
  if (!fs.existsSync(path.join(destinationRoot, file))) {
    throw new Error(`Farming-owned ${file} is missing after the upstream sync.`);
  }
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
const upstreamDirectory = path.join(destinationRoot, 'upstream');
fs.mkdirSync(upstreamDirectory, { recursive: true });
fs.copyFileSync(path.join(sourceRoot, 'LICENSE'), path.join(upstreamDirectory, 'LICENSE.openclaw'));
fs.writeFileSync(path.join(upstreamDirectory, 'upstream.json'), `${JSON.stringify({
  repository: 'https://github.com/openclaw/openclaw',
  commit,
  license: 'MIT',
  sourcePath: 'extensions/browser/chrome-extension',
  relaySourcePath: 'extensions/browser/src/browser/extension-relay',
  transform: 'Farming identity namespaces, Farming-owned side panel, and Farming base-path pairing support',
}, null, 2)}\n`);

console.log(`Synchronized Farming Browser Connector from OpenClaw ${commit}.`);
