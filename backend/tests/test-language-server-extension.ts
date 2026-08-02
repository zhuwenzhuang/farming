import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';

const { VsCodeBridgeClient } = require('../../extensions/language-server/backend/vscode-bridge-client.cjs');
const {
  createLanguageServerRouter,
  sanitizeBridgeResult,
} = require('../../extensions/language-server/backend/language-server-router.cjs');

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  return address.port;
}

async function closeIfListening(server: http.Server | null): Promise<void> {
  if (!server?.listening) return;
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
  ), 'utf8')) as { engines?: { vscode?: string }; files?: string[] };
  assert.strictEqual(
    bridgeManifest.engines?.vscode,
    '^1.85.0',
    'The user-managed Bridge should remain installable on the established VS Code Server baseline',
  );
  assert.ok(
    bridgeManifest.files?.includes('http-handler.js'),
    'The HTTP handler must be included in the packaged VS Code extension',
  );
  assert.ok(
    bridgeManifest.files?.includes('request-lifecycle.js'),
    'The request lifecycle helper must be included in the packaged VS Code extension',
  );
  const farmingManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
    files?: string[];
  };
  assert.ok(
    farmingManifest.files?.includes('extensions/language-server/vscode-bridge/http-handler.js'),
    'The HTTP handler must be included in the Farming npm package',
  );
  assert.ok(
    farmingManifest.files?.includes('extensions/language-server/vscode-bridge/request-lifecycle.js'),
    'The request lifecycle helper must be included in the Farming npm package',
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-language-server-'));
  let bridge: http.Server | null = null;
  let secondBridge: http.Server | null = null;
  let stalledBridge: http.Server | null = null;
  let unhealthyBridge: http.Server | null = null;
  let api: http.Server | null = null;
  try {
    const workspaceInput = path.join(tempDir, 'workspace');
    const descriptorPath = path.join(tempDir, 'bridge.json');
    const secondDescriptorPath = path.join(tempDir, 'bridge-22222222-2222-4222-8222-222222222222.json');
    const stalledDescriptorPath = path.join(tempDir, 'bridge-33333333-3333-4333-8333-333333333333.json');
    const unhealthyDescriptorPath = path.join(tempDir, 'bridge-44444444-4444-4444-8444-444444444444.json');
    fs.mkdirSync(path.join(workspaceInput, 'src'), { recursive: true });
    const workspace = fs.realpathSync(workspaceInput);
    fs.writeFileSync(path.join(workspace, 'src', 'main.ts'), 'export const value = 1;\n');
    const outsideFile = path.join(tempDir, 'private.txt');
    fs.writeFileSync(outsideFile, 'private\n');

    assert.deepStrictEqual(sanitizeBridgeResult(workspace, {
      selectionRange: null,
      nested: {
        value: null,
        items: [
          null,
          { uri: pathToFileURL(path.join(workspace, 'src', 'main.ts')).toString(), selectionRange: null },
          { uri: pathToFileURL(outsideFile).toString(), selectionRange: null },
        ],
      },
    }), {
      selectionRange: null,
      nested: {
        value: null,
        items: [
          null,
          { path: 'src/main.ts', selectionRange: null },
        ],
      },
    });

    assert.deepStrictEqual(sanitizeBridgeResult(workspace, [{
      item: {
        uri: pathToFileURL(outsideFile).toString(),
        selectionRange: null,
      },
      ranges: [],
    }, {
      item: {
        uri: pathToFileURL(path.join(workspace, 'src', 'main.ts')).toString(),
        selectionRange: null,
      },
      ranges: [],
    }]), [{
      item: {
        path: 'src/main.ts',
        selectionRange: null,
      },
      ranges: [],
    }]);

    let bridgeRequestFailure: { status: number; message: string } | null = null;
    bridge = http.createServer(async (request, response) => {
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
      if (bridgeRequestFailure) {
        response.statusCode = bridgeRequestFailure.status;
        response.end(JSON.stringify({
          error: bridgeRequestFailure.message,
          code: 'VSCODE_BRIDGE_PROVIDER_STALLED',
        }));
        return;
      }
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
    secondBridge = http.createServer(async (request, response) => {
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

    let stalledBridgeReceivedRequest = false;
    const stalledDetail = 'A test language provider is still running. Reload the VS Code window.';
    stalledBridge = http.createServer(async (request, response) => {
      assert.strictEqual(request.headers.authorization, 'Bearer stalled-token');
      if (request.url === '/v1/health') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          version: 1,
          name: 'Stalled VS Code Bridge',
          vscodeVersion: '1.99.0',
          features: ['definition'],
          workspaces: [pathToFileURL(workspace).toString()],
          requestState: 'stalled',
          detail: stalledDetail,
        }));
        return;
      }
      stalledBridgeReceivedRequest = true;
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'stalled bridge must be fenced' }));
    });
    const stalledBridgePort = await listen(stalledBridge);
    fs.writeFileSync(stalledDescriptorPath, JSON.stringify({
      version: 1,
      endpoint: `http://127.0.0.1:${stalledBridgePort}`,
      token: 'stalled-token',
    }), { mode: 0o600 });

    unhealthyBridge = http.createServer(async (request, response) => {
      assert.strictEqual(request.headers.authorization, 'Bearer unhealthy-token');
      await new Promise(resolve => setTimeout(resolve, 25));
      response.statusCode = 502;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: 'test unhealthy bridge' }));
    });
    const unhealthyBridgePort = await listen(unhealthyBridge);
    fs.writeFileSync(unhealthyDescriptorPath, JSON.stringify({
      version: 1,
      endpoint: `http://127.0.0.1:${unhealthyBridgePort}`,
      token: 'unhealthy-token',
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
    api = http.createServer(app);
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
      assert.strictEqual(stalledBridgeReceivedRequest, false);

      bridgeRequestFailure = { status: 504, message: 'direct deadline stalled' };
      const directDeadline = await requestJson(apiPort, '/api/language-server/request', {
        rootId: 'root-test',
        method: 'definition',
        filePath: 'src/main.ts',
        position: { line: 0, character: 1 },
      });
      assert.strictEqual(directDeadline.status, 504);
      assert.strictEqual(directDeadline.body.code, 'LANGUAGE_SERVER_BRIDGE_STALLED');
      assert.strictEqual(directDeadline.body.error, 'direct deadline stalled');

      bridgeRequestFailure = { status: 503, message: 'direct stalled fence' };
      const directFence = await requestJson(apiPort, '/api/language-server/request', {
        rootId: 'root-test',
        method: 'definition',
        filePath: 'src/main.ts',
        position: { line: 0, character: 1 },
      });
      assert.strictEqual(directFence.status, 503);
      assert.strictEqual(directFence.body.code, 'LANGUAGE_SERVER_BRIDGE_STALLED');
      assert.strictEqual(directFence.body.error, 'direct stalled fence');
      bridgeRequestFailure = null;

      const escaped = await requestJson(apiPort, '/api/language-server/request', {
        rootId: 'root-test',
        method: 'definition',
        filePath: '../private.txt',
        position: { line: 0, character: 0 },
      });
      assert.strictEqual(escaped.status, 403);

      fs.rmSync(descriptorPath, { force: true });
      client.invalidate();
      const fallbackCapability = await client.capability({ force: true });
      assert.strictEqual(fallbackCapability.status, 'connected');
      assert.deepStrictEqual(fallbackCapability.workspaces, [
        pathToFileURL(path.join(tempDir, 'other-workspace')).toString(),
      ]);
      const stalledResult = await requestJson(apiPort, '/api/language-server/request', {
        rootId: 'root-test',
        method: 'definition',
        filePath: 'src/main.ts',
        position: { line: 0, character: 1 },
      });
      assert.strictEqual(stalledResult.status, 503);
      assert.strictEqual(stalledResult.body.code, 'LANGUAGE_SERVER_BRIDGE_STALLED');
      assert.strictEqual(stalledResult.body.error, stalledDetail);
      assert.strictEqual(secondBridgeReceivedRequest, false);
      assert.strictEqual(stalledBridgeReceivedRequest, false);

      fs.rmSync(secondDescriptorPath, { force: true });
      client.invalidate();
      const stalledCapability = await client.capability({ force: true });
      assert.strictEqual(stalledCapability.status, 'error');
      assert.strictEqual(stalledCapability.detail, stalledDetail);
      const onlyStalledResult = await requestJson(apiPort, '/api/language-server/request', {
        rootId: 'root-test',
        method: 'definition',
        filePath: 'src/main.ts',
        position: { line: 0, character: 1 },
      });
      assert.strictEqual(onlyStalledResult.status, 503);
      assert.strictEqual(onlyStalledResult.body.code, 'LANGUAGE_SERVER_BRIDGE_STALLED');
    } finally {
      await closeIfListening(api);
      await closeIfListening(bridge);
      await closeIfListening(secondBridge);
      await closeIfListening(stalledBridge);
      await closeIfListening(unhealthyBridge);
    }

    fs.rmSync(descriptorPath, { force: true });
    fs.rmSync(secondDescriptorPath, { force: true });
    fs.rmSync(stalledDescriptorPath, { force: true });
    fs.rmSync(unhealthyDescriptorPath, { force: true });
    client.invalidate();
    assert.strictEqual((await client.capability({ force: true })).status, 'unavailable');
  } finally {
    await closeIfListening(api);
    await closeIfListening(bridge);
    await closeIfListening(secondBridge);
    await closeIfListening(stalledBridge);
    await closeIfListening(unhealthyBridge);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  assert.strictEqual(fs.existsSync(tempDir), false, 'the test must remove its exact temporary directory');
  console.log('Language Server extension discovery/proxy regression test passed.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
