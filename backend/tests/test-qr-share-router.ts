const assert = require('assert');
const express = require('express');
const {
  createQrShareRouter,
  entryPathWithQuery,
  shareTargetQueryFromBody,
} = require('../qr-share-router.cjs');
const { SHARE_TICKET_TTL_MS } = require('../qr-share-tickets.cjs');

type HttpServer = import('http').Server;

interface ExpressErrorResponse {
  json(value: unknown): ExpressErrorResponse;
  status(code: number): ExpressErrorResponse;
}

interface TicketCreateOptions {
  expiresAt: number;
  now: number;
  targetQuery: string;
}

interface TicketCreateCall extends TicketCreateOptions {
  token: string;
}

function serverPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return address.port;
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function middlewareErrorStatus(error: unknown): number {
  if (!error || typeof error !== 'object' || !('status' in error)) return 500;
  const status = Number(error.status);
  return Number.isInteger(status) ? status : 500;
}

async function assertJsonResponse(
  response: Response,
  status: number,
  body: unknown,
): Promise<void> {
  assert.strictEqual(response.status, status);
  assert.strictEqual(response.headers.get('cache-control'), 'no-store');
  assert.deepStrictEqual(await response.json(), body);
}

function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function postRawJson(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

async function listen(app: { listen(port: number, callback: () => void): HttpServer }): Promise<HttpServer> {
  return new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
}

async function run(): Promise<void> {
  const now = 1_800_000_000_000;
  let ownerToken = 'owner-token';
  const calls: string[] = [];
  const ticketCreates: TicketCreateCall[] = [];
  const revokedCodes: string[] = [];
  let delegatedExpiresAt = now + 20_000;
  let ticketCreateError: Error | null = null;
  let ticketSequence = 0;

  const auth = {
    createReadOnlyToken(options: { expiresAt: number }): string {
      calls.push(`createReadOnlyToken:${options.expiresAt}`);
      return `readonly-${options.expiresAt}`;
    },
    extractToken(request: { headers: Record<string, string | string[] | undefined> }): string | null {
      const token = request.headers['x-test-token'];
      calls.push(`extractToken:${String(token || '')}`);
      return typeof token === 'string' ? token : null;
    },
    getToken(): string {
      calls.push('getToken');
      return ownerToken;
    },
    readOnlyTokenExpiresAt(token: unknown): number | null {
      calls.push(`readOnlyTokenExpiresAt:${String(token || '')}`);
      if (token === 'delegated') return delegatedExpiresAt;
      return null;
    },
    rotateToken(): string {
      calls.push('rotateToken');
      ownerToken = 'rotated-owner-token';
      return ownerToken;
    },
    setAuthenticatedCookie(response: { setHeader(name: string, value: string): void }): void {
      calls.push('setAuthenticatedCookie');
      response.setHeader('Set-Cookie', `farming_token=${ownerToken}; Path=/farm; HttpOnly; SameSite=Lax`);
    },
  };
  const tickets = {
    create(token: unknown, options: TicketCreateOptions) {
      calls.push(`createTicket:${String(token)}`);
      if (ticketCreateError) throw ticketCreateError;
      ticketSequence += 1;
      ticketCreates.push({ token: String(token), ...options });
      return {
        code: `SHARE${ticketSequence}`,
        expiresAt: options.expiresAt,
        targetQuery: options.targetQuery,
      };
    },
    revoke(code: unknown): boolean {
      calls.push(`revoke:${String(code)}`);
      revokedCodes.push(String(code));
      return code === 'SHARE1';
    },
  };

  const app = express();
  app.use((req: { authAccessMode?: string; headers: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.authAccessMode = req.headers['x-test-access'] === 'read-only' ? 'read-only' : 'owner';
    next();
  });
  app.use('/farm/api/share/qr-ticket', createQrShareRouter(auth, tickets, {
    authEnabled: true,
    basePath: '/farm',
    fallbackPort: 9123,
    now: () => now,
    publicOrigin: 'https://share.example.test',
  }));
  app.use((error: unknown, _req: unknown, res: ExpressErrorResponse, _next: unknown) => {
    res.status(middlewareErrorStatus(error)).json({ error: 'request body rejected' });
  });
  const server = await listen(app);
  const endpoint = `http://127.0.0.1:${serverPort(server)}/farm/api/share/qr-ticket`;

  try {
    const fileTarget = {
      target: {
        kind: 'file',
        agentId: 'agent-1',
        absolutePath: '/workspace/src/example.ts',
        filePath: 'src/example.ts',
        projectLabel: 'Example',
        view: 'diff',
        lineNumber: 7,
        column: 2,
        endColumn: 9,
      },
    };
    const targetQuery = shareTargetQueryFromBody(fileTarget);
    assert.strictEqual(
      targetQuery,
      'ftarget=file&path=%2Fworkspace%2Fsrc%2Fexample.ts&project=Example&view=diff&line=7&column=2&endColumn=9',
    );
    assert.strictEqual(
      shareTargetQueryFromBody({ target: { kind: 'agent', agentId: 'agent-1', readingAnchor: 'turn_7' } }),
      'ftarget=agent&agent=agent-1&fra=turn_7',
    );
    assert.strictEqual(
      shareTargetQueryFromBody({ target: { kind: 'folder', projectLabel: 'Example', folderPath: '/workspace' } }),
      'ftarget=folder&project=Example&folder=%2Fworkspace',
    );
    assert.strictEqual(shareTargetQueryFromBody({ target: { kind: 'file' } }), '');
    assert.strictEqual(
      entryPathWithQuery('ftarget=agent&agent=one', {
        authEnabled: true,
        basePath: '/farm/',
        token: 'read-only-token',
      }),
      '/farm?ftarget=agent&agent=one&token=read-only-token',
    );
    assert.strictEqual(
      entryPathWithQuery('', { authEnabled: false, basePath: '/', token: ownerToken }),
      '/',
      'disabled authentication must not leak an unused token into the entry URL',
    );

    let callStart = calls.length;
    const ownerResponse = await postJson(endpoint, fileTarget, {
      'x-forwarded-host': 'share.example.test, ignored.example.test',
      'x-forwarded-proto': 'https, http',
      'x-test-token': 'owner-request-token',
    });
    const readOnlyToken = `readonly-${now + SHARE_TICKET_TTL_MS}`;
    await assertJsonResponse(ownerResponse, 200, {
      code: 'SHARE1',
      expiresAt: now + SHARE_TICKET_TTL_MS,
      ttlMs: SHARE_TICKET_TTL_MS,
      shortPath: '/farm/j/SHARE1',
      shortUrl: 'https://share.example.test/farm/j/SHARE1',
      longUrl: `https://share.example.test/farm?${targetQuery}&token=${readOnlyToken}`,
      shortUrlAccessMode: 'owner',
      longUrlAccessMode: 'read-only',
      tokenLabel: ownerToken,
      fullAccessUrl: `https://share.example.test/farm?${targetQuery}&token=${ownerToken}`,
    });
    assert.deepStrictEqual(calls.slice(callStart), [
      'extractToken:owner-request-token',
      `createReadOnlyToken:${now + SHARE_TICKET_TTL_MS}`,
      'getToken',
      `createTicket:${ownerToken}`,
      'getToken',
    ]);
    assert.deepStrictEqual(ticketCreates.at(-1), {
      token: ownerToken,
      expiresAt: now + SHARE_TICKET_TTL_MS,
      now,
      targetQuery,
    });

    const spoofedOriginResponse = await postJson(endpoint, {}, {
      'x-forwarded-host': 'attacker.example.test',
      'x-forwarded-proto': 'https',
      'x-test-token': 'owner-request-token',
    });
    const spoofedOriginBody = await spoofedOriginResponse.json() as { shortUrl: string; longUrl: string; fullAccessUrl: string };
    assert.strictEqual(spoofedOriginResponse.headers.get('cache-control'), 'no-store');
    assert.match(spoofedOriginBody.shortUrl, /^https:\/\/share\.example\.test\//);
    assert.match(spoofedOriginBody.longUrl, /^https:\/\/share\.example\.test\//);
    assert.match(spoofedOriginBody.fullAccessUrl, /^https:\/\/share\.example\.test\//);
    assert(!JSON.stringify(spoofedOriginBody).includes('attacker.example.test'));

    const directOriginApp = express();
    directOriginApp.use('/api/share/qr-ticket', createQrShareRouter(auth, tickets, {
      authEnabled: true,
      basePath: '',
      fallbackPort: 9123,
      now: () => now,
    }));
    const directOriginServer = await listen(directOriginApp);
    try {
      const directEndpoint = `http://127.0.0.1:${serverPort(directOriginServer)}/api/share/qr-ticket`;
      const directOriginResponse = await postJson(directEndpoint, {}, {
        'x-forwarded-host': 'attacker.example.test',
        'x-forwarded-proto': 'https',
        'x-test-token': 'owner-request-token',
      });
      const directOriginBody = await directOriginResponse.json() as { shortUrl: string };
      assert.strictEqual(new URL(directOriginBody.shortUrl).origin, `http://127.0.0.1:${serverPort(directOriginServer)}`);
    } finally {
      await closeServer(directOriginServer);
    }

    callStart = calls.length;
    const delegatedResponse = await postJson(endpoint, {}, {
      'x-forwarded-host': 'share.example.test',
      'x-forwarded-proto': 'https',
      'x-test-access': 'read-only',
      'x-test-token': 'delegated',
    });
    const delegatedToken = `readonly-${delegatedExpiresAt}`;
    await assertJsonResponse(delegatedResponse, 200, {
      code: 'SHARE4',
      expiresAt: delegatedExpiresAt,
      ttlMs: SHARE_TICKET_TTL_MS,
      shortPath: '/farm/j/SHARE4',
      shortUrl: 'https://share.example.test/farm/j/SHARE4',
      longUrl: `https://share.example.test/farm?token=${delegatedToken}`,
      shortUrlAccessMode: 'read-only',
      longUrlAccessMode: 'read-only',
      tokenLabel: '',
    });
    assert.deepStrictEqual(calls.slice(callStart), [
      'extractToken:delegated',
      'readOnlyTokenExpiresAt:delegated',
      `createReadOnlyToken:${delegatedExpiresAt}`,
      `createTicket:${delegatedToken}`,
    ]);
    assert.strictEqual(ticketCreates.at(-1)?.token, delegatedToken);

    callStart = calls.length;
    await assertJsonResponse(await postJson(endpoint, {}, {
      'x-test-access': 'read-only',
      'x-test-token': 'expired',
    }), 401, { error: 'Read-only share credential expired.' });
    assert.deepStrictEqual(calls.slice(callStart), [
      'extractToken:expired',
      'readOnlyTokenExpiresAt:expired',
    ]);

    delegatedExpiresAt = now + 1000;
    callStart = calls.length;
    await assertJsonResponse(await postJson(endpoint, {}, {
      'x-test-access': 'read-only',
      'x-test-token': 'delegated',
    }), 410, { error: 'Read-only share credential is too close to expiry.' });
    assert.deepStrictEqual(calls.slice(callStart), [
      'extractToken:delegated',
      'readOnlyTokenExpiresAt:delegated',
    ]);
    delegatedExpiresAt = now + 20_000;

    ticketCreateError = new Error('Unable to allocate share code');
    callStart = calls.length;
    await assertJsonResponse(await postJson(endpoint, {}, {
      'x-test-token': 'owner-request-token',
    }), 500, { error: 'Unable to allocate share code' });
    assert.deepStrictEqual(calls.slice(callStart), [
      'extractToken:owner-request-token',
      `createReadOnlyToken:${now + SHARE_TICKET_TTL_MS}`,
      'getToken',
      `createTicket:${ownerToken}`,
    ]);
    ticketCreateError = null;

    callStart = calls.length;
    await assertJsonResponse(await fetch(`${endpoint}/SHARE1`, { method: 'DELETE' }), 200, {
      revoked: true,
    });
    assert.deepStrictEqual(calls.slice(callStart), ['revoke:SHARE1']);
    assert.deepStrictEqual(revokedCodes, ['SHARE1']);

    for (const { body, status } of [
      { body: '{"target":', status: 400 },
      { body: JSON.stringify({ value: 'x'.repeat(9 * 1024) }), status: 413 },
    ]) {
      callStart = calls.length;
      await assertJsonResponse(
        await postRawJson(endpoint, body, { 'x-test-token': 'owner-request-token' }),
        status,
        { error: 'request body rejected' },
      );
      assert.strictEqual(calls.length, callStart, 'rejected JSON must not reach auth or ticket effects');
    }

    callStart = calls.length;
    const rotateResponse = await postJson(`${endpoint}/rotate`, fileTarget, {
      'x-test-token': ownerToken,
    });
    await assertJsonResponse(rotateResponse, 200, {
      tokenLabel: 'rotated-owner-token',
      fullAccessUrl: `https://share.example.test/farm?${targetQuery}&token=rotated-owner-token`,
    });
    assert.deepStrictEqual(calls.slice(callStart), ['rotateToken', 'setAuthenticatedCookie']);
    assert.strictEqual(
      rotateResponse.headers.get('set-cookie'),
      'farming_token=rotated-owner-token; Path=/farm; HttpOnly; SameSite=Lax',
    );

    callStart = calls.length;
    await assertJsonResponse(await postJson(`${endpoint}/rotate`, {}, {
      'x-test-access': 'read-only',
      'x-test-token': 'delegated',
    }), 403, { error: 'Only the Farming owner can rotate the token.' });
    assert.strictEqual(calls.length, callStart, 'read-only rotation must not reach auth mutation');

    const disabledApp = express();
    disabledApp.use('/api/share/qr-ticket', createQrShareRouter(auth, tickets, {
      authEnabled: false,
      basePath: '',
      fallbackPort: 9123,
      now: () => now,
    }));
    const disabledServer = await listen(disabledApp);
    try {
      callStart = calls.length;
      await assertJsonResponse(
        await postJson(`http://127.0.0.1:${serverPort(disabledServer)}/api/share/qr-ticket`, {}),
        409,
        { error: 'Read-only sharing requires token authentication.' },
      );
      assert.strictEqual(calls.length, callStart);
      await assertJsonResponse(
        await postJson(`http://127.0.0.1:${serverPort(disabledServer)}/api/share/qr-ticket/rotate`, {}),
        409,
        { error: 'Token rotation requires token authentication.' },
      );
      assert.strictEqual(calls.length, callStart);
    } finally {
      await closeServer(disabledServer);
    }

    console.log('QR share router behavior passed');
  } finally {
    await closeServer(server);
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
