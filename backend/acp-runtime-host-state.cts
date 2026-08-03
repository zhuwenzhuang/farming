const crypto = require('crypto') as typeof import('crypto');
const { EventEmitter } = require('events') as typeof import('events');

interface ControllerIdentity {
  id: string;
  generation: number;
}

interface BindingSnapshot extends Record<string, unknown> {
  agentId: string;
  bindingEpoch: string;
  sessionId?: string;
  state: string;
}

interface HostEvent {
  seq: number;
  type: string;
  payload: unknown;
}

interface PromptOperation extends Record<string, unknown> {
  agentId: string;
  bindingEpoch: string;
  clientPromptId: string;
  contentHash: string;
  kind: 'pending' | 'turn' | 'steer';
  error: string;
  errorEvidence: Record<string, unknown>;
  result: unknown;
  previousState: string;
  status: 'admitting' | 'provider-owned' | 'settled' | 'failed';
  turnHandle: string;
  turnSequence: number;
  updatedAt: number;
}

interface CancelOperation extends Record<string, unknown> {
  agentId: string;
  bindingEpoch: string;
  operationId: string;
  result: unknown;
  error: string;
  errorEvidence: Record<string, unknown>;
  status: 'admitted' | 'settled' | 'failed';
  turnHandle: string;
  updatedAt: number;
}

interface PromptRequest {
  agentId: string;
  bindingEpoch: string;
  clientPromptId: string;
  contentHash: string;
  delivery?: string;
  retryDefinitiveFailure?: boolean;
}

interface CancelRequest {
  agentId: string;
  bindingEpoch: string;
  operationId: string;
  turnHandle: string;
}

interface RuntimeHostStateOptions {
  hostEpoch?: string;
  maxEvents?: number;
  maxEventBytes?: number;
  maxSettledOperationsPerAgent?: number;
  maxSettledOperations?: number;
}

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function controllerIdentity(value: Partial<ControllerIdentity> = {}): ControllerIdentity {
  return {
    id: String(value.id || ''),
    generation: Math.floor(Number(value.generation)),
  };
}

function operationKey(agentId: string, operationId: string): string {
  return `${agentId}\0${operationId}`;
}

function errorEvidence(error: unknown, operationId: string): Record<string, unknown> {
  const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(detail.code ? { code: String(detail.code) } : {}),
    ...(detail.uncertain === true ? { uncertain: true } : {}),
    ...(detail.retryable === true ? { retryable: true } : {}),
    operationId,
  };
}

function restoredError(evidence: Record<string, unknown>, fallback: string): Error & Record<string, unknown> {
  const error = new Error(String(evidence.message || fallback)) as Error & Record<string, unknown>;
  for (const key of ['code', 'uncertain', 'retryable', 'operationId']) {
    if (evidence[key] !== undefined) error[key] = evidence[key];
  }
  return error;
}

class AcpRuntimeHostState extends EventEmitter {
  readonly hostEpoch: string;
  readonly maxEvents: number;
  readonly maxEventBytes: number;
  readonly maxSettledOperationsPerAgent: number;
  readonly maxSettledOperations: number;
  eventSeq: number;
  activeController: ControllerIdentity | null;
  highestControllerGeneration: number;
  bindings: Map<string, BindingSnapshot>;
  events: HostEvent[];
  eventBytes: number;
  promptOperations: Map<string, PromptOperation>;
  promptPromises: Map<string, Promise<unknown>>;
  cancelOperations: Map<string, CancelOperation>;
  cancelPromises: Map<string, Promise<unknown>>;
  configOverrides: Map<string, unknown>;
  turnSequences: Map<string, number>;

