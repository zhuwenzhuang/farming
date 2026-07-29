import { SessionEngine } from './session-engine.cjs';
import { cleanupShellBusyIntegration } from './shell-busy-integration.cjs';

interface NativePtyClient {
  canConnectWithoutStartingHost?(): boolean;
  consumeRuntimeRotation?(): unknown;
  disconnect(options: { preserveHost: boolean }): void;
  on(eventName: string, listener: (payload?: unknown) => void): unknown;
  request<T = unknown>(
    command: string,
    payload: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<T>;
}

const NativePtyHostClient = require('./native-pty-host-client') as new (
  options: Record<string, unknown>,
) => NativePtyClient;
const { normalizeShellSessionOptions } = require('./local-session-engine') as {
  normalizeShellSessionOptions(options: Record<string, unknown>): Record<string, unknown>;
};
const { compareNativePtyRuntimeEpochs } = require('./native-pty-controller-generation.cjs');

interface NativeSessionEngineOptions {
  client?: NativePtyClient;
  configDir?: string;
  preserveHostOnDispose?: boolean;
  socketPath?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRecoverableConnectError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}

function nativeSessionId(entry: unknown, fallback = ''): string {
  if (!isObject(entry)) return fallback || '';
  const metadata = isObject(entry.metadata) ? entry.metadata : {};
  return String(entry.sessionId || entry.agentId || metadata.agentId || fallback || '');
}

function recoveredRuntimeEpoch(entry: unknown): string {
  if (!isObject(entry)) return '';
  if (typeof entry.runtimeEpoch === 'string' && entry.runtimeEpoch) return entry.runtimeEpoch;
  const state = isObject(entry.state) ? entry.state : {};
  return typeof state.runtimeEpoch === 'string' ? state.runtimeEpoch : '';
}

function shouldAdvanceRuntimeEpoch(currentEpoch: string, nextEpoch: string): boolean {
  if (!nextEpoch) return false;
  if (!currentEpoch || currentEpoch === nextEpoch) return true;
  return compareNativePtyRuntimeEpochs(nextEpoch, currentEpoch) === 1;
}

class NativeSessionEngine extends SessionEngine {
  client: NativePtyClient;
  preserveHostOnDispose: boolean;
  activeSessionIds: Set<string>;
  activeSessionEpochs: Map<string, string>;
  hostDisconnectGeneration: number;
  reconciledHostDisconnectGeneration: number;
  hostDisconnectReconcilePromise: Promise<void> | null;

  constructor(options: NativeSessionEngineOptions = {}) {
    super();
    this.client = options.client || new NativePtyHostClient({
      configDir: options.configDir,
      socketPath: options.socketPath,
      preserveHostOnDisconnect: options.preserveHostOnDispose === true,
    });
    this.preserveHostOnDispose = options.preserveHostOnDispose === true;
    this.activeSessionIds = new Set<string>();
    this.activeSessionEpochs = new Map<string, string>();
    this.hostDisconnectGeneration = 0;
    this.reconciledHostDisconnectGeneration = 0;
    this.hostDisconnectReconcilePromise = null;
    this.bindClientEvents();
  }

