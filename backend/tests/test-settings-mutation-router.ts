import type { SettingsMutationPorts } from '../settings-mutation-router.cjs';

const assert = require('assert');
const express = require('express');
const http = require('http');
const {
  SettingsMutationCoordinator,
  SettingsMutationResponseError,
  createSettingsMutationRouter,
} = require('../settings-mutation-router.cjs') as typeof import('../settings-mutation-router.cjs');

type Settings = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function error(message: string, code: string, status: number) {
  return Object.assign(new Error(message), { code, status });
}

function harness(overrides: Partial<SettingsMutationPorts> = {}, initial: Settings = {}) {
  let settings: Settings = {
    browserExtensionEnabled: false,
    browserSource: 'managed',
    computerExtensionEnabled: false,
    ...initial,
  };
  const calls: string[] = [];
  const patches: Settings[] = [];
  const ports: SettingsMutationPorts = {
    getSettings() {
      calls.push('get-settings');
      return settings;
    },
    invalidateAgentExtensionInventory() {
      calls.push('invalidate-extensions');
    },
    invalidateAgentSessionInventory() {
      calls.push('invalidate-sessions');
    },
    normalizeAgentHomes(value) {
      calls.push('normalize-homes');
      return value as ReturnType<SettingsMutationPorts['normalizeAgentHomes']>;
    },
    async probeBrowser(selection) {
      calls.push(`probe-browser:${selection.browserSource}`);
      return { runtimeCapability: { kind: 'managed' } };
    },
    async probeComputer() {
      calls.push('probe-computer');
      return { dockerAvailable: true, imageReady: true };
    },
    publishSettingsMetadata() {
      calls.push('publish-metadata');
    },
    async refreshBrowserCapability() {
      calls.push('refresh-browser');
    },
    async refreshComputerCapability() {
      calls.push('refresh-computer');
    },
    async resetAllComputerContainers() {
      calls.push('reset-computers');
    },
    async stopAllBrowsers() {
      calls.push('stop-browsers');
    },
    async stopAllComputers() {
      calls.push('stop-computers');
    },
    updateSettings(patch) {
      calls.push('commit');
      patches.push({ ...patch });
      settings = { ...settings, ...patch };
    },
    ...overrides,
  };
  return { calls, patches, ports, settings: () => settings };
}

async function withServer(
  ports: SettingsMutationPorts,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/api/settings', createSettingsMutationRouter(ports));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((caught: Error | undefined) => (
      caught ? reject(caught) : resolve()
    )));
  }
}

