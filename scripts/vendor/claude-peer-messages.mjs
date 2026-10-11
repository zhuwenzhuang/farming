// Receive-side provenance only. Tool calls and quoted peer envelopes are not messages.
// Live delivery and history replay share the SDK UUID, so the host can upsert them.
export function farmingClaudePeerUpdate(message) {
  if (message?.type !== 'user' || typeof message.uuid !== 'string' || !message.uuid || message.uuid.length > 512) return null;
  const origin = message.origin;
  if (!origin || !['peer', 'coordinator'].includes(origin.kind)) return null;
  const bounded = (value, limit = 512) => typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;
  const senderAddress = origin.kind === 'coordinator' ? 'main' : bounded(origin.from);
  if (!senderAddress) return null;
  const content = message.message?.content;
  let body = typeof origin.body === 'string' ? origin.body
    : typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : null;
  if (body === null) return null;
  const coordinatorPrefix = 'The coordinator sent a message while you were working:\n';
  const coordinatorSuffix = '\n\nAddress this before completing your current task.';
  if (origin.kind === 'coordinator' && body.startsWith(coordinatorPrefix) && body.endsWith(coordinatorSuffix)) {
    body = body.slice(coordinatorPrefix.length, -coordinatorSuffix.length);
  }
  return {
    sessionUpdate: 'session_message',
    messageId: message.uuid,
    content: [{ type: 'text', text: body }],
    _meta: {
      peerMessage: {
        version: 1,
        direction: 'incoming',
        senderAddress,
        ...(bounded(origin.fromSession) ? { senderSessionId: origin.fromSession } : {}),
        ...(bounded(origin.senderTaskId) ? { senderTaskId: origin.senderTaskId } : {}),
        ...(bounded(origin.name, 240) ? { senderName: origin.name } : {}),
        ...(bounded(message.timestamp, 80) ? { timestamp: message.timestamp } : {}),
      },
      ...(bounded(message.parent_tool_use_id) ? { claudeCode: { parentToolUseId: message.parent_tool_use_id } } : {}),
    },
  };
}
