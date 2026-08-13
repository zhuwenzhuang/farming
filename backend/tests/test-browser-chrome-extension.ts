const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const { BrowserExtensionRelay } = require('../../extensions/browser/backend/browser-extension-relay.cjs');
const { ExtensionRelayBridge } = require('../../extensions/browser/backend/openclaw-relay/relay-bridge.cjs');
const {
  createRelayProof,
  randomRelayNonce,
  relayKeyIdFromHex,
  verifyRelayProof,
} = require('../../extensions/browser/backend/openclaw-relay/auth-v2-crypto.cjs');
const { BrowserResourceManager } = require('../../extensions/browser/backend/browser-resource-manager.cjs');

type BrowserRelayAuthChallenge = import(
  '../../extensions/browser/backend/openclaw-relay/auth-v2-crypto.cjs'
).BrowserRelayAuthChallenge;
type BrowserRelayAuthOk = import(
  '../../extensions/browser/backend/openclaw-relay/auth-v2-crypto.cjs'
).BrowserRelayAuthOk;

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function getStatus(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
}

async function waitFor(check, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for Browser extension state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function run() {
  const extensionRoot = path.resolve(__dirname, '../../extensions/browser/chrome-extension');
  const manifest = JSON.parse(read(path.join(extensionRoot, 'manifest.json')));
  assert.strictEqual(manifest.name, 'Farming Browser Connector');
  assert.strictEqual(manifest.permissions.includes('debugger'), true);

  const relayCore = read(path.join(extensionRoot, 'modules/relay-core.js'));
  const nativeBootstrap = read(path.join(extensionRoot, 'modules/native-bootstrap.js'));
  const background = read(path.join(extensionRoot, 'background.js'));
  assert.match(relayCore, /farming-extension-relay\.v2/);
  assert.match(relayCore, /FARMING_TAB_GROUP_TITLE = "Farming"/);
  assert.match(relayCore, /endsWith\("\/browser\/extension"\)/);
  assert.match(nativeBootstrap, /ai\.farming\.browser_bootstrap/);
  assert.doesNotMatch(`${relayCore}\n${nativeBootstrap}\n${background}`, /OpenClaw|openclaw|OPENCLAW/);

  const bridge = new ExtensionRelayBridge();
  const extensionMessages = [];
  const extensionSocket = {
    send: message => extensionMessages.push(JSON.parse(message)),
    close: () => {},
  };
  const extension = bridge.attachExtensionSocket(extensionSocket);
  extension.onMessage(JSON.stringify({
    type: 'hello',
    userAgent: 'Chrome Test',
    browserVersion: 'Chrome/144.0.0.0',
    extensionVersion: manifest.version,
    tabs: [],
  }));
  assert.strictEqual(bridge.extensionConnected, true);

  const cdpMessages = [];
  const cdp = bridge.attachCdpClientSocket({
    send: message => cdpMessages.push(JSON.parse(message)),
    close: () => {},
  });
  cdp.onMessage(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(cdpMessages[0].id, 1);
  assert.strictEqual(cdpMessages[0].result.product, 'Chrome/144.0.0.0');
  cdp.onClose();
  extension.onClose();
  bridge.dispose();

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-extension-'));
  const relay = new BrowserExtensionRelay({ configDir });
  let publicServer;
  let publicWss;
  let extensionClient;
  try {
    await relay.init();
    const capability = relay.capability();
    assert.strictEqual(capability.installed, true);
    assert.strictEqual(capability.connected, false);
    assert.match(relay.pairingString('ws://127.0.0.1:3000/farming/browser/extension'), /^ws:.*#[0-9a-f]{64}$/);
    assert.strictEqual(await getStatus(`${relay.cdpUrl()}/json/version`), 503);
    const secret = path.join(configDir, 'credentials', 'farming-browser-extension-relay.secret');
    assert.strictEqual(fs.statSync(secret).mode & 0o077, 0);

    publicServer = http.createServer();
    publicWss = new WebSocketServer({ server: publicServer });
    publicWss.on('connection', (socket, request) => {
      relay.attachWebSocket(socket, request, '/farming/browser/extension');
    });
    await new Promise(resolve => publicServer.listen(0, '127.0.0.1', resolve));
    const publicPort = publicServer.address().port;
    const pairing = relay.pairingString(`ws://127.0.0.1:${publicPort}/farming/browser/extension`);
    const token = pairing.slice(pairing.indexOf('#') + 1);
    const clientNonce = randomRelayNonce();
    extensionClient = new WebSocket(pairing.slice(0, pairing.indexOf('#')), ['farming-extension-relay.v2']);
    await new Promise((resolve, reject) => {
      extensionClient.once('open', resolve);
      extensionClient.once('error', reject);
    });
    extensionClient.send(JSON.stringify({
      type: 'auth.hello',
      v: 2,
      keyId: relayKeyIdFromHex(token),
      clientNonce,
    }));
    const challenge = await new Promise<BrowserRelayAuthChallenge>((resolve, reject) => {
      extensionClient.once('message', raw => resolve(JSON.parse(raw.toString())));
      extensionClient.once('error', reject);
    });
    const fields = {
      keyId: challenge.keyId,
      instanceId: challenge.instanceId,
      sessionId: challenge.sessionId,
      clientNonce: challenge.clientNonce,
      serverNonce: challenge.serverNonce,
      issuedAtMs: challenge.issuedAtMs,
      expiresAtMs: challenge.expiresAtMs,
      role: challenge.role,
      transport: challenge.transport,
      method: challenge.method,
      resource: challenge.resource,
      flow: challenge.flow,
    };
    assert.strictEqual(verifyRelayProof(token, 'server', fields, challenge.serverProof), true);
    const clientProof = createRelayProof(token, 'client', fields);
    extensionClient.send(JSON.stringify({
      type: 'auth.response',
      v: 2,
      sessionId: challenge.sessionId,
      clientProof,
    }));
    const accepted = await new Promise<BrowserRelayAuthOk>((resolve, reject) => {
      extensionClient.once('message', raw => resolve(JSON.parse(raw.toString())));
      extensionClient.once('error', reject);
    });
    assert.strictEqual(verifyRelayProof(token, 'accept', fields, accepted.acceptProof, clientProof), true);
    extensionClient.send(JSON.stringify({
      type: 'hello',
      userAgent: 'Chrome Test',
      browserVersion: 'Chrome/144.0.0.0',
      extensionVersion: manifest.version,
      tabs: [],
    }));
    await waitFor(() => relay.capability().connected === true);
    assert.strictEqual(relay.capability().connected, true);
    assert.strictEqual(await getStatus(`${relay.cdpUrl()}/json/version`), 200);
  } finally {
    extensionClient?.close();
    publicWss?.close();
    if (publicServer) await new Promise(resolve => publicServer.close(resolve));
    await relay.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  const managerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-extension-manager-'));
  try {
    const discovered = [];
    const connectedRelay = {
      capability: () => ({ connected: true }),
      cdpUrl: () => 'http://127.0.0.1:19444',
      pairingString: url => `${url}#${'a'.repeat(64)}`,
    };
    const manager = new BrowserResourceManager({
      configDir: managerDir,
      getBrowserSettings: () => ({ browserSource: 'extension' }),
      browserExtensionRelay: connectedRelay,
      discoverBrowserOptions: () => [],
      discoverExecutable: async selection => {
        discovered.push(selection);
        return selection.source === 'external-cdp'
          ? { kind: 'external-cdp', path: '', cdpUrl: selection.externalCdpUrl, agentBrowserPath: '/agent-browser' }
          : null;
      },
    });
    const probe = await manager.probeCapability(manager.browserSelection());
    assert.strictEqual(probe.runtimeCapability.kind, 'chrome-extension');
    assert.strictEqual(probe.runtimeCapability.cdpUrl, 'http://127.0.0.1:19444');
    assert.strictEqual(discovered.at(-1).source, 'external-cdp');
  } finally {
    fs.rmSync(managerDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
