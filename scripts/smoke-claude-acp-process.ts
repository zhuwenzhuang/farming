#!/usr/bin/env -S npx tsx

import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

interface SmokeOptions {
  packageRoot?: string;
  command?: string;
  args: string[];
  timeoutMs?: number;
}

interface LaunchResult {
  command: string;
  args: string[];
}

interface JsonRpcResponse {
  id?: number;
  error?: { message: string; code?: number; data?: unknown };
  result?: {
    protocolVersion?: number;
    agentCapabilities?: {
      sessionCapabilities?: { fork?: unknown };
      _meta?: { codex?: { steer?: { method?: string; version?: number }; subagents?: { version?: number } } };
    };
    agentInfo?: { version?: string };
    _meta?: {
      steering?: { supported?: boolean };
      jetbrains?: { air?: { version?: number; capabilities?: string[]; goal?: { version?: number; controlMethod?: string; actions?: string[] } } };
    };
  };
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
  if (options.packageRoot && options.command) {
    throw new Error('Use either --package-root or --command, not both');
  }
  if (!options.packageRoot && !options.command) {
    throw new Error('Use --package-root or --command');
  }
  return options;
}

function launchForOptions(options: SmokeOptions): LaunchResult {
  if (options.packageRoot) {
    const runtime = require(path.join(options.packageRoot, 'backend', 'acp-runtime.cjs'));
    return runtime.resolveAcpLaunch('claude');
  }
  return { command: options.command!, args: options.args };
}

async function smokeClaudeAcp(options: SmokeOptions): Promise<void> {
  const launch = launchForOptions(options);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
    ? options.timeoutMs
    : 20_000;
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-claude-acp-smoke-'));
  const claudeHome = path.join(fixtureRoot, 'claude-home');
  const projectDirectory = path.join(claudeHome, 'projects', fixtureRoot.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projectDirectory, { recursive: true });
  const cleanupSessionId = randomUUID();
  const siblingSessionId = randomUUID();
  const transcriptPath = (sessionId: string): string => path.join(projectDirectory, `${sessionId}.jsonl`);
  for (const sessionId of [cleanupSessionId, siblingSessionId]) {
    fs.writeFileSync(transcriptPath(sessionId), `${JSON.stringify({
      type: 'user', uuid: randomUUID(), parentUuid: null, sessionId,
      cwd: fixtureRoot, timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Isolated release smoke fixture' },
    })}\n`);
  }
  const siblingBefore = fs.readFileSync(transcriptPath(siblingSessionId), 'utf8');
  const child: ChildProcess = spawn(launch.command, launch.args, {
    cwd: options.packageRoot || process.cwd(),
    env: { ...process.env, CLAUDE_CODE_EXECUTABLE: process.execPath, CLAUDE_CONFIG_DIR: claudeHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdoutBuffer = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000);
  });

  let nextRequestId = 0;
  const request = (method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> => new Promise((resolve, reject) => {
    const id = ++nextRequestId;
    const timer = setTimeout(() => {
      finish(reject, new Error(`Claude ACP ${method} timed out after ${timeoutMs}ms${stderr ? `: ${stderr.trim()}` : ''}`));
    }, timeoutMs);
    timer.unref?.();
    const finish = <T>(callback: (value: T) => void, value: T): void => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stdout!.off('data', onData);
      callback(value);
    };
    const onError = (error: Error): void => finish(reject, error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(
        reject,
        new Error(`Claude ACP exited before ${method}: code=${code} signal=${signal || ''}${stderr ? `: ${stderr.trim()}` : ''}`),
      );
    };
    const onData = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString('utf8');
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line);
        } catch {
          finish(reject, new Error(`Claude ACP wrote non-JSON stdout: ${line}`));
          return;
        }
        if (message.id === id) {
          finish(resolve, message);
          return;
        }
      }
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout!.on('data', onData);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    const response = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true,
        _meta: { jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions'] } } } },
      clientInfo: { name: 'farming-release-smoke', version: '1' },
    });
    if (response.error) {
      throw new Error(`Claude ACP initialize failed: ${JSON.stringify(response.error)}`);
    }
    if (response.result?.protocolVersion !== 1) {
      throw new Error(`Claude ACP selected unexpected protocol version: ${response.result?.protocolVersion}`);
    }
    if (response.result?.agentCapabilities?.sessionCapabilities?.fork == null) {
      throw new Error('Claude ACP initialize omitted session/fork');
    }
    if (response.result?.agentInfo?.version !== '0.89.1') {
      throw new Error(`Claude ACP selected unexpected version: ${response.result?.agentInfo?.version}`);
    }
    if (response.result?._meta?.steering?.supported !== true) {
      throw new Error('Claude ACP initialize omitted provider-neutral steering support');
    }
    const goal = response.result?._meta?.jetbrains?.air?.goal;
    if (goal?.version !== 1 || goal.controlMethod !== '_session/goal'
      || !['set', 'clear'].every(action => goal.actions?.includes(action))) {
      throw new Error(`Claude ACP initialize omitted goal support: ${JSON.stringify(goal)}`);
    }
    const capabilities = response.result?._meta?.jetbrains?.air?.capabilities ?? [];
    if (capabilities.some(capability => ['sessionIndex', 'sessionArchive', 'sessionRename', 'sessionListSubscribe'].includes(capability))) {
      throw new Error('Claude ACP enabled an unrequested session index capability');
    }
    const closed = await request('session/close', { sessionId: 'farming-release-smoke-unloaded' });
    if (closed.error) {
      throw new Error(`Claude ACP close of an unloaded session failed: ${JSON.stringify(closed.error)}`);
    }
    const archived = await request('_session/archive', { sessionId: 'farming-release-smoke-unloaded' });
    if (archived.error?.code !== -32601) {
      throw new Error('Claude ACP allowed archive without session index negotiation');
    }
    const deleted = await request('session/delete', { sessionId: cleanupSessionId });
    if (deleted.error || fs.existsSync(transcriptPath(cleanupSessionId))) {
      throw new Error(`Claude ACP explicit cleanup did not delete its transcript: ${JSON.stringify(deleted.error)}`);
    }
    if (fs.readFileSync(transcriptPath(siblingSessionId), 'utf8') !== siblingBefore) {
      throw new Error('Claude ACP cleanup changed an unrelated transcript');
    }
    const missing = await request('session/delete', { sessionId: cleanupSessionId });
    if (!missing.error) {
      throw new Error('Claude ACP cleanup hid an SDK deletion failure');
    }
    console.log(`✓ Claude ACP initialized, enforced capability negotiation, and deleted only its cleanup fixture through ${launch.command} ${launch.args.join(' ')}`);
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      });
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

smokeClaudeAcp(parseArgs(process.argv.slice(2))).catch(error => {
  console.error((error as Error).message || error);
  process.exit(1);
});
