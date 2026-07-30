import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
const WebSocket = require('ws') as { OPEN: number; new(url: string): WebSocketLike };
import {
  matchingProcessIdentity,
  readServerProcessIdentity,
} from '../../../backend/server-process-identity.cjs';
import {
  runtimeExecutableInvocation,
} from '../../../backend/runtime-executable-invocation.cjs';

type UnknownRecord = Record<string, unknown>;

interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

interface BrowserTab {
  tabId: string;
  label: string;
  title: string;
  type: string;
  url: string;
  active: boolean;
}

interface ProcessIdentity {
  pid: number;
  processGroupId: number;
  startedAt: string;
  format: string;
}

interface WebSocketLike extends EventEmitter {
  readyState: number;
  send(message: string): void;
  close(): void;
}

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

interface CommandResult {
  success?: boolean;
  data?: unknown;
  error?: unknown;
  message?: unknown;
  code?: string | number;
}

type RunCommand = (
  executablePath: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

interface RuntimeOptions {
  id: string;
  generation: number;
  configDir: string;
  agentBrowserPath: string;
  profileDir: string;
  requiredVersion?: string;
  executablePath?: string;
  externalCdpUrl?: string;
  namespace?: string;
  session?: string;
  tabLabel?: string;
  runCommand?: RunCommand;
  createWebSocket?: (url: string) => WebSocketLike;
  readProcessIdentity?: (pid: number) => ProcessIdentity | null | Promise<ProcessIdentity | null>;
  wait?: (durationMs: number) => Promise<void>;
  processIdentity?: ProcessIdentity | null;
}

interface WaitForIdentityExitOptions {
  readProcessIdentity?: (pid: number) => ProcessIdentity | null | Promise<ProcessIdentity | null>;
  wait?: (durationMs: number) => Promise<void>;
  timeoutMs?: number;
}

interface BrowserFrame {
  type: 'browser-frame';
  generation: number;
  viewportRevision: number;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  format: 'jpeg';
  data: string;
  metadata: UnknownRecord;
}

interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  value: string;
  disabled: boolean;
}

const AGENT_BROWSER_VERSION = '0.32.3';
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720, deviceScaleFactor: 1 });
const MAX_VIEWPORT_DIMENSION = 4096;
const MAX_VIEWPORT_PIXELS = 8_000_000;
const COMMAND_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 10_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_EXIT_POLL_MS = 100;
const MAX_ACTION_TIMEOUT_MS = 120_000;
const MAX_SCRIPT_LENGTH = 100_000;

function namespaceForResource(configDir: string, id: unknown, generation: unknown): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${path.resolve(configDir)}:${String(id)}:${Number(generation)}`)
    .digest('hex')
    .slice(0, 16);
  return `farming-${digest}`;
}

function sessionForResource(id: unknown, generation: unknown): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${String(id)}:${Number(generation)}`)
    .digest('hex')
    .slice(0, 16);
  return `fb-${digest}`;
}

function externalTabLabel(id: unknown, generation: unknown): string {
  return `farming-${String(id)}-g${Number(generation)}`;
}

function clampViewport(value: Partial<Viewport> = {}): Viewport {
  let width = Math.max(320, Math.min(MAX_VIEWPORT_DIMENSION, Math.round(Number(value.width) || DEFAULT_VIEWPORT.width)));
  let height = Math.max(240, Math.min(MAX_VIEWPORT_DIMENSION, Math.round(Number(value.height) || DEFAULT_VIEWPORT.height)));
  const requestedScale = Number(value.deviceScaleFactor);
  let deviceScaleFactor = Number.isFinite(requestedScale)
    ? Math.max(1, Math.min(2, requestedScale))
    : DEFAULT_VIEWPORT.deviceScaleFactor;
  const pixels = width * height * deviceScaleFactor * deviceScaleFactor;
  if (pixels > MAX_VIEWPORT_PIXELS) {
    deviceScaleFactor = Math.max(1, Math.sqrt(MAX_VIEWPORT_PIXELS / (width * height)));
  }
  if (width * height * deviceScaleFactor * deviceScaleFactor > MAX_VIEWPORT_PIXELS) {
    const ratio = Math.sqrt(MAX_VIEWPORT_PIXELS / (width * height));
    width = Math.max(320, Math.floor(width * ratio));
    height = Math.max(240, Math.floor(height * ratio));
    deviceScaleFactor = 1;
  }
  return { width, height, deviceScaleFactor };
}

