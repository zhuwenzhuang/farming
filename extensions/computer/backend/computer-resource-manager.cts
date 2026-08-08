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
import { COMPUTER_CONTAINER_CPUS, COMPUTER_CONTAINER_MEMORY, COMPUTER_CONTAINER_PIDS, COMPUTER_CONTAINER_SHM_SIZE, COMPUTER_DRIVER_BIN, COMPUTER_DRIVER_VERSION, COMPUTER_IMAGE, COMPUTER_IMAGE_INDEX_DIGEST, COMPUTER_TOOL_REQUEST_TIMEOUT_MS, COMPUTER_USER } from './computer-constants.cjs';
import { ComputerResourceStore, publicResource } from './computer-resource-store.cjs';

const execFileAsync = promisify(execFile);
const INACTIVE_AGENT_STATUSES = new Set(['dead', 'error', 'exited', 'stopped']);
const CUA_TOOL_MANIFEST = require('./cua-tools.json') as {
  tools?: Array<{
    upstreamName?: unknown;
    annotations?: { readOnlyHint?: unknown };
  }>;
};
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
const DRIVER_CALL_TIMEOUT_MS = 45_000;
const SESSION_REFRESH_TIMEOUT_MS = 5_000;
const SCREENSHOT_CLEANUP_GRACE_MS = 1_000;
const DOCKER_TIMEOUT_MS = 90_000;
const START_TIMEOUT_MS = 45_000;
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
}

interface AgentLifecycleState {
  id: string;
  archived?: boolean;
  status?: string;
  lifecycleOperation?: { type?: string };
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

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function computerError(message: string, status: number, code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
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
        reject(computerError(failureMessage, 504, failureCode));
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
  capabilityCache: Record<string, unknown> | null = null;
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
    this.docker = options.dockerRunner || (async (args, runOptions = {}) => {
      const result = await execFileAsync('docker', args, {
        encoding: 'utf8',
        timeout: runOptions.timeoutMs || DOCKER_TIMEOUT_MS,
        maxBuffer: runOptions.maxBuffer || 20 * 1024 * 1024,
      });
      return {
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
      };
    });
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

  async capability(refresh = false) {
    if (this.capabilityCache && !refresh) {
      return { ...this.capabilityCache, enabled: this.isEnabled() };
    }
    const probe = await this.probeSettings(this.getSettings());
    this.capabilityCache = {
      available: probe.dockerAvailable && probe.imageReady,
      enabled: this.isEnabled(),
      ...probe,
      imageDigest: COMPUTER_IMAGE_INDEX_DIGEST,
      driverVersion: COMPUTER_DRIVER_VERSION,
      compatibilityMode: this.compatibilityMode(),
    };
    return this.capabilityCache;
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
      this.capabilityCache = null;
      return this.capability(true);
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
        if (containerId) {
          await this.inspectOwnedContainer(resource);
        } else {
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
      if (!resource.containerId || resource.status === 'stopped') {
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
        await this.inspectOwnedContainer(resource);
        await this.docker(['stop', '--time', '10', resource.containerId], { timeoutMs: 30_000 });
        return this.patch(id, {
          status: 'stopped',
          viewerPort: 0,
          sessionId: '',
          controlOwner: 'agent',
          controlEpoch: resource.controlEpoch + 1,
          needsObserve: false,
          error: '',
        });
      } catch (caught) {
        const error = caught as Error;
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
          await this.inspectOwnedContainer(resource);
          await this.docker(['rm', resource.containerId], { timeoutMs: 30_000 });
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
      const usesSession = this.toolAcceptsSession(tool);
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
        const error = caught as Error & { killed?: boolean };
        if (error.killed || error.signal || /timed out/i.test(error.message || '')) {
          this.patch(id, { needsObserve: true, error: `Uncertain ${tool} outcome; observe before retrying` });
          throw computerError(
            `Computer action ${tool} timed out with an uncertain outcome; observe before retrying`,
            504,
            'COMPUTER_ACTION_UNCERTAIN',
            { uncertain: true },
          );
        }
        throw error;
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
        await this.delete(resource.id, true);
        continue;
      }
      const operation = String(owner.lifecycleOperation?.type || '');
      const preservesRuntime = ['permission-restart', 'runtime-switch'].includes(operation);
      const stopped = owner.archived === true
        || (!preservesRuntime && INACTIVE_AGENT_STATUSES.has(String(owner.status || '')));
      if (stopped && resource.status !== 'stopped') {
        await this.stop(resource.id, true);
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

  private containerLabels(resource: { id: string; ownerAgentId: string }): Array<[string, string]> {
    return [
      ['farming.dev/kind', 'computer'],
      ['farming.dev/config', this.configFingerprint],
      ['farming.dev/resource', resource.id],
      ['farming.dev/owner-agent', resource.ownerAgentId],
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
      this.releaseStopAdmission(id);
    }
  }

  private browserExecutableInContainer(executablePath: string): string {
    const root = this.browserCacheRoot();
    const resolved = path.resolve(String(executablePath || '').trim());
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
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
    while (current === root || pathInside(root, current)) {
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

  private sessionId(resource: { id: string; generation: number }): string {
    return `${resource.id}-g${resource.generation}`;
  }

  private async ensureDriver(resource: { containerId: string; workspace: string }, sessionId: string): Promise<void> {
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
    const deadline = Date.now() + START_TIMEOUT_MS;
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

  private toolAcceptsSession(tool: string): boolean {
    return ![
      'check_for_update',
      'check_permissions',
      'get_config',
      'health_report',
      'install_ffmpeg',
      'list_apps',
      'list_windows',
      'set_config',
      'start_recording',
      'stop_recording',
      'get_recording_state',
      'replay_trajectory',
    ].includes(tool);
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
