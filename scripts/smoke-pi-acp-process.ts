#!/usr/bin/env -S npx tsx

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface SmokeOptions {
  packageRoot?: string;
  command?: string;
  args: string[];
  timeoutMs?: number;
}

interface JsonRpcResponse {
  id?: number;
  error?: { message: string };
  result?: {
    protocolVersion?: number;
    sessionId?: string;
    agentInfo?: { name?: string; version?: string };
    agentCapabilities?: {
      loadSession?: boolean;
      promptCapabilities?: { image?: boolean };
      sessionCapabilities?: { list?: unknown; delete?: unknown };
    };
  };
}

interface PendingRequest {
  resolve: (message: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function parseArgs(argv: string[]): SmokeOptions {
  const options: SmokeOptions = { args: [] };
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
    else if (arg === '--arg') options.args.push(value());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.packageRoot === undefined && options.command === undefined) {
    throw new Error('Use --package-root or --command');
  }
  if (options.packageRoot && options.command) throw new Error('Use one launch source');
  return options;
}

interface PiLaunchOptions {
  agentId: string;
  configDir: string;
  executable: string;
  farmingSystemPrompt: string;
  providerHomePath: string;
  stateDir: string;
}

function launchForOptions(
  options: SmokeOptions,
  pi: PiLaunchOptions,
): { command: string; args: string[] } {
  if (options.packageRoot) {
    const runtime = require(path.join(options.packageRoot, 'backend', 'acp-runtime.cjs'));
    return runtime.resolveAcpLaunch('pi', pi);
  }
  return {
    command: options.command!,
    args: [
      ...options.args,
      '--farming-pi-command', pi.executable,
      '--farming-pi-acp-state-dir', pi.stateDir,
      '--farming-append-system-prompt', pi.farmingSystemPrompt,
    ],
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<void>(resolve => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function writeFakePi(fakePi: string): void {
  fs.writeFileSync(fakePi, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const readline = require('readline');
if (process.argv.includes('--version')) {
  process.stdout.write('pi 0.84.1\\n');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  process.stdout.write('pi - AI coding assistant with read, bash, edit, write tools\\n');
  process.exit(0);
}
if (!process.argv.includes('--mode') || !process.argv.includes('rpc')) {
  process.stderr.write('fake Pi requires --mode rpc\\n');
  process.exit(2);
}
const sessionFile = path.join(
  process.env.PI_CODING_AGENT_DIR,
  'sessions',
  '--packaged-smoke--',
  'packaged-smoke.jsonl',
);
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
fs.writeFileSync(sessionFile, JSON.stringify({
  type: 'session',
  version: 3,
  id: 'pi-packaged-smoke',
  timestamp: new Date().toISOString(),
  cwd: process.cwd(),
}) + '\\n');
fs.writeFileSync(process.env.FARMING_FAKE_PI_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  agentHome: process.env.PI_CODING_AGENT_DIR,
}));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  let data = {};
  if (request.type === 'get_state') data = {
    sessionId: 'pi-packaged-smoke',
    sessionFile,
    thinkingLevel: 'medium',
    model: { provider: 'fake', id: 'model' },
  };
  else if (request.type === 'get_available_models') data = {
    models: [{ provider: 'fake', id: 'model', name: 'Packaged Smoke Model' }],
  };
  else if (request.type === 'get_commands') data = { commands: [] };
  process.stdout.write(JSON.stringify({
    type: 'response',
    id: request.id,
    command: request.type,
    success: true,
    data,
  }) + '\\n');
});
`);
  fs.chmodSync(fakePi, 0o755);
}

async function smokePiAcp(options: SmokeOptions): Promise<void> {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
    ? options.timeoutMs!
    : 20_000;
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-pi-acp-process-'));
  const fakePi = path.join(smokeRoot, 'fake-pi.cjs');
  const agentHome = path.join(smokeRoot, 'agent-home');
  const configDir = path.join(smokeRoot, 'config');
  const agentId = 'pi-packaged-smoke-agent';
  const stateKey = crypto.createHash('sha256')
    .update(`${path.resolve(configDir)}\0${agentId}`)
    .digest('hex')
    .slice(0, 24);
  const adapterState = path.join(agentHome, '.farming', 'pi-acp', stateKey);
  const globalHome = path.join(smokeRoot, 'global-home');
  const launchLog = path.join(smokeRoot, 'pi-launch.json');
  fs.mkdirSync(agentHome, { recursive: true });
  fs.mkdirSync(globalHome, { recursive: true });
  writeFakePi(fakePi);
  const launch = launchForOptions(options, {
    agentId,
    configDir,
    executable: fakePi,
    farmingSystemPrompt: 'Farming packaged Pi smoke',
    providerHomePath: agentHome,
    stateDir: adapterState,
  });

  const child: ChildProcess = spawn(launch.command, launch.args, {
    cwd: smokeRoot,
    env: {
      ...process.env,
      FARMING_FAKE_PI_LOG: launchLog,
      HOME: globalHome,
      PI_CODING_AGENT_DIR: agentHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdoutBuffer = '';
  const pending = new Map<number, PendingRequest>();
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000);
  });
  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as JsonRpcResponse;
      if (typeof message.id !== 'number') continue;
      const request = pending.get(message.id);
      if (!request) continue;
      clearTimeout(request.timer);
      pending.delete(message.id);
      request.resolve(message);
    }
  });
  child.once('error', error => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  });
  child.once('exit', (code, signal) => {
    const error = new Error(
      `Pi ACP exited during packaged smoke: code=${code} signal=${signal || ''}: ${stderr.trim()}`,
    );
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  });
  const request = (id: number, method: string, params: Record<string, unknown>) => (
    new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Pi ACP ${method} timed out after ${timeoutMs}ms: ${stderr.trim()}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    })
  );

  try {
    const initialized = await request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'farming-release-smoke', version: '1' },
    });
    if (initialized.error) throw new Error(`Pi ACP initialize failed: ${initialized.error.message}`);
    const result = initialized.result;
    if (
      result?.protocolVersion !== 1
      || result.agentInfo?.name !== 'pi-acp'
      || result.agentInfo?.version !== '0.0.33'
      || result.agentCapabilities?.loadSession !== true
      || result.agentCapabilities?.promptCapabilities?.image !== true
      || result.agentCapabilities?.sessionCapabilities?.list == null
      || result.agentCapabilities?.sessionCapabilities?.delete == null
    ) {
      throw new Error(`Pi ACP initialize returned unexpected capabilities: ${JSON.stringify(result)}`);
    }

    const opened = await request(2, 'session/new', { cwd: smokeRoot, mcpServers: [] });
    if (opened.error) throw new Error(`Pi ACP session/new failed: ${opened.error.message}`);
    if (opened.result?.sessionId !== 'pi-packaged-smoke') {
      throw new Error(`Pi ACP session/new returned an unexpected session: ${JSON.stringify(opened.result)}`);
    }
    const piLaunch = JSON.parse(fs.readFileSync(launchLog, 'utf8')) as {
      argv: string[];
      agentHome: string;
    };
    if (JSON.stringify(piLaunch.argv.slice(0, 3)) !== JSON.stringify(['--mode', 'rpc', '--no-themes'])) {
      throw new Error(`Pi ACP launched an unexpected Pi command: ${JSON.stringify(piLaunch.argv)}`);
    }
    const promptIndex = piLaunch.argv.indexOf('--append-system-prompt');
    if (promptIndex < 0 || piLaunch.argv[promptIndex + 1] !== 'Farming packaged Pi smoke') {
      throw new Error('Pi ACP did not pass the Farming bootstrap to its Pi child');
    }
    if (piLaunch.agentHome !== agentHome) {
      throw new Error(`Pi ACP did not preserve Agent Home isolation: ${JSON.stringify(piLaunch)}`);
    }
    const sessionMap = JSON.parse(
      fs.readFileSync(path.join(adapterState, 'session-map.json'), 'utf8'),
    );
    if (!sessionMap.sessions?.['pi-packaged-smoke']) {
      throw new Error('Pi ACP did not persist the packaged smoke session in its scoped state directory');
    }
    if (fs.existsSync(path.join(globalHome, '.pi', 'pi-acp', 'session-map.json'))) {
      throw new Error('Pi ACP leaked packaged smoke state into the global Home');
    }
    console.log(
      `✓ Pi ACP initialized and opened a Pi RPC session through ${launch.command} ${launch.args.join(' ')}`,
    );
  } finally {
    await stopChild(child);
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

smokePiAcp(parseArgs(process.argv.slice(2))).catch(error => {
  console.error((error as Error).message || error);
  process.exit(1);
});
