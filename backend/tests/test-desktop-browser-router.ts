const assert = require('assert');
const {
  createBrowserRouter,
} = require('../../extensions/browser/backend/browser-router.cjs');

function createHarness() {
  const calls: Array<Record<string, unknown>> = [];
  const manager = {
    create(input: Record<string, unknown>) {
      calls.push(input);
      return {
        id: `browser_router_${calls.length}`,
        status: 'stopped',
      };
    },
  };
  const workspace = '/tmp/farming-desktop-browser-router-workspace';
  const router = createBrowserRouter(manager, {
    resolve(rootId: unknown) {
      assert.strictEqual(rootId, 'root_router');
      return {
        canonicalPath: workspace,
        kind: 'project',
        rootId: 'root_router',
      };
    },
  }, {
    resolveAgentResourceBinding(agentId: string) {
      return agentId === 'agent_router'
        ? { agentId, workspace }
        : null;
    },
    getState() {
      return {
        agents: [{
          id: 'agent_router',
          projectWorkspace: workspace,
          status: 'running',
        }],
      };
    },
  });
  const layer = router.stack.find((candidate: {
    route?: {
      methods?: Record<string, boolean>;
      path?: string;
      stack?: Array<{ handle?: unknown }>;
    };
  }) => (
    candidate.route?.path === '/'
    && candidate.route.methods?.post === true
  ));
  const create = layer?.route?.stack?.[0]?.handle;
  if (typeof create !== 'function') throw new Error('Browser create route was not registered');
  return {
    calls,
    create,
  };
}

async function request(
  create: (request: Record<string, unknown>, response: Record<string, unknown>) => unknown,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  let status = 200;
  let responseBody: Record<string, unknown> = {};
  const response = {
    json(value: Record<string, unknown>) {
      responseBody = value;
      return response;
    },
    status(value: number) {
      status = value;
      return response;
    },
  };
  await create({
    baseUrl: '/api/browsers',
    body,
    get(name: string) {
      return headers[name] || headers[name.toLowerCase()];
    },
    headers,
    params: {},
    protocol: 'http',
  }, response);
  return { body: responseBody, status };
}

async function testDesktopRouterPreference() {
  const harness = createHarness();
  const agentDefault = await request(harness.create, {
    rootId: 'root_router',
    url: 'https://agent.example/',
  }, {
    'X-Farming-Agent-Id': 'agent_router',
  });
  assert.strictEqual(agentDefault.status, 201);
  assert.deepStrictEqual(harness.calls.at(-1), {
    name: undefined,
    ownerAgentId: 'agent_router',
    preferDesktop: true,
    projectRootId: 'root_router',
    url: 'https://agent.example/',
    workspace: '/tmp/farming-desktop-browser-router-workspace',
  });

  const humanDefault = await request(harness.create, {
    agentId: 'agent_router',
    rootId: 'root_router',
    url: 'https://human.example/',
  });
  assert.strictEqual(humanDefault.status, 201);
  assert.deepStrictEqual(harness.calls.at(-1), {
    name: undefined,
    ownerAgentId: 'agent_router',
    projectRootId: 'root_router',
    url: 'https://human.example/',
    workspace: '/tmp/farming-desktop-browser-router-workspace',
  });

  const explicitDesktop = await request(harness.create, {
    desktopAdapterId: 'desktop-exact-adapter',
    rootId: 'root_router',
    source: 'desktop',
    url: 'https://desktop.example/',
  }, {
    'X-Farming-Agent-Id': 'agent_router',
  });
  assert.strictEqual(explicitDesktop.status, 201);
  assert.deepStrictEqual(harness.calls.at(-1), {
    browserSource: 'desktop',
    desktopAdapterId: 'desktop-exact-adapter',
    name: undefined,
    ownerAgentId: 'agent_router',
    projectRootId: 'root_router',
    url: 'https://desktop.example/',
    workspace: '/tmp/farming-desktop-browser-router-workspace',
  });
}

testDesktopRouterPreference()
  .then(() => console.log('desktop browser router tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
