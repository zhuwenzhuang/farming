import {
  agentStateSnapshotFrames,
  normalizeAgentStateScope,
  type AgentStatePayload,
} from './agent-state-broadcast-protocol.cjs';
import { normalizeAgentActivityScope } from './agent-activity-delivery.cjs';
import type { DeferredAgentStateMessage } from './agent-state-snapshot-delivery.cjs';

interface WebSocketAgentStateSnapshotClient {
  activityScope?: 'none' | 'focused' | 'all';
  agentActivityAllCheckpointPending?: boolean;
  agentActivityCheckpointPending?: boolean;
  agentActivityResyncPending?: boolean;
  bufferedAmount: number;
  focusedAgentId?: string | null;
  initialStateSnapshotSent?: boolean;
  initialStateSnapshotTimer?: unknown;
  readyState: number;
  stateScope?: 'all' | 'focused';
  stateSnapshotCutId?: number | null;
  stateSnapshotInProgress?: boolean;
  stateSnapshotMessageBytes?: number;
  stateSnapshotMessages?: DeferredAgentStateMessage[];
  stateSnapshotOverflowed?: boolean;
  stateSnapshotPending?: boolean;
  stateSnapshotRetryTimer?: unknown;
  send(data: string): void;
}

interface WebSocketAgentStateSnapshotTimer {
  unref?(): void;
}

interface WebSocketAgentStateSnapshotPorts<Client extends WebSocketAgentStateSnapshotClient> {
  backpressureRetryMs: number;
  broadcastCheckpoint(client: Client): void;
  cancelPreviewHydration(client: Client): void;
  clearTimer(timer: WebSocketAgentStateSnapshotTimer): void;
  initialFollowupDelayMs: number;
  initialPageSize: number;
  maxBufferedAmount: number;
  onDeliveryFailure(client: Client, error: unknown): void;
  openState: number;
  pageSize: number;
  previewHydrationWindowMs: number;
  projectSummaries(): unknown[] | null;
  queuePreviewHydration(client: Client, delayMs: number, callback: () => void): void;
  recoverAcpSessionRevision(client: Client): void;
  recoverAgentActivity(client: Client): void;
  scopeDeclarationWindowMs: number;
  sendPreviewHydration(client: Client): void;
  serverEpoch: number;
  snapshotForScope(stateScope: 'all' | 'focused', focusedAgentId?: string | null): AgentStatePayload | null;
  snapshotSequence(): number;
  setTimer(callback: () => void, delayMs: number): WebSocketAgentStateSnapshotTimer;
}

interface WebSocketAgentStateSnapshotController<Client extends WebSocketAgentStateSnapshotClient> {
  dispose(client: Client): void;
  queueInitialSnapshot(client: Client): void;
  recoverSnapshotIfReady(client: Client): void;
  sendState(client: Client): void;
}

