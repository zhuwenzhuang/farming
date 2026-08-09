'use strict';

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { allocateAcpRuntimeHostControllerGeneration } from './acp-runtime-host-controller.cjs';
import { configInstanceFingerprint } from './config-instance.cjs';
import {
  ACP_RUNTIME_HOST_PROTOCOL_VERSION,
  acpRuntimeHostIdentity,
  normalizeAcpRuntimeHostIdentity,
} from './acp-runtime-host-identity.cjs';
import { acpRuntimeHostSocketPath } from './acp-runtime-host-path.cjs';
import { runtimeExecutableInvocation } from './runtime-executable-invocation.cjs';

type UnknownRecord = Record<string, unknown>;

interface PendingRequest {
  method: string;
  operationId: string;
  reject(error: Error): void;
  resolve(value: unknown): void;
  timer: NodeJS.Timeout | null;
}

interface AcpRuntimeHostClientOptions {
  configDir: string;
  connectRetries?: number;
  connectRetryMs?: number;
  expectedBuildId?: string;
  forceReplaceActiveHost?: boolean;
  hostScript?: string;
  requestTimeoutMs?: number;
  socketPath?: string;
  spawnHost?: () => void;
}

type ControllerCallback = (...args: unknown[]) => unknown | Promise<unknown>;

interface RequestOptions {
  timeoutMs?: number;
}

const DEFAULT_CONNECT_RETRIES = 300;
const DEFAULT_CONNECT_RETRY_MS = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
}

function connectRetryable(error: unknown): boolean {
  return ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ACP_RUNTIME_HOST_REQUEST_TIMEOUT', 'ACP_RUNTIME_HOST_ROTATED']
    .includes(errorCode(error));
}

function responseError(value: unknown): Error & UnknownRecord {
  const detail = value && typeof value === 'object' ? value as UnknownRecord : {};
  const error = new Error(String(detail.message || value || 'ACP runtime host request failed')) as Error & UnknownRecord;
  for (const key of ['code', 'uncertain', 'retryable', 'operationId']) {
    if (detail[key] !== undefined) error[key] = detail[key];
  }
  return error;
}

function mutationMethod(method: string): boolean {
  return ![
    'ping', 'recover', 'getSession', 'getSessionForRead', 'getTranscriptSessionForRead',
    'getSubagentTranscriptSessionForRead', 'getTranscriptEntryForRead', 'getToolEntryForRead',
    'listSessions', 'getSessionRequestOptions',
  ].includes(method);
}

function acpRuntimeHostSpawnCommand(
  hostScript: string,
  env: NodeJS.ProcessEnv,
  packaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg),
  platform: NodeJS.Platform | string = process.platform,
): { command: string; args: string[] } {
  const sourceHostScript = hostScript.endsWith('.cjs')
    ? hostScript.slice(0, -4) + '.cts'
    : '';
  const args = packaged
    ? ['--acp-runtime-host']
    : (!fs.existsSync(hostScript) && sourceHostScript && fs.existsSync(sourceHostScript)
      ? ['--import', require.resolve('tsx'), sourceHostScript]
      : [hostScript]);
  const executable = packaged
    ? process.execPath
    : (env.FARMING_NODE_BIN || process.execPath);
  return runtimeExecutableInvocation(executable, args, env, platform);
}

class AcpRuntimeHostClient extends EventEmitter {
  readonly configDir: string;
  readonly socketPath: string;
  readonly hostScript: string;
  readonly connectRetries: number;
  readonly connectRetryMs: number;
  readonly requestTimeoutMs: number;
  readonly controllerId: string;
  readonly expectedBuildId: string;
  readonly forceReplaceActiveHost: boolean;
  readonly spawnHostOverride: (() => void) | null;
  controllerGeneration: number;
  socket: net.Socket | null;
  buffer: string;
  nextRequestId: number;
  pending: Map<number, PendingRequest>;
  connecting: Promise<void> | null;
  disposed: boolean;
  eventSeq: number;
  hostEpoch: string;
  bindings: Map<string, UnknownRecord>;
  promptOperations: Map<string, UnknownRecord>;
  cancelOperations: Map<string, UnknownRecord>;
  configOverrides: Map<string, UnknownRecord>;
  recovering: boolean;
  recoveryEvents: UnknownRecord[];
  callbackHandlers: Map<string, Record<string, ControllerCallback>>;
  callbackAgentIds: Map<string, string>;
  poisonedError: Error | null;

