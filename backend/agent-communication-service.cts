import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Message, Task, TaskState, type SendMessageRequest, type ListTasksRequest, type ListTasksResponse } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotFoundError, TaskNotCancelableError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { atomicWriteJsonAsync } from './atomic-json-store.cjs';
import { composerCommandHash } from './agent-composer-admission.cjs';
import type { CommunicationGrant } from './agent-communication-credentials.cjs';
import { normalizeAcpPeerMessage, type AcpPeerMessage } from '../shared/acp-peer-message.js';

export interface CommunicationTarget {
  agentId: string;
  /** Exact durable provider/Home/session identity, checked again at execution. */
  sessionKey: string;
  name: string;
}

export interface CommunicationExecution {
  requestId: string;
  target: CommunicationTarget;
  source: AcpPeerMessage;
  text: string;
  taskId: string;
  contextId: string;
  replyToTaskId?: string;
}

export interface CommunicationResult { text: string; outcome?: 'completed' | 'failed' | 'canceled' }

export type { CommunicationExchange } from '../shared/agent-communication.js';
import type { CommunicationExchange } from '../shared/agent-communication.js';

export interface CommunicationPorts {
  resolveTarget(grant: CommunicationGrant, agentId: string): Promise<CommunicationTarget>;
  resolveSource(grant: CommunicationGrant): Promise<AcpPeerMessage>;
  /** Resolves with the correlated execution result, not the input admission acknowledgement. */
  execute(request: CommunicationExecution): Promise<CommunicationResult>;
  cancel?(request: CommunicationExecution): Promise<void>;
  /** Read-only receipt lookup: never redispatch an uncertain request. */
  reconcile?(request: CommunicationExecution): Promise<CommunicationResult | null>;
}

type DeliveryState = 'queued' | 'working' | 'completed' | 'failed' | 'canceled' | 'unknown';
interface RecordEntry {
  version: 1;
  owner: string;
  messageId: string;
  hash: string;
  delivery: DeliveryState;
  execution: CommunicationExecution;
  task: Task;
}
const MAX_RECORDS = 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;

function owner(grant: CommunicationGrant): string {
  return grant.principal.kind === 'agent'
    ? `agent:${grant.principal.agentId}` : `external:${grant.principal.peerId}`;
}
function requestKey(grant: CommunicationGrant, messageId: string): string {
  return createHash('sha256').update(JSON.stringify([owner(grant), messageId])).digest('hex');
}
function taskStatus(state: TaskState, text?: string) {
  return { state, timestamp: new Date().toISOString(), message: text ? Message.fromJSON({
    messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }],
  }) : undefined };
}

/** Only Farming-originated communications live here; native provider peer history remains authoritative. */
export class AgentCommunicationService {
  private readonly file: string;
  private readonly ports: CommunicationPorts;
  private tail: Promise<unknown> = Promise.resolve();
  private records: Map<string, RecordEntry> | null = null;
  private loading: Promise<void> | null = null;
  private readonly running = new Map<string, Promise<void>>();

  constructor(configDir: string, ports: CommunicationPorts) {
    this.file = path.join(configDir, 'agent-communications.json');
    this.ports = ports;
  }

