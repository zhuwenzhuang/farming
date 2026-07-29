const TERMINAL_STATE_VERSION = 1;
const MAX_SERIALIZED_TERMINAL_STATE_BYTES = 32 * 1024 * 1024;
const MAX_REPLAY_EVENT_BYTES = 8 * 1024 * 1024;

interface TerminalReplayEvent {
  data: string;
  cols: number;
  rows: number;
}

interface TerminalReplay {
  events: [TerminalReplayEvent];
}

interface SerializedTerminalStateEntry {
  id: string;
  metadata: Record<string, unknown> & { agentId: string };
  processDetails: {
    cwd: string;
    title: string;
  };
  processLaunchConfig: {
    command: string;
    args: string[];
    category: string;
  };
  replayEvent: TerminalReplay;
  timestamp: number;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finitePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeReplayEvent(replayEvent: unknown): TerminalReplay {
  const source = recordValue(replayEvent);
  const events = Array.isArray(source.events) ? source.events : [];
  if (events.length !== 1) {
    throw new Error('Serialized terminal state requires exactly one replay event');
  }
  const event = recordValue(events[0]);
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

function normalizeTerminalStateEntry(entry: unknown): SerializedTerminalStateEntry {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Serialized terminal state entry must be an object');
  }
  const source = entry as Record<string, unknown>;
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) {
    throw new Error('Serialized terminal state has an invalid session id');
  }
  const metadata = recordValue(source.metadata);
  const processDetails = recordValue(source.processDetails);
  const processLaunchConfig = recordValue(source.processLaunchConfig);
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
        ? processLaunchConfig.args.filter((arg): arg is string => typeof arg === 'string')
        : [],
      category: typeof processLaunchConfig.category === 'string' ? processLaunchConfig.category : '',
    },
    replayEvent: normalizeReplayEvent(source.replayEvent),
    timestamp: Number.isFinite(Number(source.timestamp))
      ? Math.max(0, Math.floor(Number(source.timestamp)))
      : Date.now(),
  };
}

function serializeTerminalState(entries: unknown): string {
  const state = (Array.isArray(entries) ? entries : []).map(normalizeTerminalStateEntry);
  const ids = new Set<string>();
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

function deserializeTerminalState(serialized: unknown): SerializedTerminalStateEntry[] {
  if (typeof serialized !== 'string' || !serialized) return [];
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_TERMINAL_STATE_BYTES) {
    throw new Error('Serialized terminal state exceeds the size limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Serialized terminal state is not valid JSON');
  }
  const envelope = recordValue(parsed);
  if (envelope.version !== TERMINAL_STATE_VERSION || !Array.isArray(envelope.state)) {
    throw new Error('Serialized terminal state has an unsupported format or version');
  }
  const state = envelope.state.map(normalizeTerminalStateEntry);
  const ids = new Set<string>();
  for (const entry of state) {
    if (ids.has(entry.id)) {
      throw new Error(`Serialized terminal state contains duplicate session id ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return state;
}

function terminalReplayText(entry: unknown): string {
  const normalized = normalizeTerminalStateEntry(entry);
  return normalized.replayEvent.events[0].data;
}

export {
  MAX_REPLAY_EVENT_BYTES,
  MAX_SERIALIZED_TERMINAL_STATE_BYTES,
  TERMINAL_STATE_VERSION,
  deserializeTerminalState,
  normalizeTerminalStateEntry,
  serializeTerminalState,
  terminalReplayText,
};
