import type { AgentForkResult } from './agent-manager-provider-types.js';
import type {
  ForkAgentOptions,
  LifecycleJournal,
  LifecycleOperation,
  LifecycleOperationRequest,
} from './agent-manager-lifecycle-types.js';

const crypto = require('crypto');

type ForkMode = 'same-worktree' | 'new-worktree' | 'conversation';

interface ForkOperationSource {
  agentRecordId?: string;
  id: string;
  lifecycleJournal?: LifecycleJournal;
  persistentSessionId?: string;
  runtimeBinding?: { kind?: unknown } | null;
}

interface ForkOperationChild {
  agentRecordId?: string;
  archived?: boolean;
  cwd?: string;
  forkRequestId?: string;
  forkRequestSignature?: string;
  id?: string;
  lifecycleJournal?: LifecycleJournal;
  parentAgentId?: string;
  persistentSessionId?: string;
  projectWorkspace?: string;
  providerSessionId?: string;
  reconciliationState?: 'ready' | 'retained' | 'unknown';
  runtimeOwnerRecordIds?: string[];
  runtimeAgentId?: string;
}

interface ForkExecutionContext {
  onWorktreeCreated(identity: { sourceWorkspace: string; workspace: string }): Promise<void> | void;
}

type ForkOperationAdmission =
  | { accepted: false; error: string }
  | { accepted: true; operation: LifecycleOperation };

interface ForkOperationPorts {
  begin(
    source: ForkOperationSource,
    requestKey: string,
    request: LifecycleOperationRequest,
  ): ForkOperationAdmission;
  complete(
    source: ForkOperationSource,
    operationId: string,
    result: Record<string, unknown>,
  ): void;
  checkpointWorktree(
    source: ForkOperationSource,
    operationId: string,
    identity: { sourceWorkspace: string; workspace: string },
  ): void;
  execute(
    agentId: string,
    mode: ForkMode,
    options: ForkAgentOptions,
    context?: ForkExecutionContext,
  ): Promise<AgentForkResult>;
  getSource(agentId: string): ForkOperationSource | null | undefined;
  listChildren(): ForkOperationChild[];
  rollbackWorktree(identity: {
    sourceWorkspace: string;
    workspace: string;
  }): Promise<{ error?: string; retainedWorkspace?: string; rolledBack: boolean; uncertain?: boolean }>;
  runExclusive(
    agentId: string,
    key: string,
    operation: (lifecycleToken: symbol) => Promise<AgentForkResult>,
  ): Promise<AgentForkResult | { error: string }>;
  stabilizeSourceIdentity(
    agentId: string,
    options: ForkAgentOptions,
  ): Promise<{ error?: string }>;
  transitionBlocked(
    source: ForkOperationSource,
    operationId: string,
    error: string,
    requestPatch?: LifecycleOperationRequest,
  ): void;
  transitionFailed(source: ForkOperationSource, operationId: string, error: string): void;
  waitForRecovery(): Promise<void>;
}

interface ForkOperationRequest {
  agentId: string;
  mode?: ForkMode;
  options?: ForkAgentOptions;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce((result: Record<string, unknown>, key) => {
    const child = record[key];
    if (!['function', 'symbol', 'undefined'].includes(typeof child)) {
      result[key] = stableJsonValue(child);
    }
    return result;
  }, {});
}

function sourceRecordId(source: ForkOperationSource): string {
  const agentRecordId = String(source.agentRecordId || '');
  const persistentSessionId = String(source.persistentSessionId || '');
  if (agentRecordId && persistentSessionId && agentRecordId !== persistentSessionId) return '';
  return agentRecordId || persistentSessionId;
}

function sourceRuntimeKind(source: ForkOperationSource): string {
  return String(source.runtimeBinding?.kind || '');
}

function forkRequestSignature(
  source: ForkOperationSource,
  mode: ForkMode,
  options: ForkAgentOptions,
): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableJsonValue({
      agentRecordId: sourceRecordId(source),
      expectedRevision: Number.isSafeInteger(options.expectedRevision)
        ? options.expectedRevision
        : null,
      mode,
      targetRuntime: options.targetRuntime || '',
    })))
    .digest('hex');
}

