const crypto = require('crypto');

const DEFAULT_CONTROLLER_LEASE_TTL_MS = 30000;
const MIN_CONTROLLER_LEASE_TTL_MS = 5000;
const MAX_CONTROLLER_LEASE_TTL_MS = 60000;

function finitePositiveInteger(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeLeaseTtl(value) {
  return Math.max(
    MIN_CONTROLLER_LEASE_TTL_MS,
    Math.min(MAX_CONTROLLER_LEASE_TTL_MS, finitePositiveInteger(value, DEFAULT_CONTROLLER_LEASE_TTL_MS)),
  );
}

function createTerminalControllerLease() {
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

function terminalControllerState(session, status, extra = {}) {
  const control = session.controllerLease || createTerminalControllerLease();
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

function invalidateTerminalController(session, reason = 'invalidated') {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  control.fence += 1;
  control.ownerKey = '';
  control.claimId = '';
  control.leaseId = '';
  control.expiresAt = 0;
  control.runtimeEpoch = '';
  control.rendererReadyFence = 0;
  control.lastResizeRequestSeq = 0;
  control.lastResizeAck = null;
  return terminalControllerState(session, 'unowned', { reason });
}

function expireTerminalControllerIfNeeded(session, now = Date.now()) {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  if (!control.ownerKey || control.expiresAt > now) return false;
  invalidateTerminalController(session, 'lease-expired');
  return true;
}

function claimTerminalController(session, options = {}) {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  const ownerKey = typeof options.ownerKey === 'string' ? options.ownerKey : '';
  const claimId = typeof options.claimId === 'string' ? options.claimId : '';
  if (!ownerKey || !claimId) {
    return terminalControllerState(session, 'rejected', { reason: 'invalid-claim' });
  }
  if (
    options.expectedRuntimeEpoch &&
    options.expectedRuntimeEpoch !== session.runtimeEpoch
  ) {
    return terminalControllerState(session, 'rejected', { reason: 'runtime-epoch-mismatch' });
  }

  expireTerminalControllerIfNeeded(session);
  const ttlMs = normalizeLeaseTtl(options.ttlMs);
  if (control.ownerKey && control.runtimeEpoch !== session.runtimeEpoch) {
    invalidateTerminalController(session, 'runtime-epoch-mismatch');
  }
  if (control.ownerKey === ownerKey && control.claimId === claimId && control.leaseId) {
    control.expiresAt = Date.now() + ttlMs;
    return terminalControllerState(session, 'owner', { renewed: true });
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
  return terminalControllerState(session, 'owner', { renewed: false });
}

function validateTerminalControllerInput(session, options = {}) {
  if (options.kind === 'system') {
    return validateTerminalSystemMutation(session, options, 'input');
  }
  return validateTerminalControllerRendererMutation(session, options, 'input');
}

function validateTerminalControllerClear(session, options = {}) {
  if (options.kind === 'system') {
    return validateTerminalSystemMutation(session, options, 'clear');
  }
  return validateTerminalControllerRendererMutation(session, options, 'clear');
}

function validateTerminalControllerOutputAck(session, options = {}) {
  return validateTerminalControllerRendererMutation(session, options, 'output-ack');
}

function validateTerminalControllerCheckpointApplied(session, options = {}) {
  return validateTerminalControllerRendererMutation(session, options, 'checkpoint-applied');
}

function validateTerminalControllerRendererReady(session, options = {}) {
  return validateTerminalControllerMutation(session, options, 'renderer-ready');
}

function validateTerminalSystemMutation(session, options, operation) {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  expireTerminalControllerIfNeeded(session);
  if (control.ownerKey) {
    return terminalControllerState(session, `${operation}-rejected`, {
      reason: 'terminal-controlled-by-browser',
    });
  }
  if (
    !options.expectedRuntimeEpoch ||
    options.expectedRuntimeEpoch !== session.runtimeEpoch
  ) {
    return terminalControllerState(session, `${operation}-rejected`, {
      reason: 'runtime-epoch-mismatch',
    });
  }
  return terminalControllerState(session, `${operation}-accepted`, {
    system: true,
  });
}

function validateTerminalControllerMutation(session, options, operation) {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  expireTerminalControllerIfNeeded(session);
  if (!control.ownerKey) {
    return terminalControllerState(session, `${operation}-rejected`, { reason: 'unowned' });
  }
  if (
    control.ownerKey !== options.ownerKey ||
    control.leaseId !== options.leaseId ||
    control.fence !== options.fence
  ) {
    return terminalControllerState(session, `${operation}-rejected`, { reason: 'stale-lease' });
  }
  if (
    !control.runtimeEpoch ||
    control.runtimeEpoch !== session.runtimeEpoch ||
    options.expectedRuntimeEpoch !== control.runtimeEpoch
  ) {
    return terminalControllerState(session, `${operation}-rejected`, { reason: 'runtime-epoch-mismatch' });
  }
  return terminalControllerState(session, `${operation}-accepted`);
}

function validateTerminalControllerRendererMutation(session, options, operation) {
  const result = validateTerminalControllerMutation(session, options, operation);
  if (
    result.status === `${operation}-accepted` &&
    session.controllerLease?.rendererReadyFence !== options.fence
  ) {
    return terminalControllerState(session, `${operation}-rejected`, { reason: 'renderer-not-ready' });
  }
  return result;
}

function renewTerminalController(session, options = {}) {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  expireTerminalControllerIfNeeded(session);
  if (
    !control.ownerKey ||
    control.ownerKey !== options.ownerKey ||
    control.leaseId !== options.leaseId ||
    control.fence !== options.fence
  ) {
    return terminalControllerState(session, 'rejected', { reason: 'stale-lease' });
  }
  if (
    !control.runtimeEpoch ||
    control.runtimeEpoch !== session.runtimeEpoch ||
    options.expectedRuntimeEpoch !== control.runtimeEpoch
  ) {
    return terminalControllerState(session, 'rejected', { reason: 'runtime-epoch-mismatch' });
  }
  control.expiresAt = Date.now() + normalizeLeaseTtl(options.ttlMs);
  return terminalControllerState(session, 'owner', { renewed: true });
}

function releaseTerminalController(session, options = {}) {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  const matchesCurrentLease = Boolean(control.ownerKey)
    && control.ownerKey === options.ownerKey
    && control.leaseId === options.leaseId
    && control.fence === options.fence;
  if (!matchesCurrentLease) {
    expireTerminalControllerIfNeeded(session);
    return terminalControllerState(session, 'rejected', { reason: 'stale-lease' });
  }
  return invalidateTerminalController(session, options.reason || 'released');
}

function beginTerminalControllerResize(session, options = {}) {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  expireTerminalControllerIfNeeded(session);
  if (!control.ownerKey) {
    return { accepted: false, result: terminalControllerState(session, 'resize-rejected', { reason: 'unowned' }) };
  }
  if (
    control.ownerKey !== options.ownerKey ||
    control.leaseId !== options.leaseId ||
    control.fence !== options.fence
  ) {
    return { accepted: false, result: terminalControllerState(session, 'resize-rejected', { reason: 'stale-lease' }) };
  }
  if (
    !control.runtimeEpoch ||
    control.runtimeEpoch !== session.runtimeEpoch ||
    options.expectedRuntimeEpoch !== control.runtimeEpoch
  ) {
    return { accepted: false, result: terminalControllerState(session, 'resize-rejected', { reason: 'runtime-epoch-mismatch' }) };
  }
  if (control.rendererReadyFence !== options.fence) {
    return {
      accepted: false,
      result: terminalControllerState(session, 'resize-rejected', { reason: 'renderer-not-ready' }),
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
      result: terminalControllerState(session, 'resize-rejected', {
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

function terminalControllerResizeTokenMatches(session, token) {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  return Boolean(token)
    && control.ownerKey === token.ownerKey
    && control.leaseId === token.leaseId
    && control.fence === token.fence
    && control.lastResizeRequestSeq === token.requestSeq
    && session.runtimeEpoch === token.runtimeEpoch;
}

function commitTerminalControllerResize(session, requestSeq, extra = {}, token = null) {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  if (token && !terminalControllerResizeTokenMatches(session, token)) {
    return terminalControllerState(session, 'resize-rejected', {
      reason: 'controller-replaced',
      requestSeq,
      resized: false,
    });
  }
  const result = terminalControllerState(session, 'resize-committed', {
    requestSeq,
    ...extra,
  });
  control.lastResizeAck = result;
  return result;
}

function rejectTerminalControllerResize(session, requestSeq, reason, extra = {}, token = null) {
  const control = session.controllerLease || (session.controllerLease = createTerminalControllerLease());
  if (token && !terminalControllerResizeTokenMatches(session, token)) {
    return terminalControllerState(session, 'resize-rejected', {
      reason: 'controller-replaced',
      requestSeq,
      resized: false,
    });
  }
  const result = terminalControllerState(session, 'resize-rejected', {
    reason,
    requestSeq,
    resized: false,
    ...extra,
  });
  control.lastResizeAck = result;
  return result;
}

module.exports = {
  DEFAULT_CONTROLLER_LEASE_TTL_MS,
  MAX_CONTROLLER_LEASE_TTL_MS,
  beginTerminalControllerResize,
  claimTerminalController,
  commitTerminalControllerResize,
  createTerminalControllerLease,
  expireTerminalControllerIfNeeded,
  invalidateTerminalController,
  rejectTerminalControllerResize,
  releaseTerminalController,
  renewTerminalController,
  terminalControllerResizeTokenMatches,
  terminalControllerState,
  validateTerminalControllerClear,
  validateTerminalControllerCheckpointApplied,
  validateTerminalControllerInput,
  validateTerminalControllerOutputAck,
  validateTerminalControllerRendererReady,
  validateTerminalSystemMutation,
};
