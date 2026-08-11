#!/usr/bin/env -S node --import tsx
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

type UnknownRecord = Record<string, unknown>;

function optionValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[++index]);
  }
  return values;
}

function option(argv: string[], name: string): string {
  return optionValues(argv, name)[0] || '';
}

function request(socketPath: string, method: string): Promise<UnknownRecord> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const finish = (error?: Error, value: UnknownRecord = {}) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once('error', finish);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, method, params: {} })}\n`);
    });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let parsed: UnknownRecord;
      try {
        parsed = JSON.parse(buffer.slice(0, newline)) as UnknownRecord;
      } catch (error) {
        finish(error as Error);
        return;
      }
      if (parsed.ok !== true) {
        finish(new Error(String((parsed.error as UnknownRecord | undefined)?.message || 'ACP runtime Host request failed')));
        return;
      }
      finish(undefined, (parsed.result && typeof parsed.result === 'object'
        ? parsed.result as UnknownRecord
        : {}));
    });
  });
}

async function waitForHost(socketPath: string, child: ChildProcess): Promise<UnknownRecord> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`ACP runtime Host exited before readiness (${child.exitCode ?? child.signalCode})`);
    }
    try {
      return await request(socketPath, 'ping');
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw lastError || new Error('Timed out waiting for ACP runtime Host readiness');
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ACP runtime Host did not exit')), 5_000)),
  ]);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = option(argv, '--command');
  if (!command) throw new Error('Usage: smoke-acp-runtime-host-process.ts --command <executable> [--arg <arg>]');
  const args = [...optionValues(argv, '--arg'), '--acp-runtime-host'];
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-smoke-'));
  const socketPath = path.join(configDir, 'runtime-host.sock');
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      FARMING_CONFIG_DIR: configDir,
      FARMING_ACP_RUNTIME_HOST_SOCKET: socketPath,
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  try {
    const ping = await waitForHost(socketPath, child);
    if (Number(ping.pid) !== child.pid || !String(ping.hostEpoch || '') || !ping.runtimeIdentity) {
      throw new Error('ACP runtime Host smoke returned an incomplete identity');
    }
    child.kill('SIGTERM');
    await waitForExit(child);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child).catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
