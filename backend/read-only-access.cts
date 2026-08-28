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

export { readOnlyClientMessageAllowed };
