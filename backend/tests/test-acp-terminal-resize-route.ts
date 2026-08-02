const assert = require('assert');
const express = require('express');

type HttpServer = import('http').Server;

/**
 * Route-focused test for the ACP terminal resize HTTP validation boundary.
 *
 * The canonical PTY constraint lives in acp/client-services.cts:
 *   cols 2..1000, rows 1..1000, Number.isInteger.
 *
 * The HTTP route in server.cts must reject non-number types (boolean, string,
 * null), unsafe integers (1e20), NaN, Infinity, and out-of-bounds values
 * BEFORE they reach agentManager.resizeAcpTerminal.
 */

function isValidResize(cols: unknown, rows: unknown): boolean {
  return typeof cols === 'number' && typeof rows === 'number'
    && Number.isSafeInteger(cols) && cols >= 2 && cols <= 1000
    && Number.isSafeInteger(rows) && rows >= 1 && rows <= 1000;
}

function serverPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return address.port;
}

async function run() {
  // --- Predicate unit assertions ---

  // Valid values
  assert.strictEqual(isValidResize(80, 24), true, 'standard terminal size');
  assert.strictEqual(isValidResize(2, 1), true, 'minimum bounds');
  assert.strictEqual(isValidResize(1000, 1000), true, 'maximum bounds');
  assert.strictEqual(isValidResize(100, 30), true, 'typical resize');

  // Boolean coercion must be rejected (Number(true) === 1 would pass naive check)
  assert.strictEqual(isValidResize(true, 24), false, 'boolean true is not typeof number');
  assert.strictEqual(isValidResize(80, false), false, 'boolean false is not typeof number');

  // String coercion must be rejected
  assert.strictEqual(isValidResize('80', 24), false, 'string cols rejected');
  assert.strictEqual(isValidResize(80, '24'), false, 'string rows rejected');
  assert.strictEqual(isValidResize('', ''), false, 'empty strings rejected');

  // null / undefined
  assert.strictEqual(isValidResize(null, 24), false, 'null cols rejected');
  assert.strictEqual(isValidResize(80, undefined), false, 'undefined rows rejected');

  // NaN / Infinity
  assert.strictEqual(isValidResize(NaN, 24), false, 'NaN cols rejected');
  assert.strictEqual(isValidResize(80, NaN), false, 'NaN rows rejected');
  assert.strictEqual(isValidResize(Infinity, 24), false, 'Infinity rejected');
  assert.strictEqual(isValidResize(-Infinity, 24), false, '-Infinity rejected');

  // Unsafe integers (Number.isSafeInteger boundary)
  assert.strictEqual(isValidResize(1e20, 24), false, '1e20 exceeds safe integer range');
  assert.strictEqual(isValidResize(Number.MAX_SAFE_INTEGER, 24), false, 'MAX_SAFE_INTEGER exceeds 1000');
  assert.strictEqual(isValidResize(2 ** 53, 24), false, '2^53 is not safe');

  // Fractional
  assert.strictEqual(isValidResize(80.5, 24), false, 'fractional cols rejected');
  assert.strictEqual(isValidResize(80, 24.9), false, 'fractional rows rejected');

  // Out of canonical PTY bounds
  assert.strictEqual(isValidResize(1, 24), false, 'cols=1 below PTY minimum of 2');
  assert.strictEqual(isValidResize(0, 24), false, 'cols=0 rejected');
  assert.strictEqual(isValidResize(-1, 24), false, 'negative cols rejected');
  assert.strictEqual(isValidResize(1001, 24), false, 'cols=1001 above PTY maximum');
  assert.strictEqual(isValidResize(80, 0), false, 'rows=0 rejected');
  assert.strictEqual(isValidResize(80, 1001), false, 'rows=1001 above PTY maximum');

  // --- HTTP route integration ---

  const resizeCalls: Array<{ agentId: string; terminalId: string; cols: number; rows: number }> = [];
  const app = express();
  app.post('/api/agents/:agentId/acp-terminals/:terminalId/resize', express.json(), (req, res) => {
    const cols = req.body?.cols;
    const rows = req.body?.rows;
    if (typeof cols !== 'number' || typeof rows !== 'number'
      || !Number.isSafeInteger(cols) || cols < 2 || cols > 1000
      || !Number.isSafeInteger(rows) || rows < 1 || rows > 1000) {
      res.status(400).json({ error: 'cols (2-1000) and rows (1-1000) must be safe integers' });
      return;
    }
    resizeCalls.push({ agentId: req.params.agentId, terminalId: req.params.terminalId, cols, rows });
    res.json({ resized: true });
  });

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

    // Valid resize reaches the handler
    const valid = await postResize({ cols: 120, rows: 40 });
    assert.strictEqual(valid.status, 200);
    assert.deepStrictEqual(resizeCalls.at(-1), { agentId: 'agent-1', terminalId: 'term-1', cols: 120, rows: 40 });

    // Boolean true must be rejected at the boundary
    const boolResult = await postResize({ cols: true, rows: 24 });
    assert.strictEqual(boolResult.status, 400);
    assert.match(String(boolResult.body.error), /safe integers/);

    // String "80" must be rejected
    const stringResult = await postResize({ cols: '80', rows: 24 });
    assert.strictEqual(stringResult.status, 400);

    // 1e20 must be rejected
    const unsafeResult = await postResize({ cols: 1e20, rows: 24 });
    assert.strictEqual(unsafeResult.status, 400);

    // NaN (serialized as null in JSON) must be rejected
    const nanResult = await postResize({ cols: null, rows: 24 });
    assert.strictEqual(nanResult.status, 400);

    // cols=1 below PTY minimum
    const belowMin = await postResize({ cols: 1, rows: 24 });
    assert.strictEqual(belowMin.status, 400);

    // cols=1001 above PTY maximum
    const aboveMax = await postResize({ cols: 1001, rows: 24 });
    assert.strictEqual(aboveMax.status, 400);

    // Missing body fields
    const missing = await postResize({});
    assert.strictEqual(missing.status, 400);

    // Only valid call reached the handler
    assert.strictEqual(resizeCalls.length, 1, 'exactly one resize call should reach the handler');

    console.log('✓ ACP terminal resize route rejects non-number, unsafe, and out-of-bounds values');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
