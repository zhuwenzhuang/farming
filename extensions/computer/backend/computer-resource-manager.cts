const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
import * as storageLayout from '../../../backend/storage-layout.cjs';
import {
  canonicalConfigDir,
  configInstanceFingerprint,
} from '../../../backend/config-instance.cjs';
import {
  MAX_IMAGE_ARTIFACT_BYTES,
  writeWorkspaceImageArtifact,
  type WorkspaceArtifact,
} from '../../../backend/workspace-artifacts.cjs';
import { isSameOrDescendantPath } from '../../../backend/path-containment.cjs';
import { AsyncCache } from '../../../backend/async-cache.cjs';
import { COMPUTER_CONTAINER_CPUS, COMPUTER_CONTAINER_MEMORY, COMPUTER_CONTAINER_PIDS, COMPUTER_CONTAINER_SHM_SIZE, COMPUTER_DRIVER_BIN, COMPUTER_DRIVER_VERSION, COMPUTER_IMAGE, COMPUTER_IMAGE_INDEX_DIGEST, COMPUTER_TOOL_REQUEST_TIMEOUT_MS, COMPUTER_USER } from './computer-constants.cjs';
import { ComputerResourceStore, publicResource } from './computer-resource-store.cjs';

const execFileAsync = promisify(execFile);
const INACTIVE_AGENT_STATUSES = new Set(['dead', 'error', 'exited', 'stopped']);
const CUA_TOOL_MANIFEST = require('./cua-tools.json') as {
  tools?: Array<{
    upstreamName?: unknown;
    annotations?: { readOnlyHint?: unknown };
    inputSchema?: {
      properties?: Record<string, unknown>;
      required?: unknown[];
    };
  }>;
};
const TOOL_DESCRIPTORS = new Map(
  (CUA_TOOL_MANIFEST.tools || [])
    .map(tool => [String(tool.upstreamName || '').trim(), tool] as const)
    .filter(([name]) => Boolean(name)),
);
const SUPPORTED_UPSTREAM_TOOLS = new Set(
  (CUA_TOOL_MANIFEST.tools || [])
    .map(tool => String(tool.upstreamName || '').trim())
    .filter(Boolean),
);
const READ_ONLY_TOOLS = new Set(
  (CUA_TOOL_MANIFEST.tools || [])
    .filter(tool => tool.annotations?.readOnlyHint === true)
    .map(tool => String(tool.upstreamName || '').trim())
    .filter(Boolean),
);
const STATE_OBSERVATION_TOOLS = new Set([
  'get_accessibility_tree',
  'get_browser_state',
  'get_desktop_state',
  'get_window_state',
]);
const SCREENSHOT_TOOLS = new Set([
  'get_browser_state',
  'get_desktop_state',
  'get_window_state',
  'zoom',
]);
const WINDOW_SCOPED_TOOLS = new Set([
  'click',
  'drag',
  'hotkey',
  'move_cursor',
  'press_key',
  'scroll',
  'type_text',
]);
const WINDOW_ONLY_CURSORLESS_TOOLS = new Set([
  'double_click',
  'get_window_state',
  'mouse_button_down',
  'mouse_button_up',
  'mouse_drag',
  'right_click',
  'set_value',
]);
const DRIVER_CALL_TIMEOUT_MS = 45_000;
const SESSION_REFRESH_TIMEOUT_MS = 5_000;
const SCREENSHOT_CLEANUP_GRACE_MS = 1_000;
const DOCKER_TIMEOUT_MS = 90_000;
const START_TIMEOUT_MS = 45_000;
// Docker daemon and image availability change outside Farming. A capability
// read is a current-state boundary, so the canonical read always runs a fresh
// bounded authoritative probe; cached evidence is only reusable through the
// explicit bounded-age opt-in for background navigation, never as current
// evidence.
const CAPABILITY_NAV_CACHE_MS = 30_000;
// A timed-out start/stop has an uncertain outcome. The reconciliation read and
// any bounded readiness completion share this budget so the transition still
// reaches a terminal state instead of hanging on the ambiguous outcome.
const UNCERTAIN_RECONCILE_TIMEOUT_MS = 15_000;
const COMPUTER_BROWSER_CDP_PORT = '9223/tcp';
const COMPUTER_BROWSER_MOUNT = '/opt/farming/chromium';
const COMPUTER_BROWSER_RELAY_SCRIPT = [
  'import select,socket',
  'listener=socket.socket()',
  'listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)',
  'listener.bind(("0.0.0.0",9223))',
  'listener.listen(32)',
  'while True:',
  ' client,_=listener.accept()',
  ' upstream=socket.create_connection(("127.0.0.1",9222),timeout=5)',
  ' sockets=[client,upstream]',
  ' while sockets:',
  '  readable,_,failed=select.select(sockets,[],sockets,30)',
  '  if failed: break',
  '  if not readable: continue',
  '  for source in readable:',
  '   data=source.recv(65536)',
  '   if not data: sockets=[]; break',
  '   (upstream if source is client else client).sendall(data)',
  ' client.close()',
  ' upstream.close()',
].join('\n');

type ControlOwner = 'agent' | 'human';

interface DockerResult {
  stdout: string;
  stderr: string;
}

interface DockerRunner {
  (args: string[], options?: { timeoutMs?: number; maxBuffer?: number }): Promise<DockerResult>;
}

interface DriverCallOptions {
  screenshotPath?: string;
  timeoutMs?: number;
  deadline?: number;
}

interface ComputerManagerOptions {
  configDir: string;
  isEnabled?: () => boolean;
  getSettings?: () => Record<string, unknown>;
  dockerRunner?: DockerRunner;
  uncertainReconcileBudgetMs?: number;
  capabilityNavCacheMs?: number;
  capabilityCacheNow?: () => number;
}

interface AgentLifecycleState {
  id: string;
  archived?: boolean;
  cwd?: string;
  projectWorkspace?: string;
  restartedFromAgentId?: string;
  restartedFromAgentIds?: string[];
  status?: string;
  lifecycleOperation?: { type?: string };
}

function isMissingDockerContainer(error: unknown, containerId: string): boolean {
  if (!containerId) return false;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const details = [record.message, record.stderr, record.stdout]
    .map(value => String(value || ''))
    .join('\n');
  const exactContainerId = containerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `No such (?:object|container):?\\s*${exactContainerId}(?:\\s|$)`,
    'i',
  ).test(details);
}

function replacementAgentOwner(
  ownerAgentId: string,
  workspace: string,
  agentStates: AgentLifecycleState[],
): AgentLifecycleState | null {
  const expectedWorkspace = path.resolve(workspace);
  const candidates = agentStates.filter(agent => {
    const lineage = new Set([
      String(agent.restartedFromAgentId || ''),
      ...(Array.isArray(agent.restartedFromAgentIds) ? agent.restartedFromAgentIds : []),
    ]);
    const agentWorkspace = String(agent.projectWorkspace || agent.cwd || '').trim();
    return lineage.has(ownerAgentId)
      && agent.archived !== true
      && !INACTIVE_AGENT_STATUSES.has(String(agent.status || ''))
      && Boolean(agentWorkspace)
      && path.resolve(agentWorkspace) === expectedWorkspace;
  });
  if (candidates.length > 1) {
    throw computerError(
      `Computer owner replacement is ambiguous for Agent ${ownerAgentId}`,
      409,
      'COMPUTER_OWNER_REPLACEMENT_AMBIGUOUS',
    );
  }
  return candidates[0] || null;
}

interface ViewerSocket {
  close(code?: number, reason?: string): void;
  on(event: 'close' | 'error' | 'message', listener: (...args: any[]) => void): void;
  send(data: unknown, options?: unknown): void;
  readyState: number;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sanitizeDriverResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDriverResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['screenshot_file_path', 'screenshot_out_file'].includes(key))
    .map(([key, item]) => [key, sanitizeDriverResult(item)]));
}

function computerError(message: string, status: number, code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

// Transport-timeout contract for this module. A timed-out mutation has an
// uncertain outcome, so classification must not depend on error text. It
// recognizes the explicit signals only: a docker call killed by its own
// deadline (execFile `killed`/`signal`), a socket-level ETIMEDOUT, or an error
// whose producer explicitly marked `transportTimeout` (the bounded readiness
// waits below).
function isUncertainTransportError(error: unknown): boolean {
  const candidate = error as Error & {
    killed?: boolean;
    signal?: string;
    code?: string;
    transportTimeout?: boolean;
  };
  return candidate?.killed === true
    || Boolean(candidate?.signal)
    || candidate?.code === 'ETIMEDOUT'
    || candidate?.transportTimeout === true;
}

function randomPassword(): string {
  return crypto.randomBytes(9).toString('base64url').slice(0, 12);
}

function exactImageRef(value: unknown): string {
  const requested = String(value || '').trim() || COMPUTER_IMAGE;
  if (!requested.endsWith(`@${COMPUTER_IMAGE_INDEX_DIGEST}`)) {
    throw computerError(
      `Computer image must be pinned to ${COMPUTER_IMAGE_INDEX_DIGEST}`,
      400,
      'COMPUTER_IMAGE_NOT_PINNED',
    );
  }
  return requested;
}

function safeNamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
}

