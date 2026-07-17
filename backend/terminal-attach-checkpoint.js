const DEFAULT_TERMINAL_ATTACH_CHECKPOINT_TIMEOUT_MS = 2000;

function finiteNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function finitePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

async function captureTerminalAttachCheckpoint(session, options = {}) {
  if (
    !session
    || !session.screenWorker
    || session.stateProofAvailable === false
    || typeof session.runtimeEpoch !== 'string'
    || !session.runtimeEpoch
  ) {
    return null;
  }

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs))
    : DEFAULT_TERMINAL_ATTACH_CHECKPOINT_TIMEOUT_MS;
  const state = await session.screenWorker.getState({ timeoutMs }).catch(() => null);
  const outputSeq = finiteNonNegativeInteger(state?.outputSeq);
  const stateRevision = finiteNonNegativeInteger(state?.stateRevision);
  const currentOutputSeq = finiteNonNegativeInteger(session.outputSeq);
  const currentStateRevision = finiteNonNegativeInteger(session.stateRevision);
  const cols = finitePositiveInteger(state?.cols);
  const rows = finitePositiveInteger(state?.rows);

  if (
    !state
    || state.runtimeEpoch !== session.runtimeEpoch
    || outputSeq === null
    || stateRevision === null
    || currentOutputSeq === null
    || currentStateRevision === null
    || stateRevision < outputSeq
    || outputSeq > currentOutputSeq
    || stateRevision > currentStateRevision
    || cols === null
    || rows === null
    || typeof state.renderOutput !== 'string'
  ) {
    return null;
  }

  return {
    runtimeEpoch: state.runtimeEpoch,
    renderOutput: state.renderOutput,
    outputSeq,
    stateRevision,
    cols,
    rows,
    previewText: typeof state.previewText === 'string' ? state.previewText : '',
    previewSnapshot: state.previewSnapshot || null,
    title: typeof state.title === 'string' ? state.title : '',
  };
}

module.exports = {
  DEFAULT_TERMINAL_ATTACH_CHECKPOINT_TIMEOUT_MS,
  captureTerminalAttachCheckpoint,
};
