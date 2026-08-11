import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close(() => {
        if (!address || typeof address === 'string') reject(new Error('Failed to allocate a test port'));
        else resolve(address.port);
      });
    });
  });
}

function request(
  port: number,
  pathname: string,
  headers: OutgoingHttpHeaders = {},
): Promise<{ statusCode: number | undefined; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const client = http.get({ host: '127.0.0.1', port, path: pathname, headers }, response => {
      response.resume();
      response.once('end', () => resolve({ statusCode: response.statusCode, headers: response.headers }));
    });
    client.once('error', reject);
    client.setTimeout(3_000, () => client.destroy(new Error(`Timed out requesting ${pathname}`)));
  });
}

async function waitForServer(port: number, child: import('child_process').ChildProcess) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Farming Server exited before listening: ${child.exitCode ?? child.signalCode}`);
    }
    try {
      const response = await request(port, '/farming/api/auth/status');
      if (response.statusCode === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('Farming Server did not become ready');
}

async function stop(child: import('child_process').ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Farming Server did not stop')), 5_000)),
  ]);
}

async function run() {
  const distDir = path.join(projectRoot, 'dist');
  const staticAppDir = fs.existsSync(distDir) ? distDir : path.join(projectRoot, 'frontend');
  const assetsDir = path.join(staticAppDir, 'assets');
  const assetsDirExisted = fs.existsSync(assetsDir);
  const asset = `farming-static-asset-${process.pid}.js`;
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, asset), `export const payload = '${'compressible-asset-'.repeat(512)}';\n`);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-static-assets-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['backend/farming-app-cli.cjs'], {
    cwd: projectRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      FARMING_BASE_PATH: '/farming',
      FARMING_CONFIG_DIR: configDir,
      FARMING_DISABLE_AUTH: '1',
      FARMING_E2E_FAKE_EXECUTABLES: '1',
      FARMING_RUN_SERVER: '1',
      FARMING_SESSION_ENGINE: 'local',
      FARMING_SKIP_RUNTIME_PREPARE: '1',
      NODE_ENV: 'test',
    },
  });

  try {
    await waitForServer(port, child);
    const assetResponse = await request(port, `/farming/assets/${encodeURIComponent(asset)}`, {
      'accept-encoding': 'gzip',
    });
    assert.strictEqual(assetResponse.statusCode, 200);
    assert.match(String(assetResponse.headers['cache-control'] || ''), /max-age=31536000/);
    assert.match(String(assetResponse.headers['cache-control'] || ''), /immutable/);
    assert.strictEqual(assetResponse.headers['content-encoding'], 'gzip');

    const entryResponse = await request(port, '/farming/crt/');
    assert.strictEqual(entryResponse.statusCode, 200);
    assert.strictEqual(entryResponse.headers['cache-control'], 'no-cache');
  } finally {
    await stop(child);
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(path.join(assetsDir, asset), { force: true });
    if (!assetsDirExisted) fs.rmdirSync(assetsDir);
  }
}

run()
  .then(() => console.log('✓ static assets are compressed and immutable while the HTML entry revalidates'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
