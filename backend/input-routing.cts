/**
 * Resolve which agent should receive input, with priority:
 * 1. Explicit agentId in the message data
 * 2. Currently focused agent on the WebSocket connection
 * 3. The agent that was started on this WebSocket connection
 * 4. null if none available
 */
interface InputTargetConnection {
  agentId?: unknown;
  focusedAgentId?: unknown;
}

interface InputTargetMessage {
  agentId?: unknown;
}

function nonEmptyAgentId(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function resolveInputTargetAgentId(
  ws: InputTargetConnection | null | undefined,
  data: InputTargetMessage | null | undefined,
): string | null {
  const explicitAgentId = nonEmptyAgentId(data?.agentId);
  if (explicitAgentId) return explicitAgentId;

  const focusedAgentId = nonEmptyAgentId(ws?.focusedAgentId);
  if (focusedAgentId) return focusedAgentId;

  const startedAgentId = nonEmptyAgentId(ws?.agentId);
  if (startedAgentId) return startedAgentId;

  return null;
}

export { resolveInputTargetAgentId };