  constructor(options: RuntimeHostStateOptions = {}) {
    super();
    this.hostEpoch = String(options.hostEpoch || crypto.randomUUID());
    this.maxEvents = Number.isFinite(Number(options.maxEvents))
      ? Math.max(1, Math.floor(Number(options.maxEvents)))
      : 1024;
    this.maxEventBytes = Number.isFinite(Number(options.maxEventBytes))
      ? Math.max(64 * 1024, Math.floor(Number(options.maxEventBytes)))
      : 2 * 1024 * 1024;
    this.maxSettledOperationsPerAgent = Number.isFinite(Number(options.maxSettledOperationsPerAgent))
      ? Math.max(8, Math.floor(Number(options.maxSettledOperationsPerAgent)))
      : 32;
    this.maxSettledOperations = Number.isFinite(Number(options.maxSettledOperations))
      ? Math.max(32, Math.floor(Number(options.maxSettledOperations)))
      : 1024;
    this.eventSeq = 0;
    this.activeController = null;
    this.highestControllerGeneration = 0;
    this.bindings = new Map();
    this.events = [];
    this.eventBytes = 0;
    this.promptOperations = new Map();
    this.promptPromises = new Map();
    this.cancelOperations = new Map();
    this.cancelPromises = new Map();
    this.configOverrides = new Map();
    this.turnSequences = new Map();
  }

  async registerController(value: ControllerIdentity): Promise<ControllerIdentity> {
    const next = controllerIdentity(value);
    if (!next.id || !Number.isSafeInteger(next.generation) || next.generation <= 0) {
      throw new Error('Invalid ACP runtime host controller identity');
    }
    const current = this.activeController;
    if (
      next.generation < this.highestControllerGeneration
      || (
        next.generation === this.highestControllerGeneration
        && (!current || current.id !== next.id)
      )
    ) {
      throw new Error('Stale ACP runtime host controller');
    }
    this.highestControllerGeneration = Math.max(this.highestControllerGeneration, next.generation);
    this.activeController = next;
    return { ...next };
  }

  disconnectController(value: ControllerIdentity): boolean {
    const current = this.activeController;
    const requested = controllerIdentity(value);
    if (
      !current
      || current.id !== requested.id
      || current.generation !== requested.generation
    ) return false;
    this.activeController = null;
    return true;
  }

  assertController(value: ControllerIdentity): void {
    const current = this.activeController;
    const requested = controllerIdentity(value);
    if (
      !current
      || current.id !== requested.id
      || current.generation !== requested.generation
    ) {
      throw new Error('Stale ACP runtime host controller');
    }
  }

  publish(type: string, payload: unknown): HostEvent {
    const event = { seq: ++this.eventSeq, type, payload: clone(payload) };
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    if (eventBytes > this.maxEventBytes) {
      this.events = [];
      this.eventBytes = 0;
    } else {
      this.events.push(event);
      this.eventBytes += eventBytes;
      while (this.events.length > this.maxEvents || this.eventBytes > this.maxEventBytes) {
        const removed = this.events.shift();
        if (removed) this.eventBytes -= Buffer.byteLength(JSON.stringify(removed));
      }
    }
    this.emit('event', clone(event));
    return event;
  }

  upsertBinding(value: BindingSnapshot): BindingSnapshot {
    const incoming = clone(value);
    if (!incoming.agentId || !incoming.bindingEpoch) {
      throw new Error('ACP runtime host binding requires an Agent and binding epoch');
    }
    const current = this.bindings.get(incoming.agentId);
    const binding = current && current.bindingEpoch === incoming.bindingEpoch
      ? Object.assign(current, incoming)
      : incoming;
    this.bindings.set(binding.agentId, binding);
    this.publish('binding', binding);
    return clone(binding);
  }

  patchBinding(agentId: string, patch: Record<string, unknown>): BindingSnapshot | null {
    const binding = this.bindings.get(String(agentId || ''));
    if (!binding) return null;
    Object.assign(binding, clone(patch));
    this.publish('binding-patch', { agentId: binding.agentId, bindingEpoch: binding.bindingEpoch, ...patch });
    return clone(binding);
  }

  binding(agentId: string): BindingSnapshot | null {
    const binding = this.bindings.get(String(agentId || ''));
    return binding ? clone(binding) : null;
  }