  constructor(options: AcpRuntimeHostClientOptions) {
    super();
    this.configDir = path.resolve(options.configDir);
    this.socketPath = options.socketPath || acpRuntimeHostSocketPath(this.configDir);
    this.hostScript = options.hostScript || path.join(__dirname, 'acp-runtime-host-process.cjs');
    this.connectRetries = options.connectRetries || DEFAULT_CONNECT_RETRIES;
    this.connectRetryMs = options.connectRetryMs || DEFAULT_CONNECT_RETRY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.controllerId = crypto.randomUUID();
    this.expectedBuildId = String(options.expectedBuildId || acpRuntimeHostIdentity().buildId);
    this.forceReplaceActiveHost = options.forceReplaceActiveHost === true;
    this.spawnHostOverride = options.spawnHost || null;
    this.controllerGeneration = 0;
    this.socket = null;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pending = new Map();
    this.connecting = null;
    this.disposed = false;
    this.eventSeq = 0;
    this.hostEpoch = '';
    this.bindings = new Map();
    this.promptOperations = new Map();
    this.cancelOperations = new Map();
    this.configOverrides = new Map();
    this.recovering = false;
    this.recoveryEvents = [];
    this.callbackHandlers = new Map();
    this.callbackAgentIds = new Map();
    this.poisonedError = null;
  }

  spawnHost(): void {
    if (this.spawnHostOverride) return this.spawnHostOverride();
    const env = {
      ...process.env,
      FARMING_CONFIG_DIR: this.configDir,
      FARMING_ACP_RUNTIME_HOST_BUILD_ID: acpRuntimeHostIdentity().buildId,
    };
    const spawnCommand = acpRuntimeHostSpawnCommand(this.hostScript, env);
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      detached: true,
      env,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }

