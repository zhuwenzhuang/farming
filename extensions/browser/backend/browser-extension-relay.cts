import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import {
  BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
  getBrowserRelayAuthV2Authority,
  parseExtensionRelayResource,
} from './openclaw-relay/auth-v2.cjs';
import {
  attachExtensionWebSocket,
  authenticateExtensionWebSocket,
  startExtensionRelayServer,
  type ExtensionRelayHandle,
} from './openclaw-relay/relay-server.cjs';
import { isAllowedExtensionOrigin, requestProtocols } from './openclaw-relay/relay-request.cjs';

const RELAY_SECRET_PATTERN = /^[0-9a-f]{64}$/u;
const RELAY_SECRET_FILE = 'farming-browser-extension-relay.secret';

type BrowserExtensionRelayOptions = {
  configDir: string;
  onStateChange?: () => void;
};

function secretPath(configDir: string): string {
  return path.join(configDir, 'credentials', RELAY_SECRET_FILE);
}

function ensureRelaySecret(configDir: string): string {
  const file = secretPath(configDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!RELAY_SECRET_PATTERN.test(token)) {
    throw new Error('Farming Browser extension relay secret is malformed');
  }
  return token;
}

function extensionDigest(root: string): string {
  const hash = crypto.createHash('sha256');
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        hash.update(path.relative(root, absolute));
        hash.update(fs.readFileSync(absolute));
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function prepareInstalledExtension(source: string, configDir: string): string {
  const parent = path.join(configDir, 'browser-extension');
  const installed = path.join(parent, 'chrome');
  const stamp = '.farming-content-sha256';
  const digest = extensionDigest(source);
  try {
    if (fs.readFileSync(path.join(installed, stamp), 'utf8').trim() === digest) return installed;
  } catch {
    // Missing or outdated installations are replaced atomically below.
  }
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `chrome.installing-${crypto.randomUUID()}`);
  const previous = path.join(parent, `chrome.previous-${crypto.randomUUID()}`);
  fs.cpSync(source, staging, { recursive: true, errorOnExist: true });
  fs.writeFileSync(path.join(staging, stamp), `${digest}\n`, { mode: 0o600 });
  const hasPrevious = fs.existsSync(installed);
  try {
    if (hasPrevious) fs.renameSync(installed, previous);
    fs.renameSync(staging, installed);
    if (hasPrevious) fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(installed) && hasPrevious) fs.renameSync(previous, installed);
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return installed;
}

class BrowserExtensionRelay {
  readonly configDir: string;
  readonly extensionPath: string;
  readonly onStateChange: () => void;
  private handle: ExtensionRelayHandle | null = null;
  private token = '';

  constructor(options: BrowserExtensionRelayOptions) {
    this.configDir = options.configDir;
    this.extensionPath = prepareInstalledExtension(
      path.resolve(__dirname, '..', 'chrome-extension'),
      options.configDir,
    );
    this.onStateChange = options.onStateChange || (() => {});
  }

  async init(): Promise<void> {
    if (this.handle) return;
    this.token = ensureRelaySecret(this.configDir);
    this.handle = await startExtensionRelayServer({
      port: 0,
      token: this.token,
      allowLegacyAuth: false,
      onStateChange: this.onStateChange,
    });
    this.onStateChange();
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.close();
  }

  cdpUrl(): string {
    return this.handle ? `http://127.0.0.1:${this.handle.port}` : '';
  }

  capability() {
    return {
      installed: fs.existsSync(path.join(this.extensionPath, 'manifest.json')),
      extensionPath: this.extensionPath,
      connected: this.handle?.bridge.extensionConnected === true,
      browser: this.handle?.bridge.identity || null,
      accessibleTabs: this.handle?.bridge.accessibleTabs().length || 0,
      protocol: BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
    };
  }

  tabs() {
    return (this.handle?.bridge.devtoolsTargetDescriptors() || []).map(tab => ({
      active: tab.active,
      id: tab.tabId,
      title: tab.title,
      url: tab.url,
    }));
  }

  pairingString(relayUrl: string): string {
    if (!this.token) throw new Error('Farming Browser extension relay is not ready');
    const url = new URL(relayUrl);
    if (!['ws:', 'wss:'].includes(url.protocol)) {
      throw new Error('Farming Browser extension pairing requires ws or wss');
    }
    return `${url.toString()}#${this.token}`;
  }

  attachWebSocket(ws: WebSocket, req: IncomingMessage, expectedPath: string): boolean {
    const handle = this.handle;
    const resource = parseExtensionRelayResource(req.url || '/', expectedPath);
    const protocols = requestProtocols(req);
    if (
      !handle
      || !this.token
      || !resource
      || !isAllowedExtensionOrigin(req)
      || protocols.length !== 1
      || protocols[0] !== BROWSER_RELAY_EXTENSION_SUBPROTOCOL
    ) {
      ws.close(4003, 'Invalid Farming Browser extension connection');
      return false;
    }
    authenticateExtensionWebSocket({
      ws,
      authority: getBrowserRelayAuthV2Authority(this.token),
      resource,
      prepareAuthenticated: async () => () => {
        attachExtensionWebSocket(handle.bridge, ws);
      },
    });
    return true;
  }
}

export { BrowserExtensionRelay };