  removeBinding(agentId: string, expectedBindingEpoch: string): boolean {
    const id = String(agentId || '');
    const epoch = String(expectedBindingEpoch || '');
    const binding = this.bindings.get(id);
    if (!binding || binding.bindingEpoch !== epoch) return false;
    const hasPendingPrompt = [...this.promptOperations.values()].some(operation => (
      operation.agentId === id
      && operation.bindingEpoch === epoch
      && ['admitting', 'provider-owned'].includes(operation.status)
    ));
    const hasPendingCancel = [...this.cancelOperations.values()].some(operation => (
      operation.agentId === id
      && operation.bindingEpoch === epoch
      && operation.status === 'admitted'
    ));
    if (hasPendingPrompt || hasPendingCancel) {
      throw new Error('ACP runtime host binding still owns active operations');
    }
    this.bindings.delete(id);
    for (const [key, operation] of this.promptOperations) {
      if (operation.agentId === id && operation.bindingEpoch === epoch) this.promptOperations.delete(key);
    }
    for (const [key, operation] of this.cancelOperations) {
      if (operation.agentId === id && operation.bindingEpoch === epoch) this.cancelOperations.delete(key);
    }
    this.turnSequences.delete(id);
    this.configOverrides.delete(id);
    this.publish('binding-removed', { agentId: id, bindingEpoch: epoch });
    return true;
  }

  upsertConfigOverrides(value: unknown): HostEvent {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const agentId = String(record.agentId || '');
    if (!agentId) throw new Error('ACP runtime host config overrides require an Agent');
    this.configOverrides.set(agentId, clone(value));
    return this.publish('config-overrides', value);
  }

  requireBinding(agentId: string, bindingEpoch: string): BindingSnapshot {
    const binding = this.bindings.get(String(agentId || ''));
    if (!binding) throw new Error('ACP runtime host binding was not found');
    if (binding.bindingEpoch !== String(bindingEpoch || '')) {
      throw new Error(
        `ACP runtime host binding epoch changed (expected ${binding.bindingEpoch}, received ${String(bindingEpoch || '<empty>')})`,
      );
    }
    return binding;
  }

  promptOperation(agentId: string, clientPromptId: string): PromptOperation | null {
    const operation = this.promptOperations.get(operationKey(agentId, clientPromptId));
    return operation ? clone(operation) : null;
  }

  activePromptOperation(agentId: string, bindingEpoch: string): PromptOperation | null {
    const operation = [...this.promptOperations.values()].find(candidate => (
      candidate.agentId === agentId
      && candidate.bindingEpoch === bindingEpoch
      && ['admitting', 'provider-owned'].includes(candidate.status)
      && candidate.kind === 'turn'
    ));
    return operation ? clone(operation) : null;
  }

  nextTurnHandle(binding: BindingSnapshot): string {
    const next = (this.turnSequences.get(binding.agentId) || 0) + 1;
    this.turnSequences.set(binding.agentId, next);
    return `${binding.bindingEpoch}:${next}`;
  }

  pruneSettledOperations(agentId: string): void {
    const prune = <Operation extends { agentId: string; status: string }>(
      operations: Map<string, Operation>,
      promises: Map<string, Promise<unknown>>,
      kind: 'prompt' | 'cancel',
    ) => {
      const settled = [...operations.entries()].filter(([, operation]) => (
        operation.agentId === agentId && ['settled', 'failed'].includes(operation.status)
      ));
      const excess = settled.length - this.maxSettledOperationsPerAgent;
      for (const [key] of settled.slice(0, Math.max(0, excess))) {
        operations.delete(key);
        promises.delete(key);
        this.publish('operation-pruned', { key, kind });
      }
    };
    prune(this.promptOperations, this.promptPromises, 'prompt');
    prune(this.cancelOperations, this.cancelPromises, 'cancel');
    const allSettled = [
      ...[...this.promptOperations.entries()]
        .filter(([, operation]) => ['settled', 'failed'].includes(operation.status))
        .map(([key, operation]) => ({ key, kind: 'prompt', updatedAt: operation.updatedAt })),
      ...[...this.cancelOperations.entries()]
        .filter(([, operation]) => ['settled', 'failed'].includes(operation.status))
        .map(([key, operation]) => ({ key, kind: 'cancel', updatedAt: operation.updatedAt })),
    ].sort((left, right) => left.updatedAt - right.updatedAt);
    for (const item of allSettled.slice(0, Math.max(0, allSettled.length - this.maxSettledOperations))) {
      if (item.kind === 'prompt') {
        this.promptOperations.delete(item.key);
        this.promptPromises.delete(item.key);
      } else {
        this.cancelOperations.delete(item.key);
        this.cancelPromises.delete(item.key);
      }
      this.publish('operation-pruned', { key: item.key, kind: item.kind });
    }
  }

