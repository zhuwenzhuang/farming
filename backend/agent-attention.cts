/**
 * Attention/unread state machine for Farming Agents.
 *
 * AgentManager owns Agent records; this tracker owns attention transitions.
 * Triggers are runtime observation, explicit attention events, and read/unread
 * cursor requests. Guards exclude the Main Agent and ephemeral shell
 * completions, require new output after recovery, and keep read cursors
 * monotonic. Successful transitions update the record, then persist and
 * publish through the narrow host port. Provider idle detection has one timer per
 * Agent, revalidates identity/runtime/activity before firing, cancels when the
 * Agent becomes active, and is fully drained on Manager disposal.
 */

import type { AgentId, AgentRecord as TypedAgentRecord } from './agent-manager-record-types.js';
import { deriveAgentTerminalStatus } from './agent-terminal-status.cjs';
import { providerForProgram, providerTerminalNotificationIdleFenceMs } from './provider-adapters.cjs';

const path = require('path');

type UnknownRecord = Record<string, unknown>;

interface AgentReadStatePayload extends UnknownRecord {
  agentId: AgentId;
  unread: boolean;
  attentionSeq: number;
  readAttentionSeq: number;
}

interface AgentReadRequest {
  readAttentionSeq?: unknown;
  readOutputEpoch?: unknown;
  readOutputSeq?: unknown;
  unread?: unknown;
}

interface AgentReadTransitionResult {
  changed: boolean;
  updates: UnknownRecord;
}

interface AgentAttentionHost {
  getAgent(agentId: AgentId): TypedAgentRecord | undefined;
  isDisposed(): boolean;
  isMainAgent(agentId: AgentId, agent: TypedAgentRecord): boolean;
  persistAgent(agent: TypedAgentRecord): void;
  publishReadState(payload: AgentReadStatePayload): void;
  updateProviderMetadata(agent: TypedAgentRecord): void;
}

type AgentAttentionEventResult = {
  agentId: AgentId;
  attentionSeq: number;
  readAttentionSeq: number;
  unread: boolean;
};

function finiteNumberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteNonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function agentProgramName(command?: string): string {
  const executable = String(command || '')
    .trim()
    .split(/\s+/)
    .find((token: string) => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return path.basename(executable || '');
}

function isEphemeralShellAgent(agent: TypedAgentRecord): boolean {
  const program = agentProgramName(agent.forkCommand || agent.command || '').toLowerCase();
  return ['bash', 'zsh', 'sh', 'fish'].includes(program);
}

function agentAttentionProvider(agent: TypedAgentRecord): string {
  return agent.providerSessionProvider
    || providerForProgram(agentProgramName(agent.forkCommand || agent.command || ''));
}

function agentAttentionTurnActive(agent: TypedAgentRecord | null | undefined): boolean {
  if (!agent) return false;
  if (agent.status === 'pending') return true;
  if (agent.status !== 'running') return false;
  return deriveAgentTerminalStatus(agent).activity === 'busy';
}

function agentAttentionUnread(agent: TypedAgentRecord | null | undefined) {
  return finiteNonNegativeInteger(agent?.attentionSeq)
    > finiteNonNegativeInteger(agent?.readAttentionSeq);
}

function hasAgentOutputAfterAttentionBaseline(agent: TypedAgentRecord | null | undefined) {
  if (!agent || agent.attentionRequiresNewOutput !== true) return true;
  const baselineSeq = finiteNumberOrNull(agent.attentionBaselineOutputSeq);
  const lastOutputSeq = finiteNumberOrNull(agent.lastOutputSeq);
  if (baselineSeq !== null && lastOutputSeq !== null) {
    return lastOutputSeq > baselineSeq;
  }

  const baselineAt = finiteNumberOrNull(agent.attentionBaselineOutputAt);
  const lastOutputAt = finiteNumberOrNull(agent.lastEngineOutputAt);
  if (baselineAt !== null && lastOutputAt !== null) {
    return lastOutputAt > baselineAt;
  }

  return false;
}

function applyAgentReadRequest(
  agent: TypedAgentRecord,
  request: AgentReadRequest,
  now = Date.now(),
): AgentReadTransitionResult {
  const updates: UnknownRecord = {};
  let changed = false;

  if (
    typeof request.readOutputEpoch === 'string'
    && typeof request.readOutputSeq === 'number'
    && Number.isFinite(request.readOutputSeq)
  ) {
    const currentRuntimeEpoch = typeof agent.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
    const currentOutputSeq = finiteNumberOrNull(agent.lastOutputSeq);
    if (
      currentRuntimeEpoch
      && request.readOutputEpoch === currentRuntimeEpoch
      && currentOutputSeq !== null
    ) {
      const nextOutputSeq = Math.min(
        currentOutputSeq,
        Math.max(0, Math.floor(request.readOutputSeq)),
      );
      const previousOutputSeq = agent.readOutputEpoch === currentRuntimeEpoch
        ? finiteNumberOrNull(agent.readOutputSeq)
        : null;
      const readOutputSeq = previousOutputSeq === null
        ? nextOutputSeq
        : Math.max(previousOutputSeq, nextOutputSeq);
      changed = changed
        || agent.readOutputEpoch !== currentRuntimeEpoch
        || previousOutputSeq !== readOutputSeq;
      agent.readOutputEpoch = currentRuntimeEpoch;
      agent.readOutputSeq = readOutputSeq;
    }
    updates.readOutputEpoch = typeof agent.readOutputEpoch === 'string' ? agent.readOutputEpoch : '';
    updates.readOutputSeq = finiteNumberOrNull(agent.readOutputSeq);
  }

  if (typeof request.unread === 'boolean') {
    const previousReadSeq = finiteNonNegativeInteger(agent.readAttentionSeq);
    const previousUnread = agent.unread === true;
    if (request.unread) {
      if (finiteNonNegativeInteger(agent.attentionSeq) === 0) {
        agent.attentionSeq = 1;
        agent.attentionUpdatedAt = now;
        agent.attentionReason = 'manual-unread';
        agent.attentionOutputEpoch = typeof agent.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
        agent.attentionOutputSeq = finiteNumberOrNull(agent.lastOutputSeq);
        agent.attentionAutoReadNext = false;
      }
      agent.readAttentionSeq = Math.max(0, finiteNonNegativeInteger(agent.attentionSeq) - 1);
    } else {
      agent.readAttentionSeq = finiteNonNegativeInteger(agent.attentionSeq);
    }
    agent.readAttentionAt = now;
    agent.unread = agentAttentionUnread(agent);
    changed = changed
      || previousReadSeq !== agent.readAttentionSeq
      || previousUnread !== agent.unread;
    updates.unread = agent.unread;
    updates.attentionSeq = finiteNonNegativeInteger(agent.attentionSeq);
    updates.readAttentionSeq = finiteNonNegativeInteger(agent.readAttentionSeq);
  }

  if (
    typeof request.readAttentionSeq === 'number'
    && Number.isFinite(request.readAttentionSeq)
  ) {
    const previousReadSeq = finiteNonNegativeInteger(agent.readAttentionSeq);
    const previousUnread = agent.unread === true;
    const attentionSeq = finiteNonNegativeInteger(agent.attentionSeq);
    agent.readAttentionSeq = Math.min(
      attentionSeq,
      Math.max(previousReadSeq, finiteNonNegativeInteger(request.readAttentionSeq)),
    );
    agent.readAttentionAt = now;
    agent.unread = agentAttentionUnread(agent);
    changed = changed
      || previousReadSeq !== agent.readAttentionSeq
      || previousUnread !== agent.unread;
    updates.unread = agent.unread;
    updates.attentionSeq = attentionSeq;
    updates.readAttentionSeq = agent.readAttentionSeq;
  }

  return { changed, updates };
}

class AgentAttentionTracker {
  private readonly host: AgentAttentionHost;
  private readonly terminalIdleCandidates = new Map<AgentId, ReturnType<typeof setTimeout>>();

  constructor(host: AgentAttentionHost) {
    this.host = host;
  }

  hasTerminalIdleCandidate(agentId: AgentId): boolean {
    return this.terminalIdleCandidates.has(agentId);
  }

  cancelTerminalIdleCandidate(agentId: AgentId) {
    const candidate = this.terminalIdleCandidates.get(agentId);
    if (!candidate) return false;
    clearTimeout(candidate);
    this.terminalIdleCandidates.delete(agentId);
    return true;
  }

  cancelAllTerminalIdleCandidates() {
    for (const candidate of this.terminalIdleCandidates.values()) clearTimeout(candidate);
    this.terminalIdleCandidates.clear();
  }

  scheduleTerminalIdleCandidate(agent: TypedAgentRecord) {
    if (this.terminalIdleCandidates.has(agent.id)) return;
    const idleFenceMs = providerTerminalNotificationIdleFenceMs(agentAttentionProvider(agent));
    if (idleFenceMs <= 0) return;
    const runtimeEpoch = agent.runtimeEpoch;
    const candidate = setTimeout(() => {
      if (this.terminalIdleCandidates.get(agent.id) !== candidate) return;
      this.terminalIdleCandidates.delete(agent.id);
      const current = this.host.getAgent(agent.id);
      if (
        this.host.isDisposed()
        || current !== agent
        || current.runtimeEpoch !== runtimeEpoch
        || providerTerminalNotificationIdleFenceMs(agentAttentionProvider(current)) <= 0
        || current.lastObservedTurnActive === true
        || agentAttentionTurnActive(current)
      ) {
        return;
      }
      this.completeAgentAttentionTransition(current);
    }, idleFenceMs);
    candidate.unref?.();
    this.terminalIdleCandidates.set(agent.id, candidate);
  }

  completeAgentAttentionTransition(agent: TypedAgentRecord) {
    const pendingTerminalNotificationSummary = agent.pendingTerminalNotificationSummary;
    delete agent.pendingTerminalNotificationSummary;
    if (typeof pendingTerminalNotificationSummary === 'string') {
      if (!hasAgentOutputAfterAttentionBaseline(agent)) return false;
      agent.attentionRequiresNewOutput = false;
      agent.attentionSummary = pendingTerminalNotificationSummary;
      this.recordAgentAttentionEvent(agent, 'terminal-notification');
      return true;
    }

    const terminalNotificationUntil = finiteNumberOrNull(agent.terminalNotificationAttentionUntil);
    delete agent.terminalNotificationAttentionUntil;
    if (terminalNotificationUntil !== null && terminalNotificationUntil >= Date.now()) {
      agent.attentionRequiresNewOutput = false;
      return false;
    }
    if (!hasAgentOutputAfterAttentionBaseline(agent)) return false;
    agent.attentionRequiresNewOutput = false;
    if (isEphemeralShellAgent(agent)) return false;

    const reason = agent.status === 'stopped' || agent.status === 'dead'
      ? 'process-exit'
      : 'turn-complete';
    this.recordAgentAttentionEvent(agent, reason);
    return true;
  }

  observeAgentAttentionState(agentId: AgentId) {
    const agent = this.host.getAgent(agentId);
    if (!agent) return false;

    // Retire automatic shell unread state persisted by older releases while
    // preserving deliberate manual unread marks.
    if (
      isEphemeralShellAgent(agent)
      && agent.unread === true
      && (agent.attentionReason === 'turn-complete' || agent.attentionReason === 'process-exit')
    ) {
      this.markAgentReadCursor(agent.id, finiteNonNegativeInteger(agent.attentionSeq));
    }

    const turnActive = agentAttentionTurnActive(agent);
    if (agent.attentionTrackingReady !== true) {
      agent.lastObservedTurnActive = turnActive;
      agent.attentionTrackingReady = true;
      return false;
    }

    const wasTurnActive = agent.lastObservedTurnActive === true;
    agent.lastObservedTurnActive = turnActive;
    const provider = agentAttentionProvider(agent);

    const terminalIdleFenceMs = providerTerminalNotificationIdleFenceMs(provider);
    if (turnActive && terminalIdleFenceMs > 0) {
      this.cancelTerminalIdleCandidate(agent.id);
    }

    if (wasTurnActive && !turnActive) {
      if (terminalIdleFenceMs > 0 && agent.status === 'running') {
        this.scheduleTerminalIdleCandidate(agent);
        return false;
      }
      return this.completeAgentAttentionTransition(agent);
    }

    return false;
  }

  recordAgentAttentionEvent(
    agent: TypedAgentRecord | null | undefined,
    reason: string = 'turn-complete',
    options: { persist?: boolean; publish?: boolean } = {},
  ): AgentAttentionEventResult | null {
    if (!agent) return null;
    if (this.host.isMainAgent(agent.id, agent)) return null;
    const now = Date.now();
    const nextSeq = finiteNonNegativeInteger(agent.attentionSeq) + 1;
    agent.attentionSeq = nextSeq;
    agent.attentionUpdatedAt = now;
    agent.attentionReason = reason;
    agent.attentionOutputEpoch = typeof agent.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
    const attentionOutputSeq = Number.isFinite(agent.lastOutputSeq)
      ? Number(agent.lastOutputSeq)
      : null;
    agent.attentionOutputSeq = attentionOutputSeq;
    const attentionOutputAlreadyRead = Boolean(
      agent.attentionOutputEpoch
      && agent.attentionOutputEpoch === agent.readOutputEpoch
      && attentionOutputSeq !== null
      && Number.isFinite(agent.readOutputSeq)
      && attentionOutputSeq <= Number(agent.readOutputSeq)
    );
    if (agent.attentionAutoReadNext === true || attentionOutputAlreadyRead) {
      agent.attentionAutoReadNext = false;
      agent.readAttentionSeq = nextSeq;
      agent.readAttentionAt = now;
    }
    agent.unread = agentAttentionUnread(agent);
    if (options.persist !== false) this.host.persistAgent(agent);
    if (options.publish !== false) {
      this.host.updateProviderMetadata(agent);
      this.emitAgentReadState(agent);
    }
    return {
      agentId: agent.id,
      attentionSeq: agent.attentionSeq,
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
      unread: agent.unread,
    };
  }

  markAgentReadCursor(agentId: AgentId, readAttentionSeq?: number, options: UnknownRecord = {}) {
    const agent = this.host.getAgent(agentId);
    if (!agent) return { error: 'Agent not found' };

    const attentionSeq = finiteNonNegativeInteger(agent.attentionSeq);
    const transition = applyAgentReadRequest(agent, {
      readAttentionSeq: Number.isFinite(readAttentionSeq) ? readAttentionSeq : attentionSeq,
    });
    const changed = transition.changed;
    if (changed) {
      this.host.persistAgent(agent);
      this.host.updateProviderMetadata(agent);
      if (options.emitUpdate !== false) this.emitAgentReadState(agent);
    }
    return {
      agentId,
      attentionSeq,
      readAttentionSeq: agent.readAttentionSeq,
      unread: agent.unread,
      changed,
    };
  }

  markAgentUnreadCursor(agentId: AgentId) {
    const agent = this.host.getAgent(agentId);
    if (!agent) return { error: 'Agent not found' };

    let changed = false;
    if (finiteNonNegativeInteger(agent.attentionSeq) === 0) {
      this.recordAgentAttentionEvent(agent, 'manual-unread');
      changed = true;
    }
    const attentionSeq = finiteNonNegativeInteger(agent.attentionSeq);
    const nextReadAttentionSeq = Math.max(0, attentionSeq - 1);
    changed = changed
      || finiteNonNegativeInteger(agent.readAttentionSeq) !== nextReadAttentionSeq
      || agent.unread !== true;
    if (changed) {
      agent.readAttentionSeq = nextReadAttentionSeq;
      agent.readAttentionAt = Date.now();
      agent.unread = agentAttentionUnread(agent);
      this.host.persistAgent(agent);
      this.host.updateProviderMetadata(agent);
      this.emitAgentReadState(agent);
    }
    return {
      agentId,
      attentionSeq: agent.attentionSeq,
      readAttentionSeq: agent.readAttentionSeq,
      unread: agent.unread,
      changed,
    };
  }

  emitAgentReadState(agent: TypedAgentRecord) {
    this.host.publishReadState({
      agentId: agent.id,
      unread: agent.unread === true,
      attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(agent.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(agent.readAttentionAt),
      attentionReason: typeof agent.attentionReason === 'string' ? agent.attentionReason : '',
      attentionSummary: typeof agent.attentionSummary === 'string' ? agent.attentionSummary : '',
      attentionOutputEpoch: typeof agent.attentionOutputEpoch === 'string' ? agent.attentionOutputEpoch : '',
      attentionOutputSeq: finiteNumberOrNull(agent.attentionOutputSeq),
      readOutputEpoch: typeof agent.readOutputEpoch === 'string' ? agent.readOutputEpoch : '',
      readOutputSeq: finiteNumberOrNull(agent.readOutputSeq),
    });
  }
}

export {
  AgentAttentionTracker,
  applyAgentReadRequest,
  agentAttentionProvider,
  agentAttentionTurnActive,
  agentAttentionUnread,
  hasAgentOutputAfterAttentionBaseline,
};

export type {
  AgentAttentionHost,
  AgentReadStatePayload,
};
