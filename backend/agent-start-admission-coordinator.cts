'use strict';

import type {
  AgentStartAdmission,
  AgentStartOutcome,
  CreateRequestAdmission,
} from './agent-manager-provider-types.js';

type AgentStartReport = (
  agentId: string | null,
  error?: string | null,
  metadata?: Record<string, unknown>,
) => void;

type AgentStartAdmissionRequest = {
  execute: (token: symbol, report: AgentStartReport) => Promise<string | null>;
  report?: AgentStartReport | null;
  requestId: string;
  signature: string;
  workspaceKey: string;
};

class AgentStartAdmissionCoordinator {
  private readonly starts = new Map<symbol, AgentStartAdmission>();
  private readonly createRequests = new Map<string, CreateRequestAdmission>();

  start(request: AgentStartAdmissionRequest): Promise<string | null> {
    const existing = request.requestId
      ? this.createRequests.get(request.requestId)
      : undefined;
    if (existing) {
      if (existing.signature !== request.signature) {
        const error = `Create request ${request.requestId} is already in progress with different Agent parameters`;
        request.report?.(null, error);
        return Promise.resolve(null);
      }
      return existing.promise.then(outcome => {
        request.report?.(
          outcome.agentId,
          outcome.error,
          { ...(outcome.metadata || {}), deduplicated: true },
        );
        return outcome.agentId;
      });
    }

    let resolveAdmission!: () => void;
    const token = Symbol('agent-start-admission');
    const promise = new Promise<void>(resolve => {
      resolveAdmission = resolve;
    });
    const admission: AgentStartAdmission = {
      token,
      promise,
      workspaceKey: request.workspaceKey,
    };
    this.starts.set(token, admission);

    let reportedOutcome: AgentStartOutcome | null = null;
    const report: AgentStartReport = (agentId, error, metadata = {}) => {
      reportedOutcome = { agentId, error: error || null, metadata };
      request.report?.(agentId, error, metadata);
    };
    const admitted = Promise.resolve().then(() => request.execute(token, report)).finally(() => {
      if (this.starts.get(token) === admission) this.starts.delete(token);
      resolveAdmission();
    });
    if (!request.requestId) return admitted;

    const outcome = admitted.then(agentId => (
      reportedOutcome || {
        agentId,
        error: agentId ? null : 'Failed to start Agent',
      }
    ));
    const requestAdmission: CreateRequestAdmission = {
      signature: request.signature,
      promise: outcome,
    };
    this.createRequests.set(request.requestId, requestAdmission);
    void outcome.finally(() => {
      if (this.createRequests.get(request.requestId) === requestAdmission) {
        this.createRequests.delete(request.requestId);
      }
    }).catch(() => {});
    return outcome.then(result => result.agentId);
  }

  has(token: symbol): boolean {
    return this.starts.has(token);
  }

  setWorkspace(token: symbol | undefined, workspaceKey: string): void {
    if (!token) return;
    const admission = this.starts.get(token);
    if (admission) admission.workspaceKey = workspaceKey;
  }

  pendingOperations(): Promise<void>[] {
    return [...this.starts.values()].map(admission => admission.promise);
  }

  pendingForWorkspace(
    workspaceKey: string,
    isRelated: (root: string, candidate: string) => boolean,
  ): Promise<void>[] {
    if (!workspaceKey) return [];
    return [...this.starts.values()]
      .filter(admission => (
        !admission.workspaceKey
        || isRelated(workspaceKey, admission.workspaceKey)
      ))
      .map(admission => admission.promise);
  }

  clear(): void {
    this.starts.clear();
    this.createRequests.clear();
  }
}

export {
  AgentStartAdmissionCoordinator,
  type AgentStartAdmissionRequest,
  type AgentStartReport,
};
