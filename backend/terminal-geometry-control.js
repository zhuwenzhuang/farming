const crypto = require('crypto');

const DEFAULT_GEOMETRY_LEASE_TTL_MS = 30000;
const MIN_GEOMETRY_LEASE_TTL_MS = 5000;
const MAX_GEOMETRY_LEASE_TTL_MS = 60000;

function finitePositiveInteger(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeLeaseTtl(value) {
  return Math.max(
    MIN_GEOMETRY_LEASE_TTL_MS,
    Math.min(MAX_GEOMETRY_LEASE_TTL_MS, finitePositiveInteger(value, DEFAULT_GEOMETRY_LEASE_TTL_MS)),
  );
}

function createTerminalGeometryControl() {
  return {
    fence: 0,
    ownerKey: '',
    claimId: '',
    leaseId: '',
    expiresAt: 0,
    runtimeEpoch: '',
    rendererReadyFence: 0,
    lastResizeRequestSeq: 0,
    lastResizeAck: null,
  };
}

function terminalGeometryState(session, status, extra = {}) {
  const control = session.geometryControl || createTerminalGeometryControl();
  return {
    status,
    ownerKey: control.ownerKey,
    leaseId: control.leaseId,
    fence: control.fence,
    expiresAt: control.expiresAt,
    claimedRuntimeEpoch: control.runtimeEpoch,
    ...extra,
  };
}

function invalidateTerminalGeometry(session, reason = 'invalidated') {
  const control = session.geometryControl || (session.geometryControl = createTerminalGeometryControl());
  control.fence += 1;
  control.ownerKey = '';
  control.claimId = '';
  control.leaseId = '';
  control.expiresAt = 0;
  control.runtimeEpoch = '';
  control.rendererReadyFence = 0;
  control.lastResizeRequestSeq = 0;
  control.lastResizeAck = null;
  return terminalGeometryState(session, 'unowned', { reason });
}

function expireTerminalGeometryIfNeeded(session, now = Date.now()) {
  const control = session.geometryControl || (session.geometryControl = createTerminalGeometryControl());
  if (!control.ownerKey || control.expiresAt > now) return false;
  invalidateTerminalGeometry(session, 'lease-expired');
  return true;
}

function claimTerminalGeometry(session, options = {}) {
  const control = session.geometryControl || (session.geometryControl = createTerminalGeometryControl());
  const ownerKey = typeof options.ownerKey === 'string' ? options.ownerKey : '';
  const claimId = typeof options.claimId === 'string' ? options.claimId : '';
  if (!ownerKey || !claimId) {
    return terminalGeometryState(session, 'rejected', { reason: 'invalid-claim' });
  }
  if (
    options.expectedRuntimeEpoch &&
    options.expectedRuntimeEpoch !== session.runtimeEpoch
  ) {
    return terminalGeometryState(session, 'rejected', { reason: 'runtime-epoch-mismatch' });
  }

  expireTerminalGeometryIfNeeded(session);
  const ttlMs = normalizeLeaseTtl(options.ttlMs);
  if (control.ownerKey && control.runtimeEpoch !== session.runtimeEpoch) {
    invalidateTerminalGeometry(session, 'runtime-epoch-mismatch');
  }
  if (control.ownerKey === ownerKey && control.claimId === claimId && control.leaseId) {
    control.expiresAt = Date.now() + ttlMs;
    return terminalGeometryState(session, 'owner', { renewed: true });
  }

  control.fence += 1;
  control.ownerKey = ownerKey;
  control.claimId = claimId;
  control.leaseId = crypto.randomUUID();
  control.expiresAt = Date.now() + ttlMs;
  control.runtimeEpoch = session.runtimeEpoch || '';
  control.rendererReadyFence = 0;
  control.lastResizeRequestSeq = 0;
  control.lastResizeAck = null;
  return terminalGeometryState(session, 'owner', { renewed: false });
}

function validateTerminalGeometryInput(session, options = {}) {
  return validateTerminalGeometryRendererMutation(session, options, 'input');
}

function validateTerminalGeometryClear(session, options = {}) {
  return validateTerminalGeometryRendererMutation(session, options, 'clear');
}

function validateTerminalGeometryOutputAck(session, options = {}) {
  return validateTerminalGeometryRendererMutation(session, options, 'output-ack');
}

function validateTerminalGeometryRendererReady(session, options = {}) {
  return validateTerminalGeometryMutation(session, options, 'renderer-ready');
}

function validateTerminalGeometryMutation(session, options, operation) {
  const control = session.geometryControl || (session.geometryControl = createTerminalGeometryControl());
  expireTerminalGeometryIfNeeded(session);
  if (!control.ownerKey) {
    return terminalGeometryState(session, `${operation}-rejected`, { reason: 'unowned' });
  }
  if (
    control.ownerKey !== options.ownerKey ||
    control.leaseId !== options.leaseId ||
    control.fence !== options.fence
  ) {
    return terminalGeometryState(session, `${operation}-rejected`, { reason: 'stale-lease' });
  }
  if (
    !control.runtimeEpoch ||
    control.runtimeEpoch !== session.runtimeEpoch ||
    options.expectedRuntimeEpoch !== control.runtimeEpoch
  ) {
    return terminalGeometryState(session, `${operation}-rejected`, { reason: 'runtime-epoch-mismatch' });
  }
  return terminalGeometryState(session, `${operation}-accepted`);
}

function validateTerminalGeometryRendererMutation(session, options, operation) {
  const result = validateTerminalGeometryMutation(session, options, operation);
  if (
    result.status === `${operation}-accepted` &&
    session.geometryControl?.rendererReadyFence !== options.fence
  ) {
    return terminalGeometryState(session, `${operation}-rejected`, { reason: 'renderer-not-ready' });
  }
  return result;
}

function renewTerminalGeometry(session, options = {}) {
  const control = session.geometryControl || (session.geometryControl = createTerminalGeometryControl());
  expireTerminalGeometryIfNeeded(session);
  if (
    !control.ownerKey ||
    control.ownerKey !== options.ownerKey ||
    control.leaseId !== options.leaseId ||
    control.fence !== options.fence
  ) {
    return terminalGeometryState(session, 'rejected', { reason: 'stale-lease' });
  }
  if (
    !control.runtimeEpoch ||
    control.runtimeEpoch !== session.runtimeEpoch ||
    options.expectedRuntimeEpoch !== control.runtimeEpoch
  ) {
    return terminalGeometryState(session, 'rejected', { reason: 'runtime-epoch-mismatch' });
  }
  control.expiresAt = Date.now() + normalizeLeaseTtl(options.ttlMs);
  return terminalGeometryState(session, 'owner', { renewed: true });
}

function releaseTerminalGeometry(session, options = {}) {
  const control = session.geometryControl || (session.geometryControl = createTerminalGeometryControl());
  const matchesCurrentLease = Boolean(control.ownerKey)
    && control.ownerKey === options.ownerKey
    && control.leaseId === options.leaseId
    && control.fence === options.fence;
  if (!matchesCurrentLease) {
    expireTerminalGeometryIfNeeded(session);
    return terminalGeometryState(session, 'rejected', { reason: 'stale-lease' });
  }
  return invalidateTerminalGeometry(session, options.reason || 'released');
}

function beginTerminalGeometryResize(session, options = {}) {
  const control = session.geometryControl || (session.geometryControl = createTerminalGeometryControl());
  expireTerminalGeometryIfNeeded(session);
  if (!control.ownerKey) {
    return { accepted: false, result: terminalGeometryState(session, 'resize-rejected', { reason: 'unowned' }) };
  }
  if (
    control.ownerKey !== options.ownerKey ||
    control.leaseId !== options.leaseId ||
    control.fence !== options.fence
  ) {
    return { accepted: false, result: terminalGeometryState(session, 'resize-rejected', { reason: 'stale-lease' }) };
  }
  if (
    !control.runtimeEpoch ||
    control.runtimeEpoch !== session.runtimeEpoch ||
    options.expectedRuntimeEpoch !== control.runtimeEpoch
  ) {
    return { accepted: false, result: terminalGeometryState(session, 'resize-rejected', { reason: 'runtime-epoch-mismatch' }) };
  }
  if (control.rendererReadyFence !== options.fence) {
    return {
      accepted: false,
      result: terminalGeometryState(session, 'resize-rejected', { reason: 'renderer-not-ready' }),
    };
  }

  const requestSeq = finitePositiveInteger(options.requestSeq);
  if (
    requestSeq === control.lastResizeRequestSeq &&
    control.lastResizeAck
  ) {
    return { accepted: false, duplicate: true, result: { ...control.lastResizeAck, duplicate: true } };
  }
  if (requestSeq !== control.lastResizeRequestSeq + 1) {
    return {
      accepted: false,
      result: terminalGeometryState(session, 'resize-rejected', {
        reason: requestSeq === control.lastResizeRequestSeq ? 'resize-in-progress' : 'request-sequence-gap',
        requestSeq,
      }),
    };
  }

  control.lastResizeRequestSeq = requestSeq;
  control.lastResizeAck = null;
  return {
    accepted: true,
    requestSeq,
    token: {
      ownerKey: control.ownerKey,
      leaseId: control.leaseId,
      fence: control.fence,
      requestSeq,
      runtimeEpoch: session.runtimeEpoch,
    },
  };
}

function terminalGeometryResizeTokenMatches(session, token) {
  const control = session.geometryControl || (session.geometryControl = createTerminalGeometryControl());
  return Boolean(token)
    && control.ownerKey === token.ownerKey
    && control.leaseId === token.leaseId
    && control.fence === token.fence
    && control.lastResizeRequestSeq === token.requestSeq
    && session.runtimeEpoch === token.runtimeEpoch;
}

function commitTerminalGeometryResize(session, requestSeq, extra = {}, token = null) {
  const control = session.geometryControl || (session.geometryControl = createTerminalGeometryControl());
  if (token && !terminalGeometryResizeTokenMatches(session, token)) {
    return terminalGeometryState(session, 'resize-rejected', {
      reason: 'controller-replaced',
      requestSeq,
      resized: false,
    });
  }
  const result = terminalGeometryState(session, 'resize-committed', {
    requestSeq,
    ...extra,
  });
  control.lastResizeAck = result;
  return result;
}

function rejectTerminalGeometryResize(session, requestSeq, reason, extra = {}, token = null) {
  const control = session.geometryControl || (session.geometryControl = createTerminalGeometryControl());
  if (token && !terminalGeometryResizeTokenMatches(session, token)) {
    return terminalGeometryState(session, 'resize-rejected', {
      reason: 'controller-replaced',
      requestSeq,
      resized: false,
    });
  }
  const result = terminalGeometryState(session, 'resize-rejected', {
    reason,
    requestSeq,
    resized: false,
    ...extra,
  });
  control.lastResizeAck = result;
  return result;
}

module.exports = {
  DEFAULT_GEOMETRY_LEASE_TTL_MS,
  beginTerminalGeometryResize,
  claimTerminalGeometry,
  commitTerminalGeometryResize,
  createTerminalGeometryControl,
  expireTerminalGeometryIfNeeded,
  invalidateTerminalGeometry,
  rejectTerminalGeometryResize,
  releaseTerminalGeometry,
  renewTerminalGeometry,
  terminalGeometryResizeTokenMatches,
  terminalGeometryState,
  validateTerminalGeometryClear,
  validateTerminalGeometryInput,
  validateTerminalGeometryOutputAck,
  validateTerminalGeometryRendererReady,
};
