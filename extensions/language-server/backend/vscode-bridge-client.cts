import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const BRIDGE_PROTOCOL_VERSION = 1;
const HEALTH_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DESCRIPTOR_CACHE_MS = 2_000;
const PUBLIC_STALLED_CODE = 'LANGUAGE_SERVER_BRIDGE_STALLED';
const BRIDGE_STALLED_CODE = 'VSCODE_BRIDGE_PROVIDER_STALLED';

type BridgeState = 'connected' | 'unavailable' | 'error';

interface BridgeDescriptor {
  version: number;
  endpoint: string;
  token: string;
  pid?: number;
  startedAt?: string;
}

interface BridgeHealth {
  version?: number;
  name?: string;
  vscodeVersion?: string;
  features?: string[];
  workspaces?: string[];
  requestState?: string;
  detail?: string;
}

interface LanguageServerCapability {
  status: BridgeState;
  source: 'vscode';
  detail: string;
  vscodeVersion: string;
  features: string[];
  workspaces: string[];
}

interface VsCodeBridgeClientOptions {
  descriptorPaths?: string[];
  homeDir?: string;
  now?: () => number;
}

interface CachedDiscovery {
  expiresAt: number;
  capability: LanguageServerCapability;
  bridges?: Array<{ descriptor: BridgeDescriptor; health: BridgeHealth }>;
  stalledBridges?: Array<{ descriptor: BridgeDescriptor; health: BridgeHealth; detail: string }>;
}

function descriptorCandidates(homeDir = os.homedir()): string[] {
  const storageSuffix = path.join('User', 'globalStorage', 'farming.vscode-bridge', 'bridge.json');
  return [
    path.join(homeDir, '.vscode-server', 'data', storageSuffix),
    path.join(homeDir, '.vscode-server-insiders', 'data', storageSuffix),
    path.join(homeDir, '.vscode-remote', 'data', storageSuffix),
    path.join(homeDir, '.config', 'Code', storageSuffix),
    path.join(homeDir, '.config', 'Code - Insiders', storageSuffix),
    path.join(homeDir, 'Library', 'Application Support', 'Code', storageSuffix),
    path.join(homeDir, 'Library', 'Application Support', 'Code - Insiders', storageSuffix),
  ];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function bridgeError(message: string, code: string, status = 502): Error & { code: string; status: number } {
  const error = new Error(message) as Error & { code: string; status: number };
  error.code = code;
  error.status = status;
  return error;
}

function parseDescriptor(value: unknown): BridgeDescriptor {
  const descriptor = recordValue(value);
  const endpoint = String(descriptor.endpoint || '').trim();
  const token = String(descriptor.token || '').trim();
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw bridgeError('VS Code Bridge descriptor has an invalid endpoint', 'LANGUAGE_SERVER_DESCRIPTOR_INVALID');
  }
  if (
    Number(descriptor.version) !== BRIDGE_PROTOCOL_VERSION
    || parsedEndpoint.protocol !== 'http:'
    || !['127.0.0.1', '[::1]'].includes(parsedEndpoint.hostname)
    || parsedEndpoint.username
    || parsedEndpoint.password
    || !token
  ) {
    throw bridgeError('VS Code Bridge descriptor is incompatible', 'LANGUAGE_SERVER_DESCRIPTOR_INVALID');
  }
  return {
    version: BRIDGE_PROTOCOL_VERSION,
    endpoint: parsedEndpoint.origin,
    token,
    ...(Number.isInteger(descriptor.pid) ? { pid: Number(descriptor.pid) } : {}),
    ...(typeof descriptor.startedAt === 'string' ? { startedAt: descriptor.startedAt } : {}),
  };
}