function requestIdFromOptions(options: ForkAgentOptions): string {
  return String(options.requestId || '').trim().slice(0, 160);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ForkChildStartOutcome {
  agentId: string | null;
  error: string;
  uncertain: boolean;
}

type ForkChildStartEffect = (
  callback: (agentId: string | null, error?: string | null) => void,
) => Promise<string | null>;

/**
 * Settles the legacy Agent start callback/Promise contract once. Throws and
 * rejections are uncertain because registration may already have happened;
 * resource rollback stays with the Fork execution caller.
 */
function settleForkChildStart(
  start: ForkChildStartEffect,
  failureMessage: string,
): Promise<ForkChildStartOutcome> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (
      agentId: string | null,
      error: string = '',
      uncertain = false,
    ) => {
      if (settled) return;
      settled = true;
      resolve({
        agentId,
        error: error || (agentId ? '' : failureMessage),
        uncertain,
      });
    };
    const uncertainError = (error: unknown) => (
      error instanceof Error && error.message
        ? error.message
        : String(error || failureMessage)
    );

    let started: Promise<string | null>;
    try {
      started = start((agentId, error) => settle(agentId, error || ''));
    } catch (error) {
      settle(null, uncertainError(error), true);
      return;
    }
    void Promise.resolve(started).then(
      agentId => settle(agentId),
      error => settle(null, uncertainError(error), true),
    );
  });
}

function childReconciliationState(
  child: ForkOperationChild,
): 'ready' | 'retained' | 'unknown' {
  if (child.reconciliationState) return child.reconciliationState;
  const recordId = String(child.id || '').trim();
  const currentOwnerIds = child.runtimeOwnerRecordIds;
  if (
    !recordId
    || (currentOwnerIds && (
      currentOwnerIds.length === 0
      || currentOwnerIds.some(ownerId => ownerId !== recordId)
    ))
  ) {
    return 'unknown';
  }
  const createOperation = Array.isArray(child.lifecycleJournal?.entries)
    ? [...child.lifecycleJournal.entries]
        .reverse()
        .find(operation => operation.type === 'create')
    : null;
  if (createOperation?.state === 'succeeded') return 'ready';
  return createOperation ? 'retained' : 'unknown';
}

class ForkOperationCoordinator {
  private readonly ports: ForkOperationPorts;

  constructor(ports: ForkOperationPorts) {
    this.ports = ports;
  }

