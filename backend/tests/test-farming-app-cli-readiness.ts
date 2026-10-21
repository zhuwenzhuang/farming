import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';

const { waitForServer, waitForStableServer } = require('../farming-app-cli.cjs');
const { TokenAuth } = require('../auth.cjs');
const { sessionTokenFile } = require('../storage-layout.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-cli-readiness-'));
  const configDir = path.join(root, 'client');
  fs.mkdirSync(configDir);
  const auth = new TokenAuth({ farmingDir: path.join(root, 'server'), env: {}, token: 'readiness-owner' });
  const sockets = new Set<Socket>();
  let inventoryRequests = 0;
  let statusRequests = 0;
  let variant = 'normal';
  let authRequired = true;
  let recoveryAt = 0;
  let recoveryFirstRequest = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/farming/api/executables') {
      inventoryRequests += 1;
      // An inventory that never answers must be irrelevant to startup readiness.
      return;
    }
    assert.equal(url.pathname, '/farming/api/auth/status');
    statusRequests += 1;
    if (variant === 'recovering' && statusRequests > recoveryFirstRequest && Date.now() < recoveryAt) return;
    res.writeHead(variant === 'redirect' ? 302 : 200, { 'Content-Type': 'application/json' });
    if (variant === 'stalled-body') { res.flushHeaders(); return; }
    if (variant === 'malformed') { res.end('{'); return; }
    if (variant === 'oversized') { res.end(' '.repeat(5000)); return; }
    res.end(JSON.stringify({
      authRequired,
      accessMode: authRequired ? auth.accessForToken(auth.extractToken(req)) : 'owner',
    }));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const env = { FARMING_CONFIG_DIR: configDir, FARMING_BASE_PATH: '/farming', PORT: String(address.port) };
    const tokenFile = sessionTokenFile(configDir);
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, auth.getToken(), { mode: 0o600 });
    await waitForServer(env, 1000);
    assert.equal(statusRequests, 1);
    assert.equal(inventoryRequests, 0);

    // A responsive first read can be followed by temporary startup work. The
    // final check must retain the configured budget rather than a hidden 5s cap.
    variant = 'recovering';
    recoveryFirstRequest = statusRequests + 1;
    recoveryAt = Date.now() + 5400;
    await waitForStableServer({ ...env, FARMING_START_TIMEOUT_MS: '8000', FARMING_START_STABILITY_MS: '0' }, process.pid);
    variant = 'normal';
    await assert.rejects(waitForStableServer({
      ...env, FARMING_START_TIMEOUT_MS: '100', FARMING_START_STABILITY_MS: '200',
    }, process.pid), /stability check within the startup deadline/);

    for (const token of ['wrong-token', auth.createReadOnlyToken({ expiresAt: Date.now() + 60_000 })]) {
      fs.writeFileSync(tokenFile, token);
      await assert.rejects(waitForServer(env, 80), /before timeout/);
    }
    fs.writeFileSync(tokenFile, auth.getToken());
    for (variant of ['malformed', 'oversized', 'stalled-body', 'redirect']) {
      await assert.rejects(waitForServer(env, 80), /before timeout/);
    }
    variant = 'normal';
    authRequired = false;
    await assert.rejects(waitForServer(env, 80), /before timeout/);
    await waitForServer({ ...env, FARMING_DISABLE_AUTH: '1' }, 1000);
    authRequired = true;
    await assert.rejects(waitForServer({ ...env, FARMING_DISABLE_AUTH: '1' }, 80), /before timeout/);
    assert.equal(inventoryRequests, 0, 'readiness must never trigger executable discovery');
    fs.rmSync(tokenFile);
    await assert.rejects(waitForServer(env, 80), /did not create its token file/);
    console.log('CLI readiness verifies owner authentication without executable discovery and bounds response bodies');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
