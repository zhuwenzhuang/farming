const BACKEND_INITIAL_CONNECT_GRACE_MS = 3000;
const BACKEND_HEARTBEAT_STALE_MS = 6000;
const BACKEND_OBSERVER_LAG_RESET_MS = 2500;

function advanceBackendObservation(current, observedAt) {
  const now = Number.isFinite(observedAt) ? observedAt : Date.now();
  const previousNow = Number.isFinite(current?.now) ? current.now : now;
  const continuousSince = Number.isFinite(current?.continuousSince)
    ? current.continuousSince
    : previousNow;
  return {
    now,
    continuousSince: now - previousNow > BACKEND_OBSERVER_LAG_RESET_MS
      ? now
      : continuousSince,
  };
}

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
  BACKEND_OBSERVER_LAG_RESET_MS,
  advanceBackendObservation,
  classifyBackendConnection,
  reducePageVisibilitySnapshot,
};
