import * as path from 'path';

const FARMING_BROWSER_MCP_SERVER_NAME = 'farming-browser';
const FARMING_BROWSER_MCP_META_KEY = 'farming.dev/extension';

interface BrowserMcpEnvironmentEntry {
  name: string;
  value: string;
}

interface BrowserMcpOptions {
  agentEnv?: NodeJS.ProcessEnv;
  cliBinDir?: string;
  token?: string;
  url?: string;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function browserMcpEnv(agentEnv: NodeJS.ProcessEnv): BrowserMcpEnvironmentEntry[] {
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

function isFarmingBrowserServer(server: unknown): boolean {
  const value = recordValue(server);
  return recordValue(value._meta)[FARMING_BROWSER_MCP_META_KEY] === 'browser';
}

function mergeBrowserMcpServer(
  mcpServers: unknown,
  options: BrowserMcpOptions,
): unknown[] {
  const existing: unknown[] = Array.isArray(mcpServers) ? mcpServers : [];
  const collision = existing.find(server => (
    recordValue(server).name === FARMING_BROWSER_MCP_SERVER_NAME
      && !isFarmingBrowserServer(server)
  ));
  if (collision) {
    throw new Error(
      `MCP server name "${FARMING_BROWSER_MCP_SERVER_NAME}" is reserved by the Farming Browser Extension`
    );
  }
  const metadata = { [FARMING_BROWSER_MCP_META_KEY]: 'browser' };
  const browserServer = options.url && options.token
    ? {
        name: FARMING_BROWSER_MCP_SERVER_NAME,
        type: 'http',
        url: options.url,
        headers: [{ name: 'Authorization', value: `Bearer ${options.token}` }],
        _meta: metadata,
      }
    : {
        name: FARMING_BROWSER_MCP_SERVER_NAME,
        command: path.join(
          String(options.cliBinDir || ''),
          process.platform === 'win32' ? 'farming.cmd' : 'farming',
        ),
        args: ['browser', 'mcp'],
        env: browserMcpEnv(options.agentEnv || {}),
        _meta: metadata,
      };
  return [
    ...existing.filter(server => !isFarmingBrowserServer(server)),
    browserServer,
  ];
}

export {
  FARMING_BROWSER_MCP_SERVER_NAME,
  isFarmingBrowserServer,
  mergeBrowserMcpServer,
};
