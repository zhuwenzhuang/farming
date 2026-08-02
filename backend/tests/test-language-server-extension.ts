import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';

const { VsCodeBridgeClient } = require('../../extensions/language-server/backend/vscode-bridge-client.cjs');
const { createLanguageServerRouter } = require('../../extensions/language-server/backend/language-server-router.cjs');

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function requestJson(port: number, requestPath: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function run() {
  const bridgeManifest = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../extensions/language-server/vscode-bridge/package.json',
  ), 'utf8')) as { engines?: { vscode?: string } };
  assert.strictEqual(
    bridgeManifest.engines?.vscode,
    '^1.85.0',
    'The user-managed Bridge should remain installable on the established VS Code Server baseline',
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-language-server-'));
  const workspaceInput = path.join(tempDir, 'workspace');
  const descriptorPath = path.join(tempDir, 'bridge.json');
  const secondDescriptorPath = path.join(tempDir, 'bridge-22222222-2222-4222-8222-222222222222.json');
  fs.mkdirSync(path.join(workspaceInput, 'src'), { recursive: true });
  const workspace = fs.realpathSync(workspaceInput);
  fs.writeFileSync(path.join(workspace, 'src', 'main.ts'), 'export const value = 1;\n');

  const bridge = http.createServer(async (request, response) => {
    assert.strictEqual(request.headers.authorization, 'Bearer test-token');
    if (request.url === '/v1/health') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        version: 1,
        name: 'Test VS Code Bridge',
        vscodeVersion: '1.99.0',
        features: ['definition', 'callHierarchy'],
        workspaces: [pathToFileURL(workspace).toString()],
      }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    assert.strictEqual(requestBody.method, 'definition');
    assert.strictEqual(requestBody.uri, pathToFileURL(path.join(workspace, 'src', 'main.ts')).toString());
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      result: [{
        uri: pathToFileURL(path.join(workspace, 'src', 'main.ts')).toString(),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      }, {
        uri: pathToFileURL(path.join(tempDir, 'private.txt')).toString(),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      }],
    }));
  });
  const bridgePort = await listen(bridge);
  fs.writeFileSync(descriptorPath, JSON.stringify({
    version: 1,
    endpoint: `http://127.0.0.1:${bridgePort}`,
    token: 'test-token',
  }), { mode: 0o600 });

  let secondBridgeReceivedRequest = false;
  const secondBridge = http.createServer(async (request, response) => {
    assert.strictEqual(request.headers.authorization, 'Bearer second-token');
    if (request.url === '/v1/health') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        version: 1,
        name: 'Second VS Code Bridge',
        vscodeVersion: '1.99.0',
        features: ['definition'],
        workspaces: [pathToFileURL(path.join(tempDir, 'other-workspace')).toString()],
      }));
      return;
    }
    secondBridgeReceivedRequest = true;
    response.statusCode = 500;
    response.end(JSON.stringify({ error: 'wrong bridge' }));
  });
  const secondBridgePort = await listen(secondBridge);
  fs.writeFileSync(secondDescriptorPath, JSON.stringify({
    version: 1,
    endpoint: `http://127.0.0.1:${secondBridgePort}`,
    token: 'second-token',
  }), { mode: 0o600 });

  const client = new VsCodeBridgeClient({ descriptorPaths: [descriptorPath] });
  const capability = await client.capability({ force: true });
  assert.strictEqual(capability.status, 'connected');
  assert.strictEqual(capability.vscodeVersion, '1.99.0');
  assert.strictEqual(capability.workspaces.length, 2);

  const app = express();
  app.use('/api/language-server', createLanguageServerRouter(client, {
    resolve(rootId: unknown) {
      assert.strictEqual(rootId, 'root-test');
      return { rootId: 'root-test', kind: 'directory', canonicalPath: workspace };
    },
  }));
  const api = http.createServer(app);
  const apiPort = await listen(api);
  try {
    const result = await requestJson(apiPort, '/api/language-server/request', {
      rootId: 'root-test',
      method: 'definition',
      filePath: 'src/main.ts',
      position: { line: 0, character: 1 },
    });
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body.result, [{
      path: 'src/main.ts',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    }]);
    assert.strictEqual(secondBridgeReceivedRequest, false);

    const escaped = await requestJson(apiPort, '/api/language-server/request', {
      rootId: 'root-test',
      method: 'definition',
      filePath: '../private.txt',
      position: { line: 0, character: 0 },
    });
    assert.strictEqual(escaped.status, 403);
  } finally {
    await close(api);
    await close(bridge);
    await close(secondBridge);
  }

  fs.rmSync(descriptorPath, { force: true });
  fs.rmSync(secondDescriptorPath, { force: true });
  client.invalidate();
  assert.strictEqual((await client.capability({ force: true })).status, 'unavailable');
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('Language Server extension discovery/proxy regression test passed.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
