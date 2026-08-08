/**
 * Attention/unread state machine for Farming Agents.
 *
 * AgentManager owns Agent records; this tracker owns attention transitions.
 * Triggers are runtime observation, explicit attention events, and read/unread
 * cursor requests. Guards exclude the Main Agent and ephemeral shell
 * completions, require new output after recovery, and keep read cursors
 * monotonic. Successful transitions update the record, then persist and
 * publish through the narrow host port. Qwen idle detection has one timer per
 * Agent, revalidates identity/runtime/activity before firing, cancels when the
 * Agent becomes active, and is fully drained on Manager disposal.
 */

import type { AgentId, AgentRecord as TypedAgentRecord } from './agent-manager-record-types.js';

const path = require('path');

type UnknownRecord = Record<string, unknown>;

const QWEN_TERMINAL_IDLE_STABILITY_MS = 3_000;

interface AgentReadStatePayload extends UnknownRecord {
  agentId: AgentId;
  unread: boolean;
  attentionSeq: number;
  readAttentionSeq: number;
}

interface AgentAttentionHost {
  getAgent(agentId: AgentId): TypedAgentRecord | undefined;
  isDisposed(): boolean;
  isMainAgent(agentId: AgentId, agent: TypedAgentRecord): boolean;
  isTurnActive(agent: TypedAgentRecord): boolean;
  persistAgent(agent: TypedAgentRecord): void;
  providerForAgent(agent: TypedAgentRecord): string;
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

class AgentAttentionTracker {
  private readonly host: AgentAttentionHost;
  private readonly qwenTerminalIdleCandidates = new Map<AgentId, ReturnType<typeof setTimeout>>();

  constructor(host: AgentAttentionHost) {
    this.host = host;
  }

  hasQwenTerminalIdleCandidate(agentId: AgentId): boolean {
    return this.qwenTerminalIdleCandidates.has(agentId);
  }

  cancelQwenTerminalIdleCandidate(agentId: AgentId) {
    const candidate = this.qwenTerminalIdleCandidates.get(agentId);
    if (!candidate) return false;
    clearTimeout(candidate);
    this.qwenTerminalIdleCandidates.delete(agentId);
    return true;
  }

  cancelAllQwenTerminalIdleCandidates() {
    for (const candidate of this.qwenTerminalIdleCandidates.values()) clearTimeout(candidate);
    this.qwenTerminalIdleCandidates.clear();
  }

  scheduleQwenTerminalIdleCandidate(agent: TypedAgentRecord) {
    if (this.qwenTerminalIdleCandidates.has(agent.id)) return;
    const runtimeEpoch = agent.runtimeEpoch;
    const candidate = setTimeout(() => {
      if (this.qwenTerminalIdleCandidates.get(agent.id) !== candidate) return;
      this.qwenTerminalIdleCandidates.delete(agent.id);
      const current = this.host.getAgent(agent.id);
      if (
        this.host.isDisposed()
        || current !== agent
        || current.runtimeEpoch !== runtimeEpoch
        || this.host.providerForAgent(current) !== 'qwen'
        || current.lastObservedTurnActive === true
        || this.host.isTurnActive(current)
      ) {
        return;
      }
      this.completeAgentAttentionTransition(current);
    }, QWEN_TERMINAL_IDLE_STABILITY_MS);
    candidate.unref?.();
    this.qwenTerminalIdleCandidates.set(agent.id, candidate);
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

    const turnActive = this.host.isTurnActive(agent);
    if (agent.attentionTrackingReady !== true) {
      agent.lastObservedTurnActive = turnActive;
      agent.attentionTrackingReady = true;
      return false;
    }

    const wasTurnActive = agent.lastObservedTurnActive === true;
    agent.lastObservedTurnActive = turnActive;
    const provider = this.host.providerForAgent(agent);

    if (turnActive && provider === 'qwen') {
      this.cancelQwenTerminalIdleCandidate(agent.id);
    }

    if (wasTurnActive && !turnActive) {
      if (provider === 'qwen' && agent.status === 'running') {
        this.scheduleQwenTerminalIdleCandidate(agent);
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
    const requestedSeq = Number.isFinite(readAttentionSeq)
      ? finiteNonNegativeInteger(readAttentionSeq)
      : attentionSeq;
    const nextReadSeq = Math.min(
      attentionSeq,
      Math.max(finiteNonNegativeInteger(agent.readAttentionSeq), requestedSeq),
    );
    const changed = finiteNonNegativeInteger(agent.readAttentionSeq) !== nextReadSeq
      || agent.unread === true;

    agent.readAttentionSeq = nextReadSeq;
    agent.readAttentionAt = Date.now();
    agent.unread = agentAttentionUnread(agent);
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
  QWEN_TERMINAL_IDLE_STABILITY_MS,
  agentAttentionUnread,
  hasAgentOutputAfterAttentionBaseline,
};

export type {
  AgentAttentionHost,
  AgentReadStatePayload,
};
