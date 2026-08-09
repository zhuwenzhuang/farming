const assert = require('assert');
const express = require('express');
const { createAgentMutationRouter } = require('../agent-mutation-router.cjs');

type HttpServer = import('http').Server;

interface RecordedCall {
  method: string;
  value?: unknown;
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

async function patchAgent(
  baseUrl: string,
  route: string,
  body: unknown,
  authenticated = true,
  method = 'PATCH',
): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: 'Bearer test' } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function assertJson(response: Response, status: number, body: unknown): Promise<void> {
  assert.strictEqual(response.status, status);
  assert.deepStrictEqual(await response.json(), body);
}

async function run(): Promise<void> {
  const calls: RecordedCall[] = [];
  const results = new Map<string, Record<string, unknown>>();
  let recoveryFailure: Error | null = null;
  let lifecycleIdleRelease: (() => void) | null = null;
  const result = (method: string, fallback: Record<string, unknown>): Record<string, unknown> => (
    results.has(method) ? results.get(method) as Record<string, unknown> : fallback
  );

  const router = createAgentMutationRouter({
    async whenRecovered(): Promise<void> {
      calls.push({ method: 'recovered' });
      if (recoveryFailure) throw recoveryFailure;
    },
    async whenAgentLifecycleIdle(agentId: string): Promise<void> {
      calls.push({ method: 'lifecycle-idle', value: agentId });
      if (lifecycleIdleRelease) {
        await new Promise<void>(resolve => {
          lifecycleIdleRelease = resolve;
        });
      }
    },
    renameAgent(agentId: string, customTitle: string): Record<string, unknown> {
      calls.push({ method: 'rename', value: { agentId, customTitle } });
      return result('rename', { agentId, customTitle });
    },
    setAgentTask(agentId: string, task: string): Record<string, unknown> {
      calls.push({ method: 'task', value: { agentId, task } });
      return result('task', { agentId, task });
    },
    updateAgentFlags(agentId: string, patch: Record<string, unknown>): Record<string, unknown> {
      calls.push({ method: 'flags', value: { agentId, patch } });
      return result('flags', { agentId, ...patch });
    },
    async archiveAgent(
      agentId: string,
      options: { acknowledgeUnprovenAcpExit: boolean },
    ): Promise<Record<string, unknown>> {
      calls.push({ method: 'archive', value: { agentId, options } });
      return result('archive', { agentId, archived: true });
    },
    async syncLaunchPermissionMode(agentId: string, mode: string): Promise<Record<string, unknown>> {
      calls.push({ method: 'permission', value: { agentId, mode } });
      return result('permission', { launchPermissionMode: mode });
    },
    async restartAgentRuntimeMode(agentId: string, mode: string): Promise<Record<string, unknown>> {
      calls.push({ method: 'runtime', value: { agentId, mode } });
      return result('runtime', { agentRuntimeMode: mode });
    },
    publishAgentDelta(agentId: string): void {
      calls.push({ method: 'publish-delta', value: agentId });
    },
  });

  const app = express();
  app.use('/api', (
    req: { headers: Record<string, unknown> },
    res: { status(code: number): typeof res; json(value: unknown): void },
    next: () => void,
  ) => {
    if (req.headers.authorization !== 'Bearer test') {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  });
  app.use('/api/agents', router);
  app.post('/api/agents/:agentId/reorder', express.json(), (
    req: { params: Record<string, string> },
    res: { json(value: unknown): void },
  ) => {
    res.json({ reordered: req.params.agentId });
  });
  app.post('/api/agents/:agentId/fork', express.json(), (
    req: { params: Record<string, string> },
    res: { json(value: unknown): void },
  ) => {
    res.json({ forked: req.params.agentId });
  });
  app.use((
    error: { status?: unknown },
    _req: unknown,
    res: { status(code: number): typeof res; json(value: unknown): void },
    _next: unknown,
  ) => {
    const status = Number(error?.status);
    res.status(Number.isInteger(status) ? status : 500).json({ error: 'request body rejected' });
  });
  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}/api/agents`;

  try {
    recoveryFailure = new Error('Agent lifecycle recovery failed');
    await assertJson(await patchAgent(baseUrl, '/agent-1', { pinned: true }), 503, {
      error: 'Agent lifecycle recovery failed',
      retryable: true,
    });
    assert.deepStrictEqual(calls.splice(0), [{ method: 'recovered' }]);
    recoveryFailure = null;

    await assertJson(await patchAgent(baseUrl, '/agent-1', { acknowledgeUnprovenAcpExit: true }), 400, {
      error: 'Process-exit acknowledgement is only valid for Archive',
    });
    assert.deepStrictEqual(calls.splice(0), [{ method: 'recovered' }]);

    await assertJson(await patchAgent(baseUrl, '/agent-1', { archived: true, pinned: true }), 400, {
      error: 'Archive, permission restart, and runtime switch must be requested separately from other Agent updates',
    });
    await assertJson(await patchAgent(baseUrl, '/agent-1', {
      launchPermissionMode: 'plan',
      customTitle: 'Renamed',
    }), 400, {
      error: 'Archive, permission restart, and runtime switch must be requested separately from other Agent updates',
    });
    await assertJson(await patchAgent(baseUrl, '/agent-1', {
      agentRuntimeMode: 'chat',
      task: 'Ship it',
    }), 400, {
      error: 'Archive, permission restart, and runtime switch must be requested separately from other Agent updates',
    });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { customTitle: 'Renamed', pinned: true }), 400, {
      error: 'Agent title, task, and flags must be updated in separate requests',
    });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { customTitle: 'Renamed', task: 'Ship it' }), 400, {
      error: 'Agent title, task, and flags must be updated in separate requests',
    });
    assert.deepStrictEqual(calls.splice(0).map(call => call.method), [
      'recovered',
      'recovered',
      'recovered',
      'recovered',
      'recovered',
    ]);

    await assertJson(await patchAgent(baseUrl, '/agent-1', {}), 400, {
      error: 'customTitle, task, pinned, unread, archived, readAttentionSeq, readOutputEpoch/readOutputSeq, launchPermissionMode, or agentRuntimeMode is required',
    });
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'recovered' },
      { method: 'lifecycle-idle', value: 'agent-1' },
    ]);

    await assertJson(await patchAgent(baseUrl, '/agent-1', { readOutputEpoch: 'epoch-1' }), 400, {
      error: 'customTitle, task, pinned, unread, archived, readAttentionSeq, readOutputEpoch/readOutputSeq, launchPermissionMode, or agentRuntimeMode is required',
    });
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'recovered' },
      { method: 'lifecycle-idle', value: 'agent-1' },
    ]);

    await assertJson(await patchAgent(baseUrl, '/agent-1', { customTitle: 'Renamed' }), 200, {
      agentId: 'agent-1',
      customTitle: 'Renamed',
    });
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'recovered' },
      { method: 'lifecycle-idle', value: 'agent-1' },
      { method: 'rename', value: { agentId: 'agent-1', customTitle: 'Renamed' } },
      { method: 'publish-delta', value: 'agent-1' },
    ]);

    await assertJson(await patchAgent(baseUrl, '/agent-1', { task: 'Ship it' }), 200, {
      agentId: 'agent-1',
      task: 'Ship it',
    });
    assert.deepStrictEqual(calls.splice(0).map(call => call.method), [
      'recovered',
      'lifecycle-idle',
      'task',
      'publish-delta',
    ]);

    results.set('flags', { agentId: 'agent-1', pinned: true });
    await assertJson(await patchAgent(baseUrl, '/agent-1', {
      pinned: true,
      readAttentionSeq: 7,
      readOutputEpoch: 'epoch-1',
      readOutputSeq: 12,
    }), 200, { agentId: 'agent-1', pinned: true });
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'recovered' },
      { method: 'lifecycle-idle', value: 'agent-1' },
      {
        method: 'flags',
        value: {
          agentId: 'agent-1',
          patch: {
            pinned: true,
            readAttentionSeq: 7,
            readOutputEpoch: 'epoch-1',
            readOutputSeq: 12,
          },
        },
      },
    ]);
    results.delete('flags');

    results.set('flags', { agentId: 'agent-1', unread: false, requiresState: true });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { unread: false }), 200, {
      agentId: 'agent-1',
      unread: false,
      requiresState: true,
    });
    assert.deepStrictEqual(calls.splice(0).map(call => call.method), [
      'recovered',
      'lifecycle-idle',
      'flags',
      'publish-delta',
    ]);
    results.delete('flags');

    await assertJson(await patchAgent(baseUrl, '/agent-1', {
      archived: true,
      acknowledgeUnprovenAcpExit: true,
    }), 200, { agentId: 'agent-1', archived: true });
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'recovered' },
      { method: 'lifecycle-idle', value: 'agent-1' },
      {
        method: 'archive',
        value: { agentId: 'agent-1', options: { acknowledgeUnprovenAcpExit: true } },
      },
    ]);

    results.set('archive', { error: 'Agent is still running', stopped: true });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { archived: true }), 409, {
      error: 'Agent is still running',
      stopped: true,
    });
    results.set('archive', { error: 'Agent not found' });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { archived: true }), 404, {
      error: 'Agent not found',
    });
    results.set('archive', { error: 'Process exit is unproven' });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { archived: true }), 400, {
      error: 'Process exit is unproven',
    });
    results.delete('archive');
    assert.deepStrictEqual(calls.splice(0).map(call => call.method), [
      'recovered',
      'lifecycle-idle',
      'archive',
      'recovered',
      'lifecycle-idle',
      'archive',
      'recovered',
      'lifecycle-idle',
      'archive',
    ]);

    results.set('permission', {
      launchPermissionMode: 'plan',
      restarted: true,
      restartedAgentId: 'agent-2',
    });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { launchPermissionMode: 'plan' }), 200, {
      agentId: 'agent-1',
      launchPermissionMode: 'plan',
      restarted: true,
      restartedAgentId: 'agent-2',
    });
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'recovered' },
      { method: 'lifecycle-idle', value: 'agent-1' },
      { method: 'permission', value: { agentId: 'agent-1', mode: 'plan' } },
      { method: 'publish-delta', value: 'agent-1' },
    ]);

    results.set('permission', { error: 'Agent not found' });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { launchPermissionMode: 'plan' }), 404, {
      error: 'Agent not found',
    });
    results.set('permission', { error: 'Unsupported permission mode' });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { launchPermissionMode: 'plan' }), 400, {
      error: 'Unsupported permission mode',
    });
    results.delete('permission');
    calls.splice(0);

    results.set('runtime', {
      agentRuntimeMode: 'chat',
      restarted: true,
      restartedAgentId: 'agent-3',
      switchFailed: true,
      warning: 'Runtime switch degraded',
    });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { agentRuntimeMode: 'chat' }), 200, {
      agentId: 'agent-1',
      agentRuntimeMode: 'chat',
      restarted: true,
      restartedAgentId: 'agent-3',
      switchFailed: true,
      warning: 'Runtime switch degraded',
    });
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'recovered' },
      { method: 'lifecycle-idle', value: 'agent-1' },
      { method: 'runtime', value: { agentId: 'agent-1', mode: 'chat' } },
      { method: 'publish-delta', value: 'agent-1' },
    ]);
    results.delete('runtime');

    await assertJson(await patchAgent(baseUrl, '/agent-1', { agentRuntimeMode: 'quantum' }), 400, {
      error: 'Unsupported Agent runtime mode',
    });
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'recovered' },
      { method: 'lifecycle-idle', value: 'agent-1' },
    ]);

    results.set('runtime', { error: 'Agent not found' });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { agentRuntimeMode: 'chat' }), 404, {
      error: 'Agent not found',
    });
    results.set('runtime', { error: 'Runtime switch is unavailable' });
    await assertJson(await patchAgent(baseUrl, '/agent-1', { agentRuntimeMode: 'chat' }), 400, {
      error: 'Runtime switch is unavailable',
    });
    results.delete('runtime');
    calls.splice(0);

    for (const [method, notFoundStatus] of [['rename', 404], ['task', 404], ['flags', 404]] as const) {
      results.set(method, { error: 'Agent not found' });
      const body = method === 'rename'
        ? { customTitle: 'Renamed' }
        : method === 'task'
          ? { task: 'Ship it' }
          : { pinned: true };
      await assertJson(await patchAgent(baseUrl, '/agent-1', body), notFoundStatus, {
        error: 'Agent not found',
      });
      results.set(method, { error: 'Failed to persist Agent' });
      await assertJson(await patchAgent(baseUrl, '/agent-1', body), 500, {
        error: 'Failed to persist Agent',
      });
      results.set(method, { error: 'Agent is archived' });
      await assertJson(await patchAgent(baseUrl, '/agent-1', body), 409, {
        error: 'Agent is archived',
      });
      results.delete(method);
    }
    calls.splice(0);

    lifecycleIdleRelease = () => {};
    const pending = patchAgent(baseUrl, '/agent-1', { customTitle: 'Renamed' });
    await new Promise<void>(resolve => { setTimeout(resolve, 50); });
    assert.deepStrictEqual(calls.map(call => call.method), ['recovered', 'lifecycle-idle']);
    const release = lifecycleIdleRelease;
    lifecycleIdleRelease = null;
    release();
    await assertJson(await pending, 200, { agentId: 'agent-1', customTitle: 'Renamed' });
    assert.deepStrictEqual(calls.splice(0).map(call => call.method), [
      'recovered',
      'lifecycle-idle',
      'rename',
      'publish-delta',
    ]);

    await assertJson(await patchAgent(baseUrl, '/agent-1', { pinned: true }, false), 401, {
      error: 'Authentication required',
    });
    assert.deepStrictEqual(calls.splice(0), []);

    await assertJson(await patchAgent(baseUrl, '/agent-1', '{'), 400, {
      error: 'request body rejected',
    });
    assert.deepStrictEqual(calls.splice(0), []);

    await assertJson(
      await patchAgent(baseUrl, '/agent-1/reorder', { beforeAgentId: 'agent-2' }, true, 'POST'),
      200,
      { reordered: 'agent-1' },
    );
    await assertJson(
      await patchAgent(baseUrl, '/agent-1/fork', { mode: 'same-worktree' }, true, 'POST'),
      200,
      { forked: 'agent-1' },
    );
    assert.strictEqual((await patchAgent(baseUrl, '/agent-1', { pinned: true }, true, 'POST')).status, 404);
    assert.deepStrictEqual(calls.splice(0), []);

    console.log('agent mutation router behavior passed');
  } finally {
    await closeServer(server);
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
