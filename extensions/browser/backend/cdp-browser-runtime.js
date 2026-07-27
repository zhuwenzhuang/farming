const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const { randomBytes } = require('crypto');
const { EventEmitter } = require('events');
const { readServerProcessIdentity } = require('../../../backend/server-process-identity');
const { CdpClient } = require('./cdp-client');

const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const MAX_VIEWPORT = Object.freeze({ width: 4096, height: 4096 });
// A Viewer may itself be captured by another Browser Resource, including the
// Browser it displays. Bound that video-feedback loop while retaining its last frame.
const VIEWER_FRAME_INTERVAL_MS = 1_000 / 15;
const ACTIONABLE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readCdpVersion(discoveryUrl, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const transport = discoveryUrl.protocol === 'https:' ? https : http;
    const request = transport.get(discoveryUrl, {
      headers: { accept: 'application/json' },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`External CDP discovery returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          request.destroy(new Error('External CDP discovery response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('External CDP discovery returned invalid JSON'));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('External CDP discovery timed out')));
    request.once('error', reject);
  });
}

async function resolveExternalCdpWebSocketUrl(endpoint, options = {}) {
  const configured = new URL(endpoint);
  if (configured.protocol === 'ws:' || configured.protocol === 'wss:') return configured.href;
  const discoveryUrl = new URL(configured.href);
  discoveryUrl.pathname = '/json/version';
  discoveryUrl.search = '';
  const version = await (options.readVersion || readCdpVersion)(discoveryUrl, options.timeoutMs);
  if (!version?.webSocketDebuggerUrl) {
    throw new Error('External CDP discovery did not return webSocketDebuggerUrl');
  }
  let advertised;
  try {
    advertised = new URL(version.webSocketDebuggerUrl);
  } catch {
    throw new Error('External CDP discovery returned an invalid WebSocket URL');
  }
  if (!['ws:', 'wss:'].includes(advertised.protocol)) {
    throw new Error('External CDP discovery returned a non-WebSocket URL');
  }
  // Containerized Chromium often advertises its container hostname or 0.0.0.0.
  // Keep the browser id/path but connect through the explicitly configured tunnel.
  advertised.protocol = configured.protocol === 'https:' ? 'wss:' : 'ws:';
  advertised.hostname = configured.hostname;
  advertised.port = configured.port;
  return advertised.href;
}

function clampViewport(value = {}) {
  const width = Math.round(Number(value.width));
  const height = Math.round(Number(value.height));
  return {
    width: Number.isFinite(width) ? Math.min(MAX_VIEWPORT.width, Math.max(320, width)) : DEFAULT_VIEWPORT.width,
    height: Number.isFinite(height) ? Math.min(MAX_VIEWPORT.height, Math.max(240, height)) : DEFAULT_VIEWPORT.height,
  };
}

function processExitPromise(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

async function waitForExit(child, timeoutMs) {
  let timer;
  const timedOut = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const exited = processExitPromise(child).then(() => true);
  const result = await Promise.race([exited, timedOut]);
  clearTimeout(timer);
  return result;
}

function signalBrowserProcess(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function stopBrowserProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalBrowserProcess(child, 'SIGTERM');
  if (await waitForExit(child, 3_000)) return;
  signalBrowserProcess(child, 'SIGKILL');
  if (!await waitForExit(child, 3_000)) {
    throw new Error(`System browser process ${child.pid || '(unknown)'} did not exit`);
  }
}

async function waitForDevToolsPort(profileDir, child, timeoutMs = 15_000) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.farmingStartError) throw child.farmingStartError;
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = child.farmingStderr ? `: ${child.farmingStderr}` : '';
      throw new Error(`System browser exited during startup (${child.exitCode ?? child.signalCode})${detail}`);
    }
    try {
      const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0 && lines[1]?.startsWith('/')) {
        return `ws://127.0.0.1:${port}${lines[1]}`;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  const detail = child.farmingStderr ? `: ${child.farmingStderr}` : '';
  throw new Error(`System browser did not expose a CDP endpoint before startup timed out${detail}`);
}

function browserLaunchArguments(profileDir, options = {}) {
  const platform = options.platform || process.platform;
  const noSandbox = options.noSandbox === true
    || (options.noSandbox === undefined && process.env.FARMING_BROWSER_NO_SANDBOX === '1');
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    ...(platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
    ...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter',
    '--disable-popup-blocking',
    'about:blank',
  ];
}

function launchSystemBrowser(executablePath, profileDir, options = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });
  const child = (options.spawn || spawn)(
    process.execPath,
    [path.join(__dirname, 'browser-launch-gate.js'), executablePath, ...browserLaunchArguments(profileDir, options)],
    {
    detached: process.platform !== 'win32',
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  child.release = () => {
    if (!child.stdin) throw new Error('Browser launch gate has no release pipe');
    child.stdin.end('GO\n');
  };
  return child;
}

function axValue(node, field) {
  const value = node?.[field]?.value;
  return value === undefined || value === null ? '' : String(value);
}

function compactAxTree(nodes) {
  const lines = [];
  for (const node of nodes.slice(0, 500)) {
    const role = axValue(node, 'role');
    const name = axValue(node, 'name').replace(/\s+/g, ' ').trim();
    if ((!role || role === 'generic' || role === 'none') && !name) continue;
    const value = axValue(node, 'value').replace(/\s+/g, ' ').trim();
    lines.push(`${role || 'node'}${name ? ` "${name.slice(0, 200)}"` : ''}${value ? ` value="${value.slice(0, 200)}"` : ''}`);
  }
  return lines.join('\n');
}

function keyDescription(input) {
  const key = String(input.key || '');
  const code = String(input.code || '');
  const known = {
    Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    Home: { code: 'Home', windowsVirtualKeyCode: 36 },
    End: { code: 'End', windowsVirtualKeyCode: 35 },
    PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 },
    PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 },
    ' ': { code: 'Space', windowsVirtualKeyCode: 32 },
  }[key];
  const upper = key.length === 1 ? key.toUpperCase() : '';
  return {
    key,
    code: code || known?.code || (upper ? `Key${upper}` : key),
    windowsVirtualKeyCode: known?.windowsVirtualKeyCode || (upper ? upper.charCodeAt(0) : 0),
    nativeVirtualKeyCode: known?.windowsVirtualKeyCode || (upper ? upper.charCodeAt(0) : 0),
    modifiers: Number(input.modifiers) || 0,
  };
}

