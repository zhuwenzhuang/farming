import type { AgentAttentionTracker } from './agent-attention.cjs';
import type { AcpRuntimeContract } from './agent-manager-provider-types.js';
import type {
  AcpRuntimeBinding,
  AgentId,
  AgentManagerConfig,
  AgentRecord,
} from './agent-manager-record-types.js';
import { runtimeBindingOf, runtimeKind } from './agent-runtime-binding.cjs';
import { acpLastAssistantNotificationSummary, acpTurnHandleIsNewer } from './acp-turn-summary.cjs';

const ACP_ATTENTION_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
]);

interface AcpTurnFinalizationPersistencePort {
  assertRuntimeOwner(agent: AgentRecord): void;
  config: AgentManagerConfig | null | undefined;
  persistAgent(agent: AgentRecord): string;
  setRecordId(agent: AgentRecord, recordId: unknown): void;
}

interface AcpTurnFinalizationCoordinatorOptions {
  agents: Map<AgentId, AgentRecord>;
  attention: AgentAttentionTracker;
  observeProviderSession: (agentId: AgentId) => void;
  persistence: AcpTurnFinalizationPersistencePort;
  runtime: AcpRuntimeContract;
  updateProviderMetadata: (agent: AgentRecord) => void;
}

interface SettledAcpTurn {
  agentId: AgentId;
  exactTurnSummary: string | null;
  settledTurnHandle: string;
  stopReason: string;
}

type UnknownRecord = Record<string, unknown>;

function finiteNumberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteNonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** Owns ACP settled-Turn admission, ordering, durable convergence, and cleanup. */
class AcpTurnFinalizationCoordinator {
  readonly #active = new Set<Promise<void>>();
  readonly #agents: Map<AgentId, AgentRecord>;
  readonly #attention: AgentAttentionTracker;
  readonly #finalized = new Map<AgentId, string>();
  readonly #observeProviderSession: AcpTurnFinalizationCoordinatorOptions['observeProviderSession'];
  readonly #persistence: AcpTurnFinalizationPersistencePort;
  readonly #runtime: AcpRuntimeContract;
  readonly #tails = new Map<AgentId, Promise<void>>();
  readonly #updateProviderMetadata: AcpTurnFinalizationCoordinatorOptions['updateProviderMetadata'];

  constructor(options: AcpTurnFinalizationCoordinatorOptions) {
    this.#agents = options.agents;
    this.#attention = options.attention;
    this.#observeProviderSession = options.observeProviderSession;
    this.#persistence = options.persistence;
    this.#runtime = options.runtime;
    this.#updateProviderMetadata = options.updateProviderMetadata;
  }

  observeSettledTurn({
    agentId,
    exactTurnSummary,
    settledTurnHandle,
    stopReason,
  }: SettledAcpTurn): boolean {
    const agent = this.#agents.get(agentId);
    const finalizedTurnHandle = String(
      this.#finalized.get(agentId)
      || agent?.acpFinalizedTurnHandle
      || '',
    );
    if (!settledTurnHandle || !acpTurnHandleIsNewer(settledTurnHandle, finalizedTurnHandle)) {
      return false;
    }

    this.#finalized.set(agentId, settledTurnHandle);
    const runtimeEpoch = this.#runtime.bindingEpoch(agentId);
    const previous = this.#tails.get(agentId) || Promise.resolve();
    const finalization = previous.catch(() => {}).then(() => this.#finalize(
      agentId,
      runtimeEpoch,
      settledTurnHandle,
      stopReason,
      exactTurnSummary,
    ));
    this.#tails.set(agentId, finalization);
    this.#active.add(finalization);
    void finalization.catch(error => {
      if (this.#finalized.get(agentId) === settledTurnHandle) {
        this.#finalized.delete(agentId);
        const current = this.#agents.get(agentId);
        if (current?.acpFinalizedTurnHandle === settledTurnHandle) {
          current.acpFinalizedTurnHandle = '';
        }
      }
      console.warn('Failed to finalize ACP Turn:', error);
    }).finally(() => {
      this.#active.delete(finalization);
      if (this.#tails.get(agentId) === finalization) this.#tails.delete(agentId);
    });
    return true;
  }

  finalizedTurnHandle(agentId: AgentId): string {
    return this.#finalized.get(agentId) || '';
  }

