const assert = require('assert');
const express = require('express');
const { createAcpTerminalResizeHandler } = require('../acp-terminal-resize-handler.cjs');

type HttpServer = import('http').Server;

/**
 * Route-focused test for the real ACP terminal resize handler extracted in
 * acp-terminal-resize-handler.cts. Uses a fake manager to verify that the
 * HTTP boundary rejects non-number types (boolean, string, null), unsafe
 * integers (1e20), NaN, Infinity, and out-of-bounds values BEFORE they reach
 * agentManager.resizeAcpTerminal.
 *
 * Canonical PTY constraints (acp/client-services.cts):
 *   cols 2..1000, rows 1..1000, Number.isInteger.
 */

function serverPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return address.port;
}

async function run() {
  const resizeCalls: Array<{ agentId: string; terminalId: string; cols: number; rows: number }> = [];
  const fakeManager = {
    resizeAcpTerminal(agentId: string, terminalId: string, cols: number, rows: number) {
      resizeCalls.push({ agentId, terminalId, cols, rows });
      return { resized: true, cols, rows };
    },
  };

  const app = express();
  app.post(
    '/api/agents/:agentId/acp-terminals/:terminalId/resize',
    express.json(),
    createAcpTerminalResizeHandler(fakeManager),
  );

  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    async function postResize(body: unknown) {
      const response = await fetch(`${baseUrl}/api/agents/agent-1/acp-terminals/term-1/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    // --- Valid values reach the fake manager ---

    const valid = await postResize({ cols: 120, rows: 40 });
    assert.strictEqual(valid.status, 200);
    assert.deepStrictEqual(valid.body, { resized: true, cols: 120, rows: 40 });
    assert.deepStrictEqual(resizeCalls.at(-1), { agentId: 'agent-1', terminalId: 'term-1', cols: 120, rows: 40 });

    const minBounds = await postResize({ cols: 2, rows: 1 });
    assert.strictEqual(minBounds.status, 200, 'cols=2 rows=1 is the canonical minimum');

    const maxBounds = await postResize({ cols: 1000, rows: 1000 });
    assert.strictEqual(maxBounds.status, 200, 'cols=1000 rows=1000 is the canonical maximum');

    // --- Boolean coercion must be rejected ---

    const boolTrue = await postResize({ cols: true, rows: 24 });
    assert.strictEqual(boolTrue.status, 400, 'boolean true must not coerce to 1');
    assert.match(String(boolTrue.body.error), /safe integers/);

    const boolFalse = await postResize({ cols: 80, rows: false });
    assert.strictEqual(boolFalse.status, 400, 'boolean false must not coerce to 0');

    // --- String coercion must be rejected ---

    const stringCols = await postResize({ cols: '80', rows: 24 });
    assert.strictEqual(stringCols.status, 400, 'string "80" must not pass typeof number');

    const stringRows = await postResize({ cols: 80, rows: '24' });
    assert.strictEqual(stringRows.status, 400);

    // --- null / undefined / missing ---

    const nullCols = await postResize({ cols: null, rows: 24 });
    assert.strictEqual(nullCols.status, 400, 'null (JSON NaN representation) rejected');

    const missingFields = await postResize({});
    assert.strictEqual(missingFields.status, 400, 'undefined fields rejected');

    // --- Unsafe integers ---

    const unsafeLarge = await postResize({ cols: 1e20, rows: 24 });
    assert.strictEqual(unsafeLarge.status, 400, '1e20 exceeds Number.isSafeInteger');

    // --- Fractional ---

    const fractional = await postResize({ cols: 80.5, rows: 24 });
    assert.strictEqual(fractional.status, 400, 'fractional cols rejected');

    // --- Out of canonical PTY bounds ---

    const colsBelowMin = await postResize({ cols: 1, rows: 24 });
    assert.strictEqual(colsBelowMin.status, 400, 'cols=1 below PTY minimum of 2');

    const colsAboveMax = await postResize({ cols: 1001, rows: 24 });
    assert.strictEqual(colsAboveMax.status, 400, 'cols=1001 above PTY maximum');

    const rowsZero = await postResize({ cols: 80, rows: 0 });
    assert.strictEqual(rowsZero.status, 400, 'rows=0 rejected');

    const rowsAboveMax = await postResize({ cols: 80, rows: 1001 });
    assert.strictEqual(rowsAboveMax.status, 400, 'rows=1001 above PTY maximum');

    const negative = await postResize({ cols: -5, rows: 24 });
    assert.strictEqual(negative.status, 400, 'negative cols rejected');

    // --- Only valid calls reached the fake manager ---

    assert.strictEqual(resizeCalls.length, 3, 'exactly 3 valid resize calls should reach the manager');

    // --- Direct handler invocation: NaN/Infinity/-Infinity ---
    // These cannot survive JSON.stringify over HTTP (they serialize to null),
    // but the extracted handler can be called directly with fake req/res to
    // prove the typeof + isSafeInteger guard rejects them at the boundary.

    const handler = createAcpTerminalResizeHandler(fakeManager);
    function callHandlerDirect(body: Record<string, unknown>) {
      let statusCode = 200;
      let jsonBody: unknown = null;
      const res = {
        status(code: number) { statusCode = code; return res; },
        json(value: unknown) { jsonBody = value; return res; },
      };
      handler({ body, params: { agentId: 'a', terminalId: 't' } }, res);
      return { status: statusCode, body: jsonBody as Record<string, unknown> };
    }

    const callsBefore = resizeCalls.length;
    assert.strictEqual(callHandlerDirect({ cols: NaN, rows: 24 }).status, 400, 'NaN cols rejected');
    assert.strictEqual(callHandlerDirect({ cols: 80, rows: NaN }).status, 400, 'NaN rows rejected');
    assert.strictEqual(callHandlerDirect({ cols: Infinity, rows: 24 }).status, 400, 'Infinity rejected');
    assert.strictEqual(callHandlerDirect({ cols: -Infinity, rows: 24 }).status, 400, '-Infinity rejected');
    assert.strictEqual(callHandlerDirect({ cols: 80, rows: Infinity }).status, 400, 'Infinity rows rejected');
    assert.strictEqual(resizeCalls.length, callsBefore, 'no NaN/Infinity call may reach the manager');

    // --- Manager error propagation ---

    const throwingManager = {
      resizeAcpTerminal() { throw new Error('Agent not found'); },
    };
    const errorApp = express();
    errorApp.post(
      '/api/agents/:agentId/acp-terminals/:terminalId/resize',
      express.json(),
      createAcpTerminalResizeHandler(throwingManager),
    );
    const errorServer = await new Promise<HttpServer>(resolve => {
      const listener = errorApp.listen(0, () => resolve(listener));
    });
    try {
      const notFound = await fetch(
        `http://127.0.0.1:${serverPort(errorServer)}/api/agents/bad/acp-terminals/t/resize`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: 80, rows: 24 }) },
      );
      assert.strictEqual(notFound.status, 404, 'Agent not found maps to 404');
    } finally {
      await new Promise(resolve => errorServer.close(resolve));
    }

    console.log('✓ ACP terminal resize handler validates canonical PTY bounds via real extracted route');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