  async submitPrompt(
    controller: ControllerIdentity,
    request: PromptRequest,
    execute: (
      onTurnAdmitted: (admission?: { previousState?: string }) => void,
      onSubmitted: (submission?: { steered?: boolean }) => void,
    ) => unknown | Promise<unknown>,
  ): Promise<unknown> {
    this.assertController(controller);
    const key = operationKey(request.agentId, request.clientPromptId);
    const existing = this.promptOperations.get(key);
    if (existing) {
      if (existing.contentHash !== request.contentHash) {
        return Promise.reject(new Error(`ACP prompt ${request.clientPromptId} was already used for different content`));
      }
      if (
        existing.status === 'failed'
        && request.retryDefinitiveFailure === true
        && existing.errorEvidence.uncertain !== true
      ) {
        this.promptOperations.delete(key);
        this.promptPromises.delete(key);
      } else {
        if (existing.bindingEpoch !== request.bindingEpoch) {
          return Promise.reject(new Error('ACP runtime host binding epoch changed'));
        }
        const pending = this.promptPromises.get(key);
        return pending || (existing.status === 'failed'
          ? Promise.reject(restoredError(existing.errorEvidence, existing.error || 'ACP prompt failed'))
          : Promise.resolve(clone(existing.result)));
      }
    }

    const binding = this.requireBinding(request.agentId, request.bindingEpoch);
    if (!request.clientPromptId || !request.contentHash) {
      return Promise.reject(new Error('ACP runtime host prompt identity is required'));
    }

    const operation: PromptOperation = {
      agentId: binding.agentId,
      bindingEpoch: binding.bindingEpoch,
      clientPromptId: request.clientPromptId,
      contentHash: request.contentHash,
      kind: 'pending',
      status: 'admitting',
      turnHandle: '',
      turnSequence: 0,
      previousState: '',
      result: null,
      error: '',
      errorEvidence: {},
      updatedAt: Date.now(),
    };
    this.promptOperations.set(key, operation);
    this.publish('prompt-operation', operation);

    let execution: Promise<unknown>;
    try {
      const onTurnAdmitted = (admission?: { previousState?: string }) => {
        if (operation.status !== 'admitting' || operation.kind !== 'pending') return;
        operation.kind = 'turn';
        operation.turnHandle = this.nextTurnHandle(binding);
        operation.turnSequence = this.turnSequences.get(binding.agentId) || 0;
        operation.previousState = String(admission?.previousState || binding.state || 'idle');
        binding.state = 'working';
        binding.turnHandle = operation.turnHandle;
        operation.updatedAt = Date.now();
        this.publish('prompt-operation', operation);
        this.publish('binding', binding);
      };
      execution = Promise.resolve(execute(onTurnAdmitted, submission => {
        if (operation.status !== 'admitting') return;
        if (submission?.steered === true) {
          operation.kind = 'steer';
          operation.turnHandle = String(binding.turnHandle || '');
        } else {
          onTurnAdmitted();
        }
        operation.status = 'provider-owned';
        operation.updatedAt = Date.now();
        this.publish('prompt-operation', operation);
      }));
    } catch (error) {
      const providerOwned = operation.status === 'provider-owned';
      operation.status = 'failed';
      operation.updatedAt = Date.now();
      operation.error = error instanceof Error ? error.message : String(error);
      operation.errorEvidence = errorEvidence(error, request.clientPromptId);
      this.publish('prompt-operation', operation);
      if (operation.kind === 'turn') {
        if (providerOwned) {
          if (operation.turnSequence > Number(binding.lastSettledTurnSequence || 0)) {
            binding.stopReason = 'error';
            binding.lastSettledTurnHandle = operation.turnHandle;
            binding.lastSettledTurnSequence = operation.turnSequence;
            binding.lastSettledTurnSummary = '';
          }
          if (binding.turnHandle === operation.turnHandle) {
            binding.state = 'error';
            delete binding.turnHandle;
          }
        } else if (binding.turnHandle === operation.turnHandle) {
          binding.state = operation.previousState || 'idle';
          delete binding.turnHandle;
        }
        this.publish('binding', binding);
      }
      return Promise.reject(error);
    }

    const completion = execution.then(result => {
      const envelope = result && typeof result === 'object' && (result as Record<string, unknown>).__farmingHostPromptResult === true
        ? result as Record<string, unknown>
        : null;
      const settledResult = envelope ? envelope.result : result;
      operation.status = 'settled';
      operation.updatedAt = Date.now();
      operation.result = clone(settledResult);
      this.publish('prompt-operation', operation);
      if (
        operation.kind === 'turn'
        && this.bindings.get(binding.agentId) === binding
        && binding.bindingEpoch === operation.bindingEpoch
      ) {
        if (operation.turnSequence > Number(binding.lastSettledTurnSequence || 0)) {
          binding.stopReason = String(
            envelope?.stopReason
            || (settledResult && typeof settledResult === 'object'
              ? (settledResult as Record<string, unknown>).stopReason
              : '')
            || '',
          );
          binding.lastSettledTurnHandle = operation.turnHandle;
          binding.lastSettledTurnSequence = operation.turnSequence;
          binding.lastSettledTurnSummary = String(envelope?.turnSummary || '');
        }
        if (binding.turnHandle === operation.turnHandle) {
          binding.state = 'idle';
          delete binding.turnHandle;
        }
        this.publish('binding', binding);
      }
      this.pruneSettledOperations(binding.agentId);
      return settledResult;
    }, error => {
      const providerOwned = operation.status === 'provider-owned';
      operation.status = 'failed';
      operation.updatedAt = Date.now();
      operation.error = error instanceof Error ? error.message : String(error);
      operation.errorEvidence = errorEvidence(error, request.clientPromptId);
      this.publish('prompt-operation', operation);
      if (
        operation.kind === 'turn'
        && this.bindings.get(binding.agentId) === binding
        && binding.bindingEpoch === operation.bindingEpoch
      ) {
        if (providerOwned) {
          if (operation.turnSequence > Number(binding.lastSettledTurnSequence || 0)) {
            binding.stopReason = 'error';
            binding.lastSettledTurnHandle = operation.turnHandle;
            binding.lastSettledTurnSequence = operation.turnSequence;
            binding.lastSettledTurnSummary = '';
          }
          if (binding.turnHandle === operation.turnHandle) {
            binding.state = 'error';
            delete binding.turnHandle;
          }
        } else if (binding.turnHandle === operation.turnHandle) {
          binding.state = operation.previousState || 'idle';
          delete binding.turnHandle;
        }
        this.publish('binding', binding);
      }
      this.pruneSettledOperations(binding.agentId);
      throw error;
    }).finally(() => {
      this.promptPromises.delete(key);
    });
    this.promptPromises.set(key, completion);
    return completion;
  }