async function run(): Promise<void> {
  {
    const state = harness({
      async probeBrowser(selection) {
        state.calls.push(`probe-browser:${selection.browserSource}`);
        return { runtimeCapability: { kind: 'isolated-computer' } };
      },
    });
    const result = await new SettingsMutationCoordinator(state.ports).mutate({
      browserExtensionEnabled: true,
      browserSource: 'isolated',
      mainPageSessionKeys: ['must-not-write'],
      projectWorkspaces: ['/must-not-write'],
      pinnedProjectWorkspaces: ['/must-not-write'],
    });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(state.patches, [{
      browserExtensionEnabled: true,
      browserSource: 'isolated',
      computerExtensionEnabled: true,
    }]);
    assert.deepStrictEqual(state.calls, [
      'get-settings',
      'probe-browser:isolated',
      'probe-computer',
      'commit',
      'refresh-browser',
      'refresh-computer',
      'get-settings',
    ]);
  }

  {
    const state = harness({
      normalizeAgentHomes(value) {
        state.calls.push('normalize-homes');
        const homes = value as Record<string, Array<Record<string, unknown>>>;
        return Object.fromEntries(Object.entries(homes).map(([provider, entries]) => [
          provider,
          entries.map(home => ({
            ...home,
            acpRuntime: { mode: 'managed', executable: '' },
          })),
        ]));
      },
    });
    const result = await new SettingsMutationCoordinator(state.ports).mutate({
      agentHomes: {
        codex: [{ id: 'legacy', acpRuntime: { mode: 'custom', executable: '/missing/codex' } }],
      },
    });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(state.patches, [{
      agentHomes: {
        codex: [{ id: 'legacy', acpRuntime: { mode: 'managed', executable: '' } }],
      },
    }], 'the settings boundary must commit only the normalized managed runtime');
    assert.deepStrictEqual(state.calls, [
      'get-settings',
      'normalize-homes',
      'commit',
      'invalidate-sessions',
      'invalidate-extensions',
      'get-settings',
    ], 'a successful Agent Home mutation must invalidate both derived inventories after persisting settings');
  }

  {
    const rawProbeFailure = new Error('probe transport failed');
    const state = harness({
      async probeBrowser() {
        throw rawProbeFailure;
      },
    });
    await assert.rejects(
      () => new SettingsMutationCoordinator(state.ports).mutate({ browserExtensionEnabled: true }),
      caught => caught === rawProbeFailure,
      'a thrown Browser probe must retain the HEAD uncaught error path',
    );

    const unavailable = harness({
      async probeBrowser() {
        return { runtimeCapability: { error: 'browser missing' } };
      },
    });
    await assert.rejects(
      () => new SettingsMutationCoordinator(unavailable.ports).mutate({ browserExtensionEnabled: true }),
      (caught: unknown) => (
        caught instanceof SettingsMutationResponseError
        && caught.status === 400
        && caught.code === 'BROWSER_EXECUTABLE_NOT_FOUND'
      ),
    );
  }

  {
    const state = harness({
      updateSettings() {
        throw error('home is still bound', 'AGENT_HOME_IN_USE', 409);
      },
    });
    await assert.rejects(
      () => new SettingsMutationCoordinator(state.ports).mutate({ agentHomes: {} }),
      (caught: unknown) => (
        caught instanceof SettingsMutationResponseError
        && caught.status === 409
        && caught.code === 'AGENT_HOME_IN_USE'
      ),
    );
  }

  {
    const refreshFailure = new Error('browser refresh failed');
    const state = harness({
      async refreshBrowserCapability() {
        state.calls.push('refresh-browser');
        throw refreshFailure;
      },
    });
    await assert.rejects(
      () => new SettingsMutationCoordinator(state.ports).mutate({
        agentHomes: {},
        browserExtensionEnabled: true,
        computerExtensionEnabled: true,
      }),
      caught => caught === refreshFailure,
    );
    assert(!state.calls.includes('refresh-computer'));
    assert(!state.calls.includes('invalidate-sessions'));
    assert(!state.calls.includes('invalidate-extensions'));
    assert(!state.calls.includes('publish-metadata'));
  }

  {
    const firstProbe = deferred<{ runtimeCapability: { kind: string } }>();
    const state = harness({
      async probeBrowser() {
        state.calls.push('probe-browser:blocked');
        return firstProbe.promise;
      },
    });
    const coordinator = new SettingsMutationCoordinator(state.ports);
    const blocked = coordinator.mutate({ browserExtensionEnabled: true });
    const independent = coordinator.mutate({ appearance: 'dark' });
    assert.deepStrictEqual(await independent, {
      success: true,
      settings: {
        browserExtensionEnabled: false,
        browserSource: 'managed',
        computerExtensionEnabled: false,
        appearance: 'dark',
      },
    });
    assert.deepStrictEqual(state.patches, [{ appearance: 'dark' }]);
    firstProbe.resolve({ runtimeCapability: { kind: 'managed' } });
    await blocked;
    assert.deepStrictEqual(state.patches, [
      { appearance: 'dark' },
      { browserExtensionEnabled: true },
    ]);
  }

  {
    const state = harness();
    await withServer(state.ports, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appearance: 'dark' }),
      });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), {
        success: true,
        settings: {
          browserExtensionEnabled: false,
          browserSource: 'managed',
          computerExtensionEnabled: false,
          appearance: 'dark',
        },
      });
      assert.strictEqual(state.calls.at(-1), 'publish-metadata');
    });
  }

  console.log('settings mutation router tests passed');
}

run().catch((caught: unknown) => {
  console.error(caught);
  process.exitCode = 1;
});
