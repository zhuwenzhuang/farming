const assert = require('assert');
const express = require('express');
const { createAgentSessionRouter } = require('../agent-session-router.cjs');

type HttpServer = import('http').Server;

interface SessionRecord extends Record<string, unknown> {
  id: string;
  provider: string;
  providerHomeId?: string;
}

interface ListResponse {
  hasMore: boolean;
  nextCursor: string;
  sessions: SessionRecord[];
  total: number;
}

interface SearchResponse {
  query: string;
  scope: string;
  sessions: SessionRecord[];
  total: number;
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

async function run(): Promise<void> {
  const sessions: SessionRecord[] = [
    {
      provider: 'codex',
      providerHomeId: 'work',
      id: 'session-alpha',
      title: 'Alpha session',
      workspace: '/repo/alpha',
      updatedAt: '2026-08-09T03:00:00.000Z',
      pinned: false,
    },
    {
      provider: 'claude',
      providerHomeId: 'default',
      id: 'session-beta',
      title: 'Beta session',
      workspace: '/repo/beta',
      updatedAt: '2026-08-09T02:00:00.000Z',
      pinned: true,
    },
    {
      provider: 'qwen',
      providerHomeId: 'default',
      id: 'session-gamma',
      title: 'Gamma session',
      workspace: '/repo/gamma',
      updatedAt: '2026-08-09T01:00:00.000Z',
      pinned: false,
    },
  ];
  const displayRecords = [
    {
      providerSessionKey: 'agent-session:codex:home:work:session-alpha',
      displayPinned: true,
    },
    {
      providerSessionKey: 'agent-session:claude:session-beta',
      displayPinned: false,
    },
    {
      providerSessionKey: '',
      displayPinned: true,
    },
  ];
  const events: string[] = [];
  const loggedErrors: unknown[][] = [];
  const displayWrites: Array<{ patch: unknown; sessionKey: string }> = [];
  const rememberedKeys: Array<{ patch: unknown; sessionKey: string }> = [];
  const removedKeys: string[][] = [];
  const publishedMetadata: unknown[] = [];
  let mainPageSessionKeys: string[] = ['agent-session:codex:home:work:session-alpha'];
  let listFailure: Error | null = null;
  let listPending = false;
  let searchTimeoutMs = 50;
  const settings = {
    projectNames: { '/repo/beta': 'Friendly Project' },
    get searchTimeoutMs() {
      return searchTimeoutMs;
    },
  };
  const service = {
    getMainPageSessionKeys() {
      events.push('main-page-keys');
      return mainPageSessionKeys;
    },
    getSettings() {
      events.push('settings');
      return settings;
    },
    invalidate() {
      events.push('invalidate');
    },
    listDisplayRecords() {
      events.push('display');
      return displayRecords;
    },
    async listSessions(): Promise<SessionRecord[]> {
      events.push('list');
      if (listFailure) throw listFailure;
      if (listPending) return new Promise<SessionRecord[]>(() => {});
      return sessions;
    },
    publishStateMetadata(state: unknown) {
      events.push('publish');
      publishedMetadata.push(state);
    },
    rememberMainPageSessionKey(sessionKey: string, patch: unknown) {
      events.push('remember');
      rememberedKeys.push({ patch, sessionKey });
    },
    removeMainPageSessionKeys(sessionKeys: readonly string[]) {
      events.push('remove');
      removedKeys.push([...sessionKeys]);
    },
    setProviderSessionDisplayState(sessionKey: string, patch: unknown) {
      events.push('set-display');
      displayWrites.push({ patch, sessionKey });
    },
  };

  const app = express();
  app.use((
    request: { method: string; path: string },
    response: { json: (body: unknown) => unknown; statusCode: number },
    next: () => void,
  ) => {
    if (request.method === 'POST' && request.path === '/api/main-page-agent-sessions') {
      const respond = response.json.bind(response);
      response.json = (body: unknown) => {
        if (response.statusCode === 200) events.push('response');
        return respond(body);
      };
    }
    next();
  });
  app.use('/api', createAgentSessionRouter(service));
  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const apiUrl = `http://127.0.0.1:${serverPort(server)}/api`;
  const baseUrl = `${apiUrl}/agent-sessions`;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  const patchPin = (path: string, body?: string) => fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }),
  });
  const postMembership = (body: string) => fetch(`${apiUrl}/main-page-agent-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  try {
    const fullList = await fetch(baseUrl);
    assert.strictEqual(fullList.status, 200);
    assert.strictEqual(fullList.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await fullList.json(), {
      sessions: [
        { ...sessions[0], pinned: true },
        { ...sessions[1], pinned: false },
        sessions[2],
      ],
      nextCursor: '',
      hasMore: false,
      total: 3,
    });
    assert.deepStrictEqual(events, ['list', 'display']);

    events.length = 0;
    const firstPage = await fetch(`${baseUrl}?limit=1&force=1`);
    assert.strictEqual(firstPage.status, 200);
    const firstPageBody = await firstPage.json() as ListResponse;
    assert.deepStrictEqual(firstPageBody.sessions, [{ ...sessions[0], pinned: true }]);
    assert.strictEqual(firstPageBody.hasMore, true);
    assert(firstPageBody.nextCursor);
    assert.strictEqual(firstPageBody.total, 3);
    assert.deepStrictEqual(events, ['invalidate', 'list', 'display']);

    const secondPage = await fetch(`${baseUrl}?limit=1&cursor=${encodeURIComponent(firstPageBody.nextCursor)}`);
    assert.strictEqual(secondPage.status, 200);
    const secondPageBody = await secondPage.json() as ListResponse;
    assert.deepStrictEqual(secondPageBody.sessions, [{ ...sessions[1], pinned: false }]);
    assert.strictEqual(secondPageBody.hasMore, true);

    events.length = 0;
    const zeroLimit = await fetch(`${baseUrl}?limit=0`);
    assert.strictEqual(zeroLimit.status, 200);
    assert.strictEqual((await zeroLimit.json() as ListResponse).sessions.length, 1);

    events.length = 0;
    const invalidCursor = await fetch(`${baseUrl}?cursor=not-a-cursor`);
    assert.strictEqual(invalidCursor.status, 400);
    assert.strictEqual(invalidCursor.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await invalidCursor.json(), { error: 'Invalid Agent session cursor' });
    assert.deepStrictEqual(events, ['list'], 'invalid cursors must not read display metadata');

    events.length = 0;
    const search = await fetch(`${baseUrl}/search?q=%20FRIENDLY%20&force=1`);
    assert.strictEqual(search.status, 200);
    assert.strictEqual(search.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await search.json(), {
      sessions: [{ ...sessions[1], pinned: false }],
      total: 1,
      query: 'friendly',
      scope: 'id-title-project',
    });
    assert.deepStrictEqual(events, ['settings', 'invalidate', 'list', 'display']);

    const limitedSearch = await fetch(`${baseUrl}/search?q=session&limit=1`);
    assert.strictEqual(limitedSearch.status, 200);
    const limitedSearchBody = await limitedSearch.json() as SearchResponse;
    assert.strictEqual(limitedSearchBody.sessions.length, 1);
    assert.strictEqual(limitedSearchBody.total, 3);

    listFailure = new Error('inventory unavailable');
    const failedList = await fetch(baseUrl);
    assert.strictEqual(failedList.status, 500);
    assert.strictEqual(failedList.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await failedList.json(), { error: 'inventory unavailable' });
    assert.strictEqual(loggedErrors.at(-1)?.[0], 'Failed to read agent sessions:');

    listFailure = new Error('search unavailable');
    const failedSearch = await fetch(`${baseUrl}/search?q=alpha`);
    assert.strictEqual(failedSearch.status, 500);
    assert.deepStrictEqual(await failedSearch.json(), { error: 'search unavailable' });
    assert.strictEqual(loggedErrors.at(-1)?.[0], 'Failed to search agent sessions:');

    listFailure = null;
    listPending = true;
    searchTimeoutMs = 5;
    const timedOutSearch = await fetch(`${baseUrl}/search?q=alpha`);
    assert.strictEqual(timedOutSearch.status, 504);
    assert.strictEqual(timedOutSearch.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await timedOutSearch.json(), { error: 'Agent search timed out' });

    listPending = false;
    events.length = 0;
    const pinned = await patchPin('/codex/session-alpha', JSON.stringify({ pinned: true, providerHomeId: 'work' }));
    assert.strictEqual(pinned.status, 200);
    assert.deepStrictEqual(await pinned.json(), {
      sessionKey: 'agent-session:codex:home:work:session-alpha',
      pinned: true,
    });
    assert.deepStrictEqual(events, ['set-display']);
    assert.deepStrictEqual(displayWrites, [{
      patch: { pinned: true },
      sessionKey: 'agent-session:codex:home:work:session-alpha',
    }]);

    const defaultHomePin = await patchPin('/CODEX/session-alpha', JSON.stringify({ pinned: false }));
    assert.strictEqual(defaultHomePin.status, 200);
    assert.deepStrictEqual(await defaultHomePin.json(), {
      sessionKey: 'agent-session:codex:session-alpha',
      pinned: false,
    });
    assert.deepStrictEqual(displayWrites.at(-1), {
      patch: { pinned: false },
      sessionKey: 'agent-session:codex:session-alpha',
    });

    events.length = 0;
    const unknownProvider = await patchPin('/not-a-provider/session-alpha', JSON.stringify({ pinned: true }));
    assert.strictEqual(unknownProvider.status, 400);
    assert.deepStrictEqual(await unknownProvider.json(), { error: 'Invalid Agent session' });

    const unsafeSessionId = await patchPin('/codex/..%2Fescape', JSON.stringify({ pinned: true }));
    assert.strictEqual(unsafeSessionId.status, 400);
    assert.deepStrictEqual(await unsafeSessionId.json(), { error: 'Invalid Agent session' });

    const unsafeHomeId = await patchPin('/codex/session-alpha', JSON.stringify({ pinned: true, providerHomeId: 'bad home' }));
    assert.strictEqual(unsafeHomeId.status, 400);
    assert.deepStrictEqual(await unsafeHomeId.json(), { error: 'Invalid Agent session' });

    const nonBooleanPinned = await patchPin('/codex/session-alpha', JSON.stringify({ pinned: 'yes' }));
    assert.strictEqual(nonBooleanPinned.status, 400);
    assert.deepStrictEqual(await nonBooleanPinned.json(), { error: 'Pinned state is required' });

    const missingBody = await patchPin('/codex/session-alpha');
    assert.strictEqual(missingBody.status, 400);
    assert.deepStrictEqual(await missingBody.json(), { error: 'Pinned state is required' });

    const malformedPin = await patchPin('/codex/session-alpha', '{"pinned":');
    assert.strictEqual(malformedPin.status, 400);
    assert.deepStrictEqual(events, [], 'invalid display mutations must not reach the store');

    events.length = 0;
    mainPageSessionKeys = [
      'agent-session:codex:home:work:session-alpha',
      'agent-session:claude:session-beta',
    ];
    const added = await postMembership(JSON.stringify({
      operation: 'add',
      sessionKeys: [
        ' agent-session:claude:session-beta ',
        'agent-session:codex:home:work:session-alpha',
        'agent-session:claude:session-beta',
        '',
      ],
    }));
    assert.strictEqual(added.status, 200);
    assert.deepStrictEqual(await added.json(), { success: true, mainPageSessionKeys });
    assert.deepStrictEqual(events, ['remember', 'remember', 'main-page-keys', 'invalidate', 'response', 'publish']);
    assert.deepStrictEqual(rememberedKeys, [
      {
        patch: {
          provider: 'codex',
          providerSessionId: 'session-alpha',
          providerSessionKey: 'agent-session:codex:home:work:session-alpha',
          providerHomeId: 'work',
        },
        sessionKey: 'agent-session:codex:home:work:session-alpha',
      },
      {
        patch: {
          provider: 'claude',
          providerSessionId: 'session-beta',
          providerSessionKey: 'agent-session:claude:session-beta',
          providerHomeId: 'default',
        },
        sessionKey: 'agent-session:claude:session-beta',
      },
    ]);
    assert.deepStrictEqual(publishedMetadata, [{ mainPageSessionKeys }]);

    events.length = 0;
    const removed = await postMembership(JSON.stringify({
      operation: 'remove',
      sessionKeys: ['agent-session:claude:session-beta', 'agent-session:qwen:session-gamma'],
    }));
    assert.strictEqual(removed.status, 200);
    assert.deepStrictEqual(await removed.json(), { success: true, mainPageSessionKeys });
    assert.deepStrictEqual(events, ['remove', 'main-page-keys', 'invalidate', 'response', 'publish']);
    assert.deepStrictEqual(removedKeys, [[
      'agent-session:claude:session-beta',
      'agent-session:qwen:session-gamma',
    ]]);

    events.length = 0;
    const invalidOperation = await postMembership(JSON.stringify({
      operation: 'replace',
      sessionKeys: ['agent-session:claude:session-beta'],
    }));
    assert.strictEqual(invalidOperation.status, 400);
    assert.deepStrictEqual(await invalidOperation.json(), {
      error: 'A valid main-page Agent session mutation is required',
    });

    const emptyKeys = await postMembership(JSON.stringify({ operation: 'add', sessionKeys: ['  '] }));
    assert.strictEqual(emptyKeys.status, 400);

    const unknownKey = await postMembership(JSON.stringify({
      operation: 'add',
      sessionKeys: ['agent-session:not-a-provider:session-alpha'],
    }));
    assert.strictEqual(unknownKey.status, 400);

    const tooManyKeys = await postMembership(JSON.stringify({
      operation: 'add',
      sessionKeys: Array.from({ length: 51 }, (_, index) => `agent-session:codex:session-${index}`),
    }));
    assert.strictEqual(tooManyKeys.status, 400);

    const malformedMembership = await postMembership('{"operation":');
    assert.strictEqual(malformedMembership.status, 400);
    assert.deepStrictEqual(events, [], 'invalid membership mutations must not reach the store');

    console.log('agent session router behavior passed');
  } finally {
    console.error = originalConsoleError;
    await closeServer(server);
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
