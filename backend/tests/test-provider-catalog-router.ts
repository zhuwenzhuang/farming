const assert = require('assert');
const express = require('express');
const { createProviderCatalogRouter } = require('../provider-catalog-router.cjs');

type HttpServer = import('http').Server;

interface RequestedProviderHomeFixture {
  error: string;
  home: { path: string } | null;
  status: number;
}

interface ErrorResponse {
  code?: string;
  error: string;
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
  const resolveCalls: Array<{ provider: string; rawHomeId: unknown }> = [];
  const modelRequests: string[] = [];
  const settingsRequests: string[] = [];

  let requestedHome: RequestedProviderHomeFixture = {
    error: '',
    home: { path: '/homes/codex' },
    status: 200,
  };
  let modelFailure: (Error & { code?: string }) | null = null;

  const app = express();
  app.use('/api', createProviderCatalogRouter({
    async loadCodexModels(homePath: string): Promise<unknown> {
      modelRequests.push(homePath);
      if (modelFailure) throw modelFailure;
      return { models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }], source: homePath };
    },
    readClaudeSettings(homePath: string): unknown {
      settingsRequests.push(homePath);
      return { permissions: { allow: ['Bash'] }, settingsFile: `${homePath}/settings.json` };
    },
    resolveProviderHome(provider: string, rawHomeId: unknown): RequestedProviderHomeFixture {
      resolveCalls.push({ provider, rawHomeId });
      return requestedHome;
    },
  }));
  app.get('/api/codex/sessions', (_req: unknown, res: { json(value: unknown): void }) => {
    res.json({ sessions: [] });
  });

  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}/api`;

  try {
    const modelsResponse = await fetch(`${baseUrl}/codex/models?homeId=work`);
    assert.strictEqual(modelsResponse.status, 200);
    assert.strictEqual(modelsResponse.headers.get('cache-control'), null);
    assert.deepStrictEqual(await modelsResponse.json(), {
      models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }],
      source: '/homes/codex',
    });
    assert.deepStrictEqual(resolveCalls, [{ provider: 'codex', rawHomeId: 'work' }]);
    assert.deepStrictEqual(modelRequests, ['/homes/codex']);

    modelFailure = Object.assign(new Error('codex model discovery timed out'), {
      code: 'CODEX_MODELS_TIMEOUT',
    });
    const timedOutResponse = await fetch(`${baseUrl}/codex/models`);
    assert.strictEqual(timedOutResponse.status, 504);
    assert.deepStrictEqual(await timedOutResponse.json() as ErrorResponse, {
      error: 'codex model discovery timed out',
      code: 'CODEX_MODELS_TIMEOUT',
    });

    modelFailure = Object.assign(new Error('codex config is unreadable'), { code: 'EACCES' });
    const failedResponse = await fetch(`${baseUrl}/codex/models`);
    assert.strictEqual(failedResponse.status, 502);
    assert.deepStrictEqual(await failedResponse.json() as ErrorResponse, {
      error: 'codex config is unreadable',
      code: 'EACCES',
    });

    modelFailure = new Error('');
    const fallbackResponse = await fetch(`${baseUrl}/codex/models`);
    assert.strictEqual(fallbackResponse.status, 502);
    assert.deepStrictEqual(await fallbackResponse.json() as ErrorResponse, {
      error: 'Failed to load Codex model catalog',
      code: 'CODEX_MODELS_FAILED',
    });
    modelFailure = null;

    resolveCalls.length = 0;
    const settingsResponse = await fetch(`${baseUrl}/claude/settings`);
    assert.strictEqual(settingsResponse.status, 200);
    assert.deepStrictEqual(await settingsResponse.json(), {
      settings: {
        permissions: { allow: ['Bash'] },
        settingsFile: '/homes/codex/settings.json',
      },
    });
    assert.deepStrictEqual(resolveCalls, [{ provider: 'claude', rawHomeId: undefined }]);
    assert.deepStrictEqual(settingsRequests, ['/homes/codex']);

    requestedHome = { error: 'Invalid Agent Home id', home: null, status: 400 };
    const invalidModels = await fetch(`${baseUrl}/codex/models?homeId=../escape`);
    assert.strictEqual(invalidModels.status, 400);
    assert.deepStrictEqual(await invalidModels.json() as ErrorResponse, {
      error: 'Invalid Agent Home id',
    });
    const invalidSettings = await fetch(`${baseUrl}/claude/settings?homeId=../escape`);
    assert.strictEqual(invalidSettings.status, 400);
    assert.deepStrictEqual(await invalidSettings.json() as ErrorResponse, {
      error: 'Invalid Agent Home id',
    });

    requestedHome = { error: 'Unknown claude Agent Home: ghost', home: null, status: 404 };
    const unknownSettings = await fetch(`${baseUrl}/claude/settings?homeId=ghost`);
    assert.strictEqual(unknownSettings.status, 404);
    assert.deepStrictEqual(await unknownSettings.json() as ErrorResponse, {
      error: 'Unknown claude Agent Home: ghost',
    });
    const unknownModels = await fetch(`${baseUrl}/codex/models?homeId=ghost`);
    assert.strictEqual(unknownModels.status, 404);
    assert.deepStrictEqual(await unknownModels.json() as ErrorResponse, {
      error: 'Unknown claude Agent Home: ghost',
    });

    assert.deepStrictEqual(modelRequests, ['/homes/codex', '/homes/codex', '/homes/codex', '/homes/codex']);
    assert.deepStrictEqual(settingsRequests, ['/homes/codex']);

    const passThroughResponse = await fetch(`${baseUrl}/codex/sessions`);
    assert.strictEqual(passThroughResponse.status, 200);
    assert.deepStrictEqual(await passThroughResponse.json(), { sessions: [] });

    const unmatchedResponse = await fetch(`${baseUrl}/codex/unknown`);
    assert.strictEqual(unmatchedResponse.status, 404);

    console.log('provider catalog router behavior passed');
  } finally {
    await closeServer(server);
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