async function requestJson(
  descriptor: BridgeDescriptor,
  requestPath: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
): Promise<unknown> {
  const url = new URL(requestPath, descriptor.endpoint);
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return await new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${descriptor.token}`,
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
        } : {}),
      },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', chunk => {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 4 * 1024 * 1024) {
          request.destroy(bridgeError('VS Code Bridge response is too large', 'LANGUAGE_SERVER_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value: unknown = {};
        try {
          value = text ? JSON.parse(text) : {};
        } catch {
          reject(bridgeError('VS Code Bridge returned invalid JSON', 'LANGUAGE_SERVER_RESPONSE_INVALID'));
          return;
        }
        if ((response.statusCode || 500) >= 400) {
          const result = recordValue(value);
          reject(bridgeError(
            String(result.error || 'VS Code Bridge request failed'),
            String(result.code || 'LANGUAGE_SERVER_BRIDGE_ERROR'),
            response.statusCode || 502,
          ));
          return;
        }
        resolve(value);
      });
    });
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(bridgeError('VS Code Bridge request timed out', 'LANGUAGE_SERVER_BRIDGE_TIMEOUT', 504));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

class VsCodeBridgeClient {
  private readonly paths: string[];
  private readonly now: () => number;
  private cached: CachedDiscovery | null = null;

  constructor(options: VsCodeBridgeClientOptions = {}) {
    this.paths = options.descriptorPaths || descriptorCandidates(options.homeDir);
    this.now = options.now || Date.now;
  }

  invalidate(): void {
    this.cached = null;
  }

  private readDescriptors(): Array<{ path: string; descriptor?: BridgeDescriptor; error?: Error }> {
    const result: Array<{ path: string; descriptor?: BridgeDescriptor; error?: Error }> = [];
    const descriptorPaths = new Set<string>();
    for (const basePath of this.paths) {
      descriptorPaths.add(basePath);
      const directory = path.dirname(basePath);
      let entries: Array<{ name: string; mtimeMs: number }> = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true })
          .filter(entry => entry.isFile() && /^bridge-[a-f0-9-]+\.json$/i.test(entry.name))
          .map(entry => {
            const filePath = path.join(directory, entry.name);
            return { name: filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
          })
          .sort((left, right) => right.mtimeMs - left.mtimeMs)
          .slice(0, 32);
      } catch {
        entries = [];
      }
      entries.forEach(entry => descriptorPaths.add(entry.name));
    }
    for (const descriptorPath of descriptorPaths) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(descriptorPath);
      } catch (error) {
        if (recordValue(error).code === 'ENOENT') continue;
        result.push({ path: descriptorPath, error: error as Error });
        continue;
      }
      try {
        if (!stat.isFile()) throw new Error('descriptor is not a file');
        if (typeof process.getuid === 'function' && typeof stat.uid === 'number' && stat.uid !== process.getuid()) {
          throw new Error('descriptor is owned by another user');
        }
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
          throw new Error('descriptor permissions must be 0600');
        }
        result.push({
          path: descriptorPath,
          descriptor: parseDescriptor(JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))),
        });
      } catch (error) {
        result.push({ path: descriptorPath, error: error as Error });
      }
    }
    return result;
  }

  async discover(options: { force?: boolean } = {}): Promise<CachedDiscovery> {
    if (!options.force && this.cached && this.cached.expiresAt > this.now()) return this.cached;
    const candidates = this.readDescriptors();
    if (candidates.length === 0) {
      this.cached = {
        expiresAt: this.now() + DESCRIPTOR_CACHE_MS,
        capability: {
          status: 'unavailable',
          source: 'vscode',
          detail: 'No running VS Code Bridge was discovered',
          vscodeVersion: '',
          features: [],
          workspaces: [],
        },
      };
      return this.cached;
    }

    const validCandidates = candidates.filter(
      (candidate): candidate is { path: string; descriptor: BridgeDescriptor } => Boolean(candidate.descriptor),
    );
    const invalidErrors = candidates
      .filter(candidate => !candidate.descriptor)
      .map(candidate => candidate.error?.message || `Invalid descriptor: ${candidate.path}`);
    const healthResults = await Promise.all(validCandidates.map(async candidate => {
      try {
        const health = recordValue(await requestJson(candidate.descriptor, '/v1/health', {
          timeoutMs: HEALTH_TIMEOUT_MS,
        })) as BridgeHealth;
        if (Number(health.version) !== BRIDGE_PROTOCOL_VERSION) {
          throw bridgeError('VS Code Bridge protocol version is incompatible', 'LANGUAGE_SERVER_BRIDGE_INCOMPATIBLE');
        }
        if (health.requestState === 'stalled') {
          const detail = String(
            health.detail || 'VS Code Bridge has a stalled language provider request. Reload the VS Code window.',
          );
          invalidErrors.push(detail);
          return { state: 'stalled' as const, descriptor: candidate.descriptor, health, detail };
        }
        return { state: 'ready' as const, descriptor: candidate.descriptor, health };
      } catch (error) {
        invalidErrors.push(error instanceof Error ? error.message : String(error));
        return null;
      }
    }));
    const bridges = healthResults
      .filter(value => value?.state === 'ready')
      .map(value => ({ descriptor: value.descriptor, health: value.health }));
    const stalledBridges = healthResults
      .filter(value => value?.state === 'stalled')
      .map(value => ({ descriptor: value.descriptor, health: value.health, detail: value.detail }));
    if (bridges.length > 0) {
      const features = [...new Set(bridges.flatMap(bridge => (
        Array.isArray(bridge.health.features) ? bridge.health.features.map(String) : []
      )))];
      const workspaces = [...new Set(bridges.flatMap(bridge => (
        Array.isArray(bridge.health.workspaces) ? bridge.health.workspaces.map(String) : []
      )))];
      this.cached = {
        expiresAt: this.now() + DESCRIPTOR_CACHE_MS,
        bridges,
        ...(stalledBridges.length > 0 ? { stalledBridges } : {}),
        capability: {
          status: 'connected',
          source: 'vscode',
          detail: bridges.length === 1 ? String(bridges[0].health.name || 'VS Code Bridge') : `${bridges.length} VS Code Bridges`,
          vscodeVersion: String(bridges[0].health.vscodeVersion || ''),
          features,
          workspaces,
        },
      };
      return this.cached;
    }

    this.cached = {
      expiresAt: this.now() + DESCRIPTOR_CACHE_MS,
      ...(stalledBridges.length > 0 ? { stalledBridges } : {}),
      capability: {
        status: 'error',
        source: 'vscode',
        detail: stalledBridges[0]?.detail || invalidErrors.at(-1) || 'VS Code Bridge could not be reached',
        vscodeVersion: '',
        features: [],
        workspaces: [],
      },
    };
    return this.cached;
  }

  async capability(options: { force?: boolean } = {}): Promise<LanguageServerCapability> {
    return (await this.discover(options)).capability;
  }

  async request(body: unknown): Promise<unknown> {
    const discovery = await this.discover();
    const workspace = String(recordValue(body).workspace || '');
    const bridge = discovery.bridges?.find(candidate => (
      Array.isArray(candidate.health.workspaces)
      && candidate.health.workspaces.map(String).includes(workspace)
    ));
    const stalledBridge = discovery.stalledBridges?.find(candidate => (
      Array.isArray(candidate.health.workspaces)
      && candidate.health.workspaces.map(String).includes(workspace)
    ));
    if (!bridge) {
      if (stalledBridge) {
        throw bridgeError(stalledBridge.detail, PUBLIC_STALLED_CODE, 503);
      }
      if (!discovery.bridges?.length || discovery.capability.status !== 'connected') {
        throw bridgeError(discovery.capability.detail, 'LANGUAGE_SERVER_UNAVAILABLE', 503);
      }
      throw bridgeError('The requested Project is not open in a discovered VS Code Bridge', 'LANGUAGE_SERVER_WORKSPACE_UNAVAILABLE', 503);
    }
    try {
      return await requestJson(bridge.descriptor, '/v1/request', {
        method: 'POST',
        body,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      this.invalidate();
      const value = recordValue(error);
      if (value.code === BRIDGE_STALLED_CODE) {
        throw bridgeError(
          String(value.message || 'VS Code Bridge has a stalled language provider request. Reload the VS Code window.'),
          PUBLIC_STALLED_CODE,
          Number(value.status) || 503,
        );
      }
      throw error;
    }
  }
}

export {
  BRIDGE_PROTOCOL_VERSION,
  VsCodeBridgeClient,
  descriptorCandidates,
  parseDescriptor,
  type LanguageServerCapability,
};
