const BACKEND_INITIAL_CONNECT_GRACE_MS = 3000;
const BACKEND_HEARTBEAT_STALE_MS = 6000;

function classifyBackendConnection({
  connected,
  everConnected,
  lastMessageAt,
  visibleSince,
  now,
}) {
  const observationStartedAt = Math.max(lastMessageAt, visibleSince);
  const elapsed = Math.max(0, now - observationStartedAt);
  if (!connected && everConnected) return 'lost';
  if (!connected && elapsed >= BACKEND_INITIAL_CONNECT_GRACE_MS) return 'connecting';
  if (connected && elapsed >= BACKEND_HEARTBEAT_STALE_MS) return 'stale';
  return null;
}

function reducePageVisibilitySnapshot(current, {
  eventType,
  documentVisible,
  changedAt,
}) {
  const visible = eventType === 'pagehide' ? false : documentVisible;
  if (visible === current.visible) {
    if (!visible || eventType !== 'pageshow') return current;
    return { visible: true, visibleSince: changedAt };
  }
  return {
    visible,
    visibleSince: visible ? changedAt : current.visibleSince,
  };
}

module.exports = {
  BACKEND_INITIAL_CONNECT_GRACE_MS,
  BACKEND_HEARTBEAT_STALE_MS,
  classifyBackendConnection,
  reducePageVisibilitySnapshot,
};