  pendingOperations(): ReadonlySet<Promise<void>> {
    return new Set(this.#active);
  }

  async whenIdle(agentId?: AgentId): Promise<void> {
    while (true) {
      const pending = agentId ? [this.#tails.get(agentId)].filter(Boolean) : [...this.#tails.values()];
      if (pending.length === 0) return;
      await Promise.allSettled(pending as Promise<void>[]);
    }
  }

  forget(agentId: AgentId): void {
    this.#finalized.delete(agentId);
    this.#tails.delete(agentId);
  }

  clearFinalizedTurns(): void {
    this.#finalized.clear();
  }

  dispose(): void {
    this.#active.clear();
    this.#finalized.clear();
    this.#tails.clear();
  }

  async #finalize(
    agentId: AgentId,
    runtimeEpoch: string,
    settledTurnHandle: string,
    stopReason: string,
    exactTurnSummary: string | null,
  ): Promise<void> {
    const agent = this.#agents.get(agentId);
    if (!agent || runtimeKind(agent) !== 'acp') return;
    const runtime = runtimeBindingOf(agent, 'acp');
    if (!runtime || this.#runtime.bindingEpoch(agentId) !== runtimeEpoch) return;
    const effectiveStopReason = stopReason || runtime.stopReason || '';
    let attentionSummary = exactTurnSummary || '';
    if (ACP_ATTENTION_STOP_REASONS.has(effectiveStopReason) && exactTurnSummary === null) {
      try {
        attentionSummary = acpLastAssistantNotificationSummary(
          await this.#runtime.getTranscriptSessionForRead(agentId, { maxTurns: 1 }),
        );
      } catch {
        attentionSummary = '';
      }
    }
    if (this.#agents.get(agentId) !== agent || this.#runtime.bindingEpoch(agentId) !== runtimeEpoch) return;

    const attentionInputSignature = () => JSON.stringify([
      agent.attentionAutoReadNext === true,
      agent.attentionOutputEpoch || '',
      finiteNumberOrNull(agent.attentionOutputSeq),
      agent.attentionReason || '',
      finiteNonNegativeInteger(agent.attentionSeq),
      finiteNumberOrNull(agent.attentionUpdatedAt),
      finiteNumberOrNull(agent.readAttentionAt),
      finiteNonNegativeInteger(agent.readAttentionSeq),
      agent.readOutputEpoch || '',
      finiteNumberOrNull(agent.readOutputSeq),
      agent.runtimeEpoch || '',
      agent.unread === true,
    ]);
    const stageFinalizedAgent = (currentRuntime: AcpRuntimeBinding) => {
      const staged = {
        ...agent,
        runtimeBinding: { ...currentRuntime },
        acpFinalizedTurnHandle: settledTurnHandle,
      } as AgentRecord;
      let attentionUpdate: UnknownRecord | null = null;
      if (ACP_ATTENTION_STOP_REASONS.has(effectiveStopReason)) {
        staged.attentionSummary = attentionSummary;
        attentionUpdate = this.#attention.recordAgentAttentionEvent(staged, 'turn-complete', {
          persist: false,
          publish: false,
        });
      }
      return { attentionUpdate, staged };
    };
    const publishFinalizedAgent = (
      staged: AgentRecord,
      attentionUpdate: UnknownRecord | null,
    ) => {
      Object.assign(agent, {
        acpFinalizedTurnHandle: staged.acpFinalizedTurnHandle,
        attentionAutoReadNext: staged.attentionAutoReadNext,
        attentionOutputEpoch: staged.attentionOutputEpoch,
        attentionOutputSeq: staged.attentionOutputSeq,
        attentionReason: staged.attentionReason,
        attentionSeq: staged.attentionSeq,
        attentionSummary: staged.attentionSummary,
        attentionUpdatedAt: staged.attentionUpdatedAt,
        readAttentionAt: staged.readAttentionAt,
        readAttentionSeq: staged.readAttentionSeq,
        unread: staged.unread,
      });
      if (attentionUpdate) {
        this.#updateProviderMetadata(agent);
        this.#attention.emitAgentReadState(agent);
      }
      this.#observeProviderSession(agentId);
    };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const currentRuntime = runtimeBindingOf(agent, 'acp');
      if (
        this.#agents.get(agentId) !== agent
        || !currentRuntime
        || this.#runtime.bindingEpoch(agentId) !== runtimeEpoch
      ) return;
      const inputSignature = attentionInputSignature();
      let { attentionUpdate, staged } = stageFinalizedAgent(currentRuntime);
      const statePatch = {
        ...(currentRuntime.stopReason === effectiveStopReason
          ? { acpStopReason: effectiveStopReason }
          : {}),
        acpFinalizedTurnHandle: settledTurnHandle,
        attentionSeq: finiteNonNegativeInteger(staged.attentionSeq),
        readAttentionSeq: finiteNonNegativeInteger(staged.readAttentionSeq),
        attentionUpdatedAt: finiteNumberOrNull(staged.attentionUpdatedAt),
        readAttentionAt: finiteNumberOrNull(staged.readAttentionAt),
        attentionReason: staged.attentionReason || '',
        attentionOutputEpoch: staged.attentionOutputEpoch || '',
        attentionOutputSeq: finiteNumberOrNull(staged.attentionOutputSeq),
        readOutputEpoch: staged.readOutputEpoch || '',
        readOutputSeq: finiteNumberOrNull(staged.readOutputSeq),
        unread: staged.unread === true,
      };
      const beforeCommit = () => Boolean(
        this.#agents.get(agentId) === agent
        && this.#runtime.bindingEpoch(agentId) === runtimeEpoch
        && attentionInputSignature() === inputSignature
      );
      const config = this.#persistence.config;

      if (typeof config?.persistAgentStatePatch === 'function') {
        this.#persistence.assertRuntimeOwner(agent);
        const result = await config.persistAgentStatePatch(agent, statePatch, { beforeCommit });
        if (result.status === 'fenced') {
          if (
            this.#agents.get(agentId) !== agent
            || this.#runtime.bindingEpoch(agentId) !== runtimeEpoch
          ) return;
          await new Promise<void>(resolve => setImmediate(resolve));
          continue;
        }
        if (result.status === 'owner-mismatch') {
          throw new Error(`Agent ${agentId} state owner changed before Turn finalization commit`);
        }
        if (result.status === 'record-missing') {
          throw new Error(`Agent ${agentId} state record disappeared before Turn finalization commit`);
        }
        if (result.status === 'legacy-record') {
          const legacyRuntime = runtimeBindingOf(agent, 'acp');
          if (
            this.#agents.get(agentId) !== agent
            || !legacyRuntime
            || this.#runtime.bindingEpoch(agentId) !== runtimeEpoch
          ) return;
          ({ attentionUpdate, staged } = stageFinalizedAgent(legacyRuntime));
          this.#persistence.assertRuntimeOwner(agent);
          const agentRecordId = this.#persistence.persistAgent(staged);
          if (agentRecordId) this.#persistence.setRecordId(agent, agentRecordId);
        } else {
          const durableCommitIsCurrent = typeof config.isAgentStateCommitCurrent === 'function'
            && config.isAgentStateCommitCurrent(agent, result.id, result.commit);
          if (!durableCommitIsCurrent || !beforeCommit()) {
            await new Promise<void>(resolve => setImmediate(resolve));
            continue;
          }
          this.#persistence.setRecordId(agent, result.id);
        }
      } else {
        const agentRecordId = this.#persistence.persistAgent(staged);
        if (agentRecordId) this.#persistence.setRecordId(agent, agentRecordId);
      }

      if (this.#agents.get(agentId) !== agent) return;
      publishFinalizedAgent(staged, attentionUpdate);
      return;
    }

    const currentRuntime = runtimeBindingOf(agent, 'acp');
    if (
      this.#agents.get(agentId) !== agent
      || !currentRuntime
      || this.#runtime.bindingEpoch(agentId) !== runtimeEpoch
    ) return;
    const { attentionUpdate, staged } = stageFinalizedAgent(currentRuntime);
    this.#persistence.assertRuntimeOwner(agent);
    const agentRecordId = this.#persistence.persistAgent(staged);
    if (agentRecordId) this.#persistence.setRecordId(agent, agentRecordId);
    publishFinalizedAgent(staged, attentionUpdate);
  }
}

export {
  ACP_ATTENTION_STOP_REASONS,
  AcpTurnFinalizationCoordinator,
  type AcpTurnFinalizationCoordinatorOptions,
  type AcpTurnFinalizationPersistencePort,
  type SettledAcpTurn,
};
