const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const storageLayout = require('../../../backend/storage-layout');
const { BrowserResourceStore, RESOURCE_ID_RE } = require('./browser-resource-store');
const { CdpBrowserRuntime } = require('./cdp-browser-runtime');
const { discoverBrowserExecutable } = require('./executable-discovery');

const MAX_VIEWER_BUFFER_BYTES = 2 * 1024 * 1024;

function publicResource(resource) {
  return {
    id: resource.id,
    projectRootId: resource.projectRootId,
    workspace: resource.workspace,
    name: resource.name,
    status: resource.status,
    generation: resource.generation,
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
    this.discoverExecutable = options.discoverExecutable || (() => discoverBrowserExecutable(options));
    this.createRuntime = options.createRuntime || (input => new CdpBrowserRuntime(input));
    this.isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true;
    this.runtimes = new Map();
    this.operations = new Map();
    this.disposed = false;
  }

  init() {
    this.store.init();
  }

  capability() {
    const executable = this.discoverExecutable();
    const enabled = this.isEnabled() === true;
    return {
      enabled,
      available: enabled && Boolean(executable),
      browser: executable ? { kind: executable.kind, path: executable.path } : null,
      message: !enabled
        ? 'Browser extension is disabled'
        : (executable ? '' : 'Install Chrome, Brave, Edge, or Chromium to use a system Browser in Farming'),
    };
  }

  list() {
    this.requireEnabled();
    return this.store.list().map(publicResource);
  }

  get(id) {
    this.requireEnabled();
    return publicResource(this.requireStored(id));
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
    return publicResource(resource);
  }

  rename(id, name) {
    this.requireEnabled();
    const title = String(name || '').trim();
    if (!title) throw browserError('Browser name is required');
    const resource = this.requireStored(id);
    const next = this.store.update(resource.id, { name: title.slice(0, 120) });
    this.emitResource(next);
    return publicResource(next);
  }

  start(id) {
    this.requireAvailable();
    return this.enqueue(id, async () => {
      const resource = this.requireStored(id);
      const existing = this.runtimes.get(id);
      if (resource.status === 'running' && existing) return publicResource(resource);
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
      const executable = this.discoverExecutable();
      if (!executable) {
        const failed = this.store.update(id, {
          status: 'failed',
          error: 'Install Chrome, Brave, Edge, or Chromium to use a system Browser in Farming',
        });
        this.emitResource(failed);
        throw browserError(failed.error, 503, 'BROWSER_EXECUTABLE_NOT_FOUND');
      }

      const generation = resource.generation + 1;
      const starting = this.store.update(id, {
        status: 'starting',
        generation,
        browserKind: executable.kind,
        error: '',
      });
      this.emitResource(starting);
      const runtime = this.createRuntime({
        id,
        generation,
        executablePath: executable.path,
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
        return publicResource(running);
      } catch (error) {
        let cleanupError = null;
        try {
          await runtime.close();
        } catch (closeError) {
          cleanupError = closeError;
        }
        if (!cleanupError && this.runtimes.get(id) === runtime) this.runtimes.delete(id);
        const current = this.store.get(id);
        const failed = current?.generation === generation
          ? this.store.update(id, {
            status: 'failed',
            error: cleanupError
              ? `${error?.message || 'Failed to start system browser'}; cleanup failed: ${cleanupError.message}`
              : error?.message || 'Failed to start system browser',
          })
          : null;
        if (failed) this.emitResource(failed);
        throw browserError(
          failed?.error || error?.message || 'Failed to start system browser',
          500,
          'BROWSER_START_FAILED',
        );
      }
    });
  }

  stop(id) {
    this.requireEnabled();
    return this.enqueue(id, async () => {
      this.requireStored(id);
      const runtime = this.runtimes.get(id);
      if (!runtime) {
        const stopped = this.store.update(id, { status: 'stopped', error: '' });
        this.emitResource(stopped);
        return publicResource(stopped);
      }
      const stopping = this.store.update(id, { status: 'stopping', error: '' });
      this.emitResource(stopping);
      this.broadcastRuntimeState(runtime);
      await runtime.close();
      if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
      const stopped = this.store.update(id, { status: 'stopped', error: '' });
      this.emitResource(stopped);
      this.broadcastRuntimeState(runtime);
      runtime.viewers?.clear?.();
      return publicResource(stopped);
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
    this.emit('deleted', id);
    return { id };
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
    ws.send(JSON.stringify({ type: 'browser-state', resource: publicResource(resource) }));
    if (!runtime || resource.status !== 'running') return () => {};
    if (!runtime.viewers) runtime.viewers = new Set();
    runtime.viewers.add(ws);
    if (runtime.latestFrame) ws.send(JSON.stringify(runtime.latestFrame));
    const onMessage = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      void this.handleViewerMessage(runtime, message).catch(error => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'browser-error', message: error?.message || 'Browser input failed' }));
        }
      });
    };
    ws.on('message', onMessage);
    const detach = () => {
      runtime.viewers.delete(ws);
      ws.off('message', onMessage);
    };
    ws.once('close', detach);
    return detach;
  }

  async handleViewerMessage(runtime, message) {
    if (message.generation !== runtime.generation || this.runtimes.get(runtime.id) !== runtime) {
      throw browserError('Browser Viewer generation is stale', 409, 'BROWSER_STALE_GENERATION');
    }
    if (message.type === 'resize') {
      // A Browser resource owns one authoritative viewport. Viewer layout is
      // presentation-only: allowing each attached desktop or mobile Viewer to
      // resize the page makes concurrent viewers fight over shared page state.
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
    if (!this.discoverExecutable()) {
      throw browserError(
        'Install Chrome, Brave, Edge, or Chromium to use a system Browser in Farming',
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
    this.emit('resource', publicResource(resource));
  }

  broadcastRuntimeState(runtime) {
    const resource = this.store.get(runtime.id);
    if (!resource) return;
    const message = JSON.stringify({ type: 'browser-state', resource: publicResource(resource) });
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
      error: message || 'System browser exited',
    });
    this.emitResource(failed);
    this.broadcastRuntimeState(runtime);
    try {
      await runtime.close();
      if (this.runtimes.get(runtime.id) === runtime) this.runtimes.delete(runtime.id);
    } catch (error) {
      const cleanupFailed = this.store.update(runtime.id, {
        status: 'failed',
        error: `${failed.error}; cleanup failed: ${error?.message || error}`,
      });
      this.emitResource(cleanupFailed);
      this.broadcastRuntimeState(runtime);
    }
  }
}

module.exports = {
  BrowserResourceManager,
  browserError,
  normalizeUrl,
};
