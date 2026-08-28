#!/usr/bin/env -S node --import tsx
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

async function availableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else resolve((address as net.AddressInfo).port);
      });
    });
  });
}

async function resolveBehaviorE2ePort(
  env: NodeJS.ProcessEnv,
  allocate: () => Promise<number> = availableLoopbackPort,
): Promise<number> {
  const configured = String(env.FARMING_PLAYWRIGHT_PORT || '').trim();
  if (!configured) return allocate();
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid FARMING_PLAYWRIGHT_PORT: ${configured}`);
  }
  return port;
}

async function main(): Promise<void> {
  const port = await resolveBehaviorE2ePort(process.env);
  const playwrightCli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
  const run = async (args: string[], env: NodeJS.ProcessEnv): Promise<number> => {
    const child = spawn(process.execPath, [playwrightCli, 'test', ...args], {
      cwd: path.join(__dirname, '..'),
      env,
      stdio: 'inherit',
    });
    return new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (signal) reject(new Error(`Critical behavior browser tests exited from ${signal}`));
        else resolve(code ?? 1);
      });
    });
  };
  const commonArgs = ['--workers=1', '--retries=0', '--grep', '@critical-behavior'];
  const baseEnv = { ...process.env, FARMING_PLAYWRIGHT_PORT: String(port) };
  const primaryExitCode = await run(['--project=chromium', ...commonArgs], baseEnv);
  if (primaryExitCode !== 0) {
    process.exitCode = primaryExitCode;
    return;
  }

  const authPort = await availableLoopbackPort();
  process.exitCode = await run(['--project=mobile-auth-chromium', ...commonArgs], {
    ...process.env,
    FARMING_PLAYWRIGHT_AUTH: '1',
    FARMING_PLAYWRIGHT_PORT: String(authPort),
  });
}

if (require.main === module) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { resolveBehaviorE2ePort };