class CdpBrowserRuntime extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id;
    this.generation = options.generation;
    this.executablePath = options.executablePath;
    this.externalCdpUrl = options.externalCdpUrl || '';
    this.profileDir = options.profileDir;
    this.launchBrowser = options.launchBrowser || launchSystemBrowser;
    this.createClient = options.createClient || (() => new CdpClient());
    this.child = null;
    this.client = null;
    this.sessionId = null;
    this.targetId = null;
    this.ownedTargetId = null;
    this.ownedTargetIds = new Set();
    const markerNonce = options.markerNonce || randomBytes(16).toString('hex');
    this.ownedTargetMarker = `about:blank#farming-browser-${encodeURIComponent(this.id)}-${this.generation}-${markerNonce}`;
    this.resolvedCdpWebSocketUrl = '';
    this.sessionListeners = [];
    this.globalListeners = [];
    this.refs = new Map();
    this.viewport = { ...DEFAULT_VIEWPORT };
    this.latestFrame = null;
    this.closedByOwner = false;
    this.closeComplete = false;
    this.closePromise = null;
    this.started = false;
    this.targetChange = Promise.resolve();
    this.screencastFrameTimer = null;
    this.screencastFrameEpoch = 0;
    this.pendingScreencastFrame = null;
    this.lastScreencastFrameAt = null;
    this.now = options.now || Date.now;
    this.scheduleTimeout = options.scheduleTimeout || setTimeout;
    this.cancelTimeout = options.cancelTimeout || clearTimeout;
  }

  async start(initialUrl) {
    try {
      let wsUrl;
      if (this.externalCdpUrl) {
        wsUrl = await resolveExternalCdpWebSocketUrl(this.externalCdpUrl);
        this.resolvedCdpWebSocketUrl = wsUrl;
      } else {
        this.child = this.launchBrowser(this.executablePath, this.profileDir);
        this.child.stderr?.on('data', chunk => {
          const combined = `${this.child.farmingStderr || ''}${chunk.toString('utf8')}`;
          this.child.farmingStderr = combined.slice(-8_192).trim();
        });
        this.child.once('error', error => {
          this.child.farmingStartError = error;
          if (this.started && !this.closedByOwner) this.emit('exit', `System browser failed: ${error.message}`);
        });
        this.child.once('exit', (code, signal) => {
          if (this.closedByOwner) return;
          this.emit('exit', `System browser exited (${code ?? signal ?? 'unknown'})`);
        });
        const processIdentity = await readServerProcessIdentity(this.child.pid);
        if (!processIdentity || processIdentity.processGroupId !== this.child.pid) {
          throw new Error('System browser process identity could not be verified');
        }
        this.processIdentity = processIdentity;
        this.emit('process-identity', processIdentity);
        this.child.release?.();
        wsUrl = await waitForDevToolsPort(this.profileDir, this.child);
      }
      this.client = this.createClient();
      await this.client.connect(wsUrl);
      this.globalListeners.push(this.client.onClose(error => {
        if (this.closedByOwner) return;
        this.emit('exit', error?.message || 'CDP connection closed');
      }));
      this.globalListeners.push(this.client.on('Target.targetCreated', event => {
        const target = event.targetInfo;
        if (!this.started || target?.type !== 'page' || target.targetId === this.targetId) return;
        if (this.externalCdpUrl) {
          if (!this.ownedTargetIds.has(target.openerId)) return;
          this.ownedTargetIds.add(target.targetId);
        }
        this.targetChange = this.targetChange
          .catch(() => {})
          .then(() => this.setActiveTarget(target.targetId))
          .catch(error => this.emit('error', error));
      }));
      this.globalListeners.push(this.client.on('Target.targetDestroyed', event => {
        this.ownedTargetIds.delete(event.targetId);
        if (!this.started || event.targetId !== this.targetId || this.closedByOwner) return;
        this.emit('exit', 'Browser page closed');
      }));
      await this.client.send('Target.setDiscoverTargets', { discover: true });
      let targetId;
      if (this.externalCdpUrl) {
        const created = await this.client.send('Target.createTarget', { url: this.ownedTargetMarker });
        if (!created.targetId) throw new Error('External CDP did not create a page target');
        this.ownedTargetId = created.targetId;
        this.ownedTargetIds.add(created.targetId);
        targetId = created.targetId;
      } else {
        const { targetInfos = [] } = await this.client.send('Target.getTargets');
        targetId = targetInfos.find(candidate => candidate.type === 'page')?.targetId;
        if (!targetId) throw new Error('System browser did not create a page target');
      }
      await this.setActiveTarget(targetId);
      this.started = true;
      if (this.externalCdpUrl) {
        await this.navigate(initialUrl || 'about:blank');
      } else if (initialUrl && initialUrl !== 'about:blank') {
        await this.navigate(initialUrl);
      }
      return await this.metadata();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async setActiveTarget(targetId) {
    if (!this.client || targetId === this.targetId) return;
    await this.detachActiveTarget();
    const { sessionId } = await this.client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.refs.clear();
    const session = sessionId;
    this.sessionListeners.push(
      this.client.on('Page.screencastFrame', event => {
        void this.client?.send('Page.screencastFrameAck', { sessionId: event.sessionId }, session).catch(() => {});
        const frame = {
          type: 'browser-frame',
          generation: this.generation,
          data: event.data,
          metadata: event.metadata,
        };
        this.latestFrame = frame;
        this.publishScreencastFrame(frame, session);
      }, session),
      this.client.on('Page.frameNavigated', event => {
        if (event.frame?.parentId) return;
        void this.publishMetadata();
      }, session),
      this.client.on('Page.loadEventFired', () => {
        void this.publishMetadata();
      }, session),
    );
    await Promise.all([
      this.client.send('Page.enable', {}, session),
      this.client.send('Runtime.enable', {}, session),
      this.client.send('DOM.enable', {}, session),
      this.client.send('Accessibility.enable', {}, session),
    ]);
    await this.resize(this.viewport);
    await this.client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: MAX_VIEWPORT.width,
      maxHeight: MAX_VIEWPORT.height,
      everyNthFrame: 1,
    }, session);
    await this.captureViewerFrame();
    await this.publishMetadata();
  }

  publishScreencastFrame(frame, targetSession) {
    const waitMs = this.lastScreencastFrameAt === null
      ? 0
      : Math.ceil(Math.max(0, VIEWER_FRAME_INTERVAL_MS - (this.now() - this.lastScreencastFrameAt)));
    if (waitMs > 0) {
      this.pendingScreencastFrame = frame;
      if (this.screencastFrameTimer) return;
      const epoch = this.screencastFrameEpoch;
      this.screencastFrameTimer = this.scheduleTimeout(() => {
        this.screencastFrameTimer = null;
        if (epoch !== this.screencastFrameEpoch || targetSession !== this.sessionId) return;
        const pending = this.pendingScreencastFrame;
        this.pendingScreencastFrame = null;
        if (!pending) return;
        this.lastScreencastFrameAt = this.now();
        this.emit('frame', pending);
      }, waitMs);
      return;
    }
    this.lastScreencastFrameAt = this.now();
    this.emit('frame', frame);
  }

  async detachActiveTarget() {
    const session = this.sessionId;
    this.sessionId = null;
    this.targetId = null;
    if (this.screencastFrameTimer) this.cancelTimeout(this.screencastFrameTimer);
    this.screencastFrameTimer = null;
    this.screencastFrameEpoch += 1;
    this.pendingScreencastFrame = null;
    this.lastScreencastFrameAt = null;
    for (const off of this.sessionListeners.splice(0)) off();
    if (!this.client || !session) return;
    await this.client.send('Page.stopScreencast', {}, session).catch(() => {});
    await this.client.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
  }

  requireSession() {
    if (!this.client || !this.sessionId) throw new Error('Browser page is not attached');
    return { client: this.client, sessionId: this.sessionId };
  }

  async evaluate(expression, options = {}) {
    const { client, sessionId } = this.requireSession();
    const result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: options.returnByValue !== false,
      userGesture: true,
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed');
    }
    return result.result;
  }

  async metadata() {
    const result = await this.evaluate(`({
      url: location.href,
      title: document.title
    })`);
    return {
      url: String(result.value?.url || 'about:blank'),
      title: String(result.value?.title || ''),
    };
  }

  async publishMetadata() {
    try {
      this.emit('metadata', await this.metadata());
    } catch {
      // Navigation may briefly replace the execution context.
    }
  }

  async navigate(url) {
    const { client, sessionId } = this.requireSession();
    const result = await client.send('Page.navigate', { url }, sessionId);
    if (result.errorText) throw new Error(result.errorText);
    await delay(50);
    const metadata = await this.metadata().catch(() => ({ url, title: '' }));
    await this.captureViewerFrame();
    this.emit('metadata', metadata);
    return metadata;
  }

  async goBack() {
    return this.navigateHistory(-1);
  }

  async goForward() {
    return this.navigateHistory(1);
  }

  async navigateHistory(delta) {
    const { client, sessionId } = this.requireSession();
    const history = await client.send('Page.getNavigationHistory', {}, sessionId);
    const target = history.entries?.[history.currentIndex + delta];
    if (!target) return this.metadata();
    await client.send('Page.navigateToHistoryEntry', { entryId: target.id }, sessionId);
    await delay(50);
    const metadata = await this.metadata().catch(() => ({ url: target.url, title: target.title || '' }));
    await this.captureViewerFrame();
    this.emit('metadata', metadata);
    return metadata;
  }

  async reload() {
    const { client, sessionId } = this.requireSession();
    await client.send('Page.reload', { ignoreCache: false }, sessionId);
    await delay(50);
    await this.captureViewerFrame();
    return this.metadata();
  }

  async resize(value) {
    this.viewport = clampViewport(value);
    if (!this.client || !this.sessionId) return;
    await this.client.send('Emulation.setDeviceMetricsOverride', {
      ...this.viewport,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: this.viewport.width,
      screenHeight: this.viewport.height,
    }, this.sessionId);
  }

  async screenshot() {
    const { client, sessionId } = this.requireSession();
    const result = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    }, sessionId);
    return { mimeType: 'image/png', data: result.data };
  }

  async captureViewerFrame() {
    const { client, sessionId } = this.requireSession();
    const result = await client.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 80,
      fromSurface: true,
      captureBeyondViewport: false,
    }, sessionId);
    if (sessionId !== this.sessionId || !result.data) return;
    const frame = {
      type: 'browser-frame',
      generation: this.generation,
      data: result.data,
    };
    this.latestFrame = frame;
    this.publishScreencastFrame(frame, sessionId);
  }

  async snapshot() {
    const { client, sessionId } = this.requireSession();
    const { nodes = [] } = await client.send('Accessibility.getFullAXTree', {}, sessionId);
    this.refs.clear();
    const elements = [];
    for (const node of nodes) {
      const role = axValue(node, 'role');
      if (!ACTIONABLE_ROLES.has(role) || !node.backendDOMNodeId || elements.length >= 200) continue;
      const ref = `e${elements.length + 1}`;
      this.refs.set(ref, node.backendDOMNodeId);
      elements.push({
        ref,
        role,
        name: axValue(node, 'name').replace(/\s+/g, ' ').trim().slice(0, 240),
        value: axValue(node, 'value').replace(/\s+/g, ' ').trim().slice(0, 240),
        disabled: Boolean(node.properties?.find(property => property.name === 'disabled')?.value?.value),
      });
    }
    const metadata = await this.metadata();
    return {
      ...metadata,
      elements,
      accessibilityTree: compactAxTree(nodes),
    };
  }

  async resolveElement(input) {
    const { client, sessionId } = this.requireSession();
    const ref = String(input.ref || '').trim();
    const selector = String(input.selector || '').trim();
    if (ref) {
      const backendNodeId = this.refs.get(ref);
      if (!backendNodeId) throw new Error(`Browser ref ${ref} is stale or unknown; take a new snapshot`);
      const { object } = await client.send('DOM.resolveNode', { backendNodeId }, sessionId);
      if (!object?.objectId) throw new Error(`Browser ref ${ref} no longer resolves to an element`);
      return object.objectId;
    }
    if (!selector) throw new Error('ref or selector is required');
    const result = await this.evaluate(`document.querySelector(${JSON.stringify(selector)})`, { returnByValue: false });
    if (!result.objectId || result.subtype === 'null') throw new Error(`No element matches selector: ${selector}`);
    return result.objectId;
  }

  async callOnElement(objectId, functionDeclaration, args = [], returnByValue = true) {
    const { client, sessionId } = this.requireSession();
    try {
      const result = await client.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args.map(value => ({ value })),
        returnByValue,
        awaitPromise: true,
        userGesture: true,
      }, sessionId);
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Element action failed');
      }
      return result.result;
    } finally {
      await client.send('Runtime.releaseObject', { objectId }, sessionId).catch(() => {});
    }
  }

  async focusElement(input, clear = false) {
    const objectId = await this.resolveElement(input);
    return this.callOnElement(objectId, `function(clear) {
      if (!(this instanceof Element)) throw new Error('Target is not an element');
      if (typeof this.scrollIntoView === 'function') this.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof this.focus === 'function') this.focus();
      if (clear) {
        if ('value' in this) {
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (this.isContentEditable) {
          this.textContent = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      const rect = this.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }`, [clear]);
  }

  async click(input) {
    const position = await this.focusElement(input);
    await this.pointer({ action: 'move', ...position.value });
    await this.pointer({ action: 'down', button: 'left', ...position.value });
    await this.pointer({ action: 'up', button: 'left', ...position.value });
    return { ok: true };
  }

  async type(input, clear) {
    await this.focusElement(input, clear);
    const { client, sessionId } = this.requireSession();
    await client.send('Input.insertText', { text: String(input.text ?? '') }, sessionId);
    await this.captureViewerFrame();
    return { ok: true };
  }

  async press(input) {
    const { client, sessionId } = this.requireSession();
    const description = keyDescription(input);
    if (!description.key) throw new Error('key is required');
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...description }, sessionId);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...description }, sessionId);
    await this.captureViewerFrame();
    return { ok: true };
  }

  async pointer(input) {
    const { client, sessionId } = this.requireSession();
    const x = Number(input.x);
    const y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const actionTypes = {
      move: 'mouseMoved',
      down: 'mousePressed',
      up: 'mouseReleased',
    };
    const type = actionTypes[input.action];
    if (!type) return;
    await client.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: input.button || 'none',
      buttons: Number(input.buttons) || 0,
      clickCount: input.action === 'move' ? 0 : 1,
      modifiers: Number(input.modifiers) || 0,
    }, sessionId);
    if (input.action === 'up') await this.captureViewerFrame();
  }

  async wheel(input) {
    const { client, sessionId } = this.requireSession();
    const x = Number(input.x);
    const y = Number(input.y);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Number.isFinite(x) ? x : this.viewport.width / 2,
      y: Number.isFinite(y) ? y : this.viewport.height / 2,
      deltaX: Number(input.deltaX) || 0,
      deltaY: Number(input.deltaY) || 0,
      modifiers: Number(input.modifiers) || 0,
    }, sessionId);
    await this.captureViewerFrame();
  }

  async insertText(text) {
    const { client, sessionId } = this.requireSession();
    await client.send('Input.insertText', { text: String(text || '') }, sessionId);
    await this.captureViewerFrame();
  }

  async closeOwnedExternalTargetsWith(client) {
    const { targetInfos = [] } = await client.send('Target.getTargets');
    for (const target of targetInfos) {
      if (target.url === this.ownedTargetMarker) this.ownedTargetIds.add(target.targetId);
    }
    let added;
    do {
      added = false;
      for (const target of targetInfos) {
        if (this.ownedTargetIds.has(target.targetId) || !this.ownedTargetIds.has(target.openerId)) continue;
        this.ownedTargetIds.add(target.targetId);
        added = true;
      }
    } while (added);
    const targetIds = [...this.ownedTargetIds].reverse();
    for (const targetId of targetIds) {
      try {
        const result = await client.send('Target.closeTarget', { targetId });
        if (result.success === true) continue;
        throw new Error(`External Browser target ${targetId} did not close`);
      } catch (error) {
        const { targetInfos = [] } = await client.send('Target.getTargets');
        if (targetInfos.some(target => target.targetId === targetId)) throw error;
      }
    }
  }

  async closeOwnedExternalTargets() {
    try {
      await this.closeOwnedExternalTargetsWith(this.client);
      return;
    } catch (connectionError) {
      const cleanupClient = this.createClient();
      try {
        if (!this.resolvedCdpWebSocketUrl) {
          throw new Error('External Browser identity was not resolved', { cause: connectionError });
        }
        await cleanupClient.connect(this.resolvedCdpWebSocketUrl);
        await this.closeOwnedExternalTargetsWith(cleanupClient);
      } catch (cleanupError) {
        throw new Error(
          `Could not close external Browser targets: ${cleanupError?.message || connectionError?.message || cleanupError}`,
          { cause: cleanupError },
        );
      } finally {
        cleanupClient.close();
      }
    }
  }

  async close() {
    if (this.closeComplete) return;
    if (this.closePromise) return this.closePromise;
    this.closedByOwner = true;
    this.closePromise = (async () => {
      for (const off of this.globalListeners.splice(0)) off();
      await this.detachActiveTarget();
      if (this.client) {
        if (this.externalCdpUrl) {
          await this.closeOwnedExternalTargets();
        } else {
          await this.client.send('Browser.close').catch(() => {});
        }
        this.ownedTargetId = null;
        this.ownedTargetIds.clear();
        this.client.close();
        this.client = null;
      }
      if (this.child && !await waitForExit(this.child, 3_000)) {
        await stopBrowserProcess(this.child);
      }
      this.child = null;
      this.closeComplete = true;
    })().finally(() => {
      this.closePromise = null;
    });
    return this.closePromise;
  }
}

module.exports = {
  CdpBrowserRuntime,
  DEFAULT_VIEWPORT,
  MAX_VIEWPORT,
  browserLaunchArguments,
  clampViewport,
  launchSystemBrowser,
  readCdpVersion,
  resolveExternalCdpWebSocketUrl,
  stopBrowserProcess,
  waitForDevToolsPort,
};