function parseJsonOutput(stdout: unknown): CommandResult {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('agent-browser returned no JSON output');
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Some agent-browser builds may write a diagnostic line before the JSON result.
    }
  }
  throw new Error(`agent-browser returned invalid JSON: ${text.slice(0, 240)}`);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function defaultRunCommand(
  executablePath: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const env = options.env || process.env;
  const invocation = runtimeExecutableInvocation(executablePath, args, env);
  return new Promise((resolve, reject) => {
    execFile(invocation.command, invocation.args, {
      encoding: 'utf8',
      timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      env,
    }, (error, stdout, stderr) => {
      let result: CommandResult | undefined;
      try {
        result = parseJsonOutput(stdout);
      } catch (parseError) {
        if (!error) {
          reject(parseError);
          return;
        }
      }
      if (error || result?.success === false) {
        const detail = error?.killed
          ? `Browser command timed out after ${options.timeoutMs || COMMAND_TIMEOUT_MS} ms`
          : (result?.error
            || result?.message
            || String(stderr || '').trim()
            || error?.message
            || 'agent-browser command failed');
        const commandError = Object.assign(new Error(String(detail), { cause: error }), {
          code: result?.code || error?.code || 'AGENT_BROWSER_COMMAND_FAILED',
        });
        reject(commandError);
        return;
      }
        resolve(result || {});
    });
  });
}

function commandData(result: CommandResult): UnknownRecord {
  return recordValue(result.data);
}

function publicCommandData(result: CommandResult): UnknownRecord {
  if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) return {};
  const data = result.data;
  return isRecord(data) ? data : { value: data };
}

function normalizeRef(input: UnknownRecord = {}): string {
  const ref = String(input.ref || '').trim();
  if (ref) return ref.startsWith('@') ? ref : `@${ref}`;
  const selector = String(input.selector || '').trim();
  if (selector) return selector;
  throw new Error('ref or selector is required');
}

function normalizeTimeoutMs(value: unknown, fallback = COMMAND_TIMEOUT_MS): number {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs)) return fallback;
  return Math.max(100, Math.min(MAX_ACTION_TIMEOUT_MS, Math.round(timeoutMs)));
}

