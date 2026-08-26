import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SharedConfigService } from '../../extensions/shared-config/backend/shared-config-service.cjs';
import { createSharedConfigRouter } from '../../extensions/shared-config/backend/shared-config-router.cjs';

const express = require('express');

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-shared-config-router-'));
  const envFile = path.join(temp, 'agent.env');
  fs.writeFileSync(envFile, 'ROUTER_SENTINEL=router-secret-value\n', { mode: 0o600 });
  const service = new SharedConfigService({ configDir: path.join(temp, 'config') });
  const app = express();
  app.use((req: { headers: Record<string, string>; authAccessMode?: string }, _res: unknown, next: () => void) => {
    req.authAccessMode = req.headers['x-test-access'] || 'owner';
    next();
  });
  app.use('/api/extensions/shared-config', createSharedConfigRouter(service));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/api/extensions/shared-config`;
  try {
    const ownerRead = await fetch(url, { headers: { 'x-test-access': 'owner' } });
    assert.equal(ownerRead.status, 200);
    assert.equal(ownerRead.headers.get('cache-control'), 'no-store');
    assert.equal((await ownerRead.json() as { revision: number }).revision, 0);

    const readOnlyRead = await fetch(url, { headers: { 'x-test-access': 'read-only' } });
    assert.equal(readOnlyRead.status, 403);
    assert.deepEqual(await readOnlyRead.json(), {
      error: 'Owner access is required', code: 'OWNER_ACCESS_REQUIRED',
    });

    const saved = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-access': 'owner' },
      body: JSON.stringify({
        expectedRevision: 0,
        enabled: true,
        instructions: 'Router prompt',
        environment: { format: 'dotenv', path: envFile },
      }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as { revision: number; environmentSummary: { names: string[] } };
    assert.equal(savedBody.revision, 1);
    assert.deepEqual(savedBody.environmentSummary.names, ['ROUTER_SENTINEL']);
    assert.equal(JSON.stringify(savedBody).includes('router-secret-value'), false, 'API must not return environment values');

    const conflict = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-access': 'owner' },
      body: JSON.stringify({ expectedRevision: 0, enabled: false }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { code: string }).code, 'SHARED_CONFIG_REVISION_CONFLICT');

    const readOnlyWrite = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-access': 'read-only' },
      body: JSON.stringify({ expectedRevision: 1, enabled: false }),
    });
    assert.equal(readOnlyWrite.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('shared configuration router tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
