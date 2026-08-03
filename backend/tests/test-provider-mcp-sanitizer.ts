const assert = require('assert');
const {
  isLegacyFarmingCapabilityMcpServer,
  stripLegacyFarmingCapabilityMcpServers,
} = require('../provider-mcp-sanitizer.cjs');

const providerOwned = [
  { name: 'docs', command: '/opt/docs-mcp', args: ['serve'] },
  { name: 'farming-browser', url: 'https://example.test/third-party-mcp' },
];
const legacyFarming = [{
  name: 'farming-browser',
  type: 'http',
  url: 'http://127.0.0.1:6694/farming/api/agent-capabilities/browser/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer old-token' }],
  _meta: { 'farming.dev/extension': 'browser' },
}, {
  name: 'farming-computer',
  command: '/opt/farming/bin/farming',
  args: ['computer', 'mcp'],
}, {
  name: 'farming-browser',
  command: '/opt/farming/bin/farming-browser',
  args: ['mcp'],
}];

for (const server of legacyFarming) assert.strictEqual(isLegacyFarmingCapabilityMcpServer(server), true);
for (const server of providerOwned) assert.strictEqual(isLegacyFarmingCapabilityMcpServer(server), false);

const sanitized = stripLegacyFarmingCapabilityMcpServers([
  providerOwned[0],
  legacyFarming[0],
  providerOwned[1],
  legacyFarming[1],
  legacyFarming[2],
]);
assert.deepStrictEqual(sanitized, providerOwned);
sanitized[0].name = 'changed';
assert.strictEqual(providerOwned[0].name, 'docs', 'the sanitizer must return an isolated copy');

console.log('Provider MCP sanitizer tests passed');
