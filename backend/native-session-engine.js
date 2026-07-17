const SessionEngine = require('./session-engine');
const NativePtyHostClient = require('./native-pty-host-client');
const { normalizeShellSessionOptions } = require('./local-session-engine');
const { cleanupShellBusyIntegration } = require('./shell-busy-integration');
const { compareNativePtyRuntimeEpochs } = require('./native-pty-controller-generation');

function isRecoverableConnectError(error) {
  const code = error && error.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}

function nativeSessionId(entry, fallback = '') {
  if (!entry || typeof entry !== 'object') return fallback || '';
  return entry.sessionId || entry.agentId || entry.metadata?.agentId || fallback || '';
}

function recoveredRuntimeEpoch(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.runtimeEpoch === 'string' && entry.runtimeEpoch) return entry.runtimeEpoch;
  return typeof entry.state?.runtimeEpoch === 'string' ? entry.state.runtimeEpoch : '';
}

function shouldAdvanceRuntimeEpoch(currentEpoch, nextEpoch) {
  if (!nextEpoch) return false;
  if (!currentEpoch || currentEpoch === nextEpoch) return true;
  return compareNativePtyRuntimeEpochs(nextEpoch, currentEpoch) === 1;
}

class NativeSessionEngine extends SessionEngine {
  constructor(options = {}) {
    super();
    this.client = options.client || new NativePtyHostClient({
      configDir: options.configDir,
      socketPath: options.socketPath,
      preserveHostOnDisconnect: options.preserveHostOnDispose === true,
    });
    this.preserveHostOnDispose = options.preserveHostOnDispose === true;
    this.activeSessionIds = new Set();
    this.activeSessionEpochs = new Map();
    this.hostDisconnectGeneration = 0;
    this.reconciledHostDisconnectGeneration = 0;
    this.hostDisconnectReconcilePromise = null;
    this.bindClientEvents();
  }

  bindClientEvents() {
    [
      'session-started',
      'session-output',
      'session-transition',
      'session-sync',
      'session-preview',
      'session-title',
      'session-activity',
      'session-busy-state',
      'session-exited',
      'session-error',
    ].forEach(eventName => {
      this.client.on(eventName, payload => {
        this.observeSessionLifecycleEvent(eventName, payload || {});
        this.emit(eventName, payload);
      });
    });
    this.client.on('host-disconnect', () => {
      this.hostDisconnectGeneration += 1;
      this.reconcileHostDisconnect().catch(error => {
        const message = error && error.message ? error.message : 'Native pty host disconnected';
        this.failActiveSessions(message);
      });
    });
    this.client.on('host-exit', ({ code, signal } = {}) => {
      const suffix = [
        code == null ? '' : `code ${code}`,
        signal ? `signal ${signal}` : '',
      ].filter(Boolean).join(', ');
      this.failActiveSessions(`Native pty host exited${suffix ? ` (${suffix})` : ''}`);
    });
  }

  observeSessionLifecycleEvent(eventName, payload) {
    const sessionId = nativeSessionId(payload);
    if (!sessionId) return;
    if (eventName === 'session-started') {
      const runtimeEpoch = typeof payload.runtimeEpoch === 'string' ? payload.runtimeEpoch : '';
      const currentEpoch = this.activeSessionEpochs.get(sessionId) || '';
      if (shouldAdvanceRuntimeEpoch(currentEpoch, runtimeEpoch)) {
        this.activeSessionIds.add(sessionId);
        this.activeSessionEpochs.set(sessionId, runtimeEpoch);
      } else if (!currentEpoch && !runtimeEpoch) {
        this.activeSessionIds.add(sessionId);
      }
    } else if (eventName === 'session-exited') {
      const currentEpoch = this.activeSessionEpochs.get(sessionId) || '';
      const exitedEpoch = typeof payload.runtimeEpoch === 'string' ? payload.runtimeEpoch : '';
      if (currentEpoch ? exitedEpoch !== currentEpoch : Boolean(exitedEpoch)) return;
      this.activeSessionIds.delete(sessionId);
      this.activeSessionEpochs.delete(sessionId);
    }
  }