  private async reconcile(
    source: ForkOperationSource,
    requestId: string,
    signature: string,
    mode: ForkMode,
    options: ForkAgentOptions,
  ): Promise<AgentForkResult | null> {
    const requestKey = `fork-request:${requestId}`;
    const operation = this.findOperation(source, requestKey);
    if (!operation) return null;
    const storedExpectedRevision = Number.isSafeInteger(operation.request?.expectedRevision)
      ? operation.request.expectedRevision
      : null;
    const requestedExpectedRevision = Number.isSafeInteger(options.expectedRevision)
      ? options.expectedRevision
      : null;
    if (
      String(operation.request?.mode || 'same-worktree') !== mode
      || String(operation.request?.targetRuntime || '') !== String(options.targetRuntime || '')
      || storedExpectedRevision !== requestedExpectedRevision
    ) {
      return { error: `Fork request ${requestId} was already used for different parameters` };
    }
    const storedSourceRecordId = String(operation.request?.sourceRecordId || '');
    if (storedSourceRecordId && storedSourceRecordId !== sourceRecordId(source)) {
      return { error: `Fork request ${requestId} was already used for different parameters` };
    }
    if (operation.state === 'succeeded' && operation.result) {
      return { ...operation.result, deduplicated: true };
    }
    if (['succeeded', 'failed', 'cancelled'].includes(operation.state)) {
      return { error: operation.error || `Fork request ${requestId} finished with state ${operation.state}` };
    }
    if (operation.request?.signature && operation.request.signature !== signature) {
      const legacyUnfenced = !Object.prototype.hasOwnProperty.call(operation.request, 'sourceRecordId')
        && !Object.prototype.hasOwnProperty.call(operation.request, 'sourceRuntimeKind');
      if (legacyUnfenced) {
        const detail = `Fork request ${requestId} has an uncertain legacy identity outcome and will not be replayed automatically`;
        if (operation.state !== 'blocked') {
          try {
            this.ports.transitionBlocked(source, operation.id, detail);
          } catch (error) {
            return {
              error: `${detail}; failed to persist blocked state: ${errorMessage(error)}`,
              uncertain: true,
            };
          }
        }
        return { error: detail, uncertain: true };
      }
      return { error: `Fork request ${requestId} was already used for different parameters` };
    }
    if (
      Object.prototype.hasOwnProperty.call(operation.request || {}, 'sourceRuntimeKind')
      && operation.request.sourceRuntimeKind !== sourceRuntimeKind(source)
    ) {
      return { error: `Fork request ${requestId} was already used for different parameters` };
    }

    const children = this.ports.listChildren().filter(child => (
      child.parentAgentId === source.id
      && child.forkRequestId === requestId
      && child.forkRequestSignature === signature
      && child.archived !== true
      && Boolean(String(child.runtimeAgentId || '').trim())
    ));
    if (children.length === 1 && childReconciliationState(children[0]) === 'ready') {
      const child = children[0];
      const request = operation.request || {};
      const targetRuntime = request.targetRuntime === 'chat' || request.targetRuntime === 'terminal'
        ? request.targetRuntime
        : undefined;
      const result: AgentForkResult = {
        agentId: String(child.runtimeAgentId),
        workspace: String(child.projectWorkspace || child.cwd || ''),
        mode: String(request.mode || 'same-worktree'),
        ...(targetRuntime ? { targetRuntime } : {}),
        ...(child.providerSessionId ? { providerSessionId: child.providerSessionId } : {}),
        requestId,
      };
      try {
        this.ports.complete(source, operation.id, result);
        return { ...result, deduplicated: true, reconciled: true };
      } catch (error) {
        return {
          ...result,
          error: `Fork exists, but its result could not be committed: ${errorMessage(error)}`,
          retainedAgentId: result.agentId,
          retryable: true,
        };
      }
    }
    if (children.length === 1 && childReconciliationState(children[0]) === 'retained') {
      const retainedAgentId = String(children[0].runtimeAgentId || '');
      const detail = `Fork request ${requestId} retained Agent ${retainedAgentId} after an uncertain start outcome and will not be replayed automatically`;
      if (operation.state !== 'blocked') {
        try {
          this.ports.transitionBlocked(source, operation.id, detail);
        } catch (error) {
          return {
            error: `${detail}; failed to persist blocked state: ${errorMessage(error)}`,
            retainedAgentId,
            uncertain: true,
          };
        }
      }
      return { error: detail, retainedAgentId, uncertain: true };
    }

    const checkpoint = operation.request?.forkWorktreeIdentity;
    const checkpointIdentity = checkpoint
      && typeof checkpoint === 'object'
      && typeof (checkpoint as Record<string, unknown>).sourceWorkspace === 'string'
      && typeof (checkpoint as Record<string, unknown>).workspace === 'string'
      ? checkpoint as { sourceWorkspace: string; workspace: string }
      : null;
    if (children.length === 0 && checkpointIdentity) {
      let rollback: Awaited<ReturnType<ForkOperationPorts['rollbackWorktree']>>;
      try {
        rollback = await this.ports.rollbackWorktree(checkpointIdentity);
      } catch (error) {
        rollback = {
          rolledBack: false,
          error: errorMessage(error),
          retainedWorkspace: checkpointIdentity.workspace,
          uncertain: true,
        };
      }
      if (rollback.rolledBack) {
        const detail = `Fork request ${requestId} was interrupted before child start; its temporary worktree was rolled back`;
        try {
          this.ports.transitionFailed(source, operation.id, detail);
        } catch (error) {
          return { error: `${detail}; failed to persist rollback outcome: ${errorMessage(error)}` };
        }
        return { error: detail };
      }
      const retainedWorkspace = rollback.retainedWorkspace || checkpointIdentity.workspace;
      const detail = `Fork request ${requestId} has an uncertain worktree outcome and retained ${retainedWorkspace}; it will not be replayed automatically: ${rollback.error || 'rollback could not be proven'}`;
      if (operation.state !== 'blocked') {
        try {
          this.ports.transitionBlocked(source, operation.id, detail);
        } catch (error) {
          return { error: `${detail}; failed to persist blocked state: ${errorMessage(error)}`, uncertain: true };
        }
      }
      return {
        error: detail,
        retainedWorkspace,
        workspace: checkpointIdentity.workspace,
        uncertain: true,
      };
    }

    const detail = children.length > 1
      ? `Fork request ${requestId} has multiple child Agent records and cannot be reconciled safely`
      : children.length === 1
        ? `Fork request ${requestId} has a child Agent whose live readiness cannot be proven and will not be replayed automatically`
      : `Fork request ${requestId} has an uncertain outcome and will not be replayed automatically`;
    if (operation.state !== 'blocked') {
      try {
        this.ports.transitionBlocked(source, operation.id, detail);
      } catch (error) {
        return { error: `${detail}; failed to persist blocked state: ${errorMessage(error)}`, uncertain: true };
      }
    }
    return { error: detail, uncertain: true };
  }

  private findOperation(source: ForkOperationSource, requestKey: string): LifecycleOperation | null {
    const entries = Array.isArray(source.lifecycleJournal?.entries)
      ? source.lifecycleJournal.entries
      : [];
    return entries.find(candidate => candidate.type === 'fork' && candidate.requestKey === requestKey) || null;
  }

  async request({
    agentId,
    mode = 'same-worktree',
    options = {},
  }: ForkOperationRequest): Promise<AgentForkResult> {
    const requestId = requestIdFromOptions(options);
    if (!requestId) return this.ports.execute(agentId, mode, options);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
      return { error: 'Fork requires a valid requestId' };
    }

