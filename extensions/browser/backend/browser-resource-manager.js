const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const storageLayout = require('../../../backend/storage-layout');
const {
  matchingProcessIdentity,
  readServerProcessIdentity,
} = require('../../../backend/server-process-identity');
const { BrowserResourceStore, RESOURCE_ID_RE } = require('./browser-resource-store');
const { AgentBrowserRuntime } = require('./agent-browser-runtime');
const {
  discoverBrowserExecutables,
  discoverBrowserRuntime,
} = require('./executable-discovery');

const MAX_VIEWER_BUFFER_BYTES = 2 * 1024 * 1024;
const VIEWER_RESIZE_SETTLE_MS = 80;
const BROWSER_RECOVERY_TIMEOUT_MS = 5_000;
const BROWSER_RECOVERY_POLL_MS = 100;

function publicResource(resource, collectionRevision) {
  return {
    id: resource.id,
    projectRootId: resource.projectRootId,
    workspace: resource.workspace,
    name: resource.name,
    status: resource.status,
    generation: resource.generation,
    revision: resource.revision,
    collectionRevision,
    url: resource.url,
    title: resource.title,
    browserKind: resource.browserKind,
    error: resource.error,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

function browserError(message, status = 400, code = 'BROWSER_INVALID_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function externalBrowserFailure(action, cause) {
  const error = browserError(
    `${action}; verify the Browser plugin's external CDP address and the browser's /json/version endpoint`,
    500,
    'BROWSER_EXTERNAL_CDP_FAILED',
  );
  error.cause = cause;
  return error;
}

function normalizeUrl(value) {
  const input = String(value || '').trim();
  if (!input) return 'about:blank';
  if (input === 'about:blank') return input;
  const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input) ? input : `http://${input}`;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw browserError('Browser navigation supports only http, https, and about:blank URLs');
    }
    return parsed.href;
  } catch (error) {
    if (error?.status) throw error;
    throw browserError('Invalid Browser URL');
  }
}

class BrowserResourceManager extends EventEmitter {
  constructor(options) {
    super();
    this.configDir = options.configDir;
    this.store = options.store || new BrowserResourceStore(options.configDir);
    this.discoverExecutable = options.discoverExecutable || (selection => discoverBrowserRuntime({
      ...options,
      ...selection,
      configDir: this.configDir,
    }));
    this.discoverBrowserOptions = options.discoverBrowserOptions
      || (options.discoverExecutable ? () => [] : () => discoverBrowserExecutables(options));
    this.getBrowserSettings = typeof options.getBrowserSettings === 'function'
      ? options.getBrowserSettings
      : () => ({ browserSource: 'system', browserExecutablePath: '', browserExternalCdpUrl: '' });
    this.createRuntime = options.createRuntime || (input => new AgentBrowserRuntime(input));
    this.recoverRuntime = options.recoverRuntime || (input => AgentBrowserRuntime.recover(input));
    this.isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true;
    this.readProcessIdentity = options.readProcessIdentity || readServerProcessIdentity;
    this.killProcessGroup = options.killProcessGroup || ((processGroupId, signal) => process.kill(-processGroupId, signal));
    this.wait = options.wait || (durationMs => new Promise(resolve => setTimeout(resolve, durationMs)));
    this.scheduleTimeout = options.scheduleTimeout || setTimeout;
    this.cancelTimeout = options.cancelTimeout || clearTimeout;
    this.runtimes = new Map();
    this.operations = new Map();
    this.disposed = false;
    this.runtimeCapability = null;
    this.browserOptions = [];
  }

  async init() {
    this.store.init();
    await this.refreshCapability();
    const interrupted = this.store.list().filter(resource =>
      ['running', 'starting', 'stopping'].includes(resource.status)
    );
    await Promise.all(interrupted.map(resource => this.recoverInterruptedRuntime(resource)));
  }

