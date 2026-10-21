const READ_ONLY_CLIENT_MESSAGE_TYPES = new Set([
  'business-health-probe',
  'focus-agent',
  'protocol-hello',
  'state-resync',
  'terminal-checkpoint-request',
  'watch-acp-transcripts',
  'unwatch-workspace-files',
  'watch-workspace-files',
  'workspace-request',
  'workspace-cancel',
]);

function readOnlyClientMessageAllowed(type: unknown): boolean {
  return typeof type === 'string' && READ_ONLY_CLIENT_MESSAGE_TYPES.has(type);
}

function rejectReadOnlyClientMutation(
  ws: { accessMode?: string; send(body: string): void },
  data: { type: string; requestId?: string; agentId?: string | null },
): boolean {
  if (ws.accessMode !== 'read-only' || readOnlyClientMessageAllowed(data.type)) return false;
  if ((data.type === 'composer-input' || data.type === 'composer-input-status-request')
    && data.requestId && data.agentId) {
    const statusLookup = data.type === 'composer-input-status-request';
    // Denying a status lookup proves nothing about an earlier submission.
    ws.send(JSON.stringify({
      type: 'composer-input-result',
      requestId: data.requestId,
      agentId: data.agentId,
      accepted: false,
      ...(statusLookup ? { uncertain: true } : {}),
      message: statusLookup
        ? 'This Farming share is read-only. Delivery status cannot be checked with this access.'
        : 'This Farming share is read-only.',
    }));
    return true;
  }
  ws.send(JSON.stringify({
    type: 'error',
    message: 'This Farming share is read-only.',
  }));
  return true;
}

export { readOnlyClientMessageAllowed, rejectReadOnlyClientMutation };
