import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
const { serverLogFile } = require('../storage-layout.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-onboarding-cli-'));
  const config = path.join(root, 'config');
  fs.mkdirSync(config);
  const occupied = net.createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  assert(address && typeof address !== 'string');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, FARMING_CONFIG_DIR: config, FARMING_DISABLE_AUTH: '1', FARMING_SKIP_RUNTIME_PREPARE: '1', FARMING_SESSION_ENGINE: 'local', NODE_ENV: 'test', FARMING_START_STABILITY_MS: '20' };
  delete env.PORT;
  delete env.FARMING_PORT;
  const cli = (args: string[]) => promisify(execFile)(process.execPath, ['backend/farming-app-cli.cjs', ...args], { env, timeout: 40_000 });
  try {
    assert.equal((await cli(['--version'])).stdout.trim(), require('../../package.json').version);
    const startedAt = Date.now();
    await assert.rejects(cli(['daemon', '--port', String(address.port)]), /Port .* is unavailable/);
    assert(Date.now() - startedAt < 5000, 'explicit port conflicts must fail before readiness timeout');
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    fs.writeFileSync(serverLogFile(config), '  Local: http://localhost:1/obsolete?token=stale\n');
    for (let index = 0; index < 2; index++) {
      const started = await cli(['daemon', '--port', String(address.port)]);
      assert(!started.stdout.includes('obsolete'), 'old log access URLs must never be printed');
      assert.equal((started.stdout.match(/Local:/g) || []).length, 1, 'only this launch may print access URLs');
    }
    await cli(['stop']);
    console.log('CLI rejects occupied ports promptly, exposes its version, and prints only current startup URLs');
  } finally {
    if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve()));
    await cli(['stop']);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
