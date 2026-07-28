const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const MAX_UPLOAD_FILES = 20;

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
  let url = input;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) {
    const authority = input.split(/[/?#]/, 1)[0];
    const hostname = authority.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    const explicitPort = authority.match(/:(\d+)$/)?.[1] || '';
    const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || authority.startsWith('[');
    const localHost = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || !hostname.includes('.')
      || isIpLiteral;
    url = `${localHost || (explicitPort && explicitPort !== '443') ? 'http' : 'https'}://${input}`;
  }
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

function tabResourceName(tab) {
  const title = String(tab?.title || '').trim();
  if (title) return title.slice(0, 120);
  try {
    return new URL(String(tab?.url || '')).hostname.slice(0, 120) || 'Browser';
  } catch {
    return 'Browser';
  }
}

function pathInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveWorkspaceInputFile(resource, value) {
  const workspace = fs.realpathSync(resource.workspace);
  const requested = path.resolve(resource.workspace, String(value || ''));
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch {
    throw browserError(`Upload file does not exist: ${value}`);
  }
  if (!pathInside(workspace, resolved)) {
    throw browserError('Browser uploads must stay inside the Browser Project workspace');
  }
  if (!fs.statSync(resolved).isFile()) {
    throw browserError(`Browser upload path is not a file: ${value}`);
  }
  return resolved;
}

function resolveWorkspaceOutputFile(resource, value) {
  const requestedValue = String(value || '').trim();
  if (!requestedValue) throw browserError('Download output path is required');
  const workspace = fs.realpathSync(resource.workspace);
  const requested = path.resolve(resource.workspace, requestedValue);
  if (!pathInside(path.resolve(resource.workspace), requested)) {
    throw browserError('Browser downloads must stay inside the Browser Project workspace');
  }
  let parent;
  try {
    parent = fs.realpathSync(path.dirname(requested));
  } catch {
    throw browserError('Browser download parent directory does not exist');
  }
  if (!pathInside(workspace, parent)) {
    throw browserError('Browser downloads must stay inside the Browser Project workspace');
  }
  if (fs.existsSync(requested)) {
    throw browserError('Browser download target already exists');
  }
  return requested;
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
    this.sessions = new Map();
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
    const groups = new Map();
    for (const resource of interrupted) {
      const key = resource.runtimeKind === 'agent-browser'
        ? (resource.sessionId || resource.id)
        : resource.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(resource);
    }
    await Promise.all([...groups.values()].map(resources => {
      const owner = resources.find(resource => resource.processIdentity) || resources[0];
      return this.recoverInterruptedRuntime(owner, resources);
    }));
  }

  async recoverInterruptedRuntime(resource, relatedResources = [resource]) {
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
            id: resource.sessionId || resource.id,
            generation: resource.sessionGeneration || resource.generation,
            browserKind: resource.browserKind,
            processIdentity: resource.processIdentity,
            configDir: this.configDir,
            profileDir: storageLayout.browserProfileDir(
              this.configDir,
              resource.sessionId || resource.id,
            ),
            agentBrowserPath: capability.agentBrowserPath,
            readProcessIdentity: this.readProcessIdentity,
            wait: this.wait,
          });
        } catch (error) {
          runtimeError = error;
        }
      }
      for (const related of relatedResources) {
        this.store.update(related.id, {
          status: 'failed',
          error: runtimeError
            ? `agent-browser Session cleanup failed: ${runtimeError.message || runtimeError}`
            : 'Farming restarted and cleaned up the previous Browser runtime',
          ...(!runtimeError ? { processIdentity: null } : {}),
          tabId: '',
        });
      }
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
      const existingBinding = this.runtimes.get(id);
      if (resource.status === 'running' && existingBinding) {
        return publicResource(resource, this.store.revision);
      }
      if (existingBinding) {
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

      const reusableSession = [...this.sessions.values()].find(session => (
        !session.closing
        && session.projectRootId === resource.projectRootId
        && session.browserKind === executable.kind
      ));
      if (reusableSession) {
        try {
          let running;
          let binding;
          const operation = (reusableSession.actionChain || Promise.resolve())
            .catch(() => {})
            .then(async () => {
              const tab = await reusableSession.runtime.createTab(
                resource.url,
                executable.kind === 'external-cdp'
                  ? `farming-${resource.id}-g${generation}`
                  : '',
              );
              binding = this.createBinding(reusableSession, {
                ...starting,
                tabId: tab.tabId,
              });
              reusableSession.bindings.set(id, binding);
              reusableSession.activeResourceId = id;
              this.runtimes.set(id, binding);
              running = this.store.update(id, {
                status: 'running',
                sessionId: reusableSession.id,
                sessionGeneration: reusableSession.generation,
                tabId: tab.tabId,
                url: tab.url || resource.url,
                title: tab.title || '',
                error: '',
                processIdentity: null,
              });
            });
          reusableSession.actionChain = operation;
          await operation;
          this.emitResource(running);
          this.broadcastRuntimeState(binding);
          return publicResource(running, this.store.revision);
        } catch (error) {
          const failed = this.store.update(id, {
            status: 'failed',
            error: error?.message || 'Failed to create Browser tab',
            tabId: '',
          });
          this.emitResource(failed);
          throw browserError(failed.error, 500, 'BROWSER_START_FAILED');
        }
      }

      const sessionId = resource.sessionId || id;
      const previousSessionGeneration = this.store.list()
        .filter(candidate => candidate.sessionId === sessionId)
        .reduce((maximum, candidate) => Math.max(maximum, candidate.sessionGeneration || 0), 0);
      const sessionGeneration = previousSessionGeneration + 1;
      const runtime = this.createRuntime({
        id: sessionId,
        generation: sessionGeneration,
        configDir: this.configDir,
        agentBrowserPath: executable.agentBrowserPath,
        executablePath: executable.path,
        externalCdpUrl: executable.cdpUrl || '',
        profileDir: storageLayout.browserProfileDir(this.configDir, sessionId),
      });
      const session = {
        id: sessionId,
        generation: sessionGeneration,
        projectRootId: resource.projectRootId,
        browserKind: executable.kind,
        runtime,
        bindings: new Map(),
        activeResourceId: id,
        processOwnerResourceId: id,
        actionChain: Promise.resolve(),
        reconcilingTabs: Promise.resolve(),
        initializing: true,
        closing: false,
      };
      const binding = this.createBinding(session, starting);
      session.bindings.set(id, binding);
      this.sessions.set(sessionId, session);
      this.runtimes.set(id, binding);
      this.bindSession(session);
      try {
        const metadata = await runtime.start(resource.url);
        const tabs = await runtime.listTabs();
        const tab = tabs.find(candidate => candidate.active) || tabs[0];
        if (!tab) throw new Error('agent-browser did not report the Browser tab');
        binding.tabId = tab.tabId;
        if (this.runtimes.get(id) !== binding) {
          throw browserError('Browser startup lost runtime ownership', 409, 'BROWSER_START_REPLACED');
        }
        const running = this.store.update(id, {
          status: 'running',
          sessionId,
          sessionGeneration,
          tabId: tab.tabId,
          url: metadata.url || resource.url,
          title: metadata.title || '',
          error: '',
        });
        session.initializing = false;
        this.emitResource(running);
        this.broadcastRuntimeState(binding);
        return publicResource(running, this.store.revision);
      } catch (error) {
        session.initializing = false;
        let cleanupError = null;
        try {
          await runtime.close();
        } catch (closeError) {
          cleanupError = closeError;
        }
        if (!cleanupError && this.runtimes.get(id) === binding) this.runtimes.delete(id);
        if (!cleanupError && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
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
            tabId: '',
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
      const binding = this.runtimes.get(id);
      if (!binding) {
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
      this.broadcastRuntimeState(binding);
      const { session } = binding;
      session.closing = session.bindings.size === 1;
      try {
        await session.actionChain?.catch(() => {});
        if (session.bindings.size > 1) {
          await session.runtime.closeTab(binding.tabId);
        } else {
          await session.runtime.close();
        }
      } catch (error) {
        session.closing = false;
        if (resource.browserKind === 'external-cdp') {
          throw externalBrowserFailure('External Browser targets could not be closed', error);
        }
        throw error;
      }
      session.bindings.delete(id);
      if (this.runtimes.get(id) === binding) this.runtimes.delete(id);
      if (session.bindings.size === 0 && this.sessions.get(session.id) === session) {
        this.sessions.delete(session.id);
      }
      session.closing = false;

      if (session.processOwnerResourceId === id && session.bindings.size > 0) {
        const nextOwner = session.bindings.values().next().value;
        session.processOwnerResourceId = nextOwner.id;
        const ownerResource = this.store.update(nextOwner.id, {
          processIdentity: resource.processIdentity,
        });
        this.emitResource(ownerResource);
        this.broadcastRuntimeState(nextOwner);
      }
      const stopped = this.store.update(id, {
        status: 'stopped',
        error: '',
        processIdentity: null,
        tabId: '',
      });
      this.emitResource(stopped);
      this.broadcastRuntimeState(binding);
      this.releaseViewerState(binding);
      return publicResource(stopped, this.store.revision);
    });
  }

  async delete(id) {
    this.requireEnabled();
    await this.stop(id);
    const resource = this.requireStored(id);
    this.store.delete(id);
    const sessionId = resource.sessionId || id;
    const profileDir = storageLayout.browserProfileDir(this.configDir, sessionId);
    const browsersDir = path.resolve(storageLayout.browserResourcesDir(this.configDir));
    const resourceDir = path.resolve(profileDir, '..');
    const sessionStillReferenced = this.store.list().some(candidate => candidate.sessionId === sessionId);
    if (
      !sessionStillReferenced
      && resourceDir.startsWith(`${browsersDir}${path.sep}`)
      && RESOURCE_ID_RE.test(sessionId)
    ) {
      fs.rmSync(resourceDir, { recursive: true, force: true });
    }
    this.emit('deleted', { id, collectionRevision: this.store.revision });
    return { id, collectionRevision: this.store.revision };
  }

  navigate(id, url) {
    this.requireEnabled();
    const normalized = normalizeUrl(url);
    return this.withRuntime(id, async (runtime, binding) => {
      const metadata = await runtime.navigate(normalized);
      this.updateMetadata(binding, metadata);
      return this.get(id);
    });
  }

  goBack(id) {
    return this.withRuntime(id, async (runtime, binding) => {
      const metadata = await runtime.goBack();
      this.updateMetadata(binding, metadata);
      return this.get(id);
    });
  }

  goForward(id) {
    return this.withRuntime(id, async (runtime, binding) => {
      const metadata = await runtime.goForward();
      this.updateMetadata(binding, metadata);
      return this.get(id);
    });
  }

  reload(id) {
    return this.withRuntime(id, async (runtime, binding) => {
      const metadata = await runtime.reload();
      this.updateMetadata(binding, metadata);
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
    if ([
      'dblclick',
      'hover',
      'focus',
      'check',
      'uncheck',
      'scrollintoview',
      'highlight',
    ].includes(kind)) {
      return this.withRuntime(id, runtime => runtime.elementAction(kind, input));
    }
    if (kind === 'type') return this.withRuntime(id, runtime => runtime.type(input, false));
    if (kind === 'fill') return this.withRuntime(id, runtime => runtime.type(input, true));
    if (kind === 'keyboard') return this.withRuntime(id, runtime => runtime.keyboard(input));
    if (kind === 'press') return this.withRuntime(id, runtime => runtime.press(input));
    if (kind === 'select') return this.withRuntime(id, runtime => runtime.select(input));
    if (kind === 'drag') return this.withRuntime(id, runtime => runtime.drag(input));
    if (kind === 'wait') return this.withRuntime(id, runtime => runtime.waitFor(input));
    if (kind === 'get') return this.withRuntime(id, runtime => runtime.get(input));
    if (kind === 'is') return this.withRuntime(id, runtime => runtime.is(input));
    if (kind === 'find') return this.withRuntime(id, runtime => runtime.find(input));
    if (kind === 'eval') return this.withRuntime(id, runtime => runtime.evaluate(input));
    if (kind === 'console' || kind === 'errors') {
      return this.withRuntime(id, runtime => runtime.debugLog(kind, input));
    }
    if (kind === 'network') return this.withRuntime(id, runtime => runtime.network(input));
    if (kind === 'cookies') return this.withRuntime(id, runtime => runtime.cookies(input));
    if (kind === 'storage') return this.withRuntime(id, runtime => runtime.storage(input));
    if (kind === 'frame') return this.withRuntime(id, runtime => runtime.frame(input));
    if (kind === 'dialog') return this.withRuntime(id, runtime => runtime.dialog(input));
    if (kind === 'upload') {
      const resource = this.requireStored(id);
      const requestedFiles = Array.isArray(input?.files) ? input.files : [];
      if (requestedFiles.length === 0 || requestedFiles.length > MAX_UPLOAD_FILES) {
        throw browserError(`Browser upload requires between 1 and ${MAX_UPLOAD_FILES} files`);
      }
      const files = requestedFiles.map(file => resolveWorkspaceInputFile(resource, file));
      return this.withRuntime(id, runtime => runtime.upload({ ...input, files }));
    }
    if (kind === 'download') {
      const resource = this.requireStored(id);
      const target = resolveWorkspaceOutputFile(resource, input?.path);
      return this.withRuntime(id, async runtime => {
        const resourceDir = path.dirname(storageLayout.browserProfileDir(
          this.configDir,
          resource.sessionId || id,
        ));
        const downloadDir = path.join(resourceDir, 'downloads');
        fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
        const temporaryPath = path.join(
          downloadDir,
          `${crypto.randomUUID()}-${path.basename(target)}`,
        );
        try {
          await runtime.download({ ...input, outputPath: temporaryPath });
          const stat = fs.statSync(temporaryPath);
          if (!stat.isFile()) throw browserError('Browser download did not produce a regular file');
          fs.copyFileSync(temporaryPath, target, fs.constants.COPYFILE_EXCL);
          return {
            ok: true,
            path: path.relative(resource.workspace, target) || path.basename(target),
            size: stat.size,
          };
        } finally {
          fs.rmSync(temporaryPath, { force: true });
        }
      });
    }
    if (kind === 'scroll') return this.withRuntime(id, async runtime => {
      await runtime.wheel(input);
      return { ok: true };
    });
    throw browserError(`Unsupported Browser action: ${kind || '(missing)'}`);
  }

  attachViewer(id, ws) {
    this.requireEnabled();
    const resource = this.requireStored(id);
    const binding = this.runtimes.get(id);
    ws.send(JSON.stringify({
      type: 'browser-state',
      resource: publicResource(resource, this.store.revision),
    }));
    if (!binding || resource.status !== 'running') return () => {};
    binding.viewers.add(ws);
    if (binding.latestFrame) ws.send(JSON.stringify(binding.latestFrame));
    void this.withRuntime(id, () => {}).catch(error => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'browser-error', message: error?.message || 'Browser tab failed' }));
      }
    });
    const onMessage = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const operation = message.type === 'resize'
        ? this.scheduleViewerResize(binding, ws, message)
        : this.handleViewerMessage(binding, ws, message);
      void Promise.resolve(operation).catch(error => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'browser-error', message: error?.message || 'Browser input failed' }));
        }
      });
    };
    ws.on('message', onMessage);
    const detach = () => {
      binding.viewers.delete(ws);
      binding.viewerGeometries.delete(ws);
      if (binding.viewerViewportOwner === ws) {
        binding.viewerViewportOwner = binding.viewers.values().next().value || null;
        if (binding.viewerViewportOwner) {
          const geometry = binding.viewerGeometries.get(binding.viewerViewportOwner);
          if (geometry) {
            void this.scheduleViewerResize(binding, binding.viewerViewportOwner, geometry).catch(() => {});
          }
        } else {
          this.clearViewerResize(binding);
        }
      }
      ws.off('message', onMessage);
    };
    ws.once('close', detach);
    return detach;
  }

  handleViewerMessage(binding, viewer, message) {
    const resource = this.requireStored(binding.id);
    if (
      resource.status !== 'running'
      || message.generation !== binding.generation
      || this.runtimes.get(binding.id) !== binding
    ) {
      return Promise.reject(browserError(
        'Browser Viewer input is no longer admitted',
        409,
        'BROWSER_NOT_RUNNING',
      ));
    }
    const { session } = binding;
    const next = (session.actionChain || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.activateBinding(binding);
        return this.performViewerMessage(binding, viewer, message);
      });
    session.actionChain = next;
    return next;
  }

  scheduleViewerResize(binding, viewer, message) {
    const resource = this.requireStored(binding.id);
    if (
      resource.status !== 'running'
      || message.generation !== binding.generation
      || this.runtimes.get(binding.id) !== binding
    ) {
      return Promise.reject(browserError(
        'Browser Viewer resize is no longer admitted',
        409,
        'BROWSER_NOT_RUNNING',
      ));
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
    binding.viewerGeometries.set(viewer, geometry);
    if (
      message.claim === true
      || !binding.viewerViewportOwner
      || !binding.viewers.has(binding.viewerViewportOwner)
    ) {
      binding.viewerViewportOwner = viewer;
    }
    if (binding.viewerViewportOwner !== viewer) return Promise.resolve();
    binding.pendingViewerResize = { viewer, geometry };
    if (binding.viewerResizeTimer) this.cancelTimeout(binding.viewerResizeTimer);
    binding.viewerResizeTimer = this.scheduleTimeout(() => {
      binding.viewerResizeTimer = null;
      const pending = binding.pendingViewerResize;
      binding.pendingViewerResize = null;
      if (!pending || binding.viewerViewportOwner !== pending.viewer) return;
      void this.handleViewerMessage(binding, pending.viewer, pending.geometry).catch(error => {
        if (pending.viewer.readyState === 1) {
          pending.viewer.send(JSON.stringify({
            type: 'browser-error',
            message: error?.message || 'Browser resize failed',
          }));
        }
      });
    }, VIEWER_RESIZE_SETTLE_MS);
    binding.viewerResizeTimer.unref?.();
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

  async performViewerMessage(binding, viewer, message) {
    if (message.generation !== binding.generation || this.runtimes.get(binding.id) !== binding) {
      throw browserError('Browser Viewer generation is stale', 409, 'BROWSER_STALE_GENERATION');
    }
    const runtime = binding.session.runtime;
    if (message.type === 'resize') {
      if (binding.viewerViewportOwner !== viewer) return;
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
    const sessions = [...this.sessions.values()];
    const results = await Promise.allSettled(sessions.map(session => session.runtime.close()));
    const failures = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason?.message || String(result.reason));
    if (failures.length > 0) {
      throw new Error(`Browser runtime cleanup failed: ${failures.join('; ')}`);
    }
    for (const binding of this.runtimes.values()) this.releaseViewerState(binding);
    this.runtimes.clear();
    this.sessions.clear();
  }

  async stopAll() {
    const ids = [...this.runtimes.keys()];
    const results = [];
    for (const id of ids) {
      results.push(await Promise.resolve(this.stop(id))
        .then(value => ({ status: 'fulfilled', value }))
        .catch(reason => ({ status: 'rejected', reason })));
    }
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

  createBinding(session, resource) {
    return {
      id: resource.id,
      generation: resource.generation,
      session,
      tabId: resource.tabId || '',
      viewers: new Set(),
      viewerGeometries: new Map(),
      viewerViewportOwner: null,
      viewerResizeTimer: null,
      pendingViewerResize: null,
      latestFrame: null,
    };
  }

  async activateBinding(binding) {
    const { session } = binding;
    if (!binding.tabId) throw browserError('Browser tab is unavailable', 409, 'BROWSER_TAB_UNAVAILABLE');
    if (
      session.runtime.activeTabId !== binding.tabId
      || session.runtime.streamTabId !== binding.tabId
    ) {
      await session.runtime.switchTab(binding.tabId);
    }
    session.activeResourceId = binding.id;
  }

  withRuntime(id, operation) {
    const binding = this.runtimes.get(id);
    const resource = this.requireStored(id);
    if (!binding || resource.status !== 'running') {
      throw browserError('Browser is not running', 409, 'BROWSER_NOT_RUNNING');
    }
    const { session } = binding;
    const next = (session.actionChain || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.activateBinding(binding);
        return operation(session.runtime, binding);
      });
    session.actionChain = next;
    return next;
  }

  bindSession(session) {
    const { runtime } = session;
    runtime.on('process-identity', processIdentity => {
      const owner = this.store.get(session.processOwnerResourceId);
      if (
        this.sessions.get(session.id) !== session
        || !owner
        || owner.sessionId && owner.sessionId !== session.id
      ) return;
      const next = this.store.update(owner.id, { processIdentity });
      this.emitResource(next);
    });
    runtime.on('frame', frame => {
      const binding = [...session.bindings.values()]
        .find(candidate => candidate.tabId === runtime.streamTabId)
        || session.bindings.get(session.activeResourceId);
      if (!binding) return;
      const resourceFrame = {
        ...frame,
        generation: binding.generation,
      };
      binding.latestFrame = resourceFrame;
      for (const viewer of binding.viewers) {
        if (viewer.readyState === 1 && (Number(viewer.bufferedAmount) || 0) <= MAX_VIEWER_BUFFER_BYTES) {
          viewer.send(JSON.stringify(resourceFrame));
        }
      }
    });
    runtime.on('metadata', metadata => {
      const binding = [...session.bindings.values()]
        .find(candidate => candidate.tabId === runtime.activeTabId)
        || session.bindings.get(session.activeResourceId);
      if (binding) this.updateMetadata(binding, metadata);
    });
    runtime.on('tabs', event => {
      if (session.initializing || session.closing) return;
      const next = (session.actionChain || Promise.resolve())
        .catch(() => {})
        .then(() => this.reconcileTabs(session, event));
      session.actionChain = next;
    });
    runtime.on('error', error => {
      for (const binding of session.bindings.values()) {
        for (const viewer of binding.viewers) {
          if (viewer.readyState === 1) {
            viewer.send(JSON.stringify({ type: 'browser-error', message: error?.message || 'Browser runtime failed' }));
          }
        }
      }
    });
    runtime.once('exit', message => {
      void this.handleRuntimeExit(session, message);
    });
  }

  async reconcileTabs(session, event) {
    if (this.sessions.get(session.id) !== session || session.closing) return;
    const tabs = Array.isArray(event?.tabs) ? event.tabs.filter(tab => tab.type === 'page') : [];
    const byTabId = new Map([...session.bindings.values()].map(binding => [binding.tabId, binding]));
    const opener = session.bindings.get(session.activeResourceId) || null;
    const opened = [];

    for (const tab of tabs) {
      let binding = byTabId.get(tab.tabId);
      if (!binding && (!session.runtime.externalCdpUrl || event.popupAdmitted)) {
        session.runtime.ownedTabIds.add(tab.tabId);
        const created = this.store.createRunningTab({
          projectRootId: opener?.session.projectRootId || session.projectRootId,
          workspace: this.store.get(opener?.id)?.workspace
            || this.store.list().find(resource => resource.sessionId === session.id)?.workspace,
          name: tabResourceName(tab),
          url: tab.url,
          title: tab.title,
          browserKind: session.browserKind,
          sessionId: session.id,
          sessionGeneration: session.generation,
          tabId: tab.tabId,
        });
        binding = this.createBinding(session, created);
        session.bindings.set(created.id, binding);
        this.runtimes.set(created.id, binding);
        byTabId.set(tab.tabId, binding);
        this.emitResource(created);
        opened.push(publicResource(created, this.store.revision));
      }
      if (!binding) continue;
      const current = this.store.get(binding.id);
      if (!current || current.status !== 'running') continue;
      if (current.url !== tab.url || current.title !== tab.title) {
        const updated = this.store.update(binding.id, {
          url: tab.url || current.url,
          title: tab.title || '',
        });
        this.emitResource(updated);
        this.broadcastRuntimeState(binding);
      }
    }

    const liveTabIds = new Set(tabs.map(tab => tab.tabId));
    for (const binding of [...session.bindings.values()]) {
      if (liveTabIds.has(binding.tabId)) continue;
      const current = this.store.get(binding.id);
      if (!current || current.status === 'stopping') continue;
      session.bindings.delete(binding.id);
      this.runtimes.delete(binding.id);
      const stopped = this.store.update(binding.id, {
        status: 'stopped',
        tabId: '',
        processIdentity: null,
        error: '',
      });
      this.emitResource(stopped);
      this.broadcastRuntimeState(binding);
      this.releaseViewerState(binding);
    }

    const activeTab = tabs.find(tab => tab.active);
    const activeBinding = activeTab ? byTabId.get(activeTab.tabId) : null;
    if (activeBinding) {
      session.activeResourceId = activeBinding.id;
      if (session.runtime.streamTabId !== activeBinding.tabId) {
        await session.runtime.switchTab(activeBinding.tabId);
      }
    }
    if (opened.length > 0 && opener) {
      const message = JSON.stringify({
        type: 'browser-tab-opened',
        resource: opened.at(-1),
      });
      for (const viewer of opener.viewers) {
        if (viewer.readyState === 1) viewer.send(message);
      }
    }
  }

  updateMetadata(binding, metadata) {
    const current = this.store.get(binding.id);
    if (!current || current.generation !== binding.generation || !metadata) return;
    const next = this.store.update(binding.id, {
      url: String(metadata.url || current.url),
      title: String(metadata.title || ''),
    });
    this.emitResource(next);
    this.broadcastRuntimeState(binding);
  }

  emitResource(resource) {
    this.emit('resource', publicResource(resource, this.store.revision));
  }

  broadcastRuntimeState(binding) {
    const resource = this.store.get(binding.id);
    if (!resource) return;
    const message = JSON.stringify({
      type: 'browser-state',
      resource: publicResource(resource, this.store.revision),
    });
    for (const viewer of binding.viewers || []) {
      if (viewer.readyState === 1) viewer.send(message);
    }
  }

  async handleRuntimeExit(session, message) {
    if (this.sessions.get(session.id) !== session) return;
    const failedBindings = [...session.bindings.values()];
    for (const binding of failedBindings) {
      const current = this.store.get(binding.id);
      if (!current) continue;
      const failed = this.store.update(binding.id, {
        status: 'failed',
        error: current.browserKind === 'external-cdp'
          ? 'External Browser connection exited'
          : message || 'Browser connection exited',
      });
      this.emitResource(failed);
      this.broadcastRuntimeState(binding);
    }
    try {
      await session.runtime.close();
      this.sessions.delete(session.id);
      for (const binding of failedBindings) {
        this.runtimes.delete(binding.id);
        this.releaseViewerState(binding);
        const cleaned = this.store.update(binding.id, { processIdentity: null });
        if (cleaned) this.emitResource(cleaned);
      }
    } catch (error) {
      for (const binding of failedBindings) {
        const current = this.store.get(binding.id);
        if (!current) continue;
        const cleanupFailed = this.store.update(binding.id, {
          status: 'failed',
          error: current.browserKind === 'external-cdp'
            ? `${current.error}; target cleanup failed`
            : `${current.error}; cleanup failed: ${error?.message || error}`,
        });
        this.emitResource(cleanupFailed);
        this.broadcastRuntimeState(binding);
      }
    }
  }
}

module.exports = {
  BrowserResourceManager,
  browserError,
  externalBrowserFailure,
  normalizeUrl,
};
