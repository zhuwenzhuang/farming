'use strict';

const MAX_BODY_BYTES = 1024 * 1024;

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function createBridgeHttpHandler(options) {
  return async function handleRequest(request, response) {
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      json(response, 401, { error: 'Unauthorized', code: 'VSCODE_BRIDGE_UNAUTHORIZED' });
      return;
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/health') {
      const lifecycleState = options.lifecycle.state();
      json(response, 200, {
        ...options.health(),
        requestState: lifecycleState.requestState,
        ...(lifecycleState.requestState === 'stalled' ? {
          detail: 'A VS Code language provider request is still running. Reload the VS Code window if this persists.',
          stalledGeneration: lifecycleState.stalledGenerations[0],
        } : {}),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/request') {
      try {
        const input = await readBody(request);
        const result = await options.lifecycle.run(() => options.executeRequest(input));
        json(response, 200, options.responseValue(result));
      } catch (error) {
        json(response, Number(error?.status) || 400, {
          error: error instanceof Error ? error.message : String(error),
          code: String(error?.code || 'VSCODE_BRIDGE_REQUEST_FAILED'),
        });
      }
      return;
    }
    json(response, 404, { error: 'Not found', code: 'VSCODE_BRIDGE_NOT_FOUND' });
  };
}

module.exports = { createBridgeHttpHandler };