function parsePort(inspect: Record<string, unknown>): number {
  return parsePublishedPort(inspect, '6901/tcp');
}

function parsePublishedPort(inspect: Record<string, unknown>, containerPort: string): number {
  const networkSettings = recordValue(inspect.NetworkSettings);
  const ports = recordValue(networkSettings.Ports);
  const mappings = ports[containerPort];
  if (!Array.isArray(mappings) || mappings.length !== 1) return 0;
  const mapping = recordValue(mappings[0]);
  if (mapping.HostIp !== '127.0.0.1') return 0;
  const port = Number(mapping.HostPort);
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function waitForHttpPath(
  port: number,
  requestPath: string,
  failureMessage: string,
  failureCode: string,
  timeoutMs = START_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() >= deadline) {
        reject(computerError(failureMessage, 504, failureCode, { transportTimeout: true }));
        return;
      }
      let successfulResponse = false;
      let attemptFinished = false;
      const retry = () => {
        if (attemptFinished) return;
        attemptFinished = true;
        setTimeout(attempt, 250);
      };
      const request = http.get({
        hostname: '127.0.0.1',
        port,
        path: requestPath,
        timeout: 2_000,
        agent: false,
        headers: { Connection: 'close' },
      }, (response: { statusCode?: number; resume(): void }) => {
        response.resume();
        if (Number(response.statusCode) >= 200 && Number(response.statusCode) < 500) {
          successfulResponse = true;
          return;
        }
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => {
        if (!successfulResponse) retry();
      });
      request.on('close', () => {
        if (attemptFinished) return;
        attemptFinished = true;
        if (successfulResponse) resolve();
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function waitForHttp(port: number, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  return waitForHttpPath(
    port,
    '/vnc.html',
    'Computer Viewer did not become ready in time',
    'COMPUTER_VIEWER_TIMEOUT',
    timeoutMs,
  );
}

function waitForCdp(port: number, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  return waitForHttpPath(
    port,
    '/json/version',
    'Computer Chromium did not expose DevTools in time',
    'COMPUTER_BROWSER_CDP_TIMEOUT',
    timeoutMs,
  );
}

class ComputerResourceManager extends EventEmitter {
  readonly configDir: string;
  readonly isEnabled: () => boolean;
  readonly getSettings: () => Record<string, unknown>;
  readonly store: InstanceType<typeof ComputerResourceStore>;
  readonly docker: DockerRunner;
  readonly configFingerprint: string;
  readonly legacyConfigFingerprints: Set<string>;
  readonly operations = new Map<string, Promise<unknown>>();
  readonly stopAdmissions = new Map<string, number>();
  readonly controlAdmissions = new Map<string, number>();
  readonly viewerSockets = new Map<string, Set<ViewerSocket>>();
  readonly browserLeases = new Map<string, number>();
  readonly agentOwnerReplacementHolds = new Set<string>();
  readonly capabilityCache: AsyncCache<Record<string, unknown>>;
  readonly capabilityNavCacheMs: number;
  readonly uncertainReconcileBudgetMs: number;
  preparePromise: Promise<unknown> | null = null;

  constructor(options: ComputerManagerOptions) {
    super();
    this.configDir = canonicalConfigDir(options.configDir);
    this.isEnabled = options.isEnabled || (() => false);
    this.getSettings = options.getSettings || (() => ({}));
    this.store = new ComputerResourceStore(this.configDir);
    this.configFingerprint = configInstanceFingerprint(this.configDir);
    this.legacyConfigFingerprints = new Set([
      crypto.createHash('sha256').update(options.configDir).digest('hex').slice(0, 12),
      crypto.createHash('sha256').update(this.configDir).digest('hex').slice(0, 12),
    ]);
    this.uncertainReconcileBudgetMs = typeof options.uncertainReconcileBudgetMs === 'number'
      && Number.isFinite(options.uncertainReconcileBudgetMs)
      && options.uncertainReconcileBudgetMs > 0
      ? options.uncertainReconcileBudgetMs
      : UNCERTAIN_RECONCILE_TIMEOUT_MS;
    this.docker = options.dockerRunner || (async (args, runOptions = {}) => {
      const result = await execFileAsync('docker', args, {
        encoding: 'utf8',
        timeout: runOptions.timeoutMs || DOCKER_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: runOptions.maxBuffer || 20 * 1024 * 1024,
      });
      return {
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
      };
    });
    this.capabilityNavCacheMs = typeof options.capabilityNavCacheMs === 'number'
      && Number.isFinite(options.capabilityNavCacheMs)
      ? Math.max(0, options.capabilityNavCacheMs)
      : CAPABILITY_NAV_CACHE_MS;
    this.capabilityCache = new AsyncCache(
      async () => {
        const probe = await this.probeSettings(this.getSettings());
        return {
          available: probe.dockerAvailable && probe.imageReady,
          ...probe,
          imageDigest: COMPUTER_IMAGE_INDEX_DIGEST,
          driverVersion: COMPUTER_DRIVER_VERSION,
          compatibilityMode: this.compatibilityMode(),
        };
      },
      {
        // Freshness is decided per read by explicit force/maxAge options; the
        // cache itself has no serving TTL, so it only coalesces concurrent
        // probes. Probe failures are reported inside the payload, keeping the
        // read bounded and explicitly failed instead of rejecting.
        ttlMs: 0,
        staleMs: 0,
        ...(options.capabilityCacheNow ? { now: options.capabilityCacheNow } : {}),
      },
    );
  }

  async init(): Promise<void> {
    this.store.init();
    for (const resource of this.store.list()) {
      if (!resource.containerId) {
        if (resource.status !== 'stopped') {
          this.patch(resource.id, {
            status: 'failed',
            error: 'Owned Computer container identity is missing',
            viewerPort: 0,
            sessionId: '',
          });
        }
        continue;
      }
      try {
        const inspect = await this.inspectOwnedContainer(resource);
        const running = recordValue(inspect.State).Running === true;
        if (!running) {
          this.patch(resource.id, {
            status: 'stopped',
            viewerPort: 0,
            sessionId: '',
            error: '',
          });
          continue;
        }
        const viewerPort = parsePort(inspect);
        if (!viewerPort) throw new Error('Computer container has no loopback Viewer port');
        await this.ensureDriver(resource, resource.sessionId || this.sessionId(resource));
        this.patch(resource.id, {
          status: 'running',
          viewerPort,
          sessionId: resource.sessionId || this.sessionId(resource),
          error: '',
        });
      } catch (caught) {
        if (isMissingDockerContainer(caught, resource.containerId)) {
          this.patch(resource.id, {
            status: 'stopped',
            containerId: '',
            containerName: '',
            vncPassword: '',
            viewerPort: 0,
            sessionId: '',
            error: '',
          });
          continue;
        }
        const error = caught as Error & { killed?: boolean };
        this.patch(resource.id, {
          status: 'failed',
          viewerPort: 0,
          sessionId: '',
          error: error.message || 'Computer recovery failed',
        });
      }
    }
  }

  requireEnabled(): void {
    if (!this.isEnabled()) {
      throw computerError('Computer plugin is disabled', 409, 'COMPUTER_DISABLED');
    }
  }

  imageRef(): string {
    return exactImageRef(this.getSettings().computerImage);
  }

  compatibilityMode(): boolean {
    return this.getSettings().computerCompatibilityMode === true;
  }

  list() {
    return this.store.snapshot();
  }

  get(id: string) {
    const resource = this.store.get(id);
    if (!resource) throw computerError('Computer Resource was not found', 404, 'COMPUTER_NOT_FOUND');
    return publicResource(resource, this.store.revision);
  }

  privateResource(id: string) {
    const resource = this.store.get(id);
    if (!resource) throw computerError('Computer Resource was not found', 404, 'COMPUTER_NOT_FOUND');
    return resource;
  }

  create(input: {
    ownerAgentId: string;
    projectRootId: string;
    workspace: string;
    name?: string;
  }) {
    this.requireEnabled();
    const existing = this.store.list().find(
      (resource: { ownerAgentId: string }) => resource.ownerAgentId === input.ownerAgentId,
    );
    if (existing) return publicResource(existing, this.store.revision);
    const resource = this.store.create(input);
    this.emitResource(resource);
    return publicResource(resource, this.store.revision);
  }

  beginAgentOwnerReplacement(sourceAgentId: string): void {
    this.agentOwnerReplacementHolds.add(sourceAgentId);
  }

  completeAgentOwnerReplacement(sourceAgentId: string, targetAgentId: string): void {
    try {
      for (const resource of this.store.list()) {
        if (resource.ownerAgentId !== sourceAgentId) continue;
        this.patch(resource.id, { ownerAgentId: targetAgentId });
      }
    } finally {
      this.agentOwnerReplacementHolds.delete(sourceAgentId);
    }
  }

  cancelAgentOwnerReplacement(sourceAgentId: string): void {
    this.agentOwnerReplacementHolds.delete(sourceAgentId);
  }

  async acquireBrowser(input: {
    ownerAgentId: string;
    projectRootId: string;
    workspace: string;
    executablePath: string;
  }): Promise<{ cdpUrl: string; leaseKey: string }> {
    this.requireEnabled();
    const executablePath = this.browserExecutableInContainer(input.executablePath);
    this.ensureBrowserCacheTraversal(input.executablePath);
    const resource = this.create({
      ownerAgentId: input.ownerAgentId,
      projectRootId: input.projectRootId,
      workspace: input.workspace,
      name: 'Desktop',
    });
    if (
      resource.projectRootId !== input.projectRootId
      || resource.workspace !== input.workspace
    ) {
      throw computerError(
        'The Agent Computer belongs to a different Project workspace',
        409,
        'COMPUTER_BROWSER_OWNER_MISMATCH',
      );
    }
    await this.ensureBrowserCacheMount(resource.id);
    await this.start(resource.id);
    const result = await this.enqueue(resource.id, async () => {
      const current = this.privateResource(resource.id);
      if (current.status !== 'running' || !current.containerId) {
        throw computerError(
          'Computer stopped before Chromium could start',
          409,
          'COMPUTER_NOT_RUNNING',
        );
      }
      const inspect = await this.inspectOwnedContainer(current);
      const cdpPort = parsePublishedPort(inspect, COMPUTER_BROWSER_CDP_PORT);
      if (!cdpPort) {
        throw computerError(
          'Computer container has no loopback DevTools port',
          409,
          'COMPUTER_BROWSER_PORT_MISSING',
        );
      }
      try {
        await waitForCdp(cdpPort, 500);
      } catch {
        const displayReady = await this.waitForContainer(current.containerId, [
          'test', '-S', '/tmp/.X11-unix/X1',
        ]);
        if (!displayReady) {
          throw computerError(
            'Computer desktop did not become ready for Chromium',
            504,
            'COMPUTER_BROWSER_DISPLAY_TIMEOUT',
          );
        }
        let chromiumReady = await this.waitForContainer(current.containerId, [
          'python3', '-c',
          'import urllib.request; urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=1)',
        ], 500);
        if (!chromiumReady) {
          await this.docker([
            'exec', '-d', '-u', COMPUTER_USER,
            '-e', 'HOME=/home/cua',
            '-e', 'DISPLAY=:1',
            current.containerId,
            executablePath,
            '--no-sandbox',
            '--remote-debugging-port=9222',
            '--user-data-dir=/home/cua/.farming-browser',
            '--no-first-run',
            '--no-default-browser-check',
            'about:blank',
          ], { timeoutMs: 10_000 });
          chromiumReady = await this.waitForContainer(current.containerId, [
            'python3', '-c',
            'import urllib.request; urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=1)',
          ]);
        }
        if (!chromiumReady) {
          throw computerError(
            'Chromium did not expose its internal DevTools endpoint',
            504,
            'COMPUTER_BROWSER_CHROMIUM_TIMEOUT',
          );
        }
        await this.docker([
          'exec', '-d', current.containerId,
          'python3', '-c', COMPUTER_BROWSER_RELAY_SCRIPT,
        ], { timeoutMs: 10_000 });
        await waitForCdp(cdpPort);
      }
      this.browserLeases.set(
        resource.id,
        (this.browserLeases.get(resource.id) || 0) + 1,
      );
      return { cdpUrl: `http://127.0.0.1:${cdpPort}`, leaseKey: resource.id };
    });
    return result;
  }

  releaseBrowser(leaseKey: string): Promise<void> {
    const current = this.browserLeases.get(leaseKey) || 0;
    if (current <= 1) this.browserLeases.delete(leaseKey);
    else this.browserLeases.set(leaseKey, current - 1);
    return Promise.resolve();
  }

  async verifyBrowserExecutable(executablePath: string): Promise<string> {
    const containerPath = this.browserExecutableInContainer(executablePath);
    this.ensureBrowserCacheTraversal(executablePath);
    const result = await this.docker([
      'run',
      '--rm',
      '--label', 'farming.dev/kind=computer-browser-probe',
      '--label', `farming.dev/config=${this.configFingerprint}`,
      ...(this.compatibilityMode() ? ['--security-opt', 'seccomp=unconfined'] : []),
      '--user', COMPUTER_USER,
      '-e', 'HOME=/home/cua',
      '--entrypoint', containerPath,
      '-v', `${this.browserCacheRoot()}:${COMPUTER_BROWSER_MOUNT}:ro`,
      this.imageRef(),
      '--no-sandbox',
      '--version',
    ], { timeoutMs: 30_000 });
    const version = result.stdout.trim() || result.stderr.trim();
    if (!/(?:Google Chrome|Chromium)/i.test(version)) {
      throw computerError(
        `Computer Chromium verification returned an unexpected version: ${version}`,
        409,
        'COMPUTER_BROWSER_VERSION_MISMATCH',
      );
    }
    return version;
  }

  rename(id: string, name: unknown) {
    const normalized = String(name || '').trim().slice(0, 120);
    if (!normalized) throw computerError('Computer name is required', 400, 'COMPUTER_NAME_REQUIRED');
    return this.patch(id, { name: normalized });
  }

  snapshot() {
    return this.stateSnapshot();
  }

  stateSnapshot() {
    return this.store.snapshot();
  }

  // Current-state read: always runs a fresh bounded authoritative probe
  // (concurrent probes coalesce). This is the read the capability API, UI,
  // CLI, and cross-resource consumers (the isolated Browser source) present
  // as current evidence.
  async capability(): Promise<Record<string, unknown>> {
    const probe = await this.capabilityCache.get('capability', { force: true });
    return { ...(probe || {}), enabled: this.isEnabled() };
  }

  // Background/navigation reuse: may serve bounded-age cached evidence and is
  // an explicit opt-in. It must never be presented as current state by the
  // capability API, UI, or CLI.
  async cachedCapability(maxAgeMs = this.capabilityNavCacheMs): Promise<Record<string, unknown>> {
    const probe = await this.capabilityCache.get('capability', { maxAgeMs });
    return { ...(probe || {}), enabled: this.isEnabled() };
  }

  async probeSettings(settings: Record<string, unknown>) {
    const image = exactImageRef(settings.computerImage);
    let dockerAvailable = false;
    let imageReady = false;
    let error = '';
    try {
      await this.docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8_000 });
      dockerAvailable = true;
      await this.docker(['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 8_000 });
      imageReady = true;
    } catch (caught) {
      error = (caught as Error).message || String(caught);
    }
    return { dockerAvailable, imageReady, image, error };
  }

  prepare(): Promise<unknown> {
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = (async () => {
      await this.docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8_000 });
      await this.docker(['pull', this.imageRef()], { timeoutMs: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
      const probeName = `farming-computer-probe-${this.configFingerprint}-${crypto.randomBytes(3).toString('hex')}`;
      const args = [
        'run',
        '--rm',
        '--name', probeName,
        '--label', 'farming.dev/kind=computer-probe',
        '--label', `farming.dev/config=${this.configFingerprint}`,
        ...(this.compatibilityMode() ? ['--security-opt', 'seccomp=unconfined'] : []),
        '--entrypoint', '/bin/sh',
        this.imageRef(),
        '-lc',
        `su -s /bin/sh -c 'HOME=/home/cua ${COMPUTER_DRIVER_BIN} --version' ${COMPUTER_USER}`,
      ];
      try {
        const result = await this.docker(args, { timeoutMs: 60_000 });
        if (!result.stdout.includes(COMPUTER_DRIVER_VERSION)) {
          throw computerError(
            `Computer image contains an unexpected Cua Driver version: ${result.stdout.trim()}`,
            409,
            'COMPUTER_DRIVER_VERSION_MISMATCH',
          );
        }
      } catch (caught) {
        const message = (caught as Error).message || String(caught);
        const compatibilityRequired = /operation not permitted|pthread_create|clone3/i.test(
          `${message}\n${(caught as Error).stderr || ''}`,
        );
        throw computerError(
          compatibilityRequired
            ? 'This Docker Engine requires explicit Computer compatibility mode'
            : `Computer runtime probe failed: ${message}`,
          409,
          compatibilityRequired ? 'COMPUTER_COMPATIBILITY_REQUIRED' : 'COMPUTER_PROBE_FAILED',
          { compatibilityRequired },
        );
      }
      this.capabilityCache.invalidate();
      return this.capability();
    })().finally(() => {
      this.preparePromise = null;
    });
    return this.preparePromise;
  }

  start(id: string): Promise<unknown> {
    this.requireEnabled();
    this.assertTransitionAdmissionOpen(id);
    return this.enqueue(id, async () => {
      this.assertTransitionAdmissionOpen(id);
      let resource = this.privateResource(id);
      if (resource.status === 'running') return publicResource(resource, this.store.revision);
      if (resource.needsObserve && resource.status === 'failed') {
        // An uncertain start outcome stays a pure reconciliation: observe the
        // authoritative container state only, never re-issue docker
        // create/start, regardless of what the observation shows.
        return await this.reconcileUncertainStart(
          id,
          new Error('the previous start outcome is still uncertain'),
        );
      }
      const generation = resource.generation + 1;
      const password = resource.vncPassword || randomPassword();
      const containerName = resource.containerName || this.containerName(resource);
      resource = this.patch(id, {
        status: 'starting',
        generation,
        controlOwner: 'agent',
        controlEpoch: resource.controlEpoch + 1,
        needsObserve: false,
        vncPassword: password,
        containerName,
        viewerPort: 0,
        sessionId: '',
        error: '',
      }, true);
      try {
        let containerId = resource.containerId;
        let preInspect: Record<string, unknown> | null = null;
        if (containerId) {
          try {
            preInspect = await this.inspectOwnedContainer(resource);
          } catch (caught) {
            if (!isMissingDockerContainer(caught, containerId)) throw caught;
            // The recorded container is authoritatively gone. Drop the stale
            // identity so the create below starts fresh; the exact absence was
            // proven, so this is observation, not a replayed mutation.
            resource = this.patch(id, { containerId: '' }, true);
            containerId = '';
          }
        }
        if (containerId && recordValue(preInspect!.State).Running === true) {
          // Observe before acting: the container is already running, so do not
          // replay docker start; only complete the bounded readiness checks.
          const viewerPort = parsePort(preInspect!);
          if (!viewerPort) throw new Error('Docker did not publish the Computer Viewer on loopback');
          await waitForHttp(viewerPort);
          const sessionId = this.sessionId(this.privateResource(id));
          await this.ensureDriver(this.privateResource(id), sessionId);
          return this.patch(id, {
            status: 'running',
            viewerPort,
            sessionId,
            error: '',
          });
        }
        if (!containerId) {
          const labels = this.containerLabels(resource);
          const create = await this.docker([
            'create',
            '--name', containerName,
            ...labels.flatMap(([key, value]) => ['--label', `${key}=${value}`]),
            '--cpus', COMPUTER_CONTAINER_CPUS,
            '--memory', COMPUTER_CONTAINER_MEMORY,
            '--shm-size', COMPUTER_CONTAINER_SHM_SIZE,
            '--pids-limit', COMPUTER_CONTAINER_PIDS,
            '--add-host', 'host.docker.internal:host-gateway',
            '-p', '127.0.0.1::6901',
            '-p', '127.0.0.1::9223',
            '-v', `${this.browserCacheRoot()}:${COMPUTER_BROWSER_MOUNT}:ro`,
            '-e', `VNC_PW=${password}`,
            ...(this.compatibilityMode() ? ['--security-opt', 'seccomp=unconfined'] : []),
            this.imageRef(),
          ]);
          containerId = create.stdout.trim();
          if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
            throw new Error('Docker did not return an exact Computer container identity');
          }
          resource = this.patch(id, { containerId }, true);
          await this.inspectOwnedContainer(resource);
        }
        await this.docker(['start', containerId]);
        const inspect = await this.inspectOwnedContainer(this.privateResource(id));
        const viewerPort = parsePort(inspect);
        if (!viewerPort) throw new Error('Docker did not publish the Computer Viewer on loopback');
        await waitForHttp(viewerPort);
        const sessionId = this.sessionId(this.privateResource(id));
        await this.ensureDriver(this.privateResource(id), sessionId);
        return this.patch(id, {
          status: 'running',
          viewerPort,
          sessionId,
          error: '',
        });
      } catch (caught) {
        const error = caught as Error & { killed?: boolean };
        if (isUncertainTransportError(error)) {
          // The timed-out start has an uncertain outcome. Reconcile from
          // authoritative container state; the reconciliation owns the exact
          // terminal state and error contract and never replays the mutation.
          return await this.reconcileUncertainStart(id, error);
        }
        this.patch(id, {
          status: 'failed',
          viewerPort: 0,
          sessionId: '',
          error: error.message || 'Computer start failed',
        });
        throw error;
      }
    });
  }

  stop(id: string, internal = false): Promise<unknown> {
    if (!internal) this.requireEnabled();
    if (!internal && (this.browserLeases.get(id) || 0) > 0) {
      throw computerError(
        'Stop the Agent Browsers using this Computer first',
        409,
        'COMPUTER_IN_USE_BY_BROWSER',
      );
    }
    this.holdStopAdmission(id);
    return this.enqueue(id, async () => {
      const resource = this.privateResource(id);
      if (resource.needsObserve && resource.status === 'failed') {
        // An uncertain stop outcome stays a pure reconciliation: observe the
        // authoritative container state only, never re-issue docker stop,
        // regardless of what the observation shows. The internal delete path
        // shares this gate instead of bypassing it.
        return await this.reconcileUncertainStop(
          id,
          new Error('the previous stop outcome is still uncertain'),
        );
      }
      if (!resource.containerId) {
        return this.patch(id, {
          status: 'stopped',
          viewerPort: 0,
          sessionId: '',
          controlOwner: 'agent',
          needsObserve: false,
          error: '',
        });
      }
      this.patch(id, { status: 'stopping' });
      this.closeViewers(id, 4000, 'Computer stopped');
      try {
        if (resource.sessionId) {
          await this.driverCall(resource, 'end_session', { session: resource.sessionId })
            .catch(() => null);
        }
        // Observe before acting: only a container proven still running is
        // stopped. A container already stopped, or authoritatively gone, has
        // reached the stop target, so the row converges without re-issuing
        // docker stop. A proven-gone container also clears its stale identity
        // so delete/reset do not verify a container that no longer exists.
        let inspect: Record<string, unknown> | null = null;
        let containerGone = false;
        try {
          inspect = await this.inspectOwnedContainer(resource);
        } catch (caught) {
          if (!isMissingDockerContainer(caught, resource.containerId)) throw caught;
          containerGone = true;
        }
        if (inspect && recordValue(inspect.State).Running === true) {
          await this.docker(['stop', '--time', '10', resource.containerId], { timeoutMs: 30_000 });
        }
        return this.patch(id, {
          status: 'stopped',
          viewerPort: 0,
          sessionId: '',
          controlOwner: 'agent',
          controlEpoch: resource.controlEpoch + 1,
          needsObserve: false,
          error: '',
          ...(containerGone ? { containerId: '' } : {}),
        });
      } catch (caught) {
        if (isMissingDockerContainer(caught, resource.containerId)) {
          return this.patch(id, {
            status: 'stopped',
            containerId: '',
            containerName: '',
            vncPassword: '',
            viewerPort: 0,
            sessionId: '',
            controlOwner: 'agent',
            controlEpoch: resource.controlEpoch + 1,
            needsObserve: false,
            error: '',
          });
        }
        const error = caught as Error;
        if (isUncertainTransportError(error)) {
          // The timed-out stop has an uncertain outcome. Reconcile from
          // authoritative container state; the reconciliation owns the exact
          // terminal state and error contract and never replays the mutation.
          return await this.reconcileUncertainStop(id, error);
        }
        this.patch(id, { status: 'failed', error: error.message || 'Computer stop failed' });
        throw error;
      }
    }).finally(() => this.releaseStopAdmission(id));
  }

  async delete(id: string, internal = false): Promise<unknown> {
    if (!internal) this.requireEnabled();
    if (!internal && (this.browserLeases.get(id) || 0) > 0) {
      throw computerError(
        'Delete the Agent Browsers using this Computer first',
        409,
        'COMPUTER_IN_USE_BY_BROWSER',
      );
    }
    this.holdStopAdmission(id);
    try {
      await this.stop(id, true);
      return await this.enqueue(id, async () => {
        const resource = this.privateResource(id);
        if (resource.containerId) {
          try {
            await this.inspectOwnedContainer(resource);
            await this.docker(['rm', resource.containerId], { timeoutMs: 30_000 });
          } catch (caught) {
            // Only the exact missing identity is tolerated: a recorded
            // container proven gone leaves nothing to remove. Unreadable
            // state or an ownership mismatch still fails closed.
            if (!isMissingDockerContainer(caught, resource.containerId)) throw caught;
          }
        }
        this.closeViewers(id, 4000, 'Computer deleted');
        this.browserLeases.delete(id);
        this.store.remove(id);
        this.emit('deleted', { id, collectionRevision: this.store.revision });
        return { id, collectionRevision: this.store.revision };
      });
    } finally {
      this.releaseStopAdmission(id);
    }
  }

  takeControl(id: string, owner: ControlOwner): Promise<unknown> {
    this.requireEnabled();
    const resource = this.privateResource(id);
    if (resource.status !== 'running') {
      throw computerError('Computer is not running', 409, 'COMPUTER_NOT_RUNNING');
    }
    if (owner === resource.controlOwner) {
      return Promise.resolve(publicResource(resource, this.store.revision));
    }
    if (this.isStopping(id)) {
      throw computerError('Computer is stopping', 409, 'COMPUTER_STOPPING');
    }
    if (this.isControlChanging(id)) {
      throw computerError('Computer control is changing', 409, 'COMPUTER_CONTROL_CHANGING');
    }
    this.holdControlAdmission(id);
    return this.enqueue(id, async () => {
      const current = this.privateResource(id);
      if (current.status !== 'running') {
        throw computerError('Computer is not running', 409, 'COMPUTER_NOT_RUNNING');
      }
      if (owner === current.controlOwner) {
        return publicResource(current, this.store.revision);
      }
      this.closeViewers(id, 4002, 'Computer control changed');
      return this.patch(id, {
        controlOwner: owner,
        controlEpoch: current.controlEpoch + 1,
        needsObserve: owner === 'agent',
      });
    }).finally(() => this.releaseControlAdmission(id));
  }

  callTool(id: string, tool: string, input: Record<string, unknown>, caller: ControlOwner = 'agent') {
    this.requireEnabled();
    if (!SUPPORTED_UPSTREAM_TOOLS.has(tool)) {
      throw computerError(`Computer tool is not supported: ${tool}`, 400, 'COMPUTER_TOOL_NOT_SUPPORTED');
    }
    const resource = this.privateResource(id);
    if (this.isStopping(id)) {
      throw computerError('Computer is stopping', 409, 'COMPUTER_STOPPING');
    }
    if (this.isControlChanging(id)) {
      throw computerError('Computer control is changing', 409, 'COMPUTER_CONTROL_CHANGING');
    }
    if (resource.status !== 'running') {
      throw computerError('Computer is not running', 409, 'COMPUTER_NOT_RUNNING');
    }
    if (resource.controlOwner !== caller) {
      throw computerError(
        caller === 'agent' ? 'A human currently controls this Computer' : 'The Agent currently controls this Computer',
        409,
        'COMPUTER_CONTROL_OWNER_MISMATCH',
      );
    }
    if (caller === 'agent' && resource.needsObserve && !READ_ONLY_TOOLS.has(tool)) {
      throw computerError(
        'Observe the Computer after human control before sending another action',
        409,
        'COMPUTER_OBSERVE_REQUIRED',
      );
    }
    const admittedGeneration = resource.generation;
    const admittedEpoch = resource.controlEpoch;
    const requestDeadline = Date.now() + COMPUTER_TOOL_REQUEST_TIMEOUT_MS;
    return this.enqueue(id, async () => {
      const current = this.privateResource(id);
      if (
        current.generation !== admittedGeneration
        || current.controlEpoch !== admittedEpoch
        || current.status !== 'running'
        || current.controlOwner !== caller
      ) {
        throw computerError('Computer ownership changed before this action ran', 409, 'COMPUTER_STALE_ADMISSION');
      }
      const args = { ...input };
      delete args.screenshot_out_file;
      const usesSession = this.toolUsesManagedSession(tool, args);
      if (usesSession) args.session = current.sessionId;
      else delete args.session;
      if (tool === 'end_session') {
        return { content: [{ type: 'text', text: 'Farming keeps this Computer session alive until Stop.' }] };
      }
      if (usesSession) {
        let sessionResult;
        try {
          sessionResult = await this.refreshDriverSession(
            current,
            current.sessionId,
            tool === 'start_session' ? args : {},
            requestDeadline,
          );
        } catch (caught) {
          throw this.sessionRefreshError(caught, tool, tool === 'start_session');
        }
        if (tool === 'start_session') return sessionResult;
      }
      const screenshotPath = SCREENSHOT_TOOLS.has(tool)
        ? `/tmp/farming-${current.id}-${crypto.randomBytes(5).toString('hex')}.png`
        : '';
      if (Date.now() >= requestDeadline) {
        throw computerError(
          `Computer action ${tool} was not sent because its request deadline expired`,
          503,
          'COMPUTER_ACTION_NOT_STARTED',
          { actionStarted: false, retryable: true },
        );
      }
      let result;
      try {
        result = await this.driverCall(current, tool, args, {
          screenshotPath,
          deadline: requestDeadline,
        });
      } catch (caught) {
        if (isUncertainTransportError(caught)) {
          this.patch(id, { needsObserve: true, error: `Uncertain ${tool} outcome; observe before retrying` });
          throw computerError(
            `Computer action ${tool} timed out with an uncertain outcome; observe before retrying`,
            504,
            'COMPUTER_ACTION_UNCERTAIN',
            { uncertain: true },
          );
        }
        throw caught;
      }
      const latest = this.privateResource(id);
      if (caller === 'agent' && STATE_OBSERVATION_TOOLS.has(tool) && latest.needsObserve) {
        this.patch(id, { needsObserve: false, error: '' });
      }
      return result;
    });
  }

  async reconcileAgentLifecycle(agentStates: AgentLifecycleState[]): Promise<void> {
    const agents = new Map(agentStates.map(agent => [String(agent.id || ''), agent]));
    for (const resource of this.store.list()) {
      const owner = agents.get(resource.ownerAgentId);
      if (!owner) {
        const replacement = replacementAgentOwner(
          resource.ownerAgentId,
          resource.workspace,
          agentStates,
        );
        if (replacement) {
          this.completeAgentOwnerReplacement(resource.ownerAgentId, replacement.id);
          continue;
        }
        if (this.agentOwnerReplacementHolds.has(resource.ownerAgentId)) continue;
        await this.delete(resource.id, true);
        continue;
      }
      const operation = String(owner.lifecycleOperation?.type || '');
      const preservesRuntime = ['permission-restart', 'runtime-switch'].includes(operation);
      const stopped = owner.archived === true
        || (!preservesRuntime && INACTIVE_AGENT_STATUSES.has(String(owner.status || '')));
      if (stopped) {
        await this.delete(resource.id, true);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const resource of this.store.list()) {
      if (resource.status !== 'stopped' || resource.containerId) {
        await this.stop(resource.id, true);
      }
    }
  }

  async resetAllContainers(): Promise<void> {
    for (const candidate of this.store.list()) {
      this.holdStopAdmission(candidate.id);
      try {
        await this.stop(candidate.id, true);
        await this.enqueue(candidate.id, async () => {
          const resource = this.privateResource(candidate.id);
          if (resource.containerId) {
            await this.inspectOwnedContainer(resource);
            await this.docker(['rm', resource.containerId], { timeoutMs: 30_000 });
          }
          this.patch(resource.id, {
            containerId: '',
            containerName: '',
            vncPassword: '',
            viewerPort: 0,
            sessionId: '',
            status: 'stopped',
            error: '',
          });
        });
      } finally {
        this.releaseStopAdmission(candidate.id);
      }
    }
  }

  viewerConfig(id: string) {
    const resource = this.privateResource(id);
    if (resource.status !== 'running' || !resource.viewerPort) {
      throw computerError('Computer Viewer is not running', 409, 'COMPUTER_NOT_RUNNING');
    }
    return {
      host: '127.0.0.1',
      port: resource.viewerPort,
      password: resource.vncPassword,
      viewOnly: resource.controlOwner !== 'human',
      generation: resource.generation,
      controlEpoch: resource.controlEpoch,
    };
  }

  attachViewer(id: string, client: ViewerSocket): void {
    const config = this.viewerConfig(id);
    const upstream = new WebSocket(`ws://127.0.0.1:${config.port}/websockify`);
    const sockets = this.viewerSockets.get(id) || new Set<ViewerSocket>();
    sockets.add(client);
    this.viewerSockets.set(id, sockets);
    const close = () => {
      sockets.delete(client);
      if (sockets.size === 0) this.viewerSockets.delete(id);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    };
    upstream.on('message', (data: unknown, isBinary: boolean) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    client.on('message', (data: unknown, isBinary: boolean) => {
      const latest = this.privateResource(id);
      if (
        latest.generation !== config.generation
        || latest.controlEpoch !== config.controlEpoch
      ) {
        client.close(4003, 'Computer Viewer is stale');
        return;
      }
      // RFB setup and framebuffer-update requests are bidirectional even for a
      // view-only noVNC client. The authenticated page receives view_only=true
      // while the Agent owns control, so noVNC suppresses pointer and keyboard
      // messages; an ownership change closes this epoch before reloading it.
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });
    upstream.on('close', () => client.close(4000, 'Computer Viewer closed'));
    upstream.on('error', () => client.close(4005, 'Computer Viewer failed'));
    client.on('close', close);
    client.on('error', close);
  }

  closeViewers(id: string, code: number, reason: string): void {
    const sockets = this.viewerSockets.get(id);
    if (!sockets) return;
    this.viewerSockets.delete(id);
    for (const socket of sockets) socket.close(code, reason);
  }

  private containerName(resource: { id: string }): string {
    return safeNamePart(`farming-computer-${this.configFingerprint}-${resource.id.slice(-12)}`);
  }

  private containerLabels(resource: {
    id: string;
    ownerAgentId: string;
    containerOwnerAgentId?: string;
  }): Array<[string, string]> {
    return [
      ['farming.dev/kind', 'computer'],
      ['farming.dev/config', this.configFingerprint],
      ['farming.dev/resource', resource.id],
      ['farming.dev/owner-agent', resource.containerOwnerAgentId || resource.ownerAgentId],
      ['farming.dev/image-digest', COMPUTER_IMAGE_INDEX_DIGEST],
    ];
  }

  private browserCacheRoot(): string {
    const root = storageLayout.managedChromiumRootDir(this.configDir);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  }

  private hasBrowserRuntimeWiring(inspect: Record<string, unknown>): boolean {
    const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts : [];
    return mounts.some(mount =>
      recordValue(mount).Destination === COMPUTER_BROWSER_MOUNT
      && recordValue(mount).RW === false
    ) && Boolean(recordValue(recordValue(inspect.HostConfig).PortBindings)[COMPUTER_BROWSER_CDP_PORT]);
  }

  private async ensureBrowserCacheMount(id: string): Promise<void> {
    const resource = this.privateResource(id);
    if (!resource.containerId) return;
    const inspect = await this.inspectOwnedContainer(resource);
    if (this.hasBrowserRuntimeWiring(inspect)) return;
    await this.resetContainer(id);
  }

  async resetContainer(id: string): Promise<void> {
    await this.stop(id, true);
    this.holdStopAdmission(id);
    try {
      await this.enqueue(id, async () => {
        const resource = this.privateResource(id);
        if (resource.containerId) {
          try {
            await this.inspectOwnedContainer(resource);
            await this.docker(['rm', resource.containerId], { timeoutMs: 30_000 });
          } catch (caught) {
            // Only the exact missing identity is tolerated: a recorded
            // container proven gone leaves nothing to remove. Unreadable
            // state or an ownership mismatch still fails closed.
            if (!isMissingDockerContainer(caught, resource.containerId)) throw caught;
          }
        }
        this.patch(resource.id, {
          containerId: '',
          containerName: '',
          vncPassword: '',
          viewerPort: 0,
          sessionId: '',
          status: 'stopped',
          error: '',
        });
      });
    } finally {
      this.releaseStopAdmission(id);
    }
  }

  private browserExecutableInContainer(executablePath: string): string {
    const root = this.browserCacheRoot();
    const resolved = path.resolve(String(executablePath || '').trim());
    const relative = path.relative(root, resolved);
    if (!relative || !isSameOrDescendantPath(root, resolved)) {
      throw computerError(
        'Computer Chromium must come from Farming managed runtime storage',
        400,
        'COMPUTER_BROWSER_EXECUTABLE_INVALID',
      );
    }
    return `${COMPUTER_BROWSER_MOUNT}/${relative.split(path.sep).join('/')}`;
  }

  private ensureBrowserCacheTraversal(executablePath: string): void {
    const root = path.resolve(this.browserCacheRoot());
    let current = path.dirname(path.resolve(String(executablePath || '').trim()));
    while (isSameOrDescendantPath(root, current)) {
      const mode = fs.statSync(current).mode & 0o777;
      if ((mode & 0o011) !== 0o011) fs.chmodSync(current, mode | 0o011);
      if (current === root) return;
      current = path.dirname(current);
    }
    throw computerError(
      'Computer Chromium must come from Farming managed runtime storage',
      400,
      'COMPUTER_BROWSER_EXECUTABLE_INVALID',
    );
  }

  private async waitForContainer(
    containerId: string,
    command: string[],
    timeoutMs = START_TIMEOUT_MS,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.docker(['exec', containerId, ...command], { timeoutMs: 3_000 });
        return true;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    return false;
  }

  private async inspectOwnedContainer(resource: {
    id: string;
    ownerAgentId: string;
    containerId: string;
  }): Promise<Record<string, unknown>> {
    if (!resource.containerId) {
      throw computerError('Computer container identity is missing', 409, 'COMPUTER_CONTAINER_IDENTITY_MISSING');
    }
    const result = await this.docker(['inspect', resource.containerId], { timeoutMs: 10_000 });
    const parsed = JSON.parse(result.stdout);
    const inspect = Array.isArray(parsed) ? recordValue(parsed[0]) : {};
    if (!inspect.Id || String(inspect.Id) !== resource.containerId) {
      throw computerError('Docker returned a different Computer container identity', 409, 'COMPUTER_CONTAINER_MISMATCH');
    }
    const labels = recordValue(recordValue(inspect.Config).Labels);
    for (const [key, value] of this.containerLabels(resource)) {
      if (key === 'farming.dev/config' && this.legacyConfigFingerprints.has(String(labels[key] || ''))) {
        continue;
      }
      if (labels[key] !== value) {
        throw computerError(`Computer container ownership label mismatch: ${key}`, 409, 'COMPUTER_CONTAINER_OWNER_MISMATCH');
      }
    }
    return inspect;
  }

  // Pure observation for a row whose container identity was never recorded
  // (an uncertain create outcome). Looks up the exact deterministic container
  // name with full-length IDs and admits the single candidate only when the
  // ownership-verified inspect accepts it, so another owner's container is
  // never adopted. This records an observed identity; it never creates or
  // starts anything.
  private async observeOwnedContainerByName(resource: {
    id: string;
    ownerAgentId: string;
    containerName: string;
  }): Promise<string | null> {
    const name = resource.containerName || this.containerName(resource);
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let result;
    try {
      result = await this.docker(
        ['ps', '-a', '-q', '--no-trunc', '--filter', `name=^${escapedName}$`],
        { timeoutMs: 10_000 },
      );
    } catch {
      return null;
    }
    const candidates = result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
    if (candidates.length !== 1) return null;
    try {
      await this.inspectOwnedContainer({ ...resource, containerId: candidates[0] });
      return candidates[0];
    } catch {
      return null;
    }
  }

  // Returns true only when an ownership-verified inspect proves the container
  // no longer exists. An inspect timeout stays uncertain and returns false so
  // the caller keeps the exact Resource identity for an explicit retry.
  private async containerAuthoritativelyGone(resource: {
    id: string;
    ownerAgentId: string;
    containerId: string;
  }): Promise<boolean> {
    try {
      await this.inspectOwnedContainer(resource);
      return false;
    } catch (caught) {
      return isMissingDockerContainer(caught, resource.containerId);
    }
  }

  // A timed-out stop has an uncertain outcome: the daemon may complete the stop
  // after the client gave up. One bounded authoritative observation decides the
  // row. Only observing the target terminal state (the container stopped, or
  // authoritatively gone) completes the stop. Observing the container still
  // running right after the timeout does not prove the original daemon stop
  // will not complete later, and an unreadable state proves nothing either, so
  // both keep the uncertain semantics: a terminal operation error with
  // uncertain=true, needsObserve=true, and the exact container identity
  // retained. This path never re-issues docker stop, and every later start,
  // stop, or delete request on the marked row stays a pure reconciliation:
  // observe only, never act, no matter what the observation shows.
  private async reconcileUncertainStop(id: string, error: Error): Promise<unknown> {
    let resource = this.privateResource(id);
    const completeStop = (extra: Record<string, unknown> = {}) => {
      this.patch(id, {
        status: 'stopped',
        viewerPort: 0,
        sessionId: '',
        controlOwner: 'agent',
        controlEpoch: resource.controlEpoch + 1,
        needsObserve: false,
        error: '',
        ...extra,
      });
      return this.get(id);
    };
    const failUncertain = (reason: string): never => {
      this.patch(id, {
        status: 'failed',
        needsObserve: true,
        error: `Uncertain stop outcome; observe the container state before retrying: ${reason}`,
      });
      throw computerError(
        'Computer stop outcome is uncertain; observe the container state before retrying',
        504,
        'COMPUTER_STOP_UNCERTAIN',
        { uncertain: true },
      );
    };
    if (!resource.containerId) {
      // The identity was never recorded, so the only authoritative observation
      // is the exact owned container by its deterministic name. Observing a
      // not-running one proves the stop target and admits its identity;
      // observing none keeps the uncertain semantics and never issues anything.
      const observed = await this.observeOwnedContainerByName(resource);
      if (!observed) {
        failUncertain('no exact owned container could be observed, so the stop cannot be proven');
      }
      resource = this.patch(id, { containerId: observed }, true);
    }
    let inspect: Record<string, unknown>;
    try {
      inspect = await this.inspectOwnedContainer(resource);
    } catch {
      if (await this.containerAuthoritativelyGone(resource)) {
        // The container is proven gone, so there is nothing left to stop or
        // remove. Clear the stale identity; retaining it would brick delete
        // and reset, which verify the recorded identity before any removal.
        return completeStop({ containerId: '' });
      }
      // Type-only `return` of the never-typed helper: makes the terminal catch
      // path explicit for definite-assignment analysis.
      return failUncertain(error.message || 'the container state could not be read');
    }
    if (recordValue(inspect.State).Running === true) {
      failUncertain('the container is still running');
    }
    return completeStop();
  }

  // A timed-out start has an uncertain outcome: the daemon may complete the
  // start after the client gave up. One bounded authoritative observation
  // decides the row. Only observing the target terminal state (the container
  // running and the desktop readiness completing) finishes the start; the
  // readiness completion uses the documented idempotent session refresh and is
  // not a replay of docker create/start. Observing the opposite state, or
  // failing to read state, does not prove the original daemon mutation will
  // not complete later, so both keep the uncertain semantics with needsObserve
  // and the exact container identity retained. The only deterministic outcomes
  // are non-transport facts proven by a completed observation: a recorded
  // container that is authoritatively gone can no longer be started, and a
  // running container with no published loopback Viewer port is a static
  // configuration failure. Both deterministic branches clear needsObserve so
  // the row is not trapped behind the pure-reconciliation gate.
  private async reconcileUncertainStart(id: string, error: Error): Promise<unknown> {
    const failUncertain = (message: string): never => {
      this.patch(id, {
        status: 'failed',
        viewerPort: 0,
        sessionId: '',
        needsObserve: true,
        error: message,
      });
      throw computerError(
        'Computer start outcome is uncertain; observe the Computer state before retrying',
        504,
        'COMPUTER_START_UNCERTAIN',
        { uncertain: true },
      );
    };
    let resource = this.privateResource(id);
    if (!resource.containerId) {
      // The container identity was never recorded, so the only authoritative
      // observation is the exact owned container by its deterministic name.
      // Observing one admits its identity for future reads; observing none
      // keeps the uncertain semantics and never creates or starts anything.
      const observed = await this.observeOwnedContainerByName(resource);
      if (!observed) {
        failUncertain(`Uncertain start outcome; no exact owned container could be observed: ${error.message || 'transport timeout'}`);
      }
      resource = this.patch(id, { containerId: observed }, true);
    }
    let inspect: Record<string, unknown>;
    try {
      inspect = await this.inspectOwnedContainer(resource);
    } catch (caught) {
      if (isMissingDockerContainer(caught, resource.containerId)) {
        // The recorded container identity is authoritatively gone, so this
        // start can no longer complete against it. This is a proven non-
        // transport fact, not an uncertain daemon outcome. needsObserve is
        // cleared so the deterministic row is not trapped behind the pure-
        // reconciliation gate; a later normal start may recreate after the
        // exact absence was proven.
        this.patch(id, {
          status: 'failed',
          viewerPort: 0,
          sessionId: '',
          needsObserve: false,
          error: 'Computer start timed out and the container is no longer present',
        });
        throw computerError(
          'Computer start timed out and the container is no longer present',
          502,
          'COMPUTER_START_FAILED',
          { retryable: true },
        );
      }
      // Type-only `return` of the never-typed helper: makes the terminal catch
      // path explicit for definite-assignment analysis.
      return failUncertain(`Uncertain start outcome; the container state could not be read: ${error.message || 'transport timeout'}`);
    }
    if (recordValue(inspect.State).Running !== true) {
      // Observing not-running right after the timeout does not prove the
      // original daemon start will not complete later.
      failUncertain('Uncertain start outcome; the container is not running');
    }
    const viewerPort = parsePort(inspect);
    if (!viewerPort) {
      // The inspect completed, so a missing loopback Viewer port is a proven
      // static configuration failure of this container, not a transport
      // outcome.
      this.patch(id, {
        status: 'failed',
        viewerPort: 0,
        sessionId: '',
        needsObserve: false,
        error: 'Computer start observed the container running but Docker did not publish the Computer Viewer on loopback',
      });
      throw computerError(
        'Computer start observed the container running but Docker did not publish the Computer Viewer on loopback',
        502,
        'COMPUTER_START_FAILED',
      );
    }
    try {
      await waitForHttp(viewerPort, this.uncertainReconcileBudgetMs);
      const sessionId = this.sessionId(resource);
      await this.ensureDriver(resource, sessionId, this.uncertainReconcileBudgetMs);
      return this.patch(id, {
        status: 'running',
        viewerPort,
        sessionId,
        needsObserve: false,
        error: '',
      });
    } catch {
      // The container is authoritatively running, but desktop readiness could
      // not be verified within the bounded budget; it may still become ready.
      failUncertain('Uncertain start outcome; the container is running but desktop readiness was not verified');
    }
  }

  private sessionId(resource: { id: string; generation: number }): string {
    return `${resource.id}-g${resource.generation}`;
  }

  private async ensureDriver(
    resource: { containerId: string; workspace: string },
    sessionId: string,
    timeoutMs = START_TIMEOUT_MS,
  ): Promise<void> {
    await this.docker([
      'exec', '-u', COMPUTER_USER,
      '-e', 'HOME=/home/cua',
      resource.containerId,
      COMPUTER_DRIVER_BIN, 'telemetry', 'disable',
    ], { timeoutMs: 10_000 }).catch(() => null);
    await this.docker([
      'exec', '-d', '-u', COMPUTER_USER,
      '-e', 'HOME=/home/cua',
      '-e', 'DISPLAY=:1',
      resource.containerId,
      COMPUTER_DRIVER_BIN, 'serve', '--dangerously-bypass-approvals',
    ], { timeoutMs: 10_000 }).catch(() => null);
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const version = await this.docker([
          'exec', '-u', COMPUTER_USER,
          '-e', 'HOME=/home/cua',
          '-e', 'DISPLAY=:1',
          resource.containerId,
          COMPUTER_DRIVER_BIN, '--version',
        ], { timeoutMs: 5_000 });
        if (!version.stdout.includes(COMPUTER_DRIVER_VERSION)) {
          throw new Error(`Expected Cua Driver ${COMPUTER_DRIVER_VERSION}, got ${version.stdout.trim()}`);
        }
        await this.refreshDriverSession(resource, sessionId);
        return;
      } catch (caught) {
        lastError = caught;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    throw lastError || new Error('Cua Driver did not become ready');
  }

  private async driverCall(
    resource: { containerId: string; workspace: string },
    tool: string,
    input: Record<string, unknown>,
    options: DriverCallOptions = {},
  ) {
    const screenshotPath = options.screenshotPath || '';
    const timeoutMs = options.timeoutMs || DRIVER_CALL_TIMEOUT_MS;
    const deadline = options.deadline || 0;
    const args = [
      'exec', '-u', COMPUTER_USER,
      '-e', 'HOME=/home/cua',
      '-e', 'DISPLAY=:1',
      resource.containerId,
      COMPUTER_DRIVER_BIN, 'call', tool, JSON.stringify(input),
      ...(screenshotPath ? ['--screenshot-out-file', screenshotPath] : []),
    ];
    const result = await this.docker(args, {
      timeoutMs: this.timeoutBeforeDeadline(deadline, timeoutMs, false),
      maxBuffer: 32 * 1024 * 1024,
    });
    let structuredContent: unknown;
    const text = result.stdout.trim();
    try {
      structuredContent = sanitizeDriverResult(JSON.parse(text));
    } catch {
      structuredContent = undefined;
    }
    const publicText = structuredContent === undefined
      ? (text || result.stderr.trim() || `${tool} completed`)
      : JSON.stringify(structuredContent);
    const content: Array<Record<string, unknown>> = [{
      type: 'text',
      text: publicText,
    }];
    const artifacts: WorkspaceArtifact[] = [];
    if (screenshotPath) {
      try {
        const screenshotStat = await this.docker([
          'exec', '-u', COMPUTER_USER,
          resource.containerId,
          'stat', '-c', '%s', screenshotPath,
        ], { timeoutMs: this.timeoutBeforeDeadline(deadline, 5_000) });
        const screenshotBytes = Number(screenshotStat.stdout.trim());
        if (!Number.isSafeInteger(screenshotBytes) || screenshotBytes <= 0) {
          throw new Error('Computer observation did not produce a non-empty screenshot');
        }
        if (screenshotBytes > MAX_IMAGE_ARTIFACT_BYTES) {
          throw new Error(`Computer screenshot exceeds ${MAX_IMAGE_ARTIFACT_BYTES} bytes`);
        }
        const image = await this.docker([
          'exec', '-u', COMPUTER_USER,
          resource.containerId,
          'base64', '-w', '0', screenshotPath,
        ], {
          timeoutMs: this.timeoutBeforeDeadline(deadline, 10_000),
          maxBuffer: 48 * 1024 * 1024,
        });
        if (image.stdout.trim()) {
          const artifactAbort = deadline ? new AbortController() : null;
          const artifactTimer = artifactAbort
            ? setTimeout(
                () => artifactAbort.abort(),
                this.timeoutBeforeDeadline(deadline, COMPUTER_TOOL_REQUEST_TIMEOUT_MS),
              )
            : null;
          let artifact: WorkspaceArtifact;
          try {
            artifact = await writeWorkspaceImageArtifact({
              bytes: Buffer.from(image.stdout.trim(), 'base64'),
              capability: 'computer',
              mimeType: 'image/png',
              operation: tool,
              signal: artifactAbort?.signal,
              workspace: resource.workspace,
            });
          } finally {
            if (artifactTimer) clearTimeout(artifactTimer);
          }
          artifacts.push(artifact);
          content.push({ type: 'image', ...artifact });
        }
      } catch (caught) {
        if (
          deadline
          && (
            Date.now() >= deadline
            || ['AbortError', 'TimeoutError'].includes(String((caught as { name?: string }).name || ''))
          )
        ) {
          throw computerError(
            'Computer request deadline expired while saving its screenshot',
            504,
            'COMPUTER_REQUEST_DEADLINE_EXCEEDED',
            { retryable: true },
          );
        }
        const message = caught instanceof Error ? caught.message : String(caught);
        if (!/no such file|did not produce a non-empty screenshot/i.test(message)) throw caught;
        // Some observation tools legitimately return no image for the current target.
      } finally {
        await this.docker([
          'exec', '-u', COMPUTER_USER,
          resource.containerId,
          'rm', '-f', screenshotPath,
        ], {
          timeoutMs: this.screenshotCleanupTimeout(deadline),
        }).catch(() => null);
      }
    }
    return {
      content,
      ...(structuredContent === undefined ? {} : { structuredContent }),
      ...(artifacts.length === 0 ? {} : { artifacts }),
    };
  }

  private refreshDriverSession(
    resource: { containerId: string; workspace: string },
    sessionId: string,
    input: Record<string, unknown> = {},
    deadline = 0,
  ) {
    return this.driverCall(resource, 'start_session', {
      ...input,
      session: sessionId,
      capture_scope: 'desktop',
    }, { timeoutMs: SESSION_REFRESH_TIMEOUT_MS, deadline });
  }

  private timeoutBeforeDeadline(
    deadline: number,
    maximumMs: number,
    actionStarted?: boolean,
  ): number {
    if (!deadline) return maximumMs;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw computerError(
        'Computer request deadline expired',
        504,
        'COMPUTER_REQUEST_DEADLINE_EXCEEDED',
        {
          retryable: true,
          ...(actionStarted === false ? { actionStarted: false } : {}),
        },
      );
    }
    return Math.max(1, Math.min(maximumMs, remainingMs));
  }

  private screenshotCleanupTimeout(deadline: number): number {
    if (!deadline) return 5_000;
    return Math.max(
      1,
      Math.min(SCREENSHOT_CLEANUP_GRACE_MS, deadline + SCREENSHOT_CLEANUP_GRACE_MS - Date.now()),
    );
  }

  private sessionRefreshError(caught: unknown, tool: string, explicitStart: boolean) {
    const error = caught as Error & { killed?: boolean; signal?: string; status?: number; code?: string };
    const message = error.message || 'Cua Driver session refresh failed';
    const refreshNotSent = recordValue(error).actionStarted === false;
    const retryable = Boolean(
      error.killed
      || error.signal
      || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(String(error.code || ''))
      || /timed out|deadline expired|socket hang up|connection reset|broken pipe/i.test(message),
    );
    const failureMessage = explicitStart
      ? (refreshNotSent
          ? `Computer start_session was not sent: ${message}`
          : `Computer start_session did not complete: ${message}`)
      : `Computer session could not be refreshed before ${tool}; the requested action was not sent: ${message}`;
    return computerError(
      failureMessage,
      Number(error.status) || (retryable ? 503 : 500),
      'COMPUTER_SESSION_REFRESH_FAILED',
      {
        retryable,
        ...(explicitStart && retryable && !refreshNotSent ? {
          uncertain: true,
          hint: 'start_session is idempotent; retry it before sending another Computer tool.',
        } : {}),
        ...(!explicitStart || refreshNotSent ? { actionStarted: false } : {}),
      },
    );
  }

  private toolUsesManagedSession(tool: string, input: Record<string, unknown>): boolean {
    const descriptor = TOOL_DESCRIPTORS.get(tool);
    const properties = descriptor?.inputSchema?.properties || {};
    if (!Object.prototype.hasOwnProperty.call(properties, 'session')) return false;
    if ((descriptor?.inputSchema?.required || []).includes('session')) return true;
    if (WINDOW_ONLY_CURSORLESS_TOOLS.has(tool)) return false;
    if (WINDOW_SCOPED_TOOLS.has(tool)) return input.scope === 'desktop';
    return true;
  }

  private holdStopAdmission(id: string): void {
    this.stopAdmissions.set(id, (this.stopAdmissions.get(id) || 0) + 1);
  }

  private releaseStopAdmission(id: string): void {
    const next = (this.stopAdmissions.get(id) || 1) - 1;
    if (next <= 0) this.stopAdmissions.delete(id);
    else this.stopAdmissions.set(id, next);
  }

  private isStopping(id: string): boolean {
    return (this.stopAdmissions.get(id) || 0) > 0;
  }

  private holdControlAdmission(id: string): void {
    this.controlAdmissions.set(id, (this.controlAdmissions.get(id) || 0) + 1);
  }

  private releaseControlAdmission(id: string): void {
    const next = (this.controlAdmissions.get(id) || 1) - 1;
    if (next <= 0) this.controlAdmissions.delete(id);
    else this.controlAdmissions.set(id, next);
  }

  private isControlChanging(id: string): boolean {
    return (this.controlAdmissions.get(id) || 0) > 0;
  }

  private assertTransitionAdmissionOpen(id: string): void {
    if (this.isStopping(id)) {
      throw computerError('Computer is stopping', 409, 'COMPUTER_STOPPING');
    }
    if (this.isControlChanging(id)) {
      throw computerError('Computer control is changing', 409, 'COMPUTER_CONTROL_CHANGING');
    }
  }

  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) || Promise.resolve();
    const next = previous.catch(() => null).then(action);
    this.operations.set(id, next);
    return next.finally(() => {
      if (this.operations.get(id) === next) this.operations.delete(id);
    });
  }

  private patch(id: string, patch: Record<string, unknown>, privateResult = false): any {
    const resource = this.store.patch(id, patch);
    this.emitResource(resource);
    return privateResult ? resource : publicResource(resource, this.store.revision);
  }

  private emitResource(resource: any): void {
    this.emit('resource', publicResource(resource, this.store.revision));
    this.emit('resources', this.store.snapshot());
  }
}

export {
  ComputerResourceManager,
  exactImageRef,
};
