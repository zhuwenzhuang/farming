const assert = require('assert');
const express = require('express');
const { createProjectMutationRouter } = require('../project-mutation-router.cjs');

type HttpServer = import('http').Server;

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

async function jsonRequest(
  baseUrl: string,
  route: string,
  body: unknown,
  method = 'POST',
  authenticated = true,
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
  const calls: Array<{ method: string; value?: unknown }> = [];
  const failures = new Map<string, unknown>();
  const membership = {
    projectWorkspaces: ['/canonical/project'],
    pinnedProjectWorkspaces: ['/canonical/project'],
  };
  const fail = (method: string): void => {
    if (failures.has(method)) throw failures.get(method);
  };
  const router = createProjectMutationRouter({
    async canonicalWorkspace(workspace: string): Promise<string> {
      calls.push({ method: 'canonical', value: workspace });
      fail('canonical');
      return workspace ? `/canonical/${workspace}` : '';
    },
    async gitWorkspaceForFile(filePath: string): Promise<string> {
      calls.push({ method: 'git-file', value: filePath });
      fail('git-file');
      return filePath === '/repo/src/file.ts' ? '/repo' : '';
    },
    mountWorkspace(workspace: string): unknown {
      calls.push({ method: 'mount', value: workspace });
      fail('mount');
      return membership;
    },
    removeWorkspace(workspace: unknown): unknown {
      calls.push({ method: 'remove', value: workspace });
      fail('remove');
      return membership;
    },
    setWorkspacePinned(workspace: unknown, pinned: boolean): unknown {
      calls.push({ method: 'pin', value: { workspace, pinned } });
      fail('pin');
      return membership;
    },
    reorderWorkspace(workspace: unknown, position: unknown): unknown {
      calls.push({ method: 'reorder', value: { workspace, position } });
      fail('reorder');
      return membership;
    },
    setWorkspaceName(workspace: unknown, name: unknown): unknown {
      calls.push({ method: 'name', value: { workspace, name } });
      fail('name');
      return { projectNames: { '/project': 'Example' } };
    },
    publishMembershipChange(): void {
      calls.push({ method: 'publish-membership' });
      fail('publish-membership');
    },
    publishNameChange(): void {
      calls.push({ method: 'publish-name' });
      fail('publish-name');
    },
  });

  const app = express();
  app.use('/api', (req: { headers: Record<string, unknown> }, res: { status(code: number): typeof res; json(value: unknown): void }, next: () => void) => {
    if (req.headers.authorization !== 'Bearer test') {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  });
  app.use('/api/projects', router);
  app.post('/api/projects/create-worktree', express.json(), (_req: unknown, res: { status(code: number): typeof res; json(value: unknown): void }) => {
    res.status(201).json({ downstream: true });
  });
  app.use((error: { status?: unknown }, _req: unknown, res: { status(code: number): typeof res; json(value: unknown): void }, _next: unknown) => {
    const status = Number(error?.status);
    res.status(Number.isInteger(status) ? status : 500).json({ error: 'request body rejected' });
  });
  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}/api/projects`;

  try {
    await assertJson(await jsonRequest(baseUrl, '/mount', { workspace: 'project' }), 200, membership);
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'canonical', value: 'project' },
      { method: 'mount', value: '/canonical/project' },
      { method: 'publish-membership' },
    ]);

    await assertJson(await jsonRequest(baseUrl, '/mount-file', { path: '/repo/src/file.ts' }), 200, {
      ...membership,
      workspace: '/repo',
    });
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'git-file', value: '/repo/src/file.ts' },
      { method: 'mount', value: '/repo' },
      { method: 'publish-membership' },
    ]);

    await assertJson(await jsonRequest(baseUrl, '/mount-file', { path: '/tmp/plain.txt' }), 404, {
      error: 'No Git repository found for file',
    });
    assert.deepStrictEqual(calls.splice(0), [{ method: 'git-file', value: '/tmp/plain.txt' }]);

    await assertJson(await jsonRequest(baseUrl, '/remove', { workspace: 42 }), 200, membership);
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'remove', value: 42 },
      { method: 'publish-membership' },
    ]);

    await assertJson(await jsonRequest(baseUrl, '/pin', { workspace: '/project', pinned: 'true' }), 200, membership);
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'pin', value: { workspace: '/project', pinned: false } },
      { method: 'publish-membership' },
    ]);

    await assertJson(await jsonRequest(baseUrl, '/reorder', {
      workspace: '/project',
      beforeWorkspace: 7,
      afterWorkspace: '/after',
    }), 200, membership);
    assert.deepStrictEqual(calls.splice(0), [
      {
        method: 'reorder',
        value: {
          workspace: '/project',
          position: { beforeWorkspace: undefined, afterWorkspace: '/after' },
        },
      },
      { method: 'publish-membership' },
    ]);

    await assertJson(await jsonRequest(baseUrl, '/name', {
      workspace: '/project',
      name: 'Example',
    }, 'PATCH'), 200, { projectNames: { '/project': 'Example' } });
    assert.deepStrictEqual(calls.splice(0), [
      { method: 'name', value: { workspace: '/project', name: 'Example' } },
      { method: 'publish-name' },
    ]);

    failures.set('canonical', new Error('invalid mount'));
    await assertJson(await jsonRequest(baseUrl, '/mount', { workspace: 'bad' }), 400, { error: 'invalid mount' });
    failures.delete('canonical');
    assert.deepStrictEqual(calls.splice(0), [{ method: 'canonical', value: 'bad' }]);

    failures.set('reorder', new Error('Project does not exist'));
    await assertJson(await jsonRequest(baseUrl, '/reorder', { workspace: '/missing' }), 404, {
      error: 'Project does not exist',
    });
    failures.set('reorder', new Error('Pinned Project boundary conflict'));
    await assertJson(await jsonRequest(baseUrl, '/reorder', { workspace: '/project' }), 409, {
      error: 'Pinned Project boundary conflict',
    });
    failures.delete('reorder');
    assert.deepStrictEqual(calls.splice(0).map(call => call.method), ['reorder', 'reorder']);

    failures.set('remove', new Error('remove failed'));
    await assertJson(await jsonRequest(baseUrl, '/remove', { workspace: '/project' }), 400, {
      error: 'remove failed',
    });
    failures.delete('remove');
    assert.deepStrictEqual(calls.splice(0), [{ method: 'remove', value: '/project' }]);

    failures.set('publish-membership', new Error('membership publication failed'));
    await assertJson(await jsonRequest(baseUrl, '/pin', { workspace: '/project', pinned: true }), 400, {
      error: 'membership publication failed',
    });
    failures.delete('publish-membership');
    assert.deepStrictEqual(calls.splice(0).map(call => call.method), ['pin', 'publish-membership']);

    failures.set('publish-name', new Error('name publication failed'));
    await assertJson(await jsonRequest(baseUrl, '/name', { workspace: '/project', name: 'Next' }, 'PATCH'), 400, {
      error: 'name publication failed',
    });
    failures.delete('publish-name');
    assert.deepStrictEqual(calls.splice(0).map(call => call.method), ['name', 'publish-name']);

    await assertJson(await jsonRequest(baseUrl, '/pin', { workspace: '/project' }, 'POST', false), 401, {
      error: 'Authentication required',
    });
    assert.deepStrictEqual(calls.splice(0), []);

    for (const [route, method] of [
      ['/mount', 'POST'],
      ['/mount-file', 'POST'],
      ['/remove', 'POST'],
      ['/pin', 'POST'],
      ['/reorder', 'POST'],
      ['/name', 'PATCH'],
    ]) {
      await assertJson(await jsonRequest(baseUrl, route, '{', method), 400, {
        error: 'request body rejected',
      });
      assert.deepStrictEqual(calls.splice(0), []);
    }

    await assertJson(await jsonRequest(baseUrl, '/create-worktree', {}), 201, { downstream: true });
    assert.deepStrictEqual(calls.splice(0), []);

    console.log('project mutation router behavior passed');
  } finally {
    await closeServer(server);
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
