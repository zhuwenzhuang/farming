type RealtimeStartResult = Record<string, unknown>;

interface RealtimeOperation {
  agentId: string;
  ownerId: string;
  operationId: string;
  cancelled: boolean;
  startAttempt: Promise<RealtimeStartResult>;
  result: Promise<RealtimeStartResult>;
  stop: () => Promise<unknown>;
  stopPromise: Promise<void> | null;
  startOutcome: 'pending' | 'accepted' | 'rejected' | 'uncertain';
  reconcileOutcome: 'not-requested' | 'pending' | 'closed' | 'failed';
}

function cancelledResult(operationId: string): RealtimeStartResult {
  return { started: false, cancelled: true, operationId };
}

function rejectedStart(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'realtimeStartOutcome' in error
    && error.realtimeStartOutcome === 'rejected'
  );
}

export class AcpRealtimeOperationCoordinator {
  private readonly current = new Map<string, RealtimeOperation>();
  private readonly cancelled = new Map<string, Set<string>>();

  private ownerKey(agentId: string, ownerId: string) {
    return `${agentId}\u0000${ownerId}`;
  }

  private rememberCancelled(agentId: string, ownerId: string, operationId: string) {
    const key = this.ownerKey(agentId, ownerId);
    const operationIds = this.cancelled.get(key) || new Set<string>();
    operationIds.delete(operationId);
    operationIds.add(operationId);
    this.cancelled.set(key, operationIds);
  }

  private wasCancelled(agentId: string, ownerId: string, operationId: string) {
    return this.cancelled.get(this.ownerKey(agentId, ownerId))?.has(operationId) === true;
  }

  private ensureStopped(operation: RealtimeOperation) {
    if (!operation.stopPromise) {
      operation.stopPromise = (async () => {
        operation.reconcileOutcome = 'pending';
        await operation.startAttempt.catch(() => undefined);
        if (operation.startOutcome === 'rejected') {
          operation.reconcileOutcome = 'closed';
          return;
        }
        try {
          await operation.stop();
          operation.reconcileOutcome = 'closed';
        } catch (error) {
          operation.reconcileOutcome = 'failed';
          const failure = error instanceof Error ? error : new Error(String(error));
          throw Object.assign(failure, {
            realtimeStartOutcome: 'uncertain' as const,
            realtimeFenceFailed: true,
          });
        }
      })();
    }
    return operation.stopPromise;
  }

  private async cancel(operation: RealtimeOperation) {
    operation.cancelled = true;
    this.rememberCancelled(operation.agentId, operation.ownerId, operation.operationId);
    await this.ensureStopped(operation);
    if (this.current.get(operation.agentId) === operation) {
      this.current.delete(operation.agentId);
    }
  }

  async start(
    agentId: string,
    ownerId: string,
    operationId: string,
    start: () => Promise<RealtimeStartResult>,
    stop: () => Promise<unknown>,
  ): Promise<RealtimeStartResult> {
    if (this.wasCancelled(agentId, ownerId, operationId)) return cancelledResult(operationId);

    let existing = this.current.get(agentId);
    if (existing && existing.ownerId !== ownerId) {
      this.current.delete(agentId);
      existing = undefined;
    }
    if (existing?.operationId === operationId) return existing.result;
    if (existing) await this.cancel(existing);
    if (this.wasCancelled(agentId, ownerId, operationId)) return cancelledResult(operationId);

    const operation: RealtimeOperation = {
      agentId,
      ownerId,
      operationId,
      cancelled: false,
      startAttempt: Promise.resolve({}),
      result: Promise.resolve({}),
      stop,
      stopPromise: null,
      startOutcome: 'pending',
      reconcileOutcome: 'not-requested',
    };

    operation.startAttempt = Promise.resolve().then(start).then(
      result => {
        operation.startOutcome = 'accepted';
        return result;
      },
      error => {
        operation.startOutcome = rejectedStart(error) ? 'rejected' : 'uncertain';
        throw error;
      },
    );

    operation.result = (async () => {
      try {
        const result = await operation.startAttempt;
        if (operation.cancelled || this.current.get(agentId) !== operation) {
          await this.ensureStopped(operation);
          return cancelledResult(operationId);
        }
        return { ...result, operationId };
      } catch (error) {
        await this.ensureStopped(operation);
        if (operation.cancelled) return cancelledResult(operationId);
        throw error;
      } finally {
        if (
          this.current.get(agentId) === operation
          && operation.reconcileOutcome === 'closed'
        ) {
          this.current.delete(agentId);
        }
      }
    })();

    this.current.set(agentId, operation);
    return operation.result;
  }

  async stop(agentId: string, ownerId: string, operationId: string) {
    this.rememberCancelled(agentId, ownerId, operationId);
    const operation = this.current.get(agentId);
    if (operation && operation.ownerId !== ownerId) {
      this.current.delete(agentId);
      return { stopped: false, reconciled: true, staleOwner: true, operationId };
    }
    if (!operation || operation.operationId !== operationId) {
      return { stopped: false, reconciled: true, operationId };
    }
    await this.cancel(operation);
    return { stopped: true, reconciled: true, operationId };
  }

  resetAgent(agentId: string) {
    this.current.delete(agentId);
    for (const key of this.cancelled.keys()) {
      if (key.startsWith(`${agentId}\u0000`)) this.cancelled.delete(key);
    }
  }
}
