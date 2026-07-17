const DEFAULT_TERMINAL_EXIT_DATA_FLUSH_MS = 250;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function acceptTerminalExitData(session) {
  if (!session || session.exitDataClosed === true) return false;
  if (session.exitFinalizing === true) {
    session.exitDataGeneration = (session.exitDataGeneration || 0) + 1;
  }
  return true;
}

async function waitForTerminalExitDataQuiescence(session, options = {}) {
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  const flushMs = Number.isFinite(options.flushMs)
    ? Math.max(1, Math.floor(options.flushMs))
    : DEFAULT_TERMINAL_EXIT_DATA_FLUSH_MS;
  session.exitFinalizing = true;
  session.exitDataGeneration = session.exitDataGeneration || 0;

  for (;;) {
    const observedGeneration = session.exitDataGeneration;
    await delay(flushMs);
    if (!isCurrent()) return false;
    if (session.exitDataGeneration !== observedGeneration) continue;
    // This synchronous cut closes late-data admission before the reducer is
    // drained and its final checkpoint is captured.
    session.exitDataClosed = true;
    return true;
  }
}

module.exports = {
  DEFAULT_TERMINAL_EXIT_DATA_FLUSH_MS,
  acceptTerminalExitData,
  waitForTerminalExitDataQuiescence,
};
