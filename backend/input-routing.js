/**
 * Resolve which agent should receive input, with priority:
 * 1. Explicit agentId in the message data
 * 2. Currently focused agent on the WebSocket connection
 * 3. The agent that was started on this WebSocket connection
 * 4. null if none available
 */
function resolveInputTargetAgentId(ws, data) {
  if (data && data.agentId) {
    return data.agentId;
  }

  if (ws && ws.focusedAgentId) {
    return ws.focusedAgentId;
  }

  if (ws && ws.agentId) {
    return ws.agentId;
  }

  return null;
}

module.exports = { resolveInputTargetAgentId };
