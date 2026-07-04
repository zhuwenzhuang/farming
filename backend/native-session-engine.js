const SessionEngine = require('./session-engine');
const NativePtyHostClient = require('./native-pty-host-client');

function isRecoverableConnectError(error) {
  const code = error && error.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}

function nativeSessionId(entry, fallback = '') {
  if (!entry || typeof entry !== 'object') return fallback || '';
  return entry.sessionId || entry.agentId || entry.metadata?.agentId || fallback || '';
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
    this.reconcilingHostDisconnect = false;
    this.bindClientEvents();
  }

  bindClientEvents() {
    [
      'session-started',
      'session-output',
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
      this.activeSessionIds.add(sessionId);
    } else if (eventName === 'session-exited') {
      this.activeSessionIds.delete(sessionId);
    }
  }

  async reconcileHostDisconnect() {
    if (this.reconcilingHostDisconnect) return;
    const expectedSessionIds = [...this.activeSessionIds];
    if (expectedSessionIds.length === 0) return;

    this.reconcilingHostDisconnect = true;
    try {
      const recovered = await this.recoverSessions({ startHost: true });
      const recoveredIds = new Set((recovered || [])
        .map(entry => nativeSessionId(entry))
        .filter(Boolean));

      for (const sessionId of expectedSessionIds) {
        if (recoveredIds.has(sessionId)) continue;
        this.activeSessionIds.delete(sessionId);
        this.emit('session-error', {
          sessionId,
          error: 'Native pty host disconnected; terminal session is no longer recoverable',
          fatal: true,
        });
      }
    } finally {
      this.reconcilingHostDisconnect = false;
    }
  }

  failActiveSessions(message) {
    for (const sessionId of [...this.activeSessionIds]) {
      this.activeSessionIds.delete(sessionId);
      this.emit('session-error', {
        sessionId,
        error: message,
        fatal: true,
      });
    }
  }

  getSessionSource() {
    return 'buffer';
  }

  async createSession(options) {
    const result = await this.client.request('createSession', { options });
    const sessionId = nativeSessionId(result, options.agentId);
    if (sessionId) this.activeSessionIds.add(sessionId);
    return result;
  }

  async sendInput(sessionId, input) {
    return this.client.request('sendInput', { sessionId, input });
  }

  async interruptSession(sessionId, input = '\x03') {
    return this.sendInput(sessionId, input);
  }

  async resizeSession(sessionId, cols, rows) {
    return this.client.request('resizeSession', { sessionId, cols, rows });
  }

  async killSession(sessionId) {
    const result = await this.client.request('killSession', { sessionId });
    this.activeSessionIds.delete(sessionId);
    return result;
  }

  async getSessionState(sessionId) {
    return this.client.request('getSessionState', { sessionId });
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
        if (sessionId) this.activeSessionIds.add(sessionId);
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

  dispose(options = {}) {
    this.client.disconnect({
      preserveHost: options.preserveHost === true || this.preserveHostOnDispose,
    });
    this.activeSessionIds.clear();
  }
}

module.exports = NativeSessionEngine;
