interface DeferredAgentStateMessage {
  isRelevant?: () => boolean;
  maxBufferedAmount?: number;
  message: string;
  onDiscard?: () => void;
  onSent?: () => void;
}

function deliverDeferredAgentStateMessage(
  deferred: DeferredAgentStateMessage,
  send: (message: string) => void,
): boolean {
  if (deferred.isRelevant && !deferred.isRelevant()) {
    deferred.onDiscard?.();
    return false;
  }
  send(deferred.message);
  deferred.onSent?.();
  return true;
}

interface AgentStateSnapshotMessageQueue {
  stateSnapshotInProgress?: boolean;
  stateSnapshotMessageBytes?: number;
  stateSnapshotMessages?: DeferredAgentStateMessage[];
  stateSnapshotOverflowed?: boolean;
  stateSnapshotPending?: boolean;
}

function deferAgentStateMessageDuringSnapshot(
  client: AgentStateSnapshotMessageQueue,
  deferred: DeferredAgentStateMessage,
  limits: { maxBytes: number; maxCount: number },
): boolean {
  if (client.stateSnapshotInProgress !== true) return false;
  if (client.stateSnapshotPending === true) {
    deferred.onDiscard?.();
    return true;
  }

  const messageBytes = Buffer.byteLength(deferred.message);
  const queuedMessages = client.stateSnapshotMessages || [];
  const queuedBytes = client.stateSnapshotMessageBytes || 0;
  if (
    queuedMessages.length >= limits.maxCount
    || queuedBytes + messageBytes > limits.maxBytes
  ) {
    queuedMessages.forEach(queued => queued.onDiscard?.());
    deferred.onDiscard?.();
    client.stateSnapshotOverflowed = true;
    client.stateSnapshotPending = true;
    client.stateSnapshotMessageBytes = 0;
    client.stateSnapshotMessages = [];
    return true;
  }

  queuedMessages.push(deferred);
  client.stateSnapshotMessages = queuedMessages;
  client.stateSnapshotMessageBytes = queuedBytes + messageBytes;
  return true;
}

export {
  deferAgentStateMessageDuringSnapshot,
  deliverDeferredAgentStateMessage,
};

export type {
  AgentStateSnapshotMessageQueue,
  DeferredAgentStateMessage,
};
