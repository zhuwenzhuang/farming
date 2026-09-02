#!/usr/bin/env -S npx tsx
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const inheritedPlaywrightConfigDir = process.env.FARMING_PLAYWRIGHT_CONFIG_DIR;
const configDir = inheritedPlaywrightConfigDir
  ? path.resolve(inheritedPlaywrightConfigDir)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'farming-playwright-config-'));
const ownsConfigDir = !inheritedPlaywrightConfigDir;
fs.mkdirSync(configDir, { recursive: true });
const fixtureBinDir = path.join(__dirname, '..', 'tests', 'e2e', 'fixtures');
const useRealCodex = process.env.FARMING_E2E_REAL_CODEX === '1';
fs.writeFileSync(path.join(configDir, 'server.json'), `${JSON.stringify({
  pid: process.pid,
  port: process.env.PORT || process.env.FARMING_PLAYWRIGHT_PORT || '4173',
}, null, 2)}\n`);

process.env.PORT = process.env.PORT || process.env.FARMING_PLAYWRIGHT_PORT || '4173';
process.env.FARMING_BASE_PATH = process.env.FARMING_BASE_PATH || '/farming';
// A Playwright server can be launched from inside a running Farming Agent and
// therefore inherit that server's generic config root. Ignore it and use only the
// isolated lane override or a config root created and owned by this process.
process.env.FARMING_CONFIG_DIR = configDir;
process.env.FARMING_DISABLE_AUTH = process.env.FARMING_DISABLE_AUTH || '1';
if (!useRealCodex) {
  process.env.FARMING_E2E_FAKE_EXECUTABLES = process.env.FARMING_E2E_FAKE_EXECUTABLES || '1';
  process.env.FARMING_CODEX_BIN = process.env.FARMING_CODEX_BIN || path.join(fixtureBinDir, 'fake-codex');
  process.env.PATH = `${fixtureBinDir}${path.delimiter}${process.env.PATH || ''}`;
}
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { server } = require('../backend/server.cjs') as { server: import('node:http').Server };

let cleanedUp = false;

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function removeDirSync(dir: string): void {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error as Error;
      sleepSync(100);
    }
  }
  if (lastError) {
    console.warn(`Failed to remove Playwright config dir ${dir}: ${lastError.message}`);
  }
}

function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  if (ownsConfigDir) removeDirSync(configDir);
}

function shutdown(): void {
  cleanup();
  process.exit(0);
}

server.listen(Number(process.env.PORT), () => {
  console.log(`Farming Playwright server running at http://127.0.0.1:${process.env.PORT}${process.env.FARMING_BASE_PATH}/`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('exit', cleanup);