  async recoverInterruptedRuntime(resource) {
    if (resource.runtimeKind === 'agent-browser') {
      const capability = this.runtimeCapability || await this.refreshCapability();
      let runtimeError = null;
      if (!capability || capability.error || !capability.agentBrowserPath) {
        runtimeError = new Error(
          capability?.error
          || 'The exact agent-browser runtime required to clean up this Browser is unavailable',
        );
      } else {
        try {
          await this.recoverRuntime({
            id: resource.id,
            generation: resource.generation,
            browserKind: resource.browserKind,
            processIdentity: resource.processIdentity,
            configDir: this.configDir,
            profileDir: storageLayout.browserProfileDir(this.configDir, resource.id),
            agentBrowserPath: capability.agentBrowserPath,
            readProcessIdentity: this.readProcessIdentity,
            wait: this.wait,
          });
        } catch (error) {
          runtimeError = error;
        }
      }
      this.store.update(resource.id, {
        status: 'failed',
        error: runtimeError
          ? `agent-browser Session cleanup failed: ${runtimeError.message || runtimeError}`
          : 'Farming restarted and cleaned up the previous Browser runtime',
        ...(!runtimeError ? { processIdentity: null } : {}),
      });
      return;
    }

    // Migration cleanup for Browser rows created by Farming's former raw-CDP runtime.
    const expected = resource.processIdentity;
    if (!expected) {
      this.store.update(resource.id, {
        status: 'failed',
        error: resource.browserKind === 'external-cdp'
          ? 'Farming restarted and disconnected from the external Browser'
          : 'Farming restarted before the Browser runtime identity was committed',
        processIdentity: null,
      });
      return;
    }
    const current = await this.readProcessIdentity(expected.pid);
    if (!matchingProcessIdentity(expected, current)) {
      this.store.update(resource.id, {
        status: 'failed',
        error: 'Farming restarted after the previous Browser runtime exited',
        processIdentity: null,
      });
      return;
    }
    if (expected.processGroupId !== expected.pid) {
      this.store.update(resource.id, {
        status: 'failed',
        error: `Previous Browser process ${expected.pid} has an unsafe process-group identity; stop it manually`,
      });
      return;
    }
    try {
      this.killProcessGroup(expected.processGroupId, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        const permission = error?.code === 'EPERM' || error?.code === 'EACCES';
        this.store.update(resource.id, {
          status: 'failed',
          error: permission
            ? `Farming cannot clean up previous Browser process ${expected.pid} because it lacks permission`
            : `Farming could not clean up previous Browser process ${expected.pid}: ${error?.message || error}`,
        });
        return;
      }
    }
    const startedAt = Date.now();
    while (matchingProcessIdentity(expected, await this.readProcessIdentity(expected.pid))) {
      if (Date.now() - startedAt >= BROWSER_RECOVERY_TIMEOUT_MS) {
        this.store.update(resource.id, {
          status: 'failed',
          error: `Previous Browser process ${expected.pid} did not exit after SIGKILL`,
        });
        return;
      }
      await this.wait(BROWSER_RECOVERY_POLL_MS);
    }
    this.store.update(resource.id, {
      status: 'failed',
      error: 'Farming restarted and cleaned up the previous Browser runtime',
      processIdentity: null,
    });
  }

  capability() {
    const executable = this.runtimeCapability;
    const runnable = executable && !executable.error;
    const enabled = this.isEnabled() === true;
    const selection = this.browserSelection();
    return {
      enabled,
      available: enabled && Boolean(runnable),
      browser: runnable ? { kind: executable.kind, path: executable.path } : null,
      selection,
      options: this.browserOptions.map(option => ({ kind: option.kind, path: option.path })),
      message: !enabled
        ? 'Browser extension is disabled'
        : (executable?.error || (runnable
            ? ''
            : 'Install agent-browser and a Chromium-based browser, or configure a loopback external CDP endpoint')),
    };
  }

  browserSelection(settings = this.getBrowserSettings()) {
    return {
      source: settings?.browserSource === 'external-cdp' ? 'external-cdp' : 'system',
      executablePath: String(settings?.browserExecutablePath || ''),
      externalCdpUrl: String(settings?.browserExternalCdpUrl || 'http://127.0.0.1:9222'),
    };
  }

