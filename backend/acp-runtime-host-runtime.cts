'use strict';

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { AcpRuntimeHostClient } from './acp-runtime-host-client.cjs';
import { promptContentHash } from './acp-runtime-host-service.cjs';
import type {
  AcpBindingCheckpoint,
  AcpBindingCheckpointView,
  AcpBindingContract,
  AcpConfigChange,
  AcpConfigValue,
  AcpForkOptions,
  AcpForkResult,
  AcpPrepareOptions,
  AcpPrepareResult,
  AcpProcessIdentity,
  AcpPromptBlock,
  AcpRuntimeContract,
  AcpSessionListOptions,
  AcpSessionListResult,
  AcpSessionRequestOptions,
  AcpSubmitOptions,
  AcpSubmitResult,
  AcpTranscriptEntry,
  AcpTranscriptSession,
  ProviderSessionIdentityRequest,
  ProviderSessionIdentityResult,
} from './agent-manager-provider-types.js';

type UnknownRecord = Record<string, unknown>;
type BindingCallbackHandlers = {
  onProcessStarted?: (identity: AcpProcessIdentity) => Promise<void> | void;
  onProcessStopped?: () => Promise<void> | void;
  onForkSessionCreated?: (sessionId: string) => Promise<void> | void;
  refreshMcpServersForRuntime?: AcpPrepareOptions['refreshMcpServersForRuntime'];
};

type AcpRuntimeHostRuntimeOptions = ConstructorParameters<typeof AcpRuntimeHostClient>[0];

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function operationKey(agentId: string, operationId: string): string {
  return `${agentId}\0${operationId}`;
}

class AcpRuntimeHostRuntime extends EventEmitter implements AcpRuntimeContract {
  readonly turnCompletionEvents = true;
  client: AcpRuntimeHostClient;
  readonly clientOptions: ConstructorParameters<typeof AcpRuntimeHostClient>[0];
  readonly bindings: Map<string, AcpBindingContract>;
  readonly sessions: Map<string, UnknownRecord>;
  readonly submissionCallbacks: Map<string, () => Promise<void> | void>;
  readonly forkCheckpoints: Map<string, AcpBindingCheckpoint>;
  readonly bindingCallbackTokens: Map<string, string>;
  readonly bindingCallbackHandlers: Map<string, BindingCallbackHandlers>;
  initializePromise: Promise<void> | null;
  disposed: boolean;

