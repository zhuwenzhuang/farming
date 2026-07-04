const assert = require('assert');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createAppServerApiRouter } = require('../app-server-api');

async function listen(server) {
  return new Promise((resolve) => {
    const listener = server.listen(0, () => resolve(listener));
  });
}

async function close(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

async function waitFor(fn, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

async function readSseUntil(url, predicate) {
  const controller = new globalThis.AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.strictEqual(response.status, 200);
  const reader = response.body.getReader();
  let text = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
      if (predicate(text)) break;
    }
  } finally {
    controller.abort();
  }

  return text;
}

async function createMockCodexAppServer() {
  const server = http.createServer();
  const wss = new WebSocket.Server({ server });
  const messages = [];
  const serverResponses = [];

  wss.on('connection', (ws) => {
    let sentServerRequest = false;

    function send(message) {
      ws.send(JSON.stringify(message));
    }

    function sendServerRequestOnce() {
      if (sentServerRequest) return;
      sentServerRequest = true;
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        send({
          id: 'approval-1',
          method: 'item/tool/requestUserInput',
          params: {
            prompt: 'Choose a branch',
            choices: ['main', 'feature'],
          },
        });
      }, 10);
    }

    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);

      if (message.method === 'initialize') {
        assert.strictEqual(message.params.clientInfo.name, 'farming');
        assert.strictEqual(message.params.capabilities.experimentalApi, true);
        send({
          id: message.id,
          result: {
            userAgent: 'codex-cli/0.0.test',
            codexHome: '/tmp/farming-codex-home',
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        });
        return;
      }

      if (message.method === 'initialized') {
        sendServerRequestOnce();
        return;
      }

      if (message.method === 'model/list') {
        send({
          id: message.id,
          result: {
            data: [
              { id: 'gpt-test', name: 'GPT Test', isDefault: true },
            ],
          },
        });
        send({
          method: 'thread/status/changed',
          params: {
            threadId: 'thread-test',
            status: 'idle',
          },
        });
        sendServerRequestOnce();
        return;
      }

      if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'result')) {
        serverResponses.push(message);
      }
    });
  });

  await listen(server);
  const port = server.address().port;
  return {
    endpoint: `ws://127.0.0.1:${port}`,
    messages,
    serverResponses,
    async close() {
      wss.clients.forEach((client) => client.close());
      wss.close();
      await close(server);
    },
  };
}

async function run() {
  const mock = await createMockCodexAppServer();
  const app = express();
  app.use('/api/app-server', createAppServerApiRouter({
    defaultCodexEndpoint: mock.endpoint,
  }));
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const metadata = await fetchJson(baseUrl, '/api/app-server');
    assert.strictEqual(metadata.response.status, 200);
    assert.deepStrictEqual(metadata.body.providers, ['codex']);
    assert(metadata.body.codex.clientMethods.includes('turn/start'));
    assert(metadata.body.codex.notificationMethods.includes('turn/plan/updated'));
    assert(metadata.body.codex.serverRequestMethods.includes('item/tool/requestUserInput'));

    const provider = await fetchJson(baseUrl, '/api/app-server/codex');
    assert.strictEqual(provider.response.status, 200);
    assert.strictEqual(provider.body.status.endpoint, mock.endpoint);
    assert.strictEqual(provider.body.status.connected, false);

    const unsupportedProvider = await fetchJson(baseUrl, '/api/app-server/claude');
    assert.strictEqual(unsupportedProvider.response.status, 404);

    const unsupportedMethod = await fetchJson(baseUrl, '/api/app-server/codex/rpc', {
      method: 'POST',
      body: JSON.stringify({ method: 'not/a-method' }),
    });
    assert.strictEqual(unsupportedMethod.response.status, 400);

    const models = await fetchJson(baseUrl, '/api/app-server/codex/rpc', {
      method: 'POST',
      body: JSON.stringify({
        method: 'model/list',
        params: {
          cursor: null,
          limit: 5,
          includeHidden: true,
        },
      }),
    });
    assert.strictEqual(models.response.status, 200);
    assert.strictEqual(models.body.result.data[0].id, 'gpt-test');
    assert(mock.messages.some(message => message.method === 'initialize'));
    assert(mock.messages.some(message => message.method === 'initialized'));

    await waitFor(async () => {
      const status = await fetchJson(baseUrl, '/api/app-server/codex');
      return status.body.status.pendingServerRequestIds.includes('approval-1');
    });

    const sseText = await readSseUntil(
      `${baseUrl}/api/app-server/codex/events?replay=1`,
      text => text.includes('event: server-request') && text.includes('thread/status/changed')
    );
    assert(sseText.includes('"kind":"server-request"'));
    assert(sseText.includes('"method":"thread/status/changed"'));

    const resolved = await fetchJson(baseUrl, '/api/app-server/codex/server-requests/approval-1/resolve', {
      method: 'POST',
      body: JSON.stringify({ result: { choice: 'feature' } }),
    });
    assert.strictEqual(resolved.response.status, 200);
    assert.strictEqual(resolved.body.resolved, true);
    await waitFor(() => mock.serverResponses.find(message => message.id === 'approval-1'));
    assert.deepStrictEqual(mock.serverResponses[0].result, { choice: 'feature' });

    console.log('✓ app-server API bridges Codex JSON-RPC requests, notifications, and server requests');
  } finally {
    await close(server);
    await mock.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
