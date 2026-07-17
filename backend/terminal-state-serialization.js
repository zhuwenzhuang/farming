const TERMINAL_STATE_VERSION = 1;
const MAX_SERIALIZED_TERMINAL_STATE_BYTES = 32 * 1024 * 1024;
const MAX_REPLAY_EVENT_BYTES = 8 * 1024 * 1024;

function finitePositiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeReplayEvent(replayEvent) {
  const events = Array.isArray(replayEvent?.events) ? replayEvent.events : [];
  if (events.length !== 1) {
    throw new Error('Serialized terminal state requires exactly one replay event');
  }
  const event = events[0] || {};
  const data = typeof event.data === 'string' ? event.data : '';
  if (Buffer.byteLength(data, 'utf8') > MAX_REPLAY_EVENT_BYTES) {
    throw new Error('Serialized terminal replay event exceeds the size limit');
  }
  return {
    events: [{
      data,
      cols: finitePositiveInteger(event.cols, 80),
      rows: finitePositiveInteger(event.rows, 30),
    }],
  };
}

function normalizeTerminalStateEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Serialized terminal state entry must be an object');
  }
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) {
    throw new Error('Serialized terminal state has an invalid session id');
  }
  const metadata = entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
    ? { ...entry.metadata }
    : {};
  const processDetails = entry.processDetails && typeof entry.processDetails === 'object'
    ? entry.processDetails
    : {};
  const processLaunchConfig = entry.processLaunchConfig && typeof entry.processLaunchConfig === 'object'
    ? entry.processLaunchConfig
    : {};
  return {
    id,
    metadata: {
      ...metadata,
      agentId: id,
    },
    processDetails: {
      cwd: typeof processDetails.cwd === 'string' ? processDetails.cwd : '',
      title: typeof processDetails.title === 'string' ? processDetails.title : '',
    },
    processLaunchConfig: {
      command: typeof processLaunchConfig.command === 'string' ? processLaunchConfig.command : '',
      args: Array.isArray(processLaunchConfig.args)
        ? processLaunchConfig.args.filter(arg => typeof arg === 'string')
        : [],
      category: typeof processLaunchConfig.category === 'string' ? processLaunchConfig.category : '',
    },
    replayEvent: normalizeReplayEvent(entry.replayEvent),
    timestamp: Number.isFinite(Number(entry.timestamp))
      ? Math.max(0, Math.floor(Number(entry.timestamp)))
      : Date.now(),
  };
}

function serializeTerminalState(entries) {
  const state = (Array.isArray(entries) ? entries : []).map(normalizeTerminalStateEntry);
  const ids = new Set();
  for (const entry of state) {
    if (ids.has(entry.id)) {
      throw new Error(`Serialized terminal state contains duplicate session id ${entry.id}`);
    }
    ids.add(entry.id);
  }
  const serialized = JSON.stringify({
    version: TERMINAL_STATE_VERSION,
    state,
  });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_TERMINAL_STATE_BYTES) {
    throw new Error('Serialized terminal state exceeds the size limit');
  }
  return serialized;
}

function deserializeTerminalState(serialized) {
  if (typeof serialized !== 'string' || !serialized) return [];
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_TERMINAL_STATE_BYTES) {
    throw new Error('Serialized terminal state exceeds the size limit');
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Serialized terminal state is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== TERMINAL_STATE_VERSION || !Array.isArray(parsed.state)) {
    throw new Error('Serialized terminal state has an unsupported format or version');
  }
  const state = parsed.state.map(normalizeTerminalStateEntry);
  const ids = new Set();
  for (const entry of state) {
    if (ids.has(entry.id)) {
      throw new Error(`Serialized terminal state contains duplicate session id ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return state;
}

function terminalReplayText(entry) {
  const normalized = normalizeTerminalStateEntry(entry);
  return normalized.replayEvent.events[0].data;
}

module.exports = {
  MAX_REPLAY_EVENT_BYTES,
  MAX_SERIALIZED_TERMINAL_STATE_BYTES,
  TERMINAL_STATE_VERSION,
  deserializeTerminalState,
  normalizeTerminalStateEntry,
  serializeTerminalState,
  terminalReplayText,
};
