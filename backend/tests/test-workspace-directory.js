const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  createWorkspaceDirectoryRouter,
  prepareWorkspaceDirectory,
  resolveWorkspaceDirectory,
} = require('../workspace-directory');

async function fetchJson(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/workspaces/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-workspace-directory-'));
  const existing = path.join(tempRoot, 'existing');
  const missing = path.join(tempRoot, 'new-project', 'nested');
  const filePath = path.join(tempRoot, 'file.txt');
  fs.mkdirSync(existing);
  fs.writeFileSync(filePath, 'not a directory');

  assert.strictEqual(resolveWorkspaceDirectory('~/project', tempRoot), path.join(tempRoot, 'project'));
  assert.strictEqual(resolveWorkspaceDirectory('  ', tempRoot), '');

  const ready = await prepareWorkspaceDirectory(existing);
  assert.deepStrictEqual(ready, {
    status: 200,
    body: { status: 'ready', workspace: existing },
  });

  const missingResult = await prepareWorkspaceDirectory(missing);
  assert.strictEqual(missingResult.status, 409);
  assert.strictEqual(missingResult.body.status, 'missing');
  assert.strictEqual(missingResult.body.code, 'workspace-not-found');
  assert.strictEqual(fs.existsSync(missing), false, 'checking a missing workspace must not create it');

  const created = await prepareWorkspaceDirectory(missing, { create: true });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.status, 'created');
  assert.strictEqual(fs.statSync(missing).isDirectory(), true);

  const notDirectory = await prepareWorkspaceDirectory(filePath);
  assert.strictEqual(notDirectory.status, 409);
  assert.strictEqual(notDirectory.body.code, 'workspace-not-directory');

  const deniedFileSystem = {
    stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    mkdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  };
  const forbidden = await prepareWorkspaceDirectory(path.join(tempRoot, 'denied'), {
    create: true,
    fileSystem: deniedFileSystem,
  });
  assert.strictEqual(forbidden.status, 403);
  assert.strictEqual(forbidden.body.code, 'workspace-create-forbidden');

  const parentNotDirectory = await prepareWorkspaceDirectory(path.join(filePath, 'child'), { create: true });
  assert.strictEqual(parentNotDirectory.status, 409);
  assert.strictEqual(parentNotDirectory.body.code, 'workspace-parent-not-directory');

  const app = express();
  app.use('/api/workspaces', createWorkspaceDirectoryRouter());
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const routeMissing = path.join(tempRoot, 'route-project');
    const checked = await fetchJson(baseUrl, { workspace: routeMissing });
    assert.strictEqual(checked.status, 409);
    assert.strictEqual(checked.body.code, 'workspace-not-found');

    const routeCreated = await fetchJson(baseUrl, { workspace: routeMissing, create: true });
    assert.strictEqual(routeCreated.status, 201);
    assert.deepStrictEqual(routeCreated.body, { status: 'created', workspace: routeMissing });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('✓ Workspace directory preparation is explicit and fail-closed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
