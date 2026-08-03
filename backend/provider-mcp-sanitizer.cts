import * as path from 'node:path';

const FARMING_EXTENSION_META_KEY = 'farming.dev/extension';
const FARMING_CAPABILITIES = new Set(['browser', 'computer']);

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)) : [];
}

function isLegacyFarmingCapabilityMcpServer(server: unknown): boolean {
  const value = recordValue(server);
  const extension = String(recordValue(value._meta)[FARMING_EXTENSION_META_KEY] || '');
  if (FARMING_CAPABILITIES.has(extension)) return true;

  const url = String(value.url || '');
  if (/\/api\/agent-capabilities\/(?:browser|computer)\/mcp(?:$|[?#])/i.test(url)) return true;

  const command = path.basename(String(value.command || '')).toLowerCase();
  const args = stringArray(value.args);
  if (command === 'farming' || command === 'farming.cmd') {
    return args.length === 2
      && FARMING_CAPABILITIES.has(args[0])
      && args[1] === 'mcp';
  }
  if (command === 'farming-browser' || command === 'farming-browser.cmd') {
    return args.length === 1 && args[0] === 'mcp';
  }
  if (command === 'farming-computer' || command === 'farming-computer.cmd') {
    return args.length === 1 && args[0] === 'mcp';
  }
  return false;
}

function stripLegacyFarmingCapabilityMcpServers(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [])
    .filter(server => !isLegacyFarmingCapabilityMcpServer(server))
    .filter(server => server && typeof server === 'object' && !Array.isArray(server))
    .map(server => JSON.parse(JSON.stringify(server)) as Record<string, unknown>);
}

export {
  isLegacyFarmingCapabilityMcpServer,
  stripLegacyFarmingCapabilityMcpServers,
};
