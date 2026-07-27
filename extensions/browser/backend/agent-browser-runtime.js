const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const {
  matchingProcessIdentity,
  readServerProcessIdentity,
} = require('../../../backend/server-process-identity');

const AGENT_BROWSER_VERSION = '0.32.3';
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720, deviceScaleFactor: 1 });
const MAX_VIEWPORT_DIMENSION = 4096;
const MAX_VIEWPORT_PIXELS = 8_000_000;
const COMMAND_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 10_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_EXIT_POLL_MS = 100;

function namespaceForResource(configDir, id, generation) {
  const digest = crypto
    .createHash('sha256')
    .update(`${path.resolve(configDir)}:${String(id)}:${Number(generation)}`)
    .digest('hex')
    .slice(0, 16);
  return `farming-${digest}`;
}

function sessionForResource(id, generation) {
  const digest = crypto
    .createHash('sha256')
    .update(`${String(id)}:${Number(generation)}`)
    .digest('hex')
    .slice(0, 16);
  return `fb-${digest}`;
}

function externalTabLabel(id, generation) {
  return `farming-${String(id)}-g${Number(generation)}`;
}

function clampViewport(value = {}) {
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

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('agent-browser returned no JSON output');
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Some agent-browser builds may write a diagnostic line before the JSON result.
    }
  }
  throw new Error(`agent-browser returned invalid JSON: ${text.slice(0, 240)}`);
}

function defaultRunCommand(executablePath, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(executablePath, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      env: options.env || process.env,
    }, (error, stdout, stderr) => {
      let result;
      try {
        result = parseJsonOutput(stdout);
      } catch (parseError) {
        if (!error) {
          reject(parseError);
          return;
        }
      }
      if (error || result?.success === false) {
        const detail = result?.error
          || result?.message
          || String(stderr || '').trim()
          || error?.message
          || 'agent-browser command failed';
        const commandError = new Error(detail);
        commandError.code = result?.code || error?.code || 'AGENT_BROWSER_COMMAND_FAILED';
        commandError.cause = error;
        reject(commandError);
        return;
      }
      resolve(result);
    });
  });
}

function commandData(result) {
  return result && typeof result.data === 'object' && result.data !== null ? result.data : {};
}

function normalizeRef(input = {}) {
  const ref = String(input.ref || '').trim();
  if (ref) return ref.startsWith('@') ? ref : `@${ref}`;
  const selector = String(input.selector || '').trim();
  if (selector) return selector;
  throw new Error('ref or selector is required');
}

function metadataFromTabs(data) {
  const tabs = Array.isArray(data?.tabs) ? data.tabs : (Array.isArray(data) ? data : []);
  const active = tabs.find(tab => tab?.active) || tabs[0];
  if (!active) return null;
  return {
    url: String(active.url || 'about:blank'),
    title: String(active.title || ''),
  };
}

function snapshotElements(refs) {
  if (!refs || typeof refs !== 'object') return [];
  return Object.entries(refs).slice(0, 500).map(([ref, value]) => ({
    ref: String(ref).replace(/^@/, ''),
    role: String(value?.role || ''),
    name: String(value?.name || '').slice(0, 240),
    value: String(value?.value || '').slice(0, 240),
    disabled: value?.disabled === true,
  }));
}