function createWebSocketAgentStateSnapshotController<Client extends WebSocketAgentStateSnapshotClient>(
  ports: WebSocketAgentStateSnapshotPorts<Client>,
): WebSocketAgentStateSnapshotController<Client> {
  let snapshotSerial = 0;

  // Cleanup and failure-report callbacks are untrusted effects: a throw must not
  // escape a timer/message callback, override the original failure, or skip the
  // remaining cleanup work.
  function safeInvoke(callback: (() => void) | undefined): { error: unknown } | null {
    if (!callback) return null;
    try {
      callback();
      return null;
    } catch (error) {
      // Contained: primary state cleanup already completed. The caller decides
      // whether this throw is itself a reportable delivery failure.
      return { error };
    }
  }

  // Callers must detach the queue from the client first, so each entry is
  // claimed exactly once before its onDiscard runs.
  function discardClaimedQueue(claimed: DeferredAgentStateMessage[]): void {
    for (const queued of claimed) safeInvoke(queued.onDiscard);
  }

  // Single send-effect boundary: client.send can throw synchronously, and the
  // transport outcome of a throwing send is unknown, so the cut is terminated
  // rather than replayed.
  function terminateDelivery(
    client: Client,
    error: unknown,
    owned: DeferredAgentStateMessage[] = [],
  ): void {
    if (client.stateSnapshotRetryTimer) {
      ports.clearTimer(client.stateSnapshotRetryTimer as WebSocketAgentStateSnapshotTimer);
    }
    client.stateSnapshotRetryTimer = null;
    const abandonedQueue = client.stateSnapshotMessages ?? [];
    client.stateSnapshotMessages = [];
    client.stateSnapshotMessageBytes = 0;
    client.stateSnapshotCutId = null;
    client.stateSnapshotInProgress = false;
    client.stateSnapshotPending = false;
    client.stateSnapshotOverflowed = false;
    discardClaimedQueue(owned);
    discardClaimedQueue(abandonedQueue);
    safeInvoke(() => ports.onDeliveryFailure(client, error));
  }

  function sendState(client: Client): void {
    client.initialStateSnapshotSent = true;
    if (client.initialStateSnapshotTimer) {
      ports.clearTimer(client.initialStateSnapshotTimer as WebSocketAgentStateSnapshotTimer);
    }
    client.initialStateSnapshotTimer = null;
    if (client.stateSnapshotInProgress) {
      client.stateSnapshotPending = true;
      return;
    }
    ports.cancelPreviewHydration(client);
    ports.broadcastCheckpoint(client);
    const stateScope = normalizeAgentStateScope(client.stateScope);
    const state = ports.snapshotForScope(stateScope, client.focusedAgentId);
    const summaries = ports.projectSummaries();
    if (!state || !summaries) {
      client.stateSnapshotPending = true;
      try {
        client.send(JSON.stringify({
          type: 'error',
          message: 'Agent state snapshot is temporarily unavailable; Farming will retry',
        }));
      } catch (error) {
        terminateDelivery(client, error);
      }
      return;
    }
    const sequence = ports.snapshotSequence();
    const cutId = ++snapshotSerial;
    const snapshotId = `${ports.serverEpoch}:${sequence}:${cutId}`;
    const forceSinglePage = client.stateSnapshotOverflowed === true;
    client.stateSnapshotOverflowed = false;
    const frames = agentStateSnapshotFrames(
      {
        ...state,
        projectAgentSummaries: summaries,
      } as AgentStatePayload,
      snapshotId,
      forceSinglePage ? Math.max(1, state.agents.length) : ports.initialPageSize,
      forceSinglePage ? Math.max(1, state.agents.length) : ports.pageSize,
    )[Symbol.iterator]();
    client.stateSnapshotCutId = cutId;
    client.stateSnapshotInProgress = true;
    client.stateSnapshotPending = false;
    client.stateSnapshotMessageBytes = 0;
    client.stateSnapshotMessages = [];
    const activityScope = normalizeAgentActivityScope(client.activityScope);
    const agentSnapshotCoversActivity = activityScope === 'none'
      || stateScope === 'all'
      || (activityScope === 'focused' && Boolean(client.focusedAgentId));
    if (agentSnapshotCoversActivity) {
      client.agentActivityAllCheckpointPending = false;
      client.agentActivityCheckpointPending = false;
      client.agentActivityResyncPending = false;
    } else if (client.agentActivityResyncPending) {
      if (activityScope === 'all') client.agentActivityAllCheckpointPending = true;
      else if (activityScope === 'focused') client.agentActivityCheckpointPending = true;
    }

    // A cut only owns the client while the client still points at its identity:
    // a terminated cut, or one superseded by a newer cut, loses ownership, so a
    // stale timer callback cannot clear timers, send frames, or release recovery.
    const ownsCut = () => client.stateSnapshotCutId === cutId;
    const guardCutSend = (perform: () => void, owned?: DeferredAgentStateMessage[]): boolean => {
      try {
        perform();
        return true;
      } catch (error) {
        terminateDelivery(client, error, owned);
        return false;
      }
    };
    const queueNextPage = (delayMs: number, callback: () => void = deliverNextPage) => {
      if (client.stateSnapshotRetryTimer) {
        ports.clearTimer(client.stateSnapshotRetryTimer as WebSocketAgentStateSnapshotTimer);
      }
      const timer = ports.setTimer(callback, delayMs);
      client.stateSnapshotRetryTimer = timer;
      timer.unref?.();
    };
    const finishSnapshotDelivery = () => {
      client.stateSnapshotInProgress = false;
      client.stateSnapshotRetryTimer = null;
      ports.recoverAgentActivity(client);
      ports.recoverAcpSessionRevision(client);
      ports.queuePreviewHydration(
        client,
        ports.previewHydrationWindowMs,
        () => {
          if (ownsCut() && client.readyState === ports.openState) ports.sendPreviewHydration(client);
        },
      );
    };
    const restartPendingSnapshot = () => {
      if (!client.stateSnapshotPending) return false;
      const claimed = client.stateSnapshotMessages ?? [];
      client.stateSnapshotMessageBytes = 0;
      client.stateSnapshotMessages = [];
      client.stateSnapshotInProgress = false;
      discardClaimedQueue(claimed);
      sendState(client);
      return true;
    };
    const drainSnapshotDeltas = () => {
      if (!ownsCut()) return;
      client.stateSnapshotRetryTimer = null;
      if (client.readyState !== ports.openState) {
        client.stateSnapshotInProgress = false;
        return;
      }
      if (restartPendingSnapshot()) return;
      if (client.bufferedAmount > ports.maxBufferedAmount) {
        queueNextPage(ports.backpressureRetryMs, drainSnapshotDeltas);
        return;
      }
      const queued = client.stateSnapshotMessages?.[0];
      if (!queued) {
        client.stateSnapshotMessageBytes = 0;
        finishSnapshotDelivery();
        return;
      }
      if (
        Number.isFinite(queued.maxBufferedAmount)
        && client.bufferedAmount > Number(queued.maxBufferedAmount)
      ) {
        queueNextPage(ports.backpressureRetryMs, drainSnapshotDeltas);
        return;
      }
      client.stateSnapshotMessages?.shift();
      client.stateSnapshotMessageBytes = Math.max(
        0,
        (client.stateSnapshotMessageBytes || 0) - Buffer.byteLength(queued.message),
      );
      // The dequeued entry is now solely owned here: it is never reinserted, so
      // its cleanup runs exactly once on whichever path claims it.
      let relevant = true;
      if (queued.isRelevant) {
        try {
          relevant = Boolean(queued.isRelevant());
        } catch {
          relevant = false;
        }
      }
      if (!relevant) {
        // The entry is already claimed here, so a throwing discard is a terminal
        // cleanup failure for this cut and must not be re-owned by termination.
        const discardFailure = safeInvoke(queued.onDiscard);
        if (discardFailure) {
          terminateDelivery(client, discardFailure.error);
          return;
        }
        queueNextPage(0, drainSnapshotDeltas);
        return;
      }
      const delivered = guardCutSend(() => client.send(queued.message), [queued]);
      if (!delivered) return;
      safeInvoke(queued.onSent);
      queueNextPage(0, drainSnapshotDeltas);
    };
    const completeSnapshot = () => {
      client.stateSnapshotRetryTimer = null;
      if (forceSinglePage) {
        // The overflow fallback is emitted synchronously as one complete frame,
        // so no post-cut message can exist yet. Release the barrier immediately;
        // later sends remain ordered behind that frame by the WebSocket transport.
        finishSnapshotDelivery();
        return;
      }
      drainSnapshotDeltas();
    };
    let sentPages = 0;
    function deliverNextPage() {
      if (!ownsCut()) return;
      client.stateSnapshotRetryTimer = null;
      if (client.readyState !== ports.openState) {
        client.stateSnapshotInProgress = false;
        return;
      }
      if (restartPendingSnapshot()) return;
      if (sentPages > 0 && client.bufferedAmount > ports.maxBufferedAmount) {
        queueNextPage(ports.backpressureRetryMs);
        return;
      }
      const next = frames.next();
      if (next.done) {
        completeSnapshot();
        return;
      }
      const delivered = guardCutSend(() => client.send(JSON.stringify({
        type: 'state',
        generation: ports.serverEpoch,
        sequence,
        ...next.value,
      })));
      if (!delivered) return;
      sentPages += 1;
      if (next.value.snapshot.complete) {
        completeSnapshot();
        return;
      }
      queueNextPage(sentPages === 1 ? ports.initialFollowupDelayMs : 0);
    }
    deliverNextPage();
  }

  function queueInitialSnapshot(client: Client): void {
    if (client.initialStateSnapshotSent === true || client.initialStateSnapshotTimer) return;
    const timer = ports.setTimer(() => {
      client.initialStateSnapshotTimer = null;
      if (client.readyState === ports.openState && client.initialStateSnapshotSent !== true) {
        sendState(client);
      }
    }, ports.scopeDeclarationWindowMs);
    client.initialStateSnapshotTimer = timer;
    timer.unref?.();
  }

  function recoverSnapshotIfReady(client: Client): void {
    if (
      client.readyState !== ports.openState
      || client.stateSnapshotInProgress
      || client.stateSnapshotPending !== true
    ) return;
    if (client.bufferedAmount <= ports.maxBufferedAmount) sendState(client);
  }

  function dispose(client: Client): void {
    if (client.initialStateSnapshotTimer) {
      ports.clearTimer(client.initialStateSnapshotTimer as WebSocketAgentStateSnapshotTimer);
    }
    if (client.stateSnapshotRetryTimer) {
      ports.clearTimer(client.stateSnapshotRetryTimer as WebSocketAgentStateSnapshotTimer);
    }
    client.stateSnapshotMessageBytes = 0;
    const claimed = client.stateSnapshotMessages ?? [];
    client.stateSnapshotMessages = [];
    client.stateSnapshotRetryTimer = null;
    client.initialStateSnapshotTimer = null;
    client.stateSnapshotCutId = null;
    client.stateSnapshotInProgress = false;
    client.stateSnapshotOverflowed = false;
    discardClaimedQueue(claimed);
  }

  return { dispose, queueInitialSnapshot, recoverSnapshotIfReady, sendState };
}

export {
  createWebSocketAgentStateSnapshotController,
  type WebSocketAgentStateSnapshotClient,
  type WebSocketAgentStateSnapshotController,
  type WebSocketAgentStateSnapshotPorts,
};
