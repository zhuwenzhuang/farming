const assert = require('assert');
const express = require('express');
const { createAgentExtensionRouter } = require('../agent-extension-router.cjs');

type HttpServer = import('http').Server;

interface AgentHomeFixture {
  acpRuntime: unknown;
  id: string;
  newAgentDefaults: unknown;
  order: number;
  path: string;
}

interface InventoryFixture {
  configuration: object;
  extensions: readonly object[];
}

interface SlashCommandRequest {
  provider: string;
  providerHomePath: string;
  workspace: string;
}

interface RequestedProviderHomeFixture {
  error: string;
  home: { path: string } | null;
  status: number;
}

interface ErrorResponse {
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

function home(overrides: Partial<AgentHomeFixture> & { id: string; path: string }): AgentHomeFixture {
  return {
    order: 1,
    acpRuntime: { mode: 'managed', executable: '/usr/local/bin/codex' },
    newAgentDefaults: { model: 'gpt-5', reasoning: 'high', fast: 'inherit' },
    ...overrides,
  };
}

async function run(): Promise<void> {
  const codexHomes = [
    home({ id: 'default', path: '/homes/codex', order: 0 }),
    home({ id: 'work', path: '/homes/codex-work', order: 1 }),
  ];
  const inventoryRequests: Array<{ homePath: string; provider: string }> = [];
  const retainCalls: Array<Array<{ provider: string; path: string }>> = [];
  const slashRequests: SlashCommandRequest[] = [];
  const loggedErrors: unknown[][] = [];

  let inventoryFailure: Error | null = null;
  let slashFailure: Error | null = null;
  let requestedHome: RequestedProviderHomeFixture = {
    error: '',
    home: { path: '/homes/codex' },
    status: 200,
  };
  let requestedHomeCalls: Array<{ provider: string; rawHomeId: unknown }> = [];

  const app = express();
  app.use('/api', createAgentExtensionRouter({
    agentExtensionInventory: {
      async get(provider: string, homePath: string): Promise<InventoryFixture> {
        inventoryRequests.push({ homePath, provider });
        if (inventoryFailure) throw inventoryFailure;
        if (homePath === '/homes/codex-work') {
          return {
            configuration: { exists: true, filePath: `${homePath}/config.toml`, rootId: 'inventory-root' },
            extensions: [],
          };
        }
        return {
          configuration: { exists: Boolean(homePath), filePath: homePath ? `${homePath}/config.toml` : '' },
          extensions: homePath
            ? [{ id: 'skill-a', kind: 'skill', name: 'Alpha', sourceFile: `${homePath}/skills/alpha.md` }]
            : [],
        };
      },
      async retain(homes: Array<{ provider: string; path: string }>): Promise<void> {
        retainCalls.push(homes.map(entry => ({ ...entry })));
      },
    },
    configuredProviders: () => ['codex', 'gemini'],
    getAgentHomes: (provider: string) => provider === 'codex' ? codexHomes : [],
    getAvailableAgents: () => [
      { category: 'coding', command: 'codex', description: 'Codex CLI', name: 'codex' },
      { category: 'shell', command: 'gemini', description: 'Not a coding agent', name: 'gemini' },
    ],
    getMainAgentSkillsCatalog: () => [{ id: 'quest', name: 'Quest', trigger: '/quest' }],
    getProviderAcpExecutablePolicy: (provider: string) => provider === 'codex' ? 'managed' : 'system',
    requestedProviderHome: (provider: string, rawHomeId: unknown) => {
      requestedHomeCalls.push({ provider, rawHomeId });
      return requestedHome;
    },
    rootIdForPath: (homePath: string) => homePath ? `root:${homePath}` : 'root:none',
    slashCommandDiscoveryCache: {
      async get(request: SlashCommandRequest): Promise<unknown> {
        slashRequests.push({ ...request });
        if (slashFailure) throw slashFailure;
        return [{ name: 'review', scope: 'home' }];
      },
    },
  }));
  app.get('/api/executables', (_req: unknown, res: { json(value: unknown): void }) => {
    res.json({ agents: [] });
  });

  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}/api`;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { loggedErrors.push(args); };

  try {
    const skillsResponse = await fetch(`${baseUrl}/skills`);
    assert.strictEqual(skillsResponse.status, 200);
    assert.strictEqual(skillsResponse.headers.get('cache-control'), null);
    assert.deepStrictEqual(await skillsResponse.json(), {
      skills: [{ id: 'quest', name: 'Quest', trigger: '/quest' }],
    });

    const extensionsResponse = await fetch(`${baseUrl}/agent-extensions`);
    assert.strictEqual(extensionsResponse.status, 200);
    assert.strictEqual(extensionsResponse.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await extensionsResponse.json(), {
      agents: [
        {
          id: 'codex',
          name: 'codex',
          description: 'Codex CLI',
          available: true,
          discoverySupported: true,
          acpExecutablePolicy: 'managed',
          homes: [
            {
              id: 'default',
              path: '/homes/codex',
              order: 0,
              acpRuntime: { mode: 'managed', executable: '/usr/local/bin/codex' },
              newAgentDefaults: { model: 'gpt-5', reasoning: 'high', fast: 'inherit' },
              configuration: {
                rootId: 'root:/homes/codex',
                exists: true,
                filePath: '/homes/codex/config.toml',
              },
              extensions: [{
                id: 'skill-a',
                kind: 'skill',
                name: 'Alpha',
                sourceFile: '/homes/codex/skills/alpha.md',
                rootId: 'root:/homes/codex',
              }],
            },
            {
              id: 'work',
              path: '/homes/codex-work',
              order: 1,
              acpRuntime: { mode: 'managed', executable: '/usr/local/bin/codex' },
              newAgentDefaults: { model: 'gpt-5', reasoning: 'high', fast: 'inherit' },
              configuration: {
                rootId: 'inventory-root',
                exists: true,
                filePath: '/homes/codex-work/config.toml',
              },
              extensions: [],
            },
          ],
        },
        {
          id: 'gemini',
          name: 'gemini',
          description: '',
          available: false,
          discoverySupported: true,
          acpExecutablePolicy: 'system',
          homes: [{
            id: 'default',
            path: '',
            order: Number.MAX_SAFE_INTEGER,
            acpRuntime: { mode: 'managed', executable: '' },
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
            configuration: { rootId: 'root:none', exists: false, filePath: '' },
            extensions: [],
          }],
        },
      ],
    });
    assert.deepStrictEqual(inventoryRequests, [
      { homePath: '/homes/codex', provider: 'codex' },
      { homePath: '/homes/codex-work', provider: 'codex' },
      { homePath: '', provider: 'gemini' },
    ]);
    assert.deepStrictEqual(retainCalls, [[
      { provider: 'codex', path: '/homes/codex' },
      { provider: 'codex', path: '/homes/codex-work' },
    ]]);
    assert.deepStrictEqual(loggedErrors, []);

    inventoryFailure = new Error('inventory snapshot is unreadable');
    const failedExtensions = await fetch(`${baseUrl}/agent-extensions`);
    assert.strictEqual(failedExtensions.status, 500);
    assert.strictEqual(failedExtensions.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await failedExtensions.json() as ErrorResponse, {
      error: 'inventory snapshot is unreadable',
    });
    assert.strictEqual(retainCalls.length, 1);
    assert.strictEqual(loggedErrors.length, 1);
    assert.strictEqual(loggedErrors[0][0], 'Failed to read Agent extension inventory:');
    inventoryFailure = null;

    requestedHomeCalls = [];
    const commandsResponse = await fetch(`${baseUrl}/slash-commands?provider=codex&workspace=/repo&homeId=default`);
    assert.strictEqual(commandsResponse.status, 200);
    assert.strictEqual(commandsResponse.headers.get('cache-control'), null);
    assert.deepStrictEqual(await commandsResponse.json(), {
      commands: [{ name: 'review', scope: 'home' }],
    });
    assert.deepStrictEqual(requestedHomeCalls, [{ provider: 'codex', rawHomeId: 'default' }]);
    assert.deepStrictEqual(slashRequests, [{
      provider: 'codex',
      providerHomePath: '/homes/codex',
      workspace: '/repo',
    }]);

    requestedHomeCalls = [];
    const bareCommandsResponse = await fetch(`${baseUrl}/slash-commands`);
    assert.strictEqual(bareCommandsResponse.status, 200);
    assert.deepStrictEqual(requestedHomeCalls, [{ provider: '', rawHomeId: undefined }]);
    assert.deepStrictEqual(slashRequests[1], {
      provider: '',
      providerHomePath: '/homes/codex',
      workspace: '',
    });

    requestedHome = { error: 'Invalid Agent Home id', home: null, status: 400 };
    const invalidHomeResponse = await fetch(`${baseUrl}/slash-commands?provider=codex&homeId=../escape`);
    assert.strictEqual(invalidHomeResponse.status, 400);
    assert.deepStrictEqual(await invalidHomeResponse.json() as ErrorResponse, {
      error: 'Invalid Agent Home id',
    });
    assert.strictEqual(slashRequests.length, 2);

    requestedHome = { error: 'Unknown codex Agent Home: ghost', home: null, status: 404 };
    const unknownHomeResponse = await fetch(`${baseUrl}/slash-commands?provider=codex&homeId=ghost`);
    assert.strictEqual(unknownHomeResponse.status, 404);
    assert.deepStrictEqual(await unknownHomeResponse.json() as ErrorResponse, {
      error: 'Unknown codex Agent Home: ghost',
    });
    assert.strictEqual(slashRequests.length, 2);

    requestedHome = { error: '', home: { path: '/homes/codex' }, status: 200 };
    slashFailure = new Error('discovery process failed');
    const failedCommands = await fetch(`${baseUrl}/slash-commands?provider=codex`);
    assert.strictEqual(failedCommands.status, 500);
    assert.strictEqual(failedCommands.headers.get('cache-control'), null);
    assert.deepStrictEqual(await failedCommands.json() as ErrorResponse, {
      error: 'discovery process failed',
    });
    assert.strictEqual(loggedErrors.length, 2);
    assert.strictEqual(loggedErrors[1][0], 'Failed to discover slash commands:');
    slashFailure = null;

    const passThroughResponse = await fetch(`${baseUrl}/executables`);
    assert.strictEqual(passThroughResponse.status, 200);
    assert.deepStrictEqual(await passThroughResponse.json(), { agents: [] });

    const unmatchedResponse = await fetch(`${baseUrl}/unknown-endpoint`);
    assert.strictEqual(unmatchedResponse.status, 404);

    console.error = originalConsoleError;
    console.log('agent extension router behavior passed');
  } finally {
    console.error = originalConsoleError;
    await closeServer(server);
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