function processIdFromSessionInfo(data) {
  const candidates = [
    data?.pid,
    data?.runtime?.backgroundPid,
    data?.daemonPid,
    data?.daemon?.pid,
    data?.session?.pid,
  ];
  for (const candidate of candidates) {
    const pid = Number(candidate);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function versionFromSessionInfo(data) {
  return String(
    data?.version
    || data?.agentBrowserVersion
    || data?.daemon?.version
    || '',
  ).replace(/^agent-browser\s+/i, '').trim();
}

function webSocketPort(data) {
  const port = Number(data?.port || data?.streamPort || data?.server?.port);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function keyCodeFor(key) {
  const named = {
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

async function waitForIdentityExit(expected, options = {}) {
  if (!expected) return true;
  const readProcessIdentity = options.readProcessIdentity || readServerProcessIdentity;
  const wait = options.wait || (durationMs => new Promise(resolve => setTimeout(resolve, durationMs)));
  const timeoutMs = options.timeoutMs || PROCESS_EXIT_TIMEOUT_MS;
  const startedAt = Date.now();
  while (matchingProcessIdentity(expected, await readProcessIdentity(expected.pid))) {
    if (Date.now() - startedAt >= timeoutMs) return false;
    await wait(PROCESS_EXIT_POLL_MS);
  }
  return true;
}

class AgentBrowserRuntime extends EventEmitter {
  constructor(options) {
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
    this.createWebSocket = options.createWebSocket || (url => new WebSocket(url));
    this.readProcessIdentity = options.readProcessIdentity || readServerProcessIdentity;
    this.wait = options.wait || (durationMs => new Promise(resolve => setTimeout(resolve, durationMs)));
    this.viewport = { ...DEFAULT_VIEWPORT };
    this.viewportRevision = 0;
    this.latestFrame = null;
    this.processIdentity = null;
    this.connectedCdp = false;
    this.stream = null;
    this.streamReady = false;
    this.started = false;
    this.closedByOwner = false;
    this.closeComplete = false;
    this.closePromise = null;
  }

  baseArgs() {
    return ['--namespace', this.namespace, '--session', this.session];
  }

  async command(args, options = {}) {
    if (!this.agentBrowserPath) throw new Error('agent-browser runtime is unavailable');
    const env = this.externalCdpUrl
      ? (options.env || process.env)
      : {
          ...process.env,
          ...options.env,
          AGENT_BROWSER_EXECUTABLE_PATH: this.executablePath,
          AGENT_BROWSER_PROFILE: this.profileDir,
        };
    return this.runCommand(
      this.agentBrowserPath,
      [...this.baseArgs(), ...args, '--json'],
      { ...options, env },
    );
  }

  async sessionInfo() {
    return commandData(await this.command(['session', 'info']));
  }

  async start(initialUrl) {
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
        if (url !== 'about:blank') await this.command(['open', url]);
      } else {
        if (!this.executablePath) throw new Error('A compatible system browser is required');
        await this.command(['open', url]);
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
          if (!/already enabled/i.test(String(error?.message || ''))) throw error;
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
          `${error?.message || error}; agent-browser cleanup failed: ${cleanupError?.message || cleanupError}`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  connectStream(url) {
    return new Promise((resolve, reject) => {
      const socket = this.createWebSocket(url);
      this.stream = socket;
      let settled = false;
      const failStart = error => {
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
      socket.on('message', raw => this.handleStreamMessage(raw));
      socket.once('error', error => {
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

  handleStreamMessage(raw) {
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
      const frame = {
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
      const metadata = metadataFromTabs(message.data || message);
      if (metadata) this.emit('metadata', metadata);
    }
  }

  sendStream(message) {
    if (!this.stream || !this.streamReady || this.stream.readyState !== WebSocket.OPEN) {
      throw new Error('agent-browser stream is not connected');
    }
    this.stream.send(JSON.stringify(message));
  }

  async metadata() {
    const [urlResult, titleResult] = await Promise.all([
      this.command(['get', 'url']),
      this.command(['get', 'title']),
    ]);
    return {
      url: String(commandData(urlResult).url || 'about:blank'),
      title: String(commandData(titleResult).title || ''),
    };
  }

  async navigate(url) {
    await this.command(['open', url]);
    const metadata = await this.metadata();
    this.emit('metadata', metadata);
    return metadata;
  }

  async navigationCommand(command) {
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
    const data = commandData(await this.command(['snapshot', '-i']));
    const metadata = await this.metadata();
    return {
      ...metadata,
      elements: snapshotElements(data.refs),
      accessibilityTree: String(data.snapshot || ''),
      origin: String(data.origin || ''),
    };
  }

  async screenshot() {
    const output = path.join(path.dirname(this.profileDir), `screenshot-${this.generation}.png`);
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
  }

  async click(input) {
    await this.command(['click', normalizeRef(input)]);
    return { ok: true };
  }

  async type(input, clear) {
    const action = clear ? 'fill' : 'type';
    await this.command([action, normalizeRef(input), String(input.text ?? '')]);
    return { ok: true };
  }

  async press(input) {
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

  async resize(value) {
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

  async pointer(input) {
    const x = Number(input.x);
    const y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const eventTypes = {
      move: 'mouseMoved',
      down: 'mousePressed',
      up: 'mouseReleased',
    };
    const eventType = eventTypes[input.action];
    if (!eventType) return;
    this.sendStream({
      type: 'input_mouse',
      eventType,
      x,
      y,
      button: input.action === 'move' ? 'none' : (input.button || 'left'),
      clickCount: input.action === 'move' ? 0 : 1,
      modifiers: Number(input.modifiers) || 0,
    });
  }

  async wheel(input) {
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

  async insertText(text) {
    this.sendStream({
      type: 'input_keyboard',
      eventType: 'char',
      key: '',
      code: '',
      text: String(text || ''),
      windowsVirtualKeyCode: 0,
      modifiers: 0,
    });
  }

  async closeOwnedExternalTab() {
    try {
      await this.command(['tab', 'close', this.tabLabel], { timeoutMs: CLOSE_TIMEOUT_MS });
    } catch (error) {
      const tabs = commandData(await this.command(['tab', 'list'], { timeoutMs: CLOSE_TIMEOUT_MS }));
      const stillExists = (tabs.tabs || []).some(tab => tab?.label === this.tabLabel);
      if (stillExists) throw error;
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
      await this.closeOwnedExternalTab();
    }
    let closeError = null;
    try {
      await this.command(['close'], { timeoutMs: CLOSE_TIMEOUT_MS });
    } catch (error) {
      if (!this.processIdentity || matchingProcessIdentity(
        this.processIdentity,
        await this.readProcessIdentity(this.processIdentity.pid),
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
        if (!await waitForIdentityExit(this.processIdentity, {
          readProcessIdentity: this.readProcessIdentity,
          wait: this.wait,
        })) {
          throw new Error(`agent-browser daemon ${this.processIdentity.pid} did not exit`);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length) {
        throw new Error(cleanupErrors.map(error => error?.message || error).join('; '), {
          cause: cleanupErrors[0],
        });
      }
      this.closeComplete = true;
    })().finally(() => {
      this.closePromise = null;
    });
    return this.closePromise;
  }

  static async recover(options) {
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

module.exports = {
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
