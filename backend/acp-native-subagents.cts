type RecordValue = Record<string, unknown>;

export interface NativeSubagentAssociation {
  parentSessionId: string;
  title?: string | null;
  description?: string | null;
  capabilities?: { cancel?: RecordValue | null } | null;
  state?: { state: string; stopReason?: string | null; [key: string]: unknown } | null;
  _meta?: RecordValue | null;
}

export function nativeSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error('Invalid native subagent identity');
  }
  return value;
}

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Association patches and foreground-state snapshots have different semantics:
// omitted fields persist, null clears, and a supplied state replaces the whole state.
export function mergeNativeSubagentAssociation(
  parentSessionId: string, update: RecordValue, previous?: NativeSubagentAssociation | null,
): NativeSubagentAssociation {
  const id = nativeSessionId(update.sessionId);
  if (id === parentSessionId || (previous && previous.parentSessionId !== parentSessionId)) {
    throw new Error('Native subagent parent cannot change');
  }
  for (const key of ['title', 'description']) {
    if (key in update && update[key] !== null && typeof update[key] !== 'string') {
      throw new Error(`Invalid native subagent ${key}`);
    }
  }
  if ('capabilities' in update && update.capabilities !== null && (!object(update.capabilities)
    || ('cancel' in update.capabilities && update.capabilities.cancel !== null && !object(update.capabilities.cancel)))) {
    throw new Error('Invalid native subagent capabilities');
  }
  if ('state' in update && update.state !== null && (!object(update.state)
    || typeof update.state.state !== 'string' || !update.state.state)) {
    throw new Error('Invalid native subagent state');
  }
  if ('_meta' in update && update._meta !== null && !object(update._meta)) {
    throw new Error('Invalid native subagent metadata');
  }
  const patch = Object.fromEntries(['title', 'description', 'capabilities', 'state', '_meta']
    .filter(key => Object.prototype.hasOwnProperty.call(update, key)).map(key => [key, update[key]]));
  return JSON.parse(JSON.stringify({ ...previous, ...patch, parentSessionId })) as NativeSubagentAssociation;
}

// ACP SDK 1.4 predates native child notifications. Translate at the wire
// boundary into the existing transcript contract; never load or resume a child.
export function normalizeNativeSubagentNotification(params: RecordValue): RecordValue {
  const update = params.update as RecordValue | undefined;
  if (!update || !['subagent_spawned', 'subagent_state_update'].includes(String(update.sessionUpdate))) return params;
  const id = update.subagentSessionId;
  if (typeof id !== 'string' || !id.trim() || id.length > 512 || id === params.sessionId) {
    throw new Error('Invalid native subagent identity');
  }
  const spawned = update.sessionUpdate === 'subagent_spawned';
  const state = String(update.state || '');
  const status = spawned || state === 'running' ? 'in_progress'
    : state === 'failed' || state === 'disconnected' ? 'failed' : 'completed';
  return { ...params, update: {
    sessionUpdate: spawned ? 'tool_call' : 'tool_call_update',
    toolCallId: `native-subagent:${id}`,
    ...(spawned ? { title: String(update.name || 'Subagent'), kind: 'other',
      rawInput: { task: String(update.task || '') } } : {}),
    status,
    _meta: {
      subagent_session_info: { session_id: id },
      farming: { nativeSubagent: true, state: spawned ? 'running' : state },
    },
  } };
}
