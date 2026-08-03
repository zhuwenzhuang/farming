#!/usr/bin/env -S npx tsx

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXPECTED_TOOLS = [
  'browser_open',
  'browser_list',
  'browser_snapshot',
  'browser_screenshot',
  'browser_emulate',
  'browser_start',
  'browser_stop',
  'browser_close',
  'browser_navigate',
  'browser_click',
  'browser_fill',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_history',
  'browser_wait',
  'browser_get',
  'browser_is',
  'browser_eval',
  'browser_element_action',
  'browser_keyboard',
  'browser_select',
  'browser_drag',
  'browser_find',
  'browser_debug',
  'browser_network',
  'browser_cookies',
  'browser_storage',
  'browser_frame',
  'browser_dialog',
  'browser_upload',
  'browser_download',
];

interface SmokeOptions {
  packageRoot?: string;
  command?: string;
}

function parseArgs(argv: string[]): SmokeOptions {
  const options: SmokeOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string => {
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

function launchForOptions(options: SmokeOptions): { command: string; args: string[] } {
  if (options.packageRoot) {
    return {
      command: process.execPath,
      args: [path.join(options.packageRoot, 'bin', 'farming'), 'browser', 'mcp'],
    };
  }
  return {
    command: options.command!,
    args: ['browser', 'mcp'],
  };
}

async function smokeBrowserMcp(options: SmokeOptions): Promise<void> {
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
  transport.stderr!.on('data', (chunk: Buffer) => {
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
    const err = error as Error;
    if (stderr) throw new Error(`${err.message}: ${stderr.trim()}`, { cause: error });
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
  console.log(`✓ Browser MCP tools/list completed through ${launch.command} ${launch.args.join(' ')}`);
}

smokeBrowserMcp(parseArgs(process.argv.slice(2))).catch(error => {
  console.error((error as Error).message || error);
  process.exit(1);
});
