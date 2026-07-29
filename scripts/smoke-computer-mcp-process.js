#!/usr/bin/env node

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

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
      args: [path.join(options.packageRoot, 'bin', 'farming'), 'computer', 'mcp'],
    };
  }
  return {
    command: options.command,
    args: ['computer', 'mcp'],
  };
}

async function smokeComputerMcp(options) {
  const launch = launchForOptions(options);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: options.packageRoot || process.cwd(),
    env: {
      FARMING_AGENT_ID: 'agent_release_smoke',
      FARMING_DISABLE_AUTH: '1',
      FARMING_PROJECT_WORKSPACE: process.cwd(),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000);
  });
  const client = new Client({ name: 'farming-release-computer-smoke', version: '1' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map(tool => tool.name);
    if (names.length !== 56 || new Set(names).size !== 56) {
      throw new Error(`Computer MCP returned ${names.length} non-unique or incomplete tools`);
    }
    for (const required of [
      'computer_open',
      'computer_list',
      'computer_stop',
      'computer_get_desktop_state',
      'computer_click',
      'computer_browser_navigate',
      'computer_start_recording',
    ]) {
      if (!names.includes(required)) {
        throw new Error(`Computer MCP omitted ${required}`);
      }
    }
  } catch (error) {
    if (stderr) throw new Error(`${error.message}: ${stderr.trim()}`, { cause: error });
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
  console.log(`✓ Computer MCP tools/list completed through ${launch.command} ${launch.args.join(' ')}`);
}

smokeComputerMcp(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
