const READ_ONLY_CLIENT_MESSAGE_TYPES = new Set([
  'business-health-probe',
  'focus-agent',
  'protocol-hello',
  'state-resync',
  'unwatch-workspace-files',
  'watch-workspace-files',
]);

function readOnlyClientMessageAllowed(type: unknown): boolean {
  return typeof type === 'string' && READ_ONLY_CLIENT_MESSAGE_TYPES.has(type);
}

export { readOnlyClientMessageAllowed };