  async connectOnce(): Promise<void> {
    const socket = net.createConnection(this.socketPath);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        resolve();
      });
    });
    this.attachSocket(socket);
  }

  attachSocket(socket: net.Socket): void {
    this.socket = socket;
    this.buffer = '';
    socket.on('data', chunk => this.handleData(chunk));
    socket.once('close', () => this.handleDisconnect(new Error('ACP runtime host connection closed')));
    socket.once('error', error => this.handleDisconnect(error));
  }

  handleDisconnect(error: Error): void {
    if (!this.socket) return;
    this.socket = null;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      const pendingError = new Error(error.message) as Error & UnknownRecord;
      pendingError.cause = error;
      if (mutationMethod(pending.method)) {
        pendingError.uncertain = true;
        if (pending.operationId) pendingError.operationId = pending.operationId;
      }
      pending.reject(pendingError);
    }
    this.pending.clear();
    if (!this.disposed) this.emit('disconnect', error);
  }

  handleData(chunk: Buffer | string): void {
    this.buffer += chunk.toString('utf8');
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          if (message && typeof message === 'object') this.handleMessage(message);
        } catch {
          this.handleDisconnect(new Error('ACP runtime host sent an invalid response'));
          return;
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  handleMessage(message: UnknownRecord): void {
    if (message.event) {
      this.applyEvent(String(message.event), message.payload);
      return;
    }
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(responseError(message.error));
  }

  applyEvent(event: string, payload: unknown): void {
    if (event === 'controller-callback') {
      void this.handleControllerCallback(payload).catch(error => this.emit('error', error));
      return;
    }
    if (event === 'runtime-event' && payload && typeof payload === 'object') {
      const item = payload as UnknownRecord;
      if (this.recovering) {
        this.recoveryEvents.push(item);
        return;
      }
      const seq = Number(item.seq);
      if (!Number.isSafeInteger(seq) || seq <= 0) return;
      if (seq <= this.eventSeq) return;
      if (seq !== this.eventSeq + 1) {
        void this.recover(true).catch(error => this.emit('error', error));
        return;
      }
      this.installRuntimeEvent(item);
      return;
    }
    this.emit(event, payload);
  }

  async handleControllerCallback(payload: unknown): Promise<void> {
    const request = payload && typeof payload === 'object' ? payload as UnknownRecord : {};
    const callbackId = String(request.callbackId || '');
    const callbackToken = String(request.callbackToken || '');
    const generation = Number(request.controllerGeneration);
    if (
      !callbackId
      || !callbackToken
      || String(request.hostEpoch || '') !== this.hostEpoch
      || generation !== this.controllerGeneration
    ) return;
    const expectedAgentId = this.callbackAgentIds.get(callbackToken) || '';
    if (expectedAgentId && String(request.agentId || '') !== expectedAgentId) return;
    const currentBindingEpoch = String(this.bindings.get(expectedAgentId)?.bindingEpoch || '');
    if (currentBindingEpoch && String(request.bindingEpoch || '') !== currentBindingEpoch) return;
    const handler = this.callbackHandlers.get(callbackToken)?.[String(request.name || '')];
    try {
      if (!handler) throw new Error('ACP runtime Host requested an unavailable Controller callback');
      const result = await handler(...(Array.isArray(request.args) ? request.args : []));
      await this.request('resolveControllerCallback', { callbackId, ok: true, result });
    } catch (error) {
      await this.request('resolveControllerCallback', {
        callbackId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        uncertain: Boolean(error && typeof error === 'object' && (error as UnknownRecord).uncertain === true),
      }).catch(() => {});
    }
  }

  registerCallbackHandlers(
    handlers: Record<string, ControllerCallback>,
    requestedToken = '',
    agentId = '',
  ): string {
    const token = requestedToken || crypto.randomUUID();
    this.callbackHandlers.set(token, handlers);
    if (agentId) this.callbackAgentIds.set(token, agentId);
    return token;
  }

  unregisterCallbackHandlers(token: string): void {
    this.callbackHandlers.delete(token);
    this.callbackAgentIds.delete(token);
  }

  installRuntimeEvent(item: UnknownRecord): void {
    this.eventSeq = Number(item.seq);
    if (item.type === 'binding' && item.payload && typeof item.payload === 'object') {
      const binding = item.payload as UnknownRecord;
      const agentId = String(binding.agentId || '');
      if (agentId) this.bindings.set(agentId, binding);
    }
    if (item.type === 'binding-patch' && item.payload && typeof item.payload === 'object') {
      const patch = item.payload as UnknownRecord;
      const agentId = String(patch.agentId || '');
      const current = this.bindings.get(agentId);
      if (current && String(current.bindingEpoch || '') === String(patch.bindingEpoch || '')) {
        this.bindings.set(agentId, { ...current, ...patch });
      }
    }
    if (item.type === 'prompt-operation' && item.payload && typeof item.payload === 'object') {
      const operation = item.payload as UnknownRecord;
      const key = `${String(operation.agentId || '')}\0${String(operation.clientPromptId || '')}`;
      this.promptOperations.set(key, operation);
    }
    if (item.type === 'cancel-operation' && item.payload && typeof item.payload === 'object') {
      const operation = item.payload as UnknownRecord;
      const key = `${String(operation.agentId || '')}\0${String(operation.operationId || '')}`;
      this.cancelOperations.set(key, operation);
    }
    if (item.type === 'config-overrides' && item.payload && typeof item.payload === 'object') {
      const overrides = item.payload as UnknownRecord;
      const agentId = String(overrides.agentId || '');
      if (agentId) this.configOverrides.set(agentId, overrides);
      this.emit('config-overrides', overrides);
    }
    if (item.type === 'binding-removed' && item.payload && typeof item.payload === 'object') {
      const removal = item.payload as UnknownRecord;
      const agentId = String(removal.agentId || '');
      const bindingEpoch = String(removal.bindingEpoch || '');
      if (String(this.bindings.get(agentId)?.bindingEpoch || '') === bindingEpoch) {
        this.bindings.delete(agentId);
        this.configOverrides.delete(agentId);
        for (const [key, operation] of this.promptOperations) {
          if (operation.agentId === agentId && operation.bindingEpoch === bindingEpoch) {
            this.promptOperations.delete(key);
          }
        }
        for (const [key, operation] of this.cancelOperations) {
          if (operation.agentId === agentId && operation.bindingEpoch === bindingEpoch) {
            this.cancelOperations.delete(key);
          }
        }
      }
    }
    if (item.type === 'operation-pruned' && item.payload && typeof item.payload === 'object') {
      const pruned = item.payload as UnknownRecord;
      const key = String(pruned.key || '');
      if (pruned.kind === 'prompt') this.promptOperations.delete(key);
      if (pruned.kind === 'cancel') this.cancelOperations.delete(key);
    }
    this.emit('runtime-event', item);
  }

  async ensureConnected(): Promise<void> {
    if (this.disposed) throw new Error('ACP runtime host client is disposed');
    if (this.socket && !this.socket.destroyed) return;
    if (this.controllerGeneration > 0) {
      throw new Error('ACP runtime host controller disconnected; create a new controller generation');
    }
    if (this.connecting) return this.connecting;
    this.connecting = this.connectAndRegister().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async connectAndRegister(): Promise<void> {
    this.controllerGeneration = await allocateAcpRuntimeHostControllerGeneration(this.configDir);
    let spawned = false;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < this.connectRetries; attempt += 1) {
      let registrationAttempted = false;
      try {
        await this.connectOnce();
        const ping = await this.request<UnknownRecord>('ping', {}, { timeoutMs: 3000 });
        const runtimeIdentity = normalizeAcpRuntimeHostIdentity(ping.runtimeIdentity);
        if (runtimeIdentity?.protocolVersion !== ACP_RUNTIME_HOST_PROTOCOL_VERSION) {
          const error = new Error('ACP runtime host protocol is incompatible') as Error & { code?: string };
          error.code = 'ACP_RUNTIME_HOST_PROTOCOL_MISMATCH';
          throw error;
        }
        if (String(ping.configInstanceFingerprint || '') !== configInstanceFingerprint(this.configDir)) {
          const error = new Error('ACP runtime host belongs to another config instance') as Error & { code?: string };
          error.code = 'ACP_RUNTIME_HOST_CONFIG_MISMATCH';
          throw error;
        }
        if (runtimeIdentity.buildId !== this.expectedBuildId) {
          if (Number(ping.bindingCount) === 0 || this.forceReplaceActiveHost) {
            registrationAttempted = true;
            await this.request('registerController', {
              identity: { id: this.controllerId, generation: this.controllerGeneration },
            }, { timeoutMs: 3000 });
            await this.request('shutdownHost', {}, { timeoutMs: 3000 });
            const rotated = new Error(
              this.forceReplaceActiveHost
                ? 'Replaced an active incompatible ACP runtime Host for a forced restart'
                : 'Replaced an idle incompatible ACP runtime Host',
            ) as Error & { code?: string };
            rotated.code = 'ACP_RUNTIME_HOST_ROTATED';
            throw rotated;
          }
          const bindingCount = Number(ping.bindingCount) || 0;
          const hostPid = Number(ping.pid);
          const stopCommand = process.platform === 'win32'
            ? `taskkill /PID ${hostPid} /T`
            : `kill -TERM ${hostPid}`;
          const sessionLabel = bindingCount === 1 ? 'session' : 'sessions';
          const error = new Error(
            `An older ACP runtime Host (PID ${hostPid}) for config ${JSON.stringify(this.configDir)} `
            + `is still running and owns ${bindingCount} active Chat ${sessionLabel}. `
            + `Farming did not stop it automatically. Stopping it will terminate all ${bindingCount} ${sessionLabel}.\n`
            + `Run:\n  ${stopCommand}\nThen start Farming again.`,
          ) as Error & { code?: string };
          error.code = 'ACP_RUNTIME_HOST_BUILD_MISMATCH_ACTIVE';
          throw error;
        }
        this.hostEpoch = String(ping.hostEpoch || '');
        registrationAttempted = true;
        await this.request('registerController', {
          identity: { id: this.controllerId, generation: this.controllerGeneration },
        }, { timeoutMs: 3000 });
        await this.recover();
        return;
      } catch (error) {
        lastError = error;
        this.socket?.destroy();
        this.socket = null;
        if (!connectRetryable(error)) throw error;
        if (registrationAttempted) {
          this.controllerGeneration = await allocateAcpRuntimeHostControllerGeneration(this.configDir);
        }
        if (!spawned) {
          spawned = true;
          this.spawnHost();
        }
        await delay(this.connectRetryMs);
      }
    }
    throw lastError || new Error('Failed to connect to ACP runtime host');
  }

  request<T = unknown>(method: string, params: UnknownRecord = {}, options: RequestOptions = {}): Promise<T> {
    if (this.poisonedError) return Promise.reject(this.poisonedError);
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('ACP runtime host is not connected'));
    }
    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs === 0 ? 0 : Number(options.timeoutMs || this.requestTimeoutMs);
    return new Promise<T>((resolve, reject) => {
      const operationId = String(params.clientPromptId || params.operationId || '');
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            const error = new Error(`ACP runtime host ${method} timed out`) as Error & UnknownRecord;
            error.code = 'ACP_RUNTIME_HOST_REQUEST_TIMEOUT';
            if (mutationMethod(method)) error.uncertain = true;
            if (operationId) error.operationId = operationId;
            reject(error);
            if (mutationMethod(method)) {
              this.poisonedError = error;
              this.socket?.destroy(error);
            }
          }, timeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, { method, operationId, resolve: value => resolve(value as T), reject, timer });
      this.socket?.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        const writeError = new Error(error.message) as Error & UnknownRecord;
        writeError.cause = error;
        if (mutationMethod(method)) {
          writeError.uncertain = true;
          if (operationId) writeError.operationId = operationId;
          this.poisonedError = writeError;
        }
        pending.reject(writeError);
        if (mutationMethod(method)) this.socket?.destroy(writeError);
      });
    });
  }

  async recover(forceReplace = false): Promise<UnknownRecord> {
    if (this.recovering) throw new Error('ACP runtime host recovery is already in progress');
    this.recovering = true;
    this.recoveryEvents = [];
    let requireFull = forceReplace;
    let result: UnknownRecord = {};
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const baseEventSeq = requireFull ? 0 : this.eventSeq;
        result = await this.request<UnknownRecord>('recover', {
          ...(!requireFull && baseEventSeq > 0 ? { afterEventSeq: baseEventSeq } : {}),
        });
        const buffered = this.recoveryEvents;
        this.recoveryEvents = [];
        let contiguous = this.installRecovery(result, baseEventSeq, requireFull)
          && this.installBufferedEvents(buffered);
        if (contiguous) {
          while (this.recoveryEvents.length > 0) {
            const next = this.recoveryEvents;
            this.recoveryEvents = [];
            if (!this.installBufferedEvents(next)) {
              contiguous = false;
              break;
            }
          }
          if (contiguous) return result;
        }
        requireFull = true;
      }
      throw new Error('ACP runtime host recovery could not establish a contiguous event stream');
    } finally {
      this.recovering = false;
      this.recoveryEvents = [];
    }
  }

  installRecovery(result: UnknownRecord, baseEventSeq: number, requireFull: boolean): boolean {
    const hostEpoch = String(result.hostEpoch || '');
    if (this.hostEpoch && hostEpoch && hostEpoch !== this.hostEpoch) {
      this.bindings.clear();
      this.promptOperations.clear();
      this.cancelOperations.clear();
      this.configOverrides.clear();
      this.eventSeq = 0;
      if (result.replace !== true) return false;
    }
    if (hostEpoch) this.hostEpoch = hostEpoch;
    if (result.replace === true) {
      this.bindings.clear();
      this.promptOperations.clear();
      this.cancelOperations.clear();
      this.configOverrides.clear();
      for (const binding of Array.isArray(result.bindings) ? result.bindings : []) {
        const agentId = String(binding?.agentId || '');
        if (agentId) this.bindings.set(agentId, binding);
      }
      for (const operation of Array.isArray(result.promptOperations) ? result.promptOperations : []) {
        const key = `${String(operation?.agentId || '')}\0${String(operation?.clientPromptId || '')}`;
        this.promptOperations.set(key, operation);
      }
      for (const operation of Array.isArray(result.cancelOperations) ? result.cancelOperations : []) {
        const key = `${String(operation?.agentId || '')}\0${String(operation?.operationId || '')}`;
        this.cancelOperations.set(key, operation);
      }
      for (const overrides of Array.isArray(result.configOverrides) ? result.configOverrides : []) {
        const agentId = String(overrides?.agentId || '');
        if (agentId) this.configOverrides.set(agentId, overrides);
      }
      const watermark = Number(result.eventSeq);
      if (!Number.isSafeInteger(watermark) || watermark < 0) return false;
      this.eventSeq = watermark;
    } else {
      if (requireFull || this.eventSeq !== baseEventSeq) return false;
      for (const event of Array.isArray(result.events) ? result.events : []) {
        if (!event || typeof event !== 'object') return false;
        const seq = Number(event.seq);
        if (seq <= this.eventSeq) continue;
        if (seq !== this.eventSeq + 1) return false;
        this.installRuntimeEvent(event);
      }
      if (this.eventSeq !== Number(result.eventSeq)) return false;
    }
    return true;
  }

  installBufferedEvents(events: UnknownRecord[]): boolean {
    for (const event of events) {
      const seq = Number(event.seq);
      if (!Number.isSafeInteger(seq) || seq <= 0) return false;
      if (seq <= this.eventSeq) continue;
      if (seq !== this.eventSeq + 1) return false;
      this.installRuntimeEvent(event);
    }
    return true;
  }

  disconnect(): void {
    this.disposed = true;
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      const error = new Error('ACP runtime host client disconnected') as Error & UnknownRecord;
      if (mutationMethod(pending.method)) {
        error.uncertain = true;
        if (pending.operationId) error.operationId = pending.operationId;
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export { AcpRuntimeHostClient, acpRuntimeHostSpawnCommand };
