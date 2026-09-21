type RecordValue = Record<string, unknown>;

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