  async reconcileHostDisconnect() {
    if (this.hostDisconnectReconcilePromise) return this.hostDisconnectReconcilePromise;
    this.hostDisconnectReconcilePromise = (async () => {
      while (this.reconciledHostDisconnectGeneration < this.hostDisconnectGeneration) {
        const generation = this.hostDisconnectGeneration;
        const expectedSessions = [...this.activeSessionIds].map(sessionId => ({
          sessionId,
          runtimeEpoch: this.activeSessionEpochs.get(sessionId) || '',
        }));
        if (expectedSessions.length > 0) {
          const recovered = await this.recoverSessions({ startHost: true });
          const recoveredIds = new Set((recovered || [])
            .map(entry => nativeSessionId(entry))
            .filter(Boolean));

          for (const expected of expectedSessions) {
            if (recoveredIds.has(expected.sessionId)) continue;
            this.activeSessionIds.delete(expected.sessionId);
            this.activeSessionEpochs.delete(expected.sessionId);
            this.emit('session-error', {
              sessionId: expected.sessionId,
              runtimeEpoch: expected.runtimeEpoch,
              error: 'Native pty host disconnected; terminal session is no longer recoverable',
              fatal: true,
            });
          }
        }
        this.reconciledHostDisconnectGeneration = generation;
      }
    })();
    try {
      await this.hostDisconnectReconcilePromise;
    } finally {
      this.hostDisconnectReconcilePromise = null;
    }
  }

  failActiveSessions(message) {
    for (const sessionId of [...this.activeSessionIds]) {
      this.activeSessionIds.delete(sessionId);
      const runtimeEpoch = this.activeSessionEpochs.get(sessionId) || '';
      this.activeSessionEpochs.delete(sessionId);
      this.emit('session-error', {
        sessionId,
        runtimeEpoch,
        error: message,
        fatal: true,
      });
    }
  }

  getSessionSource() {
    return 'buffer';
  }

  async createSession(options) {
    // Prepare the startup plan in the server process. A native PTY host may
    // deliberately survive a server restart, so it must not retain authority
    // over how newly created shells source rc files or choose a prompt.
    const preparedOptions = normalizeShellSessionOptions(options);
    preparedOptions.shellIntegrationPrepared = true;
    let result;
    try {
      result = await this.client.request('createSession', { options: preparedOptions });
    } catch (error) {
      cleanupShellBusyIntegration(preparedOptions.shellBusyIntegration);
      throw error;
    }
    const sessionId = nativeSessionId(result, preparedOptions.agentId);
    if (sessionId) this.activeSessionIds.add(sessionId);
    return result;
  }

  async sendInput(sessionId, input, options = {}) {
    return this.client.request('sendInput', {
      sessionId,
      input,
      expectedRuntimeEpoch: options.expectedRuntimeEpoch || '',
    }, {
      retryOnDisconnect: false,
    });
  }

  async interruptSession(sessionId, input = '\x03', options = {}) {
    return this.sendInput(sessionId, input, options);
  }

  async resizeSession(sessionId, cols, rows) {
    return this.client.request('resizeSession', { sessionId, cols, rows });
  }

  async clearBuffer(sessionId, options = {}) {
    return this.client.request('clearBuffer', {
      sessionId,
      expectedRuntimeEpoch: options.expectedRuntimeEpoch || '',
    }, {
      retryOnDisconnect: false,
    });
  }

  async killSession(sessionId) {
    const result = await this.client.request('killSession', { sessionId });
    this.activeSessionIds.delete(sessionId);
    this.activeSessionEpochs.delete(sessionId);
    return result;
  }

  async getSessionState(sessionId) {
    return this.client.request('getSessionState', { sessionId });
  }

  async getSessionAttachCheckpoint(sessionId) {
    return this.client.request('getSessionAttachCheckpoint', { sessionId });
  }

  async getSessionPreview(sessionId) {
    return this.client.request('getSessionPreview', { sessionId });
  }

  async recoverSessions(options = {}) {
    const startHost = options.startHost === true;
    if (
      !startHost &&
      this.client &&
      typeof this.client.canConnectWithoutStartingHost === 'function' &&
      !this.client.canConnectWithoutStartingHost()
    ) {
      return [];
    }
    try {
      const recovered = await this.client.request('recoverSessions', {}, { startHost });
      for (const entry of recovered || []) {
        const sessionId = nativeSessionId(entry);
        if (!sessionId) continue;
        this.activeSessionIds.add(sessionId);
        const runtimeEpoch = recoveredRuntimeEpoch(entry);
        const currentEpoch = this.activeSessionEpochs.get(sessionId) || '';
        if (shouldAdvanceRuntimeEpoch(currentEpoch, runtimeEpoch)) {
          this.activeSessionEpochs.set(sessionId, runtimeEpoch);
        }
      }
      return recovered;
    } catch (error) {
      if (isRecoverableConnectError(error)) return [];
      throw error;
    }
  }

  async updateSessionMetadata(sessionId, patch) {
    return this.client.request('updateSessionMetadata', { sessionId, patch });
  }

  consumeRuntimeRotation() {
    return typeof this.client.consumeRuntimeRotation === 'function'
      ? this.client.consumeRuntimeRotation()
      : null;
  }

  dispose(options = {}) {
    this.client.disconnect({
      preserveHost: options.preserveHost === true || this.preserveHostOnDispose,
    });
    this.activeSessionIds.clear();
    this.activeSessionEpochs.clear();
  }
}

module.exports = NativeSessionEngine;
