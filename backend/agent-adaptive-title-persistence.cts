'use strict';

/**
 * Owner of Agent-managed (adaptive) title durability state.
 *
 * The coordinator holds the only coalesced durability entry per Agent, keyed by
 * the exact runtime record and the runtime epoch observed when the entry was
 * created. AgentManager keeps request admission and the optimistic runtime
 * title; it never reads or rebuilds the queue.
 *
 * Per Agent: idle -> queued (latest value wins) -> deferred drain -> persisting
 * -> committed | failed rollback | stale-owner drop | cancelled. Across Agents
 * the queue is FIFO and drains exactly one entry at a time, yielding between
 * entries so a startup fan-out never persists on the request stack.
 *
 * An entry is written only while the exact record it was queued for is still
 * live and still carries the runtime epoch observed at admission; either fence
 * failing drops the entry with a retryable stale result, writes nothing, and
 * never rolls a newer epoch back. A committed record id is republished under
 * the same record-and-epoch fence: an epoch rotation observed after a
 * successful durable write keeps the success result but rebinds no identity and
 * refreshes no provider metadata, because the write is never replayed. A failed
 * write rolls the optimistic title back only while the same record, the same
 * epoch, and the exact value this entry wrote are all still live.
 *
 * Clearing the queue resolves every still-queued entry exactly once as a
 * cancelled shutdown result so no caller waits forever; an entry already taken
 * off the queue for its write is left to the drain, which owns its terminal
 * outcome. Nothing is replayed after a restart.
 */

import type { AgentId, AgentRecord } from './agent-manager-record-types.js';

type AdaptiveTitleResult = Record<string, unknown>;

interface AdaptiveTitlePersistenceEntry {
  agent: AgentRecord;
  previousTitle: string;
  promise: Promise<AdaptiveTitleResult>;
  resolve: (result: AdaptiveTitleResult) => void;
  runtimeEpoch: string;
  title: string;
}

interface AgentAdaptiveTitlePersistencePorts {
  getAgent(agentId: AgentId): AgentRecord | undefined;
  persistAdaptiveTitle(agent: AgentRecord, adaptiveTitle: string): Promise<string>;
  publishAgentPatch(agentId: AgentId, patch: Record<string, unknown>): void;
  setRecordId(agent: AgentRecord, agentRecordId: unknown): void;
  updateProviderMetadata(agent: AgentRecord): void;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

class AgentAdaptiveTitlePersistenceCoordinator {
  private readonly entries = new Map<AgentId, AdaptiveTitlePersistenceEntry>();
  private drain: Promise<void> | null = null;
  private readonly ports: AgentAdaptiveTitlePersistencePorts;

  constructor(ports: AgentAdaptiveTitlePersistencePorts) {
    this.ports = ports;
  }

  pendingResult(agentId: AgentId): Promise<AdaptiveTitleResult> | undefined {
    return this.entries.get(agentId)?.promise;
  }

  activeDrain(): Promise<void> | null {
    return this.drain;
  }

  clearPending(): void {
    const cancelled = [...this.entries.values()];
    this.entries.clear();
    for (const entry of cancelled) {
      entry.resolve({
        cancelled: true,
        error: 'Failed to update Agent title: Farming is shutting down',
        retryable: true,
      });
    }
  }

  schedule(
    agentId: AgentId,
    agent: AgentRecord,
    adaptiveTitle: string,
    previousTitle: string,
  ): Promise<AdaptiveTitleResult> {
    const pending = this.entries.get(agentId);
    if (pending) {
      pending.title = adaptiveTitle;
      return pending.promise;
    }

    let resolve: (result: AdaptiveTitleResult) => void = () => {};
    const promise = new Promise<AdaptiveTitleResult>((settle) => {
      resolve = settle;
    });
    this.entries.set(agentId, {
      agent,
      previousTitle,
      promise,
      resolve,
      title: adaptiveTitle,
      runtimeEpoch: agent.runtimeEpoch || '',
    });
    this.startDrain();
    return promise;
  }

  private startDrain(): void {
    if (this.drain) return;
    const drain = (async () => {
      await yieldToEventLoop();
      while (this.entries.size > 0) {
        const next = this.entries.entries().next().value as
          | [AgentId, AdaptiveTitlePersistenceEntry]
          | undefined;
        if (!next) break;
        const [agentId, entry] = next;
        this.entries.delete(agentId);
        await this.commitEntry(agentId, entry);
        if (this.entries.size > 0) {
          await yieldToEventLoop();
        }
      }
    })();
    this.drain = drain;
    void drain.finally(() => {
      if (this.drain === drain) {
        this.drain = null;
      }
      if (this.entries.size > 0) {
        this.startDrain();
      }
    }).catch(() => {});
  }

  private async commitEntry(
    agentId: AgentId,
    entry: AdaptiveTitlePersistenceEntry,
  ): Promise<void> {
    const adaptiveTitle = entry.title;
    const current = this.ports.getAgent(agentId);
    if (current !== entry.agent || !this.ownsEpoch(current, entry)) {
      entry.resolve({
        error: 'Failed to update Agent title: Agent runtime changed before persistence',
        retryable: true,
      });
      return;
    }

    const staged: AgentRecord = { ...current, adaptiveTitle };
    try {
      const agentRecordId = await this.ports.persistAdaptiveTitle(staged, adaptiveTitle);
      if (!agentRecordId) {
        throw new Error('Agent session record is unavailable or no longer owned by this runtime');
      }
      this.ports.setRecordId(staged, agentRecordId);
      const live = this.ports.getAgent(agentId);
      if (live === current && this.ownsEpoch(live, entry)) {
        this.ports.setRecordId(live, staged.agentRecordId || staged.persistentSessionId || '');
        this.ports.updateProviderMetadata(live);
      }
      entry.resolve({ agentId, adaptiveTitle });
    } catch (caughtError: unknown) {
      const error = caughtError as { message?: string };
      console.error('Failed to persist adaptive Agent title:', error);
      const live = this.ports.getAgent(agentId);
      if (
        live === current
        && this.ownsEpoch(live, entry)
        && current.adaptiveTitle === adaptiveTitle
      ) {
        current.adaptiveTitle = entry.previousTitle;
        this.ports.publishAgentPatch(agentId, { adaptiveTitle: entry.previousTitle });
      }
      entry.resolve({
        error: `Failed to update Agent title: ${error.message || error}`,
        retryable: true,
      });
    }
  }

  private ownsEpoch(
    agent: AgentRecord | undefined,
    entry: AdaptiveTitlePersistenceEntry,
  ): boolean {
    return !!agent && (agent.runtimeEpoch || '') === entry.runtimeEpoch;
  }
}

export {
  AgentAdaptiveTitlePersistenceCoordinator,
};
export type {
  AgentAdaptiveTitlePersistencePorts,
};