  bindClientEvents(): void {
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
      this.client.on(eventName, (payload: unknown) => {
        this.observeSessionLifecycleEvent(eventName, payload);
        this.emit(eventName, payload);
      });
    });
    this.client.on('host-disconnect', () => {
      this.hostDisconnectGeneration += 1;
      this.reconcileHostDisconnect().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Native pty host disconnected';
        this.failActiveSessions(message);
      });
    });
    this.client.on('host-exit', (payload: unknown) => {
      const exit = isObject(payload) ? payload : {};
      const code = typeof exit.code === 'number' ? exit.code : null;
      const signal = typeof exit.signal === 'string' ? exit.signal : '';
      const suffix = [
        code == null ? '' : `code ${code}`,
        signal ? `signal ${signal}` : '',
      ].filter(Boolean).join(', ');
      this.failActiveSessions(`Native pty host exited${suffix ? ` (${suffix})` : ''}`);
    });
  }

  observeSessionLifecycleEvent(eventName: string, payload: unknown): void {
    const sessionId = nativeSessionId(payload);
    if (!sessionId) return;
    const event = isObject(payload) ? payload : {};
    if (eventName === 'session-started') {
      const runtimeEpoch = typeof event.runtimeEpoch === 'string' ? event.runtimeEpoch : '';
      const currentEpoch = this.activeSessionEpochs.get(sessionId) || '';
      if (shouldAdvanceRuntimeEpoch(currentEpoch, runtimeEpoch)) {
        this.activeSessionIds.add(sessionId);
        this.activeSessionEpochs.set(sessionId, runtimeEpoch);
      } else if (!currentEpoch && !runtimeEpoch) {
        this.activeSessionIds.add(sessionId);
      }
    } else if (eventName === 'session-exited') {
      const currentEpoch = this.activeSessionEpochs.get(sessionId) || '';
      const exitedEpoch = typeof event.runtimeEpoch === 'string' ? event.runtimeEpoch : '';
      if (currentEpoch ? exitedEpoch !== currentEpoch : Boolean(exitedEpoch)) return;
      this.activeSessionIds.delete(sessionId);
      this.activeSessionEpochs.delete(sessionId);
    }
  }

  async reconcileHostDisconnect(): Promise<void> {
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
          const recoveredIds = new Set<string>((recovered || [])
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

  failActiveSessions(message: string): void {
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

  getSessionSource(): 'buffer' {
    return 'buffer';
  }

  override async createSession(options: unknown): Promise<unknown> {
    // Prepare the startup plan in the server process. A native PTY host may
    // deliberately survive a server restart, so it must not retain authority
    // over how newly created shells source rc files or choose a prompt.
    const preparedOptions = normalizeShellSessionOptions(isObject(options) ? options : {});
    preparedOptions.shellIntegrationPrepared = true;
    let result;
    try {
      result = await this.client.request('createSession', { options: preparedOptions });
    } catch (error) {
      cleanupShellBusyIntegration(preparedOptions.shellBusyIntegration);
      throw error;
    }
    const sessionId = nativeSessionId(result, String(preparedOptions.agentId || ''));
    if (sessionId) this.activeSessionIds.add(sessionId);
    return result;
  }

  override async sendInput(
    sessionId: string,
    input: unknown,
    options: { expectedRuntimeEpoch?: string } = {},
  ): Promise<unknown> {
    return this.client.request('sendInput', {
      sessionId,
      input,
      expectedRuntimeEpoch: options.expectedRuntimeEpoch || '',
    }, {
      retryOnDisconnect: false,
    });
  }

  override async interruptSession(
    sessionId: string,
    input: unknown = '\x03',
    options: { expectedRuntimeEpoch?: string } = {},
  ): Promise<unknown> {
    return this.sendInput(sessionId, input, options);
  }

  override async resizeSession(sessionId: string, cols: number, rows: number): Promise<unknown> {
    return this.client.request('resizeSession', { sessionId, cols, rows });
  }

  override async clearBuffer(
    sessionId: string,
    options: { expectedRuntimeEpoch?: string } = {},
  ): Promise<unknown> {
    return this.client.request('clearBuffer', {
      sessionId,
      expectedRuntimeEpoch: options.expectedRuntimeEpoch || '',
    }, {
      retryOnDisconnect: false,
    });
  }

  override async killSession(sessionId: string): Promise<unknown> {
    const result = await this.client.request('killSession', { sessionId });
    this.activeSessionIds.delete(sessionId);
    this.activeSessionEpochs.delete(sessionId);
    return result;
  }

  override async getSessionState(sessionId: string): Promise<unknown> {
    return this.client.request('getSessionState', { sessionId });
  }

  async getSessionAttachCheckpoint(sessionId: string): Promise<unknown> {
    return this.client.request('getSessionAttachCheckpoint', { sessionId });
  }

  override async getSessionPreview(sessionId: string): Promise<unknown> {
    return this.client.request('getSessionPreview', { sessionId });
  }

  override async recoverSessions(
    options: { startHost?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
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
      const recovered = await this.client.request<unknown[]>('recoverSessions', {}, { startHost });
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
      return recovered.filter(isObject);
    } catch (error) {
      if (isRecoverableConnectError(error)) return [];
      throw error;
    }
  }

  async updateSessionMetadata(sessionId: string, patch: unknown): Promise<unknown> {
    return this.client.request('updateSessionMetadata', { sessionId, patch });
  }

  override consumeRuntimeRotation(): unknown {
    return typeof this.client.consumeRuntimeRotation === 'function'
      ? this.client.consumeRuntimeRotation()
      : null;
  }

  override dispose(options: { preserveHost?: boolean } = {}): void {
    this.client.disconnect({
      preserveHost: options.preserveHost === true || this.preserveHostOnDispose,
    });
    this.activeSessionIds.clear();
    this.activeSessionEpochs.clear();
  }
}

export { NativeSessionEngine };
