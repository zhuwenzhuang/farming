const BACKEND_INITIAL_CONNECT_GRACE_MS = 8000;

function classifyBackendConnection({
  connected,
  lastMessageAt,
  disconnectedAt,
  visibleSince,
  now,
  businessStatus,
}) {
  // Application traffic is not a heartbeat. A connected socket can stay quiet
  // while the Agent is working; transport loss comes only from WebSocket close,
  // while business failure comes only from the explicit request/ack probe.
  if (connected) {
    if (businessStatus === 'recovering') return 'business-recovering';
    return ['failed', 'stopping', 'unresponsive'].includes(businessStatus)
      ? 'business-unavailable'
      : null;
  }

  const disconnectObservedAt = Number.isFinite(disconnectedAt)
    ? disconnectedAt
    : lastMessageAt;
  const disconnectedElapsed = Math.max(
    0,
    now - Math.max(disconnectObservedAt, visibleSince),
  );
  return disconnectedElapsed >= BACKEND_INITIAL_CONNECT_GRACE_MS
    ? 'lost'
    : 'connecting';
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
  classifyBackendConnection,
  reducePageVisibilitySnapshot,
};