  private async load(): Promise<void> {
    if (this.records) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let data: unknown;
      try {
        const file = await fs.open(this.file, 'r');
        try {
          const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead > MAX_FILE_BYTES) throw new Error('Communication journal exceeds limit');
          data = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
        } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.records = new Map(); return;
      }
      const state = data as { version?: unknown; records?: unknown } | null;
      if (!state || state.version !== 1 || !Array.isArray(state.records) || state.records.length > MAX_RECORDS) {
        throw new Error('Invalid communication journal');
      }
      const records = new Map<string, RecordEntry>();
      for (const value of state.records) {
        if (!value || typeof value !== 'object') throw new Error('Invalid communication record');
        const item = value as RecordEntry;
        if (item.version !== 1 || typeof item.owner !== 'string' || typeof item.messageId !== 'string' || !ID.test(item.messageId)
          || !/^[a-f0-9]{64}$/.test(item.hash) || !item.execution?.target?.sessionKey
          || typeof item.execution.taskId !== 'string' || !ID.test(item.execution.taskId)
          || typeof item.execution.requestId !== 'string' || !ID.test(item.execution.requestId)
          || typeof item.execution.text !== 'string' || !item.task
          || !['queued', 'working', 'completed', 'failed', 'canceled', 'unknown'].includes(item.delivery)) {
          throw new Error('Invalid communication record');
        }
        item.task = Task.fromJSON(item.task);
        if (item.task.id !== item.execution.taskId || records.has(item.task.id)) throw new Error('Invalid communication task identity');
        if (item.delivery === 'queued' || item.delivery === 'working') {
          item.delivery = 'unknown';
          item.task.status = taskStatus(TaskState.TASK_STATE_INPUT_REQUIRED,
            'Execution outcome is unknown after restart. Reconcile the original request; it was not replayed.');
        }
        records.set(item.task.id, item);
      }
      await this.persist(records);
      this.records = records;
    })();
    try { await this.loading; } finally { this.loading = null; }
  }

  private async persist(records: Map<string, RecordEntry>): Promise<void> {
    const value = { version: 1, records: [...records.values()].map(r => ({ ...r, task: Task.toJSON(r.task) })) };
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_FILE_BYTES) throw new Error('Communication journal capacity reached');
    if (!await atomicWriteJsonAsync(this.file, value, { mode: 0o600 })) throw new Error('Communication journal was not persisted');
  }

  private transaction<T>(change: (records: Map<string, RecordEntry>) => T): Promise<T> {
    const operation = this.tail.then(async () => {
      await this.load();
      const next = new Map([...this.records!].map(([id, record]) => [id, structuredClone(record)]));
      const result = change(next);
      await this.persist(next);
      this.records = next;
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async send(grant: CommunicationGrant, targetAgentId: string, params: SendMessageRequest): Promise<Task> {
    if (grant.expiresAt <= Date.now()) throw new RequestMalformedError('Communication credential expired');
    if (!params.message || !ID.test(params.message.messageId)) throw new RequestMalformedError('A bounded messageId is required');
    const message = structuredClone(params.message);
    grant = structuredClone(grant);
    if (message.taskId) throw new UnsupportedOperationError('Task continuation is not supported; reuse contextId for a new request');
    if (params.tenant) throw new RequestMalformedError('Tenant selection is not supported');
    let contextId = message.contextId || `ctx-${randomUUID()}`;
    if (!ID.test(contextId)) throw new RequestMalformedError('Invalid contextId');
    if (message.referenceTaskIds.length > 1 || message.referenceTaskIds.some(id => !ID.test(id))) throw new RequestMalformedError('At most one valid referenceTaskId is supported');
    if (!message.parts.length || message.parts.some(p => p.content?.$case !== 'text')) {
      throw new RequestMalformedError('Only text messages are supported');
    }
    if (params.configuration?.taskPushNotificationConfig) throw new UnsupportedOperationError('Push notifications are not supported');
    if (params.configuration?.acceptedOutputModes.length && !params.configuration.acceptedOutputModes.includes('text/plain')) throw new UnsupportedOperationError('Only text/plain output is supported');
    const text = message.parts.map(p => p.content?.value).join('\n');
    if (!text.trim() || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new RequestMalformedError('Text must contain 1 to 65536 bytes');
    if (grant.principal.kind === 'external' && !grant.targets.includes(targetAgentId)) throw new TaskNotFoundError('Agent is not available to this peer');
    // Hash caller intent, not mutable names or a generated context ID.
    const hash = composerCommandHash({ targetAgentId, message: Message.toJSON(message), ...(grant.initiatedBy ? { initiatedBy: grant.initiatedBy } : {}) });
    const key = requestKey(grant, message.messageId);
    // Replays return saved evidence before resolving a runtime which may since have stopped.
    await this.tail; await this.load();
    const previous = [...this.records!.values()].find(r => r.execution.requestId === key);
    if (previous) {
      if (previous.hash !== hash) throw new RequestMalformedError('messageId was already used for different content or target');
      return this.get(grant, targetAgentId, previous.task.id);
    }
    let target: CommunicationTarget;
    let source: AcpPeerMessage | null;
    try {
      target = await this.ports.resolveTarget(grant, targetAgentId);
      source = normalizeAcpPeerMessage(await this.ports.resolveSource(grant));
    } catch (error) {
      // No admission has happened: a caller may correct this initial request.
      throw new RequestMalformedError(error instanceof Error ? error.message : 'Communication runtime is unavailable');
    }
    if (!source || target.agentId !== targetAgentId || !target.sessionKey) throw new RequestMalformedError('Invalid communication runtime identity');
    const id = randomUUID();
    const admission = await this.transaction(records => {
      const existing = [...records.values()].find(r => r.execution.requestId === key);
      if (existing) {
        if (existing.hash !== hash) throw new RequestMalformedError('messageId was already used for different content or target');
        return { record: existing, created: false };
      }
      const replyToTaskId = message.referenceTaskIds[0];
      if (replyToTaskId) {
        const reference = records.get(replyToTaskId);
        const sameDirection = reference && reference.owner === owner(grant) && reference.execution.target.agentId === targetAgentId
          && reference.execution.target.sessionKey === target.sessionKey
          && reference.execution.source.senderSessionKey === source.senderSessionKey;
        const reverseDirection = reference && grant.principal.kind === 'agent'
          && reference.execution.target.agentId === grant.principal.agentId
          && reference.execution.target.sessionKey === source.senderSessionKey
          && reference.execution.source.senderAgentId === targetAgentId
          && reference.execution.source.senderSessionKey === target.sessionKey;
        if (!reference || (!sameDirection && !reverseDirection)) throw new TaskNotFoundError('Referenced task is not available in this recipient session');
        if (message.contextId && message.contextId !== reference.task.contextId) throw new RequestMalformedError('Referenced task belongs to another context');
        contextId = reference.task.contextId;
      }
      const context = [...records.values()].find(record => record.owner === owner(grant) && record.task.contextId === contextId);
      if (context && (context.execution.target.agentId !== targetAgentId || context.execution.target.sessionKey !== target.sessionKey)) {
        throw new RequestMalformedError('Context belongs to another recipient session; start a new context');
      }
      if (context && context.execution.source.senderSessionKey !== source.senderSessionKey) {
        throw new RequestMalformedError('Context belongs to another sender session; start a new context');
      }
      if ([...records.values()].filter(r => r.delivery === 'queued' || r.delivery === 'working').length >= 32) {
        throw new Error('Communication execution capacity reached; wait for active requests');
      }
      if (records.size >= MAX_RECORDS) throw new Error('Communication journal capacity reached');
      const task = Task.fromJSON({ id, contextId, status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() }, history: [Message.toJSON({ ...message, contextId })] });
      const record: RecordEntry = { version: 1, owner: owner(grant), messageId: message.messageId,
        hash, delivery: 'queued', execution: { requestId: key, target, source, text, taskId: id, contextId, ...(replyToTaskId ? { replyToTaskId } : {}) }, task };
      records.set(id, record);
      return { record, created: true };
    });
    if (admission.created) {
      const run = this.execute(admission.record);
      this.running.set(id, run);
      void run.finally(() => this.running.delete(id)).catch(() => {});
    }
    return structuredClone(admission.record.task);
  }

  private async execute(record: RecordEntry): Promise<void> {
    try {
      await this.transaction(records => {
        const current = records.get(record.task.id)!;
        current.delivery = 'working'; current.task.status = taskStatus(TaskState.TASK_STATE_WORKING);
      });
      const result = await this.ports.execute(structuredClone(record.execution));
      if (typeof result.text !== 'string' || Buffer.byteLength(result.text) > MAX_TEXT_BYTES) throw new Error('Execution result exceeds the supported text limit');
      await this.transaction(records => {
        const current = records.get(record.task.id)!;
        this.applyResult(current, result);
      });
    } catch {
      const result = await this.ports.reconcile?.(structuredClone(record.execution)).catch(() => null);
      if (result && Buffer.byteLength(result.text) <= MAX_TEXT_BYTES) {
        await this.transaction(records => this.applyResult(records.get(record.task.id)!, result));
        return;
      }
      // A dispatch exception alone does not prove whether the provider acted.
      await this.transaction(records => {
        const current = records.get(record.task.id)!;
        if (['completed', 'failed', 'canceled'].includes(current.delivery)) return;
        current.delivery = 'unknown'; current.task.status = taskStatus(TaskState.TASK_STATE_INPUT_REQUIRED,
          'Execution outcome could not be confirmed. Inspect the recipient before retrying with a new request.');
      });
    }
  }

  async get(grant: CommunicationGrant, targetAgentId: string, taskId: string): Promise<Task> {
    if (grant.expiresAt <= Date.now()) throw new TaskNotFoundError();
    await this.tail; await this.load();
    const record = this.records!.get(taskId);
    if (!record || record.owner !== owner(grant) || record.execution.target.agentId !== targetAgentId
      || (grant.principal.kind === 'external' && !grant.targets.includes(targetAgentId))) throw new TaskNotFoundError();
    if (record.delivery === 'unknown' && this.ports.reconcile) {
      const result = await this.ports.reconcile(structuredClone(record.execution));
      if (result && typeof result.text === 'string' && Buffer.byteLength(result.text) <= MAX_TEXT_BYTES) {
        return this.transaction(records => {
          const current = records.get(taskId)!;
          if (current.delivery === 'unknown') {
            this.applyResult(current, result);
          }
          return structuredClone(current.task);
        });
      }
    }
    return structuredClone(record.task);
  }

  private applyResult(record: RecordEntry, result: CommunicationResult): void {
    if (['completed', 'failed', 'canceled'].includes(record.delivery)) return;
    record.delivery = result.outcome || 'completed';
    record.task.status = taskStatus(result.outcome === 'failed' ? TaskState.TASK_STATE_FAILED
      : result.outcome === 'canceled' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_COMPLETED,
    result.outcome === 'failed' ? result.text : undefined);
    record.task.artifacts = result.outcome === 'failed' || result.outcome === 'canceled' ? [] : [{ artifactId: randomUUID(), name: 'result', description: '', extensions: [], metadata: undefined,
      parts: Message.fromJSON({ parts: [{ text: result.text }] }).parts }];
  }

  async cancel(grant: CommunicationGrant, targetAgentId: string, taskId: string): Promise<Task> {
    const task = await this.get(grant, targetAgentId, taskId);
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) return task;
    const record = this.records!.get(taskId)!;
    if (!this.ports.cancel || !['working', 'queued'].includes(record.delivery)) throw new TaskNotCancelableError('Only an identifiable active request can be canceled');
    try { await this.ports.cancel(structuredClone(record.execution)); }
    catch (error) { throw new TaskNotCancelableError(error instanceof Error ? error.message : 'Cancellation was not confirmed; read the original Task'); }
    // Cancellation acknowledgement is not proof of settlement. Read the original receipt.
    const deadline = Date.now() + 15000;
    for (;;) {
      const result = await this.ports.reconcile?.(structuredClone(record.execution));
      if (result) await this.transaction(records => {
        const current = records.get(taskId)!;
        if (['working', 'queued', 'unknown'].includes(current.delivery)) this.applyResult(current, result);
      });
      const current = await this.get(grant, targetAgentId, taskId);
      if (current.status?.state === TaskState.TASK_STATE_CANCELED) return current;
      if (!isCommunicationTaskActive(current) || Date.now() >= deadline) throw new TaskNotCancelableError('Cancellation was not confirmed; read the original Task');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async list(grant: CommunicationGrant, targetAgentId: string, params: ListTasksRequest): Promise<ListTasksResponse> {
    validateCommunicationHistoryLength(params.historyLength);
    if (params.tenant || (params.pageSize !== undefined && (!Number.isInteger(params.pageSize) || params.pageSize < 1 || params.pageSize > 100))
      || (params.statusTimestampAfter !== undefined && !Number.isFinite(Date.parse(params.statusTimestampAfter)))) throw new RequestMalformedError('Invalid task list filter');
    if (grant.expiresAt <= Date.now() || (grant.principal.kind === 'external' && !grant.targets.includes(targetAgentId))) throw new TaskNotFoundError();
    await this.tail; await this.load();
    const tasks = [...this.records!.values()].reverse().filter(r => r.owner === owner(grant) && r.execution.target.agentId === targetAgentId
      && (!params.contextId || r.task.contextId === params.contextId)
      && (!params.status || r.task.status?.state === params.status)
      && (!params.statusTimestampAfter || Date.parse(r.task.status?.timestamp || '') >= Date.parse(params.statusTimestampAfter))).map(r => r.task);
    const signature = composerCommandHash({ owner: owner(grant), targetAgentId, contextId: params.contextId, status: params.status, after: params.statusTimestampAfter || '' }).slice(0, 16);
    let start = 0;
    if (params.pageToken) {
      const [scope, id] = params.pageToken.split(':');
      const index = tasks.findIndex(task => task.id === id);
      if (scope !== signature || index < 0) throw new RequestMalformedError('Task page changed or cursor is invalid; refresh the first page');
      start = index + 1;
    }
    const pageSize = params.pageSize || 50;
    const page = tasks.slice(start, start + pageSize).map(task => {
      const result = communicationTaskView(task, params.historyLength);
      if (!params.includeArtifacts) result.artifacts = [];
      return result;
    });
    return { tasks: page, pageSize, totalSize: tasks.length, nextPageToken: start + pageSize < tasks.length ? `${signature}:${page.at(-1)!.id}` : '' };
  }

  async cancelForOwner(taskId: string): Promise<CommunicationExchange> {
    await this.tail; await this.load();
    const record = this.records!.get(taskId);
    if (!record) throw new TaskNotFoundError();
    const principal: CommunicationGrant['principal'] = record.owner.startsWith('agent:')
      ? { kind: 'agent', agentId: record.owner.slice(6) }
      : { kind: 'external', peerId: record.owner.slice(9), name: record.execution.source.senderName || record.owner };
    await this.cancel({ id: 'owner-inspection', principal, targets: [record.execution.target.agentId], expiresAt: Date.now() + 60000 }, record.execution.target.agentId, taskId);
    return this.exchangeById(taskId);
  }

  /** Owner-only inspection: the HTTP boundary supplies authorization, never peer credentials. */
  async exchanges(agentId: string, before = '', limit = 30): Promise<{ items: CommunicationExchange[]; next: string }> {
    await this.tail; await this.load();
    const records = [...this.records!.values()].reverse().filter(r => r.execution.target.agentId === agentId || r.execution.source.senderAgentId === agentId);
    const index = before ? records.findIndex(r => r.task.id === before) : -1;
    if (before && index < 0) throw new RequestMalformedError('Invalid exchange cursor');
    const page = records.slice(index + 1, index + 1 + limit);
    return { items: page.map(r => this.exchange(r)), next: index + 1 + limit < records.length ? page.at(-1)!.task.id : '' };
  }

  async exchangeById(taskId: string): Promise<CommunicationExchange> {
    await this.tail; await this.load();
    const record = this.records!.get(taskId);
    if (!record) throw new TaskNotFoundError();
    if (record.delivery === 'unknown' && this.ports.reconcile) {
      const result = await this.ports.reconcile(structuredClone(record.execution));
      if (result && Buffer.byteLength(result.text) <= MAX_TEXT_BYTES) await this.transaction(records => {
        const current = records.get(taskId)!;
        if (current.delivery === 'unknown') this.applyResult(current, result);
      });
    }
    return this.exchange(this.records!.get(taskId)!);
  }

  private exchange(record: RecordEntry): CommunicationExchange {
    return { taskId: record.task.id, messageId: record.messageId, contextId: record.task.contextId, state: record.delivery,
      source: structuredClone(record.execution.source), target: structuredClone(record.execution.target), text: record.execution.text,
      result: record.task.artifacts.flatMap(a => a.parts.map(p => p.content?.$case === 'text' ? p.content.value : '')).join('\n'),
      detail: record.task.status?.message?.parts.map(p => p.content?.$case === 'text' ? p.content.value : '').join('\n') || '',
      updatedAt: record.task.status?.timestamp || '', replyToTaskId: record.execution.replyToTaskId };
  }

  /** Used by tests and lifecycle observers; never starts or replays work. */
  async waitForSettledOperations(): Promise<void> { await Promise.allSettled([...this.running.values()]); }
}

export function isCommunicationTaskActive(task: Task): boolean {
  return task.status?.state === TaskState.TASK_STATE_SUBMITTED || task.status?.state === TaskState.TASK_STATE_WORKING;
}

export function validateCommunicationHistoryLength(historyLength?: number): void {
  if (historyLength !== undefined && (!Number.isSafeInteger(historyLength) || historyLength < 0)) throw new RequestMalformedError('historyLength must be a nonnegative integer');
}

export function communicationTaskView(task: Task, historyLength?: number): Task {
  validateCommunicationHistoryLength(historyLength);
  const view = structuredClone(task);
  if (historyLength !== undefined) view.history = historyLength === 0 ? [] : view.history.slice(-historyLength);
  return view;
}
