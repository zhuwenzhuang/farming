#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-playwright-config-'));
const fixtureBinDir = path.join(__dirname, '..', 'tests', 'e2e', 'fixtures');
fs.writeFileSync(path.join(configDir, 'server.json'), `${JSON.stringify({
  pid: process.pid,
  port: process.env.PORT || process.env.FARMING_PLAYWRIGHT_PORT || '4173',
}, null, 2)}\n`);

process.env.PORT = process.env.PORT || process.env.FARMING_PLAYWRIGHT_PORT || '4173';
process.env.FARMING_BASE_PATH = process.env.FARMING_BASE_PATH || '/farming';
process.env.FARMING_CONFIG_DIR = process.env.FARMING_CONFIG_DIR || configDir;
process.env.FARMING_DISABLE_AUTH = process.env.FARMING_DISABLE_AUTH || '1';
process.env.FARMING_E2E_FAKE_EXECUTABLES = process.env.FARMING_E2E_FAKE_EXECUTABLES || '1';
process.env.FARMING_CODEX_BIN = process.env.FARMING_CODEX_BIN || path.join(fixtureBinDir, 'fake-codex');
process.env.PATH = `${fixtureBinDir}${path.delimiter}${process.env.PATH || ''}`;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { server, shutdownServer } = require('../backend/server');

let cleanedUp = false;

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function removeDirSync(dir) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      sleepSync(100);
    }
  }
  if (lastError) {
    console.warn(`Failed to remove Playwright config dir ${dir}: ${lastError.message}`);
  }
}

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  removeDirSync(configDir);
}

function shutdown() {
  shutdownServer({ exit: false })
    .catch(error => {
      console.warn(`Failed to stop Farming Playwright server cleanly: ${error.message || error}`);
    })
    .finally(() => {
      cleanup();
      process.exit(0);
    });
  setTimeout(() => {
    cleanup();
    process.exit(0);
  }, 1000).unref();
}

server.listen(Number(process.env.PORT), () => {
  console.log(`Farming Playwright server running at http://127.0.0.1:${process.env.PORT}${process.env.FARMING_BASE_PATH}/`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('exit', cleanup);
