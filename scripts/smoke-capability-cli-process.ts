#!/usr/bin/env -S npx tsx

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface SmokeOptions {
  command?: string;
  packageRoot?: string;
}

function parseArgs(argv: string[]): SmokeOptions {
  const options: SmokeOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--command') options.command = next();
    else if (arg === '--package-root') options.packageRoot = path.resolve(next());
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (Boolean(options.command) === Boolean(options.packageRoot)) {
    throw new Error('Use exactly one of --command or --package-root');
  }
  return options;
}

function launch(options: SmokeOptions, args: string[]): { args: string[]; command: string } {
  if (options.packageRoot) {
    return {
      command: process.execPath,
      args: [path.join(options.packageRoot, 'bin', 'farming'), ...args],
    };
  }
  return { command: options.command!, args };
}

async function invoke(options: SmokeOptions, args: string[]): Promise<string> {
  const target = launch(options, args);
  const result = await execFileAsync(target.command, target.args, {
    cwd: options.packageRoot || process.cwd(),
    env: {
      ...process.env,
      FARMING_DISABLE_AUTH: '1',
    },
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout;
}

async function run(options: SmokeOptions): Promise<void> {
  const browser = JSON.parse(await invoke(options, ['browser', 'describe', 'screenshot', '--json']));
  if (browser.ok !== true || browser.result?.result?.media !== 'workspace-artifact') {
    throw new Error('Packaged Browser CLI did not expose its screenshot artifact contract');
  }
  const computer = JSON.parse(await invoke(options, [
    'computer', 'describe', 'computer_get_desktop_state', '--json',
  ]));
  if (
    computer.ok !== true
    || computer.result?.providerToolName !== 'computer_get_desktop_state'
    || computer.result?.result?.media !== 'workspace-artifact'
  ) {
    throw new Error('Packaged Computer CLI did not expose the pinned CUA contract');
  }
  const help = await invoke(options, ['browser', '--help']);
  if (!help.includes('help workflow') || /\bmcp\b/i.test(help)) {
    throw new Error('Packaged Browser CLI progressive disclosure contract is invalid');
  }
  console.log('✓ Browser and Computer CLI contracts completed without MCP');
}

run(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
