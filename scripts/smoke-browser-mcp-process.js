#!/usr/bin/env node

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const EXPECTED_TOOLS = [
  'browser_list',
  'browser_snapshot',
  'browser_screenshot',
  'browser_start',
  'browser_stop',
  'browser_navigate',
  'browser_click',
  'browser_fill',
  'browser_type',
  'browser_press',
  'browser_scroll',
];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--package-root') options.packageRoot = path.resolve(value());
    else if (arg === '--command') options.command = value();
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.packageRoot && options.command) {
    throw new Error('Use either --package-root or --command, not both');
  }
  if (!options.packageRoot && !options.command) {
    throw new Error('Use --package-root or --command');
  }
  return options;
}

function launchForOptions(options) {
  if (options.packageRoot) {
    return {
      command: process.execPath,
      args: [path.join(options.packageRoot, 'bin', 'farming'), 'browser', 'mcp'],
    };
  }
  return {
    command: options.command,
    args: ['browser', 'mcp'],
  };
}

async function smokeBrowserMcp(options) {
  const launch = launchForOptions(options);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: options.packageRoot || process.cwd(),
    env: {
      FARMING_DISABLE_AUTH: '1',
      FARMING_PROJECT_WORKSPACE: process.cwd(),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000);
  });
  const client = new Client({ name: 'farming-release-browser-smoke', version: '1' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map(tool => tool.name);
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error(`Browser MCP returned unexpected tools: ${names.join(', ')}`);
    }
    const snapshot = result.tools.find(tool => tool.name === 'browser_snapshot');
    if (!snapshot?.description?.includes('untrusted data')) {
      throw new Error('Browser MCP snapshot tool omitted its page-content trust boundary');
    }
  } catch (error) {
    if (stderr) throw new Error(`${error.message}: ${stderr.trim()}`, { cause: error });
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
  console.log(`✓ Browser MCP tools/list completed through ${launch.command} ${launch.args.join(' ')}`);
}

smokeBrowserMcp(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