  constructor(options: AcpRuntimeHostRuntimeOptions) {
    super();
    this.clientOptions = options;
    this.client = new AcpRuntimeHostClient(options);
    this.bindings = new Map();
    this.sessions = new Map();
    this.submissionCallbacks = new Map();
    this.forkCheckpoints = new Map();
    this.bindingCallbackTokens = new Map();
    this.bindingCallbackHandlers = new Map();
    this.initializePromise = null;
    this.disposed = false;
    this.attachClient(this.client);
  }

  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('ACP runtime Host facade is disposed'));
    if (this.client.socket && !this.client.socket.destroyed) return Promise.resolve();
    if (this.initializePromise) return this.initializePromise;
    const previousHostEpoch = this.client.hostEpoch;
    const previousSessions = new Map<string, UnknownRecord>(
      [...this.sessions.entries()].map(([agentId, session]) => [agentId, clone(session)]),
    );
    if (this.client.controllerGeneration > 0 || this.client.poisonedError) {
      this.client = new AcpRuntimeHostClient(this.clientOptions);
      this.attachClient(this.client);
    }
    this.initializePromise = this.client.ensureConnected().then(() => {
      this.syncRecoveredBindings();
      if (previousSessions.size > 0) {
        this.reconcileRecoveredBindings(previousSessions, previousHostEpoch);
      }
    }).finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  attachClient(client: AcpRuntimeHostClient): void {
    client.on('runtime-event', event => {
      if (this.client === client) this.applyRuntimeEvent(event);
    });
    client.on('config-overrides', event => {
      if (this.client === client) this.emit('config-overrides', event);
    });
    client.on('disconnect', error => {
      if (this.client !== client) return;
      this.initializePromise = null;
      this.handleDisconnect(error);
    });
  }

  syncRecoveredBindings(): void {
    this.bindings.clear();
    this.sessions.clear();
    for (const binding of this.client.bindings.values()) this.installBinding(binding, false);
    for (const agentId of this.bindings.keys()) this.installBindingCallbackHandlers(agentId);
  }

  publishRecoveredBindings(): void {
    for (const binding of this.sessions.values()) this.installBinding(binding, true);
    for (const overrides of this.client.configOverrides.values()) {
      this.emit('config-overrides', clone(overrides));
    }
  }

  reconcileRecoveredBindings(
    previousSessions: Map<string, UnknownRecord>,
    previousHostEpoch: string,
  ): void {
    const hostReplaced = Boolean(
      previousHostEpoch
      && this.client.hostEpoch
      && previousHostEpoch !== this.client.hostEpoch
    );
    for (const [agentId, previous] of previousSessions) {
      if (!hostReplaced && this.sessions.has(agentId)) continue;
      const interrupted: UnknownRecord = {
        ...previous,
        state: 'error',
        error: hostReplaced
          ? 'ACP runtime Host restarted; the previous runtime binding is no longer recoverable'
          : 'ACP runtime Host no longer owns the previous runtime binding',
        stopReason: 'interrupted',
        updatedAt: new Date().toISOString(),
      };
      this.emit('agent-runtime', clone(interrupted));
      this.emit('session', {
        agentId,
        revision: Number(interrupted.revision || 0),
        title: String(interrupted.title || ''),
      });
    }
    this.publishRecoveredBindings();
  }

  applyRuntimeEvent(value: unknown): void {
    const event = value && typeof value === 'object' ? value as UnknownRecord : {};
    const payload = event.payload && typeof event.payload === 'object'
      ? event.payload as UnknownRecord
      : {};
    if (event.type === 'binding') this.installBinding(payload, true);
    if (event.type === 'binding-patch') {
      const agentId = String(payload.agentId || '');
      const current = this.sessions.get(agentId);
      if (current && String(current.bindingEpoch || '') === String(payload.bindingEpoch || '')) {
        const next = { ...current, ...payload };
        this.sessions.set(agentId, next);
        this.emit('session', {
          agentId,
          revision: Number(next.revision || 0),
          title: String(next.title || ''),
        });
      }
    }
    if (event.type === 'binding-removed') {
      const agentId = String(payload.agentId || '');
      const bindingEpoch = String(payload.bindingEpoch || '');
      if (this.bindingEpoch(agentId) === bindingEpoch) {
        this.bindings.delete(agentId);
        this.sessions.delete(agentId);
        const token = this.bindingCallbackTokens.get(agentId);
        if (token) this.client.unregisterCallbackHandlers(token);
        this.bindingCallbackTokens.delete(agentId);
        this.bindingCallbackHandlers.delete(agentId);
      }
    }
    if (event.type === 'prompt-operation') {
      const agentId = String(payload.agentId || '');
      const clientPromptId = String(payload.clientPromptId || '');
      if (payload.status === 'provider-owned' || payload.status === 'settled') {
        const callback = this.submissionCallbacks.get(operationKey(agentId, clientPromptId));
        if (callback) {
          this.submissionCallbacks.delete(operationKey(agentId, clientPromptId));
          void Promise.resolve(callback()).catch(() => {});
        }
      }
    }
  }

  installBinding(binding: UnknownRecord, emitEvents: boolean): void {
    const agentId = String(binding.agentId || '');
    if (!agentId) return;
    const snapshot = clone(binding);
    this.sessions.set(agentId, snapshot);
    this.bindings.set(agentId, {
      agentId,
      provider: String(snapshot.provider || ''),
      sessionId: String(snapshot.sessionId || ''),
      cwd: String(snapshot.cwd || ''),
    });
    if (!emitEvents) return;
    this.emit('agent-runtime', clone(snapshot));
    this.emit('session', {
      agentId,
      revision: Number(snapshot.revision || 0),
      title: String(snapshot.title || ''),
    });
  }

  handleDisconnect(error: Error): void {
    this.emit('host-disconnect', error);
    void this.initialize().catch(reconnectError => {
      this.emit('host-reconnect-error', reconnectError);
    });
  }

  async prepareAgent(options: AcpPrepareOptions): Promise<AcpPrepareResult> {
    await this.initialize();
    const agentId = String(options.agentId || '');
    const callbackToken = `agent:${agentId}`;
    this.bindingCallbackHandlers.set(agentId, {
      onProcessStarted: options.onProcessStarted,
      onForkSessionCreated: options.onForkSessionCreated,
      refreshMcpServersForRuntime: options.refreshMcpServersForRuntime,
    });
    this.bindingCallbackTokens.set(agentId, callbackToken);
    this.installBindingCallbackHandlers(agentId);
    const serializable = { ...options } as UnknownRecord;
    delete serializable.onProcessStarted;
    delete serializable.onForkSessionCreated;
    delete serializable.refreshMcpServersForRuntime;
    return this.client.request<AcpPrepareResult>('prepareAgent', {
      options: {
        ...serializable,
        callbackToken,
        callbackNames: [
          ...(options.onProcessStarted ? ['onProcessStarted'] : []),
          ...(options.onForkSessionCreated ? ['onForkSessionCreated'] : []),
          ...(options.refreshMcpServersForRuntime ? ['refreshMcpServersForRuntime'] : []),
        ],
      },
    }, { timeoutMs: 0 });
  }

  registerBindingCallbacks(
    agentId: string,
    handlers: BindingCallbackHandlers,
  ): void {
    const token = `agent:${agentId}`;
    this.bindingCallbackHandlers.set(agentId, handlers);
    this.bindingCallbackTokens.set(agentId, token);
    this.installBindingCallbackHandlers(agentId);
  }

  installBindingCallbackHandlers(agentId: string): void {
    const handlers = this.bindingCallbackHandlers.get(agentId);
    const token = this.bindingCallbackTokens.get(agentId);
    if (!handlers || !token) return;
    this.client.registerCallbackHandlers({
      ...(handlers.onProcessStarted
        ? { onProcessStarted: (value: unknown) => handlers.onProcessStarted?.(value as AcpProcessIdentity) }
        : {}),
      ...(handlers.onProcessStopped ? { onProcessStopped: handlers.onProcessStopped } : {}),
      ...(handlers.onForkSessionCreated
        ? { onForkSessionCreated: (value: unknown) => handlers.onForkSessionCreated?.(String(value || '')) }
        : {}),
      ...(handlers.refreshMcpServersForRuntime
        ? {
            refreshMcpServersForRuntime: (value: unknown) => handlers.refreshMcpServersForRuntime?.(
              Array.isArray(value) ? value as UnknownRecord[] : [],
            ),
          }
        : {}),
    }, token, agentId);
  }

  async reconnectAgent(
    agentId: string,
    options: { onProcessStopped?: () => Promise<void> | void } = {},
  ): Promise<UnknownRecord> {
    await this.initialize();
    const callbackToken = this.client.registerCallbackHandlers({
      ...(options.onProcessStopped ? { onProcessStopped: options.onProcessStopped } : {}),
    }, `reconnect:${agentId}:${crypto.randomUUID()}`, agentId);
    try {
      return await this.client.request<UnknownRecord>('reconnectAgent', {
        agentId,
        options: {
          agentId,
          callbackToken,
          bindingEpoch: this.bindingEpoch(agentId),
          callbackNames: options.onProcessStopped ? ['onProcessStopped'] : [],
        },
      }, { timeoutMs: 0 });
    } finally {
      this.client.unregisterCallbackHandlers(callbackToken);
    }
  }

  async createSessionIdentity(options: ProviderSessionIdentityRequest): Promise<ProviderSessionIdentityResult> {
    await this.initialize();
    return this.client.request('createSessionIdentity', { options }, { timeoutMs: 0 });
  }

  async submitMessage(
    agentId: string,
    prompt: AcpPromptBlock[],
    options: AcpSubmitOptions = {},
  ): Promise<AcpSubmitResult> {
    await this.initialize();
    const clientPromptId = String(options.clientPromptId || crypto.randomUUID());
    const key = operationKey(agentId, clientPromptId);
    if (options.onSubmitted) this.submissionCallbacks.set(key, options.onSubmitted);
    const existing = this.client.promptOperations.get(key);
    if (existing && ['provider-owned', 'settled'].includes(String(existing.status || ''))) {
      const callback = this.submissionCallbacks.get(key);
      this.submissionCallbacks.delete(key);
      await callback?.();
    }
    try {
      return await this.client.request<AcpSubmitResult>('submitPrompt', {
        agentId,
        bindingEpoch: this.bindingEpoch(agentId),
        clientPromptId,
        contentHash: promptContentHash(prompt, options.delivery),
        prompt,
        delivery: options.delivery,
        retryDefinitiveFailure: options.retryDefinitiveFailure,
      }, { timeoutMs: 0 });
    } finally {
      this.submissionCallbacks.delete(key);
    }
  }

  getSession(agentId: string, _options: UnknownRecord = {}): UnknownRecord {
    const session = this.sessions.get(agentId);
    if (!session) throw new Error('ACP Agent is not registered');
    return { ...clone(session), entries: [] };
  }

  async getSessionForRead(agentId: string, options: UnknownRecord = {}): Promise<UnknownRecord> {
    await this.initialize();
    const session = await this.client.request<UnknownRecord>('getSessionForRead', { agentId, options });
    const summary = clone(session);
    delete summary.entries;
    delete summary.transcriptTail;
    delete summary.updates;
    this.sessions.set(agentId, summary);
    return session;
  }

  getTranscriptSession(agentId: string): AcpTranscriptSession {
    return {
      sessionId: String(this.sessions.get(agentId)?.sessionId || ''),
      entries: [],
    };
  }

  async getTranscriptSessionForRead(
    agentId: string,
    options: UnknownRecord = {},
  ): Promise<AcpTranscriptSession> {
    await this.initialize();
    return this.client.request<AcpTranscriptSession>(
      'getTranscriptSessionForRead',
      { agentId, options },
    );
  }

  getSubagentTranscriptSession(agentId: string, sessionId: string): UnknownRecord | null {
    void agentId;
    void sessionId;
    return null;
  }

  async getSubagentTranscriptSessionForRead(
    agentId: string,
    sessionId: string,
    options: UnknownRecord = {},
  ): Promise<UnknownRecord | null> {
    await this.initialize();
    return this.client.request<UnknownRecord | null>(
      'getSubagentTranscriptSessionForRead',
      { agentId, sessionId, options },
    );
  }

  getTranscriptEntry(agentId: string, entryId: string): AcpTranscriptEntry | null {
    void agentId;
    void entryId;
    return null;
  }

  async getTranscriptEntryForRead(agentId: string, entryId: string): Promise<AcpTranscriptEntry | null> {
    await this.initialize();
    return this.client.request<AcpTranscriptEntry | null>(
      'getTranscriptEntryForRead',
      { agentId, entryId },
    );
  }

  getToolEntry(agentId: string, toolCallId: string): AcpTranscriptEntry | null {
    void agentId;
    void toolCallId;
    return null;
  }

  async getToolEntryForRead(agentId: string, toolCallId: string): Promise<AcpTranscriptEntry | null> {
    await this.initialize();
    return this.client.request<AcpTranscriptEntry | null>(
      'getToolEntryForRead',
      { agentId, toolCallId },
    );
  }

  transcriptProjectionRevision(agentId: string): number {
    return Number(this.sessions.get(agentId)?.transcriptProjectionRevision || 0);
  }

  getSessionRequestOptions(agentId: string): AcpSessionRequestOptions {
    const options = this.sessions.get(agentId)?.sessionRequestOptions;
    const recoveredOverrides = this.client.configOverrides.get(agentId)?.configOverrides;
    const configOverrides = Array.isArray(recoveredOverrides)
      ? clone(recoveredOverrides)
      : [];
    if (!options || typeof options !== 'object') {
      return {
        cwd: String(this.sessions.get(agentId)?.cwd || ''),
        additionalDirectories: [],
        configOverrides,
        mcpServers: [],
      };
    }
    return { ...clone(options as AcpSessionRequestOptions), configOverrides };
  }

  bindingCheckpoint(binding: AcpBindingContract): AcpBindingCheckpointView {
    return {
      exportCheckpoint: () => clone(this.forkCheckpoints.get(binding.agentId) || {}),
    };
  }

  async runWithForkReservation<T>(
    agentId: string,
    options: AcpForkOptions,
    operation: (binding: AcpBindingContract) => Promise<T> | T,
  ): Promise<T> {
    await this.initialize();
    const reservation = await this.client.request<UnknownRecord>(
      'beginForkReservation',
      { agentId, options },
      { timeoutMs: 0 },
    );
    const token = String(reservation.token || '');
    const binding = reservation.binding as unknown as AcpBindingContract;
    this.forkCheckpoints.set(agentId, clone(reservation.checkpoint as AcpBindingCheckpoint));
    try {
      return await operation(binding);
    } finally {
      this.forkCheckpoints.delete(agentId);
      await this.client.request('endForkReservation', { token }, { timeoutMs: 0 });
    }
  }

  async forkSession(agentId: string, options: AcpForkOptions = {}): Promise<AcpForkResult> {
    await this.initialize();
    return this.client.request('forkSession', { agentId, options }, { timeoutMs: 0 });
  }

  async listSessions(agentId: string, options: AcpSessionListOptions = {}): Promise<AcpSessionListResult> {
    await this.initialize();
    return this.client.request('listSessions', { agentId, options });
  }

  respondPermission(agentId: string, requestId: string, optionId: string, cancelled = false): unknown {
    return this.client.request('respondPermission', { agentId, requestId, optionId, cancelled });
  }

  respondElicitation(agentId: string, requestId: string, action: string, content: unknown): unknown {
    return this.client.request('respondElicitation', { agentId, requestId, action, content });
  }

  authenticate(agentId: string, methodId: string): Promise<unknown> {
    return this.client.request('authenticate', { agentId, methodId });
  }

  logout(agentId: string): Promise<unknown> {
    return this.client.request('logout', { agentId });
  }

  deleteSession(agentId: string, sessionId: string): Promise<unknown> {
    return this.client.request('deleteSession', { agentId, sessionId });
  }

  closeSession(agentId: string): Promise<unknown> {
    return this.client.request('closeSession', { agentId });
  }

  setSessionMode(agentId: string, modeId: string): Promise<unknown> {
    return this.client.request('setSessionMode', { agentId, modeId });
  }

  setSessionConfigOption(agentId: string, configId: string, value: AcpConfigValue): Promise<unknown> {
    return this.client.request('setSessionConfigOption', { agentId, configId, value });
  }

  setSessionConfigOptions(agentId: string, changes: AcpConfigChange[]): Promise<unknown> {
    return this.client.request('setSessionConfigOptions', { agentId, changes });
  }

  killTerminal(agentId: string, terminalId: string): unknown {
    return this.client.request('killTerminal', { agentId, terminalId });
  }

  inputTerminal(agentId: string, terminalId: string, input: string, operationId = crypto.randomUUID()): unknown {
    const bindingEpoch = this.bindingEpoch(agentId);
    return this.client.request('inputTerminal', {
      agentId,
      terminalId,
      input,
      operationId,
      bindingEpoch,
      signature: crypto.createHash('sha256').update(`${terminalId}\0${input}`).digest('hex'),
    });
  }

  resizeTerminal(agentId: string, terminalId: string, cols: number, rows: number): unknown {
    return this.client.request('resizeTerminal', { agentId, terminalId, cols, rows });
  }

  cancelSubagent(agentId: string, sessionId: string): Promise<unknown> {
    return this.client.request('cancelSubagent', { agentId, sessionId });
  }

  decidePatch(
    agentId: string,
    toolCallId: string,
    requestedPath: string,
    decision: 'keep' | 'revert',
  ): Promise<unknown> {
    return this.client.request('decidePatch', { agentId, toolCallId, requestedPath, decision });
  }

  async cancel(agentId: string): Promise<unknown> {
    await this.initialize();
    const binding = this.client.bindings.get(agentId);
    const session = this.sessions.get(agentId);
    const bindingEpoch = this.bindingEpoch(agentId);
    const turnHandle = String(binding?.turnHandle || session?.turnHandle || '');
    if (!bindingEpoch) throw new Error('ACP runtime Host binding is unavailable for cancellation');
    const recovered = [...this.client.cancelOperations.values()].find(operation => (
      operation.agentId === agentId
      && operation.bindingEpoch === bindingEpoch
      && operation.turnHandle === turnHandle
      && ['admitted', 'settled'].includes(String(operation.status || ''))
    ));
    const operationId = String(recovered?.operationId || crypto.randomUUID());
    return this.client.request('cancelTurn', {
      agentId,
      bindingEpoch,
      turnHandle,
      operationId,
    }, { timeoutMs: 0 });
  }

  bindingEpoch(agentId: string): string {
    return String(
      this.client.bindings.get(agentId)?.bindingEpoch
      || this.sessions.get(agentId)?.bindingEpoch
      || '',
    );
  }

  transcriptSettled(agentId: string): boolean {
    const state = String(this.sessions.get(agentId)?.state || '');
    return Boolean(state && !['connecting', 'reconnecting'].includes(state));
  }

  hasBinding(agentId: string): boolean {
    return this.bindings.has(agentId);
  }

  unregisterAgent(agentId: string): void {
    void this.unregisterAgentAndWait(agentId).catch(() => {});
  }

  async unregisterAgentAndWait(agentId: string): Promise<boolean> {
    await this.initialize();
    return this.client.request('unregisterAgentAndWait', { agentId }, { timeoutMs: 0 });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.client.socket && !this.client.socket.destroyed) {
        await this.client.request('shutdownHost', {}, { timeoutMs: 30000 });
      }
    } finally {
      this.client.disconnect();
    }
  }

  disconnect(): void {
    this.client.disconnect();
  }

  resumeAfterDisposeAbort(): void {
    this.disposed = false;
  }
}

export { AcpRuntimeHostRuntime };