  async probeCapability(selection = this.browserSelection()) {
    const browserOptions = this.discoverBrowserOptions();
    const selectedOption = browserOptions.find(option => option.path === selection.executablePath);
    const runtimeCapability = await this.discoverExecutable({
      source: selection.source,
      executablePath: selection.executablePath,
      executableKind: selectedOption?.kind,
      externalCdpUrl: selection.externalCdpUrl,
    });
    return { browserOptions, runtimeCapability };
  }

  async refreshCapability(selection = this.browserSelection()) {
    const probe = await this.probeCapability(selection);
    this.browserOptions = probe.browserOptions;
    this.runtimeCapability = probe.runtimeCapability;
    return this.runtimeCapability;
  }

  list() {
    this.requireEnabled();
    return this.store.list().map(resource => publicResource(resource, this.store.revision));
  }

  snapshot() {
    return {
      collectionRevision: this.store.revision,
      resources: this.list(),
    };
  }

  get(id) {
    this.requireEnabled();
    return publicResource(this.requireStored(id), this.store.revision);
  }

  create(input) {
    this.requireAvailable();
    if (this.disposed) throw browserError('Browser manager is stopping', 503, 'BROWSER_MANAGER_STOPPING');
    const resource = this.store.create({
      projectRootId: input.projectRootId,
      workspace: input.workspace,
      name: input.name,
      url: normalizeUrl(input.url),
    });
    this.emitResource(resource);
    return publicResource(resource, this.store.revision);
  }

  rename(id, name) {
    this.requireEnabled();
    const title = String(name || '').trim();
    if (!title) throw browserError('Browser name is required');
    const resource = this.requireStored(id);
    const next = this.store.update(resource.id, { name: title.slice(0, 120) });
    this.emitResource(next);
    return publicResource(next, this.store.revision);
  }

  start(id) {
    this.requireEnabled();
    return this.enqueue(id, async () => {
      const resource = this.requireStored(id);
      const existing = this.runtimes.get(id);
      if (resource.status === 'running' && existing) return publicResource(resource, this.store.revision);
      if (existing) {
        throw browserError(
          'A previous Browser runtime still owns this resource; stop it before restarting',
          409,
          'BROWSER_RUNTIME_OWNED',
        );
      }
      if (resource.status === 'starting' || resource.status === 'stopping') {
        throw browserError(`Browser is ${resource.status}`, 409, 'BROWSER_BUSY');
      }
      if (resource.processIdentity) {
        const blockedIdentity = resource.processIdentity;
        throw browserError(
          `Previous Browser process ${blockedIdentity.pid} still requires cleanup`,
          409,
          'BROWSER_RECOVERY_CLEANUP_REQUIRED',
        );
      }
      const executable = await this.refreshCapability();
      if (!executable || executable.error) {
        const failed = this.store.update(id, {
          status: 'failed',
          error: executable?.error
            || 'Install agent-browser and a Chromium-based browser, or configure a loopback external CDP endpoint',
        });
        this.emitResource(failed);
        throw browserError(failed.error, 503, 'BROWSER_EXECUTABLE_NOT_FOUND');
      }

      const generation = resource.generation + 1;
      const starting = this.store.update(id, {
        status: 'starting',
        generation,
        browserKind: executable.kind,
        runtimeKind: 'agent-browser',
        error: '',
        processIdentity: null,
      });
      this.emitResource(starting);
      const runtime = this.createRuntime({
        id,
        generation,
        configDir: this.configDir,
        agentBrowserPath: executable.agentBrowserPath,
        executablePath: executable.path,
        externalCdpUrl: executable.cdpUrl || '',
        profileDir: storageLayout.browserProfileDir(this.configDir, id),
      });
      this.runtimes.set(id, runtime);
      this.bindRuntime(runtime);
      try {
        const metadata = await runtime.start(resource.url);
        if (this.runtimes.get(id) !== runtime) {
          throw browserError('Browser startup lost runtime ownership', 409, 'BROWSER_START_REPLACED');
        }
        const running = this.store.update(id, {
          status: 'running',
          url: metadata.url || resource.url,
          title: metadata.title || '',
          error: '',
        });
        this.emitResource(running);
        this.broadcastRuntimeState(runtime);
        return publicResource(running, this.store.revision);
      } catch (error) {
        let cleanupError = null;
        try {
          await runtime.close();
        } catch (closeError) {
          cleanupError = closeError;
        }
        if (!cleanupError && this.runtimes.get(id) === runtime) this.runtimes.delete(id);
        const current = this.store.get(id);
        const failureMessage = executable.kind === 'external-cdp'
          ? externalBrowserFailure('External Browser connection failed', error).message
          : error?.message || 'Failed to start Browser';
        const failed = current?.generation === generation
          ? this.store.update(id, {
            status: 'failed',
            error: cleanupError
              ? `${failureMessage}; cleanup failed`
              : failureMessage,
            ...(!cleanupError ? { processIdentity: null } : {}),
          })
          : null;
        if (failed) this.emitResource(failed);
        throw browserError(
          failed?.error || error?.message || 'Failed to start Browser',
          500,
          'BROWSER_START_FAILED',
        );
      }
    });
  }

