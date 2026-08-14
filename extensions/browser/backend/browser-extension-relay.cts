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
import {
  browserExtensionPath,
  ensureBrowserExtensionLink,
} from './browser-extension-location.cjs';

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

class BrowserExtensionRelay {
  readonly configDir: string;
  readonly extensionSource: string;
  readonly extensionPath: string;
  readonly onStateChange: () => void;
  private handle: ExtensionRelayHandle | null = null;
  private token = '';

  constructor(options: BrowserExtensionRelayOptions) {
    this.configDir = options.configDir;
    this.extensionSource = path.resolve(__dirname, '..', 'chrome-extension');
    this.extensionPath = browserExtensionPath(options.configDir);
    this.onStateChange = options.onStateChange || (() => {});
  }

  prepare() {
    ensureBrowserExtensionLink(this.extensionSource, this.configDir);
    return this.capability();
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