    await this.ports.waitForRecovery();
    const stabilization = await this.ports.stabilizeSourceIdentity(agentId, options);
    if (stabilization.error) return { error: stabilization.error };
    const initialSource = this.ports.getSource(agentId);
    if (!initialSource) return { error: 'Agent not found' };
    const initialRecordId = sourceRecordId(initialSource);
    if (!initialRecordId) {
      return { error: `Fork source Agent ${agentId} does not have a persistent identity` };
    }
    const initialRuntimeKind = sourceRuntimeKind(initialSource);
    const signature = forkRequestSignature(initialSource, mode, options);
    const key = `fork:${requestId}:${signature}`;
    const existing = this.findOperation(initialSource, `fork-request:${requestId}`);
    if (existing && ['succeeded', 'failed', 'cancelled'].includes(existing.state)) {
      const terminalReplay = await this.reconcile(initialSource, requestId, signature, mode, options);
      if (terminalReplay) return terminalReplay;
    }

    return this.ports.runExclusive(agentId, key, async lifecycleToken => {
      const source = this.ports.getSource(agentId);
      if (!source) return { error: 'Agent not found' };
      if (
        sourceRecordId(source) !== initialRecordId
        || sourceRuntimeKind(source) !== initialRuntimeKind
      ) {
        return {
          error: `Fork source Agent ${agentId} changed identity before the request was admitted`,
          uncertain: true,
        };
      }

      // This check intentionally happens after lifecycle admission. Concurrent
      // callers with the same key join, while a different signature waits and
      // then observes the already-persisted request instead of starting again.
      const replay = await this.reconcile(source, requestId, signature, mode, options);
      if (replay) return replay;

      const admission = this.ports.begin(source, `fork-request:${requestId}`, {
        signature,
        mode,
        sourceRecordId: initialRecordId,
        sourceRuntimeKind: initialRuntimeKind,
        targetRuntime: options.targetRuntime || '',
        expectedRevision: Number.isSafeInteger(options.expectedRevision)
          ? options.expectedRevision
          : null,
      });
      if (admission.accepted === false) return { error: admission.error };

      let createdWorktreeIdentity: { sourceWorkspace: string; workspace: string } | null = null;
      let result: AgentForkResult;
      try {
        result = await this.ports.execute(agentId, mode, {
          ...options,
          requestId: '',
          forkRequestId: requestId,
          forkRequestSignature: signature,
          lifecycleToken,
        }, {
          onWorktreeCreated: identity => {
            createdWorktreeIdentity = identity;
            this.ports.checkpointWorktree(source, admission.operation.id, identity);
          },
        });
      } catch (error) {
        const retained = (
          createdWorktreeIdentity as { sourceWorkspace: string; workspace: string } | null
        )?.workspace;
        result = {
          error: retained
            ? `Fork execution failed unexpectedly; temporary worktree retained at ${retained}: ${errorMessage(error)}`
            : `Fork execution failed unexpectedly with an uncertain outcome: ${errorMessage(error)}`,
          ...(retained
            ? { retainedWorkspace: retained, workspace: retained }
            : {}),
          uncertain: true,
        };
      }
      if (result.error) {
        const uncertain = result.uncertain === true
          || Boolean(result.retainedAgentId)
          || Boolean(result.retainedProviderSessionId)
          || Boolean(result.retainedWorkspace);
        try {
          if (uncertain) {
            this.ports.transitionBlocked(
              source,
              admission.operation.id,
              result.error,
              createdWorktreeIdentity
                ? { forkWorktreeIdentity: createdWorktreeIdentity }
                : undefined,
            );
          } else {
            this.ports.transitionFailed(source, admission.operation.id, result.error);
          }
        } catch (error) {
          return {
            ...result,
            error: `${result.error}; failed to persist Fork outcome: ${errorMessage(error)}`,
          };
        }
        return { ...result, requestId, ...(uncertain ? { uncertain: true } : {}) };
      }

      const committedResult: AgentForkResult = { ...result, requestId };
      try {
        this.ports.complete(source, admission.operation.id, committedResult);
        return committedResult;
      } catch (error) {
        return {
          ...committedResult,
          error: `Fork was created, but its result could not be committed: ${errorMessage(error)}`,
          retainedAgentId: result.agentId,
          retryable: true,
        };
      }
    }) as Promise<AgentForkResult>;
  }
}

export {
  ForkOperationCoordinator,
  forkRequestSignature,
  settleForkChildStart,
  type ForkOperationChild,
  type ForkOperationPorts,
  type ForkOperationRequest,
  type ForkOperationSource,
  childReconciliationState,
};
