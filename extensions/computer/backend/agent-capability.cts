const path = require('path');

const FARMING_COMPUTER_MCP_SERVER_NAME = 'farming-computer';
const FARMING_COMPUTER_MCP_META_KEY = 'farming.dev/extension';

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function isFarmingComputerServer(server: unknown): boolean {
  const value = recordValue(server);
  return recordValue(value._meta)[FARMING_COMPUTER_MCP_META_KEY] === 'computer';
}

function computerMcpEnv(agentEnv: NodeJS.ProcessEnv) {
  return [
    'FARMING_AGENT_ID',
    'FARMING_CONFIG_DIR',
    'FARMING_CONTROL_URL',
    'FARMING_DISABLE_AUTH',
    'FARMING_PROJECT_WORKSPACE',
    'FARMING_TOKEN_FILE',
  ].flatMap(name => (
    agentEnv[name] === undefined || agentEnv[name] === ''
      ? []
      : [{ name, value: String(agentEnv[name]) }]
  ));
}

function mergeComputerMcpServer(
  mcpServers: unknown,
  options: { cliBinDir: string; agentEnv?: NodeJS.ProcessEnv },
) {
  const existing = Array.isArray(mcpServers) ? mcpServers : [];
  const collision = existing.find(server => (
    recordValue(server).name === FARMING_COMPUTER_MCP_SERVER_NAME
    && !isFarmingComputerServer(server)
  ));
  if (collision) {
    throw new Error(
      `MCP server name "${FARMING_COMPUTER_MCP_SERVER_NAME}" is reserved by the Farming Computer Extension`,
    );
  }
  const command = path.join(options.cliBinDir, process.platform === 'win32' ? 'farming.cmd' : 'farming');
  return [
    ...existing.filter(server => !isFarmingComputerServer(server)),
    {
      name: FARMING_COMPUTER_MCP_SERVER_NAME,
      command,
      args: ['computer', 'mcp'],
      env: computerMcpEnv(options.agentEnv || {}),
      _meta: { [FARMING_COMPUTER_MCP_META_KEY]: 'computer' },
    },
  ];
}

export {
  FARMING_COMPUTER_MCP_SERVER_NAME,
  isFarmingComputerServer,
  mergeComputerMcpServer,
};