  async cancelTurn(
    controller: ControllerIdentity,
    request: CancelRequest,
    execute: () => unknown | Promise<unknown>,
  ): Promise<unknown> {
    this.assertController(controller);
    const key = operationKey(request.agentId, request.operationId);
    const existing = this.cancelOperations.get(key);
    if (existing) {
      if (existing.bindingEpoch !== request.bindingEpoch) {
        return Promise.reject(new Error('ACP runtime host binding epoch changed'));
      }
      if (existing.turnHandle !== request.turnHandle) {
        return Promise.reject(new Error(`ACP cancel ${request.operationId} was already used for another turn`));
      }
      const pending = this.cancelPromises.get(key);
      return pending || (existing.status === 'failed'
        ? Promise.reject(restoredError(existing.errorEvidence, existing.error || 'ACP cancellation failed'))
        : Promise.resolve(clone(existing.result)));
    }
    const binding = this.requireBinding(request.agentId, request.bindingEpoch);
    if (binding.turnHandle !== request.turnHandle) {
      return Promise.reject(new Error('ACP runtime host turn changed before cancellation'));
    }
    const operation: CancelOperation = {
      agentId: binding.agentId,
      bindingEpoch: binding.bindingEpoch,
      operationId: request.operationId,
      turnHandle: request.turnHandle,
      status: 'admitted',
      result: null,
      error: '',
      errorEvidence: {},
      updatedAt: Date.now(),
    };
    this.cancelOperations.set(key, operation);
    binding.state = 'interrupting';
    this.publish('cancel-operation', operation);
    this.publish('binding', binding);
    let execution;
    try {
      execution = Promise.resolve(execute());
    } catch (error) {
      operation.status = 'failed';
      operation.error = error instanceof Error ? error.message : String(error);
      operation.errorEvidence = errorEvidence(error, request.operationId);
      this.publish('cancel-operation', operation);
      return Promise.reject(error);
    }
    const completion = execution.then(result => {
      operation.status = 'settled';
      operation.updatedAt = Date.now();
      operation.result = clone(result);
      this.publish('cancel-operation', operation);
      let admittingPrompt: PromptOperation | null = null;
      for (const prompt of this.promptOperations.values()) {
        if (
          prompt.agentId === operation.agentId
          && prompt.bindingEpoch === operation.bindingEpoch
          && prompt.turnHandle === operation.turnHandle
          && prompt.kind === 'turn'
          && prompt.status === 'admitting'
        ) {
          admittingPrompt = prompt;
          break;
        }
      }
      if (
        admittingPrompt
        && this.bindings.get(binding.agentId) === binding
        && binding.bindingEpoch === operation.bindingEpoch
        && binding.turnHandle === operation.turnHandle
      ) {
        binding.state = admittingPrompt.previousState || 'idle';
        delete binding.turnHandle;
        this.publish('binding', binding);
      }
      this.pruneSettledOperations(binding.agentId);
      return result;
    }, error => {
      operation.status = 'failed';
      operation.updatedAt = Date.now();
      operation.error = error instanceof Error ? error.message : String(error);
      operation.errorEvidence = errorEvidence(error, request.operationId);
      this.publish('cancel-operation', operation);
      this.pruneSettledOperations(binding.agentId);
      throw error;
    }).finally(() => {
      this.cancelPromises.delete(key);
    });
    this.cancelPromises.set(key, completion);
    return completion;
  }

  recover(afterEventSeq?: number): Record<string, unknown> {
    const requested = Number(afterEventSeq);
    const firstSeq = this.events[0]?.seq || this.eventSeq + 1;
    if (
      Number.isSafeInteger(requested)
      && requested >= 0
      && requested <= this.eventSeq
      && requested >= firstSeq - 1
    ) {
      return {
        hostEpoch: this.hostEpoch,
        eventSeq: this.eventSeq,
        replace: false,
        events: clone(this.events.filter(event => event.seq > requested)),
      };
    }
    return {
      hostEpoch: this.hostEpoch,
      eventSeq: this.eventSeq,
      replace: true,
      bindings: clone([...this.bindings.values()]),
      promptOperations: clone([...this.promptOperations.values()]),
      cancelOperations: clone([...this.cancelOperations.values()]),
      configOverrides: clone([...this.configOverrides.values()]),
    };
  }
}

export {
  AcpRuntimeHostState,
  type BindingSnapshot,
  type ControllerIdentity,
};