function requiredText(value: unknown, name: string, maxLength = 10_000): string {
  const text = String(value ?? '');
  if (!text.trim()) throw new Error(`${name} is required`);
  if (text.length > maxLength) throw new Error(`${name} is too long`);
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

function oneOf<const Value extends string>(
  value: unknown,
  values: readonly Value[],
  name: string,
): Value {
  const normalized = String(value || '').trim();
  if (!values.includes(normalized as Value)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`);
  }
  return normalized as Value;
}

function normalizedTabs(data: unknown): BrowserTab[] {
  const record = recordValue(data);
  const tabs = Array.isArray(record.tabs) ? record.tabs : (Array.isArray(data) ? data : []);
  return tabs
    .map(recordValue)
    .filter(tab => String(tab.tabId || tab.id || '').trim())
    .map(tab => ({
      tabId: String(tab.tabId || tab.id).trim(),
      label: String(tab.label || ''),
      title: String(tab.title || ''),
      type: String(tab.type || 'page'),
      url: String(tab.url || 'about:blank'),
      active: tab.active === true,
    }));
}

function snapshotElements(refs: unknown): SnapshotElement[] {
  if (!isRecord(refs)) return [];
  return Object.entries(refs).slice(0, 500).map(([ref, rawValue]) => {
    const value = recordValue(rawValue);
    return {
      ref: String(ref).replace(/^@/, ''),
      role: String(value.role || ''),
      name: String(value.name || '').slice(0, 240),
      value: String(value.value || '').slice(0, 240),
      disabled: value.disabled === true,
    };
  });
}

function processIdFromSessionInfo(data: unknown): number | null {
  const info = recordValue(data);
  const runtime = recordValue(info.runtime);
  const daemon = recordValue(info.daemon);
  const session = recordValue(info.session);
  const candidates = [
    info.pid,
    runtime.backgroundPid,
    info.daemonPid,
    daemon.pid,
    session.pid,
  ];
  for (const candidate of candidates) {
    const pid = Number(candidate);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function versionFromSessionInfo(data: unknown): string {
  const info = recordValue(data);
  const daemon = recordValue(info.daemon);
  return String(
    info.version
    || info.agentBrowserVersion
    || daemon.version
    || '',
  ).replace(/^agent-browser\s+/i, '').trim();
}

function webSocketPort(data: unknown): number | null {
  const info = recordValue(data);
  const server = recordValue(info.server);
  const port = Number(info.port || info.streamPort || server.port);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function keyCodeFor(key: string): number {
  const named: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Escape: 27,
    ' ': 32,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
    Meta: 91,
  };
  if (named[key]) return named[key];
  return key?.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}

async function waitForIdentityExit(
  expected: ProcessIdentity | null,
  options: WaitForIdentityExitOptions = {},
): Promise<boolean> {
  if (!expected) return true;
  const readProcessIdentity = options.readProcessIdentity || readServerProcessIdentity;
  const wait = options.wait || ((durationMs: number) => new Promise<void>(resolve => {
    setTimeout(resolve, durationMs);
  }));
  const timeoutMs = options.timeoutMs || PROCESS_EXIT_TIMEOUT_MS;
  const startedAt = Date.now();
  while (matchingProcessIdentity(
    expected,
    await readProcessIdentity(expected.pid) as ReturnType<typeof readServerProcessIdentity>,
  )) {
    if (Date.now() - startedAt >= timeoutMs) return false;
    await wait(PROCESS_EXIT_POLL_MS);
  }
  return true;
}

class AgentBrowserRuntime extends EventEmitter {
  id: string;
  generation: number;
  configDir: string;
  agentBrowserPath: string;
  requiredVersion: string;
  executablePath: string;
  externalCdpUrl: string;
  profileDir: string;
  namespace: string;
  session: string;
  tabLabel: string;
  runCommand: RunCommand;
  createWebSocket: (url: string) => WebSocketLike;
  readProcessIdentity: (
    pid: number,
  ) => ProcessIdentity | null | Promise<ProcessIdentity | null>;
  wait: (durationMs: number) => Promise<void>;
  viewport: Viewport;
  viewportRevision: number;
  latestFrame: BrowserFrame | null;
  processIdentity: ProcessIdentity | null;
  connectedCdp: boolean;
  stream: WebSocketLike | null;
  streamReady: boolean;
  activeTabId: string;
  streamTabId: string;
  knownTabIds: Set<string>;
  ownedTabIds: Set<string>;
  popupAdmissionUntil: number;
  started: boolean;
  closedByOwner: boolean;
  closeComplete: boolean;
  closePromise: Promise<void> | null;
  commandChain: Promise<CommandResult | void>;
  screenshotChain: Promise<unknown>;

  constructor(options: RuntimeOptions) {
    super();
    this.id = options.id;
    this.generation = options.generation;
    this.configDir = options.configDir;
    this.agentBrowserPath = options.agentBrowserPath;
    this.requiredVersion = options.requiredVersion || AGENT_BROWSER_VERSION;
    this.executablePath = options.executablePath || '';
    this.externalCdpUrl = options.externalCdpUrl || '';
    this.profileDir = options.profileDir;
    this.namespace = options.namespace || namespaceForResource(
      this.configDir,
      this.id,
      this.generation,
    );
    this.session = options.session || sessionForResource(this.id, this.generation);
    this.tabLabel = options.tabLabel || externalTabLabel(this.id, this.generation);
    this.runCommand = options.runCommand || defaultRunCommand;
    this.createWebSocket = options.createWebSocket || ((url: string) => new WebSocket(url));
    this.readProcessIdentity = options.readProcessIdentity || readServerProcessIdentity;
    this.wait = options.wait || ((durationMs: number) => new Promise<void>(resolve => {
      setTimeout(resolve, durationMs);
    }));
    /** @type {{width: number, height: number, deviceScaleFactor: number}} */
    this.viewport = { ...DEFAULT_VIEWPORT };
    this.viewportRevision = 0;
    this.latestFrame = null;
    this.processIdentity = null;
    this.connectedCdp = false;
    this.stream = null;
    this.streamReady = false;
    this.activeTabId = '';
    this.streamTabId = '';
    this.knownTabIds = new Set();
    this.ownedTabIds = new Set();
    this.popupAdmissionUntil = 0;
    this.started = false;
    this.closedByOwner = false;
    this.closeComplete = false;
    this.closePromise = null;
    this.commandChain = Promise.resolve();
    this.screenshotChain = Promise.resolve();
  }

  baseArgs(): string[] {
    return ['--namespace', this.namespace, '--session', this.session];
  }

  async command(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    if (!this.agentBrowserPath) throw new Error('agent-browser runtime is unavailable');
    const env = {
      ...process.env,
      ...options.env,
      AGENT_BROWSER_NO_AUTO_DIALOG: 'true',
      ...(!this.externalCdpUrl ? {
        AGENT_BROWSER_EXECUTABLE_PATH: this.executablePath,
        AGENT_BROWSER_PROFILE: this.profileDir,
      } : {}),
    };
    const execute = () => this.runCommand(
      this.agentBrowserPath,
      [...this.baseArgs(), ...args, '--json'],
      { ...options, env },
    );
    const result = this.commandChain.catch(() => {}).then(execute);
    this.commandChain = result;
    return result;
  }

  async sessionInfo(): Promise<UnknownRecord> {
    return commandData(await this.command(['session', 'info']));
  }

  async start(initialUrl?: string): Promise<{ url: string; title: string }> {
    const url = initialUrl || 'about:blank';
    try {
      fs.mkdirSync(path.dirname(this.profileDir), { recursive: true, mode: 0o700 });
      if (this.externalCdpUrl) {
        await this.command(['connect', this.externalCdpUrl]);
        this.connectedCdp = true;
        const created = commandData(await this.command([
          'tab', 'new', '--label', this.tabLabel, 'about:blank',
        ]));
        const tabId = String(created.tabId || created.id || created.targetId || this.tabLabel);
        await this.command(['tab', tabId]);
        this.ownedTabIds.add(tabId);
        if (url !== 'about:blank') await this.command(['open', url]);
      } else {
        if (!this.executablePath) throw new Error('A compatible system browser is required');
        await this.command(['open', url]);
      }

      const tabs = await this.listTabs();
      const activeTab = tabs.find(tab => tab.active) || tabs[0];
      if (!activeTab) throw new Error('agent-browser did not create an initial tab');
      this.activeTabId = activeTab.tabId;
      this.streamTabId = activeTab.tabId;
      this.knownTabIds = new Set(tabs.map(tab => tab.tabId));
      if (!this.externalCdpUrl) {
        for (const tab of tabs) this.ownedTabIds.add(tab.tabId);
      }

      const info = await this.sessionInfo();
      const version = versionFromSessionInfo(info);
      if (version && version !== this.requiredVersion) {
        throw new Error(`agent-browser ${this.requiredVersion} is required, but session uses ${version}`);
      }
      const pid = processIdFromSessionInfo(info);
      if (!pid) throw new Error('agent-browser did not report its daemon process identity');
      const processIdentity = await this.readProcessIdentity(pid);
      if (!processIdentity || processIdentity.processGroupId !== pid) {
        throw new Error('agent-browser daemon process identity could not be verified');
      }
      this.processIdentity = processIdentity;
      this.emit('process-identity', processIdentity);

      let status = commandData(await this.command(['stream', 'status']));
      if (!webSocketPort(status)) {
        try {
          status = commandData(await this.command(['stream', 'enable']));
        } catch (error) {
          if (!/already enabled/i.test(errorMessage(error))) throw error;
          status = commandData(await this.command(['stream', 'status']));
        }
      }
      const port = webSocketPort(status);
      if (!port) throw new Error('agent-browser stream did not report a loopback port');
      await this.connectStream(`ws://127.0.0.1:${port}`);
      this.started = true;
      const metadata = await this.metadata();
      this.emit('metadata', metadata);
      return metadata;
    } catch (error) {
      try {
        await this.close();
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)}; agent-browser cleanup failed: ${errorMessage(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  connectStream(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.createWebSocket(url);
      this.stream = socket;
      let settled = false;
      const failStart = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error || 'agent-browser stream failed')));
      };
      socket.once('open', () => {
        if (settled) return;
        settled = true;
        this.streamReady = true;
        resolve();
      });
      socket.on('message', (raw: Buffer) => this.handleStreamMessage(raw));
      socket.once('error', (error: Error) => {
        if (!settled) {
          failStart(error);
          return;
        }
        if (!this.closedByOwner) this.emit('error', error);
      });
      socket.once('close', () => {
        this.streamReady = false;
        if (!settled) {
          failStart(new Error('agent-browser stream closed before it was ready'));
          return;
        }
        if (!this.closedByOwner) this.emit('exit', 'agent-browser stream closed');
      });
    });
  }

  handleStreamMessage(raw: Buffer | string): void {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === 'frame' && message.data) {
      const metadata = message.metadata || {};
      const width = Number(metadata.deviceWidth) || this.viewport.width;
      const height = Number(metadata.deviceHeight) || this.viewport.height;
      const frame: BrowserFrame = {
        type: 'browser-frame',
        generation: this.generation,
        viewportRevision: this.viewportRevision,
        viewport: { width, height },
        deviceScaleFactor: Number(metadata.pageScaleFactor) || this.viewport.deviceScaleFactor,
        format: 'jpeg',
        data: String(message.data),
        metadata,
      };
      this.latestFrame = frame;
      this.emit('frame', frame);
      return;
    }
    if (message.type === 'tabs') {
      const tabs = normalizedTabs(message.data || message);
      const active = tabs.find(tab => tab.active) || tabs[0];
      if (active) this.activeTabId = active.tabId;
      const newTabIds = tabs
        .map(tab => tab.tabId)
        .filter(tabId => !this.knownTabIds.has(tabId));
      this.knownTabIds = new Set(tabs.map(tab => tab.tabId));
      this.emit('tabs', {
        tabs,
        newTabIds,
        popupAdmitted: Date.now() <= this.popupAdmissionUntil,
      });
    }
  }

  sendStream(message: UnknownRecord): void {
    if (!this.stream || !this.streamReady || this.stream.readyState !== WebSocket.OPEN) {
      throw new Error('agent-browser stream is not connected');
    }
    this.stream.send(JSON.stringify(message));
  }

  async metadata(): Promise<{ url: string; title: string }> {
    const [urlResult, titleResult] = await Promise.all([
      this.command(['get', 'url']),
      this.command(['get', 'title']),
    ]);
    return {
      url: String(commandData(urlResult).url || 'about:blank'),
      title: String(commandData(titleResult).title || ''),
    };
  }

  async listTabs(): Promise<BrowserTab[]> {
    return normalizedTabs(commandData(await this.command(['tab', 'list'])));
  }

  async createTab(url = 'about:blank', label = ''): Promise<BrowserTab> {
    const args = ['tab', 'new'];
    if (label) args.push('--label', label);
    args.push(url);
    const created = commandData(await this.command(args));
    const tabs = await this.listTabs();
    const tabId = String(created.tabId || created.id || created.targetId || '').trim();
    const tab = tabs.find(candidate => candidate.tabId === tabId)
      || tabs.find(candidate => candidate.active)
      || tabs.at(-1);
    if (!tab) throw new Error('agent-browser did not report the new tab');
    this.knownTabIds = new Set(tabs.map(candidate => candidate.tabId));
    this.ownedTabIds.add(tab.tabId);
    await this.switchTab(tab.tabId);
    return tab;
  }

  async switchTab(tabId: unknown): Promise<BrowserTab> {
    const target = String(tabId || '').trim();
    if (!target) throw new Error('tab id is required');
    await this.command(['tab', target]);
    this.activeTabId = target;
    this.streamTabId = target;
    const tabs = await this.listTabs();
    const tab = tabs.find(candidate => candidate.tabId === target);
    if (!tab) throw new Error(`Browser tab ${target} is unavailable`);
    this.knownTabIds = new Set(tabs.map(candidate => candidate.tabId));
    return tab;
  }

  async closeTab(tabId: unknown): Promise<BrowserTab[]> {
    const target = String(tabId || '').trim();
    if (!target) throw new Error('tab id is required');
    await this.command(['tab', 'close', target], { timeoutMs: CLOSE_TIMEOUT_MS });
    this.knownTabIds.delete(target);
    this.ownedTabIds.delete(target);
    const tabs = await this.listTabs();
    const active = tabs.find(tab => tab.active) || tabs[0];
    this.activeTabId = active?.tabId || '';
    if (this.streamTabId === target) this.streamTabId = '';
    return tabs;
  }

  admitPopup(): void {
    this.popupAdmissionUntil = Date.now() + 2_000;
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    await this.command(['open', url]);
    const metadata = await this.metadata();
    this.emit('metadata', metadata);
    return metadata;
  }

  async navigationCommand(command: string): Promise<{ url: string; title: string }> {
    await this.command([command]);
    const metadata = await this.metadata();
    this.emit('metadata', metadata);
    return metadata;
  }

  goBack() {
    return this.navigationCommand('back');
  }

  goForward() {
    return this.navigationCommand('forward');
  }

  reload() {
    return this.navigationCommand('reload');
  }

  async snapshot() {
    const data = commandData(await this.command(['snapshot']));
    const metadata = await this.metadata();
    return {
      ...metadata,
      elements: snapshotElements(data.refs),
      accessibilityTree: String(data.snapshot || ''),
      origin: String(data.origin || ''),
    };
  }

  async screenshot() {
    const operation = async () => {
      const output = path.join(
        path.dirname(this.profileDir),
        `screenshot-${this.generation}-${crypto.randomUUID()}.png`,
      );
      const data = commandData(await this.command(['screenshot', output]));
      const resolved = path.resolve(String(data.path || output));
      const resourceDir = path.resolve(path.dirname(this.profileDir));
      if (resolved !== path.resolve(output) && !resolved.startsWith(`${resourceDir}${path.sep}`)) {
        throw new Error('agent-browser returned an unsafe screenshot path');
      }
      try {
        return { mimeType: 'image/png', data: fs.readFileSync(resolved).toString('base64') };
      } finally {
        fs.rmSync(resolved, { force: true });
      }
    };
    const next = this.screenshotChain.catch(() => {}).then(operation);
    this.screenshotChain = next;
    return next;
  }

  async click(input: UnknownRecord): Promise<{ ok: true }> {
    this.admitPopup();
    await this.command(['click', normalizeRef(input)]);
    return { ok: true };
  }

  async elementAction(kind: unknown, input: UnknownRecord): Promise<UnknownRecord> {
    const command = oneOf(
      kind,
      ['dblclick', 'hover', 'focus', 'check', 'uncheck', 'scrollintoview', 'highlight'],
      'element action',
    );
    const result = await this.command([command, normalizeRef(input)]);
    return publicCommandData(result);
  }

  async type(input: UnknownRecord, clear: boolean): Promise<{ ok: true }> {
    const action = clear ? 'fill' : 'type';
    await this.command([action, normalizeRef(input), String(input.text ?? '')]);
    return { ok: true };
  }

  async keyboard(input: UnknownRecord): Promise<UnknownRecord> {
    const mode = oneOf(input?.mode, ['type', 'inserttext'], 'keyboard mode');
    const text = String(input?.text ?? '');
    const result = await this.command(['keyboard', mode, text]);
    return publicCommandData(result);
  }

  async select(input: UnknownRecord): Promise<UnknownRecord> {
    const values = Array.isArray(input?.values)
      ? input.values.map((value: unknown) => String(value))
      : [String(input?.value ?? '')];
    if (values.length === 0 || values.some((value: string) => !value)) {
      throw new Error('at least one select value is required');
    }
    const result = await this.command(['select', normalizeRef(input), ...values]);
    return publicCommandData(result);
  }

  async drag(input: UnknownRecord): Promise<UnknownRecord> {
    const source = normalizeRef({
      ref: input?.sourceRef,
      selector: input?.sourceSelector,
    });
    const target = normalizeRef({
      ref: input?.targetRef,
      selector: input?.targetSelector,
    });
    const result = await this.command(['drag', source, target]);
    return publicCommandData(result);
  }

  async upload(input: UnknownRecord): Promise<UnknownRecord> {
    const files = Array.isArray(input?.files)
      ? input.files.map((file: unknown) => String(file))
      : [];
    if (files.length === 0) throw new Error('at least one upload file is required');
    const result = await this.command(['upload', normalizeRef(input), ...files], {
      timeoutMs: normalizeTimeoutMs(input?.timeoutMs),
    });
    return publicCommandData(result);
  }

  async download(input: UnknownRecord): Promise<UnknownRecord> {
    const outputPath = requiredText(input?.outputPath, 'download output path');
    const timeoutMs = normalizeTimeoutMs(input?.timeoutMs);
    const result = await this.command([
      'download',
      normalizeRef(input),
      outputPath,
      '--timeout',
      String(timeoutMs),
    ], {
      timeoutMs: timeoutMs + 5_000,
    });
    return publicCommandData(result);
  }

  async waitFor(input: UnknownRecord): Promise<UnknownRecord> {
    const mode = oneOf(
      input?.mode || 'selector',
      ['selector', 'time', 'url', 'load', 'function', 'text'],
      'wait mode',
    );
    const args = ['wait'];
    if (mode === 'selector') {
      args.push(normalizeRef(input));
      if (input?.state) {
        args.push('--state', oneOf(
          input.state,
          ['visible', 'hidden', 'attached', 'detached'],
          'wait state',
        ));
      }
    } else if (mode === 'time') {
      const durationMs = normalizeTimeoutMs(input?.durationMs, 1_000);
      args.push(String(durationMs));
    } else {
      const option = mode === 'function' ? 'fn' : mode;
      const value = mode === 'load'
        ? oneOf(input?.value, ['load', 'domcontentloaded', 'networkidle'], 'load state')
        : requiredText(input?.value, `${mode} wait value`, mode === 'function' ? MAX_SCRIPT_LENGTH : 10_000);
      args.push(`--${option}`, value);
    }
    const timeoutMs = normalizeTimeoutMs(input?.timeoutMs);
    args.push('--timeout', String(timeoutMs));
    const result = await this.command(args, {
      timeoutMs: timeoutMs + 5_000,
    });
    return publicCommandData(result);
  }

  async get(input: UnknownRecord): Promise<UnknownRecord> {
    const what = oneOf(
      input?.what,
      ['text', 'html', 'value', 'attr', 'title', 'url', 'count', 'box', 'styles'],
      'get type',
    );
    const args = ['get', what];
    if (!['title', 'url'].includes(what)) args.push(normalizeRef(input));
    if (what === 'attr') args.push(requiredText(input?.attribute, 'attribute name', 256));
    return publicCommandData(await this.command(args));
  }

  async is(input: UnknownRecord): Promise<UnknownRecord> {
    const state = oneOf(input?.state, ['visible', 'enabled', 'checked'], 'element state');
    return publicCommandData(await this.command(['is', state, normalizeRef(input)]));
  }

  async find(input: UnknownRecord): Promise<UnknownRecord> {
    const locator = oneOf(
      input?.locator,
      ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth'],
      'find locator',
    );
    const action = oneOf(
      input?.action || 'click',
      ['click', 'fill', 'type', 'hover', 'focus', 'check', 'uncheck'],
      'find action',
    );
    const args = ['find', locator];
    if (locator === 'nth') {
      const index = Number(input?.index);
      if (!Number.isSafeInteger(index) || index < 0) throw new Error('find index must be a non-negative integer');
      args.push(String(index), requiredText(input?.value, 'find selector'));
    } else {
      args.push(requiredText(input?.value, 'find value'));
    }
    args.push(action);
    if (['fill', 'type'].includes(action)) args.push(String(input?.text ?? ''));
    if (input?.name) args.push('--name', String(input.name));
    if (input?.exact === true) args.push('--exact');
    const result = await this.command(args);
    return publicCommandData(result);
  }

  async evaluate(input: UnknownRecord): Promise<UnknownRecord> {
    const expression = requiredText(input?.expression, 'JavaScript expression', MAX_SCRIPT_LENGTH);
    const encoded = Buffer.from(expression).toString('base64');
    return publicCommandData(await this.command(['eval', '--base64', encoded]));
  }

  async debugLog(kind: unknown, input: UnknownRecord): Promise<UnknownRecord> {
    const command = oneOf(kind, ['console', 'errors'], 'debug log');
    const args: string[] = [command];
    if (input?.clear === true) args.push('--clear');
    return publicCommandData(await this.command(args));
  }

  async network(input: UnknownRecord): Promise<UnknownRecord> {
    const operation = oneOf(input?.operation || 'requests', ['requests', 'request'], 'network operation');
    if (operation === 'request') {
      return publicCommandData(await this.command([
        'network',
        'request',
        requiredText(input?.requestId, 'request id', 256),
      ]));
    }
    const args = ['network', 'requests'];
    if (input?.clear === true) args.push('--clear');
    for (const [key, flag] of [
      ['filter', '--filter'],
      ['resourceType', '--type'],
      ['method', '--method'],
      ['status', '--status'],
    ]) {
      if (input?.[key] !== undefined && input[key] !== '') {
        args.push(flag, String(input[key]));
      }
    }
    return publicCommandData(await this.command(args));
  }

  async cookies(input: UnknownRecord): Promise<UnknownRecord> {
    const operation = oneOf(input?.operation || 'get', ['get', 'set', 'clear'], 'cookie operation');
    const args = ['cookies', operation];
    if (operation === 'set') {
      args.push(
        requiredText(input?.name, 'cookie name', 1_024),
        String(input?.value ?? ''),
      );
      for (const [key, flag] of [
        ['url', '--url'],
        ['domain', '--domain'],
        ['path', '--path'],
        ['sameSite', '--sameSite'],
        ['expires', '--expires'],
      ]) {
        if (input?.[key] !== undefined && input[key] !== '') {
          args.push(flag, String(input[key]));
        }
      }
      if (input?.httpOnly === true) args.push('--httpOnly');
      if (input?.secure === true) args.push('--secure');
    }
    const result = await this.command(args);
    return publicCommandData(result);
  }

  async storage(input: UnknownRecord): Promise<UnknownRecord> {
    const storageType = oneOf(input?.storageType, ['local', 'session'], 'storage type');
    const operation = oneOf(input?.operation || 'get', ['get', 'set', 'clear'], 'storage operation');
    const args = ['storage', storageType, operation];
    if (operation === 'get' && input?.key) args.push(String(input.key));
    if (operation === 'set') {
      args.push(requiredText(input?.key, 'storage key', 10_000), String(input?.value ?? ''));
    }
    const result = await this.command(args);
    return publicCommandData(result);
  }

  async frame(input: UnknownRecord): Promise<UnknownRecord> {
    const target = input?.main === true ? 'main' : normalizeRef(input);
    return publicCommandData(await this.command(['frame', target]));
  }

  async dialog(input: UnknownRecord): Promise<UnknownRecord> {
    const operation = oneOf(input?.operation || 'status', ['status', 'accept', 'dismiss'], 'dialog operation');
    const args = ['dialog', operation];
    if (operation === 'accept' && input?.text !== undefined) args.push(String(input.text));
    const result = await this.command(args);
    return publicCommandData(result);
  }

  async press(input: UnknownRecord): Promise<{ ok: true }> {
    if (input?.type === 'key') {
      const key = String(input.key || '');
      if (!key) throw new Error('key is required');
      const code = String(input.code || '');
      const windowsVirtualKeyCode = keyCodeFor(key);
      const common = {
        key,
        code,
        modifiers: Number(input.modifiers) || 0,
        windowsVirtualKeyCode,
      };
      this.sendStream({ type: 'input_keyboard', eventType: 'keyDown', ...common });
      this.sendStream({ type: 'input_keyboard', eventType: 'keyUp', ...common });
      return { ok: true };
    }
    const key = String(input?.key || '').trim();
    if (!key) throw new Error('key is required');
    await this.command(['press', key]);
    return { ok: true };
  }

  async resize(value: Partial<Viewport>): Promise<Viewport> {
    const next = clampViewport(value);
    if (
      next.width === this.viewport.width
      && next.height === this.viewport.height
      && next.deviceScaleFactor === this.viewport.deviceScaleFactor
    ) return this.viewport;
    await this.command([
      'set',
      'viewport',
      String(next.width),
      String(next.height),
      String(next.deviceScaleFactor),
    ]);
    this.viewport = next;
    this.viewportRevision += 1;
    return this.viewport;
  }

  async pointer(input: UnknownRecord): Promise<void> {
    const x = Number(input.x);
    const y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const eventTypes: Record<string, string> = {
      move: 'mouseMoved',
      down: 'mousePressed',
      up: 'mouseReleased',
    };
    const action = String(input.action || '');
    const eventType = eventTypes[action];
    if (!eventType) return;
    if (action === 'down') this.admitPopup();
    this.sendStream({
      type: 'input_mouse',
      eventType,
      x,
      y,
      button: action === 'move' ? 'none' : (input.button || 'left'),
      clickCount: action === 'move' ? 0 : 1,
      modifiers: Number(input.modifiers) || 0,
    });
  }

  async wheel(input: UnknownRecord): Promise<void> {
    const x = Number(input.x);
    const y = Number(input.y);
    this.sendStream({
      type: 'input_mouse',
      eventType: 'mouseWheel',
      x: Number.isFinite(x) ? x : this.viewport.width / 2,
      y: Number.isFinite(y) ? y : this.viewport.height / 2,
      deltaX: Number(input.deltaX) || 0,
      deltaY: Number(input.deltaY) || 0,
      modifiers: Number(input.modifiers) || 0,
    });
  }

  async insertText(text: unknown): Promise<void> {
    const value = String(text || '');
    if (/[^\x20-\x7e]/.test(value)) {
      await this.command(['keyboard', 'inserttext', value]);
      return;
    }
    for (const key of value) {
      const common = {
        key,
        code: '',
        windowsVirtualKeyCode: keyCodeFor(key),
        modifiers: 0,
      };
      this.sendStream({
        type: 'input_keyboard',
        eventType: 'keyDown',
        ...common,
        text: key,
      });
      this.sendStream({
        type: 'input_keyboard',
        eventType: 'keyUp',
        ...common,
      });
    }
  }

  async closeOwnedExternalTabs() {
    for (const tabId of [...this.ownedTabIds]) {
      try {
        await this.command(['tab', 'close', tabId], { timeoutMs: CLOSE_TIMEOUT_MS });
        this.ownedTabIds.delete(tabId);
      } catch (error) {
        const tabs = await this.listTabs();
        if (tabs.some(tab => tab.tabId === tabId)) throw error;
        this.ownedTabIds.delete(tabId);
      }
    }
  }

  async closeSession() {
    const info = await this.sessionInfo();
    if (info.active === false) return;
    if (!this.processIdentity) {
      const pid = processIdFromSessionInfo(info);
      if (pid) this.processIdentity = await this.readProcessIdentity(pid);
    }
    if (this.connectedCdp) {
      // Keep the daemon/session identity alive when target cleanup is not
      // proven, so an operator can restore the endpoint and retry safely.
      await this.closeOwnedExternalTabs();
    }
    let closeError = null;
    try {
      await this.command(['close'], { timeoutMs: CLOSE_TIMEOUT_MS });
    } catch (error) {
      if (!this.processIdentity || matchingProcessIdentity(
        this.processIdentity,
        await this.readProcessIdentity(this.processIdentity.pid) as ReturnType<
          typeof readServerProcessIdentity
        >,
      )) {
        closeError ||= error;
      }
    }
    if (closeError) throw closeError;
  }

  async close() {
    if (this.closeComplete) return;
    if (this.closePromise) return this.closePromise;
    this.closedByOwner = true;
    this.closePromise = (async () => {
      if (this.stream) {
        this.stream.removeAllListeners();
        this.stream.close();
        this.stream = null;
        this.streamReady = false;
      }
      const cleanupErrors = [];
      try {
        await this.closeSession();
        const processIdentity = this.processIdentity;
        if (!await waitForIdentityExit(processIdentity, {
          readProcessIdentity: this.readProcessIdentity,
          wait: this.wait,
        })) {
          throw new Error(`agent-browser daemon ${processIdentity?.pid || 'unknown'} did not exit`);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length) {
        throw new Error(cleanupErrors.map(errorMessage).join('; '), {
          cause: cleanupErrors[0],
        });
      }
      this.closeComplete = true;
    })().finally(() => {
      this.closePromise = null;
    });
    return this.closePromise;
  }

  static async recover(options: RuntimeOptions): Promise<void> {
    const runtime = new AgentBrowserRuntime({
      ...options,
      id: options.id,
      generation: options.generation,
      externalCdpUrl: 'recovery',
    });
    runtime.processIdentity = options.processIdentity || null;
    runtime.connectedCdp = true;
    runtime.closedByOwner = true;
    await runtime.close();
  }
}

export {
  AGENT_BROWSER_VERSION,
  AgentBrowserRuntime,
  DEFAULT_VIEWPORT,
  clampViewport,
  defaultRunCommand,
  externalTabLabel,
  namespaceForResource,
  sessionForResource,
  waitForIdentityExit,
};
export type {
  BrowserTab,
  ProcessIdentity,
  RuntimeOptions,
  Viewport,
};
