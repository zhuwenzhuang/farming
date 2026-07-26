const path = require('path');

const FARMING_BROWSER_MCP_SERVER_NAME = 'farming-browser';
const FARMING_BROWSER_MCP_META_KEY = 'farming.dev/extension';

function browserMcpEnv(agentEnv) {
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

function isFarmingBrowserServer(server) {
  return server?._meta?.[FARMING_BROWSER_MCP_META_KEY] === 'browser';
}

function mergeBrowserMcpServer(mcpServers, options) {
  const existing = Array.isArray(mcpServers) ? mcpServers : [];
  const collision = existing.find(server => (
    server?.name === FARMING_BROWSER_MCP_SERVER_NAME && !isFarmingBrowserServer(server)
  ));
  if (collision) {
    throw new Error(
      `MCP server name "${FARMING_BROWSER_MCP_SERVER_NAME}" is reserved by the Farming Browser Extension`
    );
  }
  const command = path.join(options.cliBinDir, process.platform === 'win32' ? 'farming.cmd' : 'farming');
  const browserServer = {
    name: FARMING_BROWSER_MCP_SERVER_NAME,
    command,
    args: ['browser', 'mcp'],
    env: browserMcpEnv(options.agentEnv || {}),
    _meta: {
      [FARMING_BROWSER_MCP_META_KEY]: 'browser',
    },
  };
  return [
    ...existing.filter(server => !isFarmingBrowserServer(server)),
    browserServer,
  ];
}

module.exports = {
  FARMING_BROWSER_MCP_SERVER_NAME,
  isFarmingBrowserServer,
  mergeBrowserMcpServer,
};