  stop(id) {
    this.requireEnabled();
    return this.enqueue(id, async () => {
      const resource = this.requireStored(id);
      const runtime = this.runtimes.get(id);
      if (!runtime) {
        if (resource.processIdentity) {
          await this.recoverInterruptedRuntime(resource);
          const recovered = this.requireStored(id);
          if (recovered.processIdentity) {
            const blockedIdentity = recovered.processIdentity;
            throw browserError(
              recovered.error || `Previous Browser process ${blockedIdentity.pid} still requires cleanup`,
              500,
              'BROWSER_RECOVERY_CLEANUP_REQUIRED',
            );
          }
        }
        const stopped = this.store.update(id, {
          status: 'stopped',
          error: '',
          processIdentity: null,
        });
        this.emitResource(stopped);
        return publicResource(stopped, this.store.revision);
      }
      const stopping = this.store.update(id, { status: 'stopping', error: '' });
      this.emitResource(stopping);
      this.broadcastRuntimeState(runtime);
      try {
        await runtime.close();
      } catch (error) {
        if (resource.browserKind === 'external-cdp') {
          throw externalBrowserFailure('External Browser targets could not be closed', error);
        }
        throw error;
      }
      if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
      const stopped = this.store.update(id, {
        status: 'stopped',
        error: '',
        processIdentity: null,
      });
      this.emitResource(stopped);
      this.broadcastRuntimeState(runtime);
      this.releaseViewerState(runtime);
      return publicResource(stopped, this.store.revision);
    });
  }

  async delete(id) {
    this.requireEnabled();
    await this.stop(id);
    this.requireStored(id);
    this.store.delete(id);
    const profileDir = storageLayout.browserProfileDir(this.configDir, id);
    const browsersDir = path.resolve(storageLayout.browserResourcesDir(this.configDir));
    const resourceDir = path.resolve(profileDir, '..');
    if (resourceDir.startsWith(`${browsersDir}${path.sep}`) && RESOURCE_ID_RE.test(id)) {
      fs.rmSync(resourceDir, { recursive: true, force: true });
    }
    this.emit('deleted', { id, collectionRevision: this.store.revision });
    return { id, collectionRevision: this.store.revision };
  }

  navigate(id, url) {
    this.requireEnabled();
    const normalized = normalizeUrl(url);
    return this.withRuntime(id, async runtime => {
      const metadata = await runtime.navigate(normalized);
      this.updateMetadata(runtime, metadata);
      return this.get(id);
    });
  }

  goBack(id) {
    return this.withRuntime(id, async runtime => {
      const metadata = await runtime.goBack();
      this.updateMetadata(runtime, metadata);
      return this.get(id);
    });
  }

  goForward(id) {
    return this.withRuntime(id, async runtime => {
      const metadata = await runtime.goForward();
      this.updateMetadata(runtime, metadata);
      return this.get(id);
    });
  }

  reload(id) {
    return this.withRuntime(id, async runtime => {
      const metadata = await runtime.reload();
      this.updateMetadata(runtime, metadata);
      return this.get(id);
    });
  }

  action(id, input) {
    this.requireEnabled();
    const kind = String(input?.kind || '').trim();
    if (kind === 'snapshot') return this.withRuntime(id, runtime => runtime.snapshot());
    if (kind === 'screenshot') return this.withRuntime(id, runtime => runtime.screenshot());
    if (kind === 'navigate') return this.navigate(id, input.url);
    if (kind === 'back') return this.goBack(id);
    if (kind === 'forward') return this.goForward(id);
    if (kind === 'reload') return this.reload(id);
    if (kind === 'click') return this.withRuntime(id, runtime => runtime.click(input));
    if (kind === 'type') return this.withRuntime(id, runtime => runtime.type(input, false));
    if (kind === 'fill') return this.withRuntime(id, runtime => runtime.type(input, true));
    if (kind === 'press') return this.withRuntime(id, runtime => runtime.press(input));
    if (kind === 'scroll') return this.withRuntime(id, async runtime => {
      await runtime.wheel(input);
      return { ok: true };
    });
    throw browserError(`Unsupported Browser action: ${kind || '(missing)'}`);
  }

  attachViewer(id, ws) {
    this.requireEnabled();
    const resource = this.requireStored(id);
    const runtime = this.runtimes.get(id);
    ws.send(JSON.stringify({
      type: 'browser-state',
      resource: publicResource(resource, this.store.revision),
    }));
    if (!runtime || resource.status !== 'running') return () => {};
    if (!runtime.viewers) runtime.viewers = new Set();
    if (!runtime.viewerGeometries) runtime.viewerGeometries = new Map();
    runtime.viewers.add(ws);
    if (runtime.latestFrame) ws.send(JSON.stringify(runtime.latestFrame));
    const onMessage = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const operation = message.type === 'resize'
        ? this.scheduleViewerResize(runtime, ws, message)
        : this.handleViewerMessage(runtime, ws, message);
      void Promise.resolve(operation).catch(error => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'browser-error', message: error?.message || 'Browser input failed' }));
        }
      });
    };
    ws.on('message', onMessage);
    const detach = () => {
      runtime.viewers.delete(ws);
      runtime.viewerGeometries.delete(ws);
      if (runtime.viewerViewportOwner === ws) {
        runtime.viewerViewportOwner = runtime.viewers.values().next().value || null;
        if (runtime.viewerViewportOwner) {
          const geometry = runtime.viewerGeometries.get(runtime.viewerViewportOwner);
          if (geometry) this.scheduleViewerResize(runtime, runtime.viewerViewportOwner, geometry);
        } else {
          this.clearViewerResize(runtime);
        }
      }
      ws.off('message', onMessage);
    };
    ws.once('close', detach);
    return detach;
  }

  handleViewerMessage(runtime, viewer, message) {
    const next = (runtime.actionChain || Promise.resolve())
      .catch(() => {})
      .then(() => this.performViewerMessage(runtime, viewer, message));
    runtime.actionChain = next;
    return next;
  }

  scheduleViewerResize(runtime, viewer, message) {
    if (message.generation !== runtime.generation || this.runtimes.get(runtime.id) !== runtime) {
      return Promise.reject(browserError('Browser Viewer generation is stale', 409, 'BROWSER_STALE_GENERATION'));
    }
    const width = Math.round(Number(message.width));
    const height = Math.round(Number(message.height));
    const requestedDeviceScaleFactor = Number(message.deviceScaleFactor);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return Promise.reject(browserError('Browser Viewer size is invalid'));
    }
    const deviceScaleFactor = Number.isFinite(requestedDeviceScaleFactor)
      ? Math.max(1, Math.min(2, requestedDeviceScaleFactor))
      : 1;
    const geometry = {
      type: 'resize',
      generation: message.generation,
      width,
      height,
      deviceScaleFactor,
    };
    runtime.viewerGeometries.set(viewer, geometry);
    if (
      message.claim === true
      || !runtime.viewerViewportOwner
      || !runtime.viewers.has(runtime.viewerViewportOwner)
    ) {
      runtime.viewerViewportOwner = viewer;
    }
    if (runtime.viewerViewportOwner !== viewer) return Promise.resolve();
    runtime.pendingViewerResize = { viewer, geometry };
    if (runtime.viewerResizeTimer) this.cancelTimeout(runtime.viewerResizeTimer);
    runtime.viewerResizeTimer = this.scheduleTimeout(() => {
      runtime.viewerResizeTimer = null;
      const pending = runtime.pendingViewerResize;
      runtime.pendingViewerResize = null;
      if (!pending || runtime.viewerViewportOwner !== pending.viewer) return;
      void this.handleViewerMessage(runtime, pending.viewer, pending.geometry).catch(error => {
        if (pending.viewer.readyState === 1) {
          pending.viewer.send(JSON.stringify({
            type: 'browser-error',
            message: error?.message || 'Browser resize failed',
          }));
        }
      });
    }, VIEWER_RESIZE_SETTLE_MS);
    runtime.viewerResizeTimer.unref?.();
    return Promise.resolve();
  }

  clearViewerResize(runtime) {
    if (runtime.viewerResizeTimer) this.cancelTimeout(runtime.viewerResizeTimer);
    runtime.viewerResizeTimer = null;
    runtime.pendingViewerResize = null;
  }

  releaseViewerState(runtime) {
    this.clearViewerResize(runtime);
    runtime.viewerGeometries?.clear?.();
    runtime.viewerViewportOwner = null;
    runtime.viewers?.clear?.();
  }

  async performViewerMessage(runtime, viewer, message) {
    if (message.generation !== runtime.generation || this.runtimes.get(runtime.id) !== runtime) {
      throw browserError('Browser Viewer generation is stale', 409, 'BROWSER_STALE_GENERATION');
    }
    if (message.type === 'resize') {
      if (runtime.viewerViewportOwner !== viewer) return;
      await runtime.resize({
        width: message.width,
        height: message.height,
        deviceScaleFactor: message.deviceScaleFactor,
      });
      return;
    }
    if (message.type === 'pointer') {
      await runtime.pointer(message);
      return;
    }
    if (message.type === 'wheel') {
      await runtime.wheel(message);
      return;
    }
    if (message.type === 'key') {
      await runtime.press(message);
      return;
    }
    if (message.type === 'text') {
      await runtime.insertText(message.text);
    }
  }

  async dispose() {
    this.disposed = true;
    const runtimes = [...this.runtimes.values()];
    const results = await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    const failures = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason?.message || String(result.reason));
    if (failures.length > 0) {
      throw new Error(`Browser runtime cleanup failed: ${failures.join('; ')}`);
    }
    for (const runtime of runtimes) this.releaseViewerState(runtime);
    this.runtimes.clear();
  }

  async stopAll() {
    const ids = [...this.runtimes.keys()];
    const results = await Promise.allSettled(ids.map(id => this.stop(id)));
    const failures = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason?.message || String(result.reason));
    if (failures.length > 0) {
      throw browserError(
        `Browser extension could not stop every running Browser: ${failures.join('; ')}`,
        500,
        'BROWSER_DISABLE_FAILED',
      );
    }
  }

  requireEnabled() {
    if (this.isEnabled() !== true) {
      throw browserError('Browser extension is disabled', 409, 'BROWSER_EXTENSION_DISABLED');
    }
  }

  requireAvailable() {
    this.requireEnabled();
    const executable = this.runtimeCapability;
    if (!executable || executable.error) {
      throw browserError(
        executable?.error || 'Install agent-browser and a Chromium-based browser, or configure a loopback external CDP endpoint',
        503,
        'BROWSER_EXECUTABLE_NOT_FOUND',
      );
    }
  }

  requireStored(id) {
    if (!RESOURCE_ID_RE.test(String(id || ''))) {
      throw browserError('Invalid Browser resource id');
    }
    const resource = this.store.get(id);
    if (!resource) throw browserError('Browser resource not found', 404, 'BROWSER_NOT_FOUND');
    return resource;
  }

  enqueue(id, operation) {
    const previous = this.operations.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.operations.set(id, next);
    return next.finally(() => {
      if (this.operations.get(id) === next) this.operations.delete(id);
    });
  }

  withRuntime(id, operation) {
    const runtime = this.runtimes.get(id);
    const resource = this.requireStored(id);
    if (!runtime || resource.status !== 'running') {
      throw browserError('Browser is not running', 409, 'BROWSER_NOT_RUNNING');
    }
    const next = (runtime.actionChain || Promise.resolve())
      .catch(() => {})
      .then(() => operation(runtime));
    runtime.actionChain = next;
    return next;
  }

  bindRuntime(runtime) {
    runtime.on('process-identity', processIdentity => {
      const current = this.store.get(runtime.id);
      if (
        this.runtimes.get(runtime.id) !== runtime
        || !current
        || current.generation !== runtime.generation
      ) return;
      this.store.update(runtime.id, { processIdentity });
    });
    runtime.on('frame', frame => {
      runtime.latestFrame = frame;
      for (const viewer of runtime.viewers || []) {
        if (viewer.readyState === 1 && (Number(viewer.bufferedAmount) || 0) <= MAX_VIEWER_BUFFER_BYTES) {
          viewer.send(JSON.stringify(frame));
        }
      }
    });
    runtime.on('metadata', metadata => this.updateMetadata(runtime, metadata));
    runtime.on('error', error => {
      for (const viewer of runtime.viewers || []) {
        if (viewer.readyState === 1) {
          viewer.send(JSON.stringify({ type: 'browser-error', message: error?.message || 'Browser runtime failed' }));
        }
      }
    });
    runtime.once('exit', message => {
      void this.handleRuntimeExit(runtime, message);
    });
  }

  updateMetadata(runtime, metadata) {
    const current = this.store.get(runtime.id);
    if (!current || current.generation !== runtime.generation || !metadata) return;
    const next = this.store.update(runtime.id, {
      url: String(metadata.url || current.url),
      title: String(metadata.title || ''),
    });
    this.emitResource(next);
    this.broadcastRuntimeState(runtime);
  }

  emitResource(resource) {
    this.emit('resource', publicResource(resource, this.store.revision));
  }

  broadcastRuntimeState(runtime) {
    const resource = this.store.get(runtime.id);
    if (!resource) return;
    const message = JSON.stringify({
      type: 'browser-state',
      resource: publicResource(resource, this.store.revision),
    });
    for (const viewer of runtime.viewers || []) {
      if (viewer.readyState === 1) viewer.send(message);
    }
  }

  async handleRuntimeExit(runtime, message) {
    const current = this.store.get(runtime.id);
    if (
      this.runtimes.get(runtime.id) !== runtime
      || !current
      || current.generation !== runtime.generation
    ) return;
    const failed = this.store.update(runtime.id, {
      status: 'failed',
      error: current.browserKind === 'external-cdp'
        ? 'External Browser connection exited'
        : message || 'Browser connection exited',
    });
    this.emitResource(failed);
    this.broadcastRuntimeState(runtime);
    try {
      await runtime.close();
      if (this.runtimes.get(runtime.id) === runtime) this.runtimes.delete(runtime.id);
      this.releaseViewerState(runtime);
      const cleaned = this.store.update(runtime.id, {
        processIdentity: null,
      });
      this.emitResource(cleaned);
      this.broadcastRuntimeState(runtime);
    } catch (error) {
      const cleanupFailed = this.store.update(runtime.id, {
        status: 'failed',
        error: current.browserKind === 'external-cdp'
          ? `${failed.error}; target cleanup failed`
          : `${failed.error}; cleanup failed: ${error?.message || error}`,
      });
      this.emitResource(cleanupFailed);
      this.broadcastRuntimeState(runtime);
    }
  }
}

module.exports = {
  BrowserResourceManager,
  browserError,
  externalBrowserFailure,
  normalizeUrl,
};
