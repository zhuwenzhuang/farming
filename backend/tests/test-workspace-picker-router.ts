const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkspacePickerRouter } = require('../workspace-picker-router.cjs');

type HttpServer = import('http').Server;

interface WorkspaceSuggestion {
  name: string;
  path: string;
}

interface CompletionResponse {
  error?: string;
  suggestions: WorkspaceSuggestion[];
}

interface ErrorResponse {
  error: string;
}

interface RecentResponse {
  workspaceHistory: string[];
}

interface ExpressErrorResponse {
  json(value: unknown): ExpressErrorResponse;
  status(code: number): ExpressErrorResponse;
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

function requestUrl(baseUrl: string, pathname: string, query: Record<string, string>): string {
  return `${baseUrl}${pathname}?${new URLSearchParams(query).toString()}`;
}

function middlewareErrorStatus(error: unknown): number {
  if (!error || typeof error !== 'object' || !('status' in error)) return 500;
  const status = Number(error.status);
  return Number.isInteger(status) ? status : 500;
}

async function runWithTemporaryRoot(temporaryRoot: string): Promise<void> {
  const pickerRoot = path.join(temporaryRoot, 'picker');
  const bulkRoot = path.join(temporaryRoot, 'bulk');
  fs.mkdirSync(pickerRoot);
  fs.mkdirSync(bulkRoot);
  for (const directory of ['alpha', 'beta', 'gamma', '.hidden']) {
    fs.mkdirSync(path.join(pickerRoot, directory));
  }
  fs.writeFileSync(path.join(pickerRoot, 'artifact.txt'), 'not a directory\n');
  for (let index = 0; index < 105; index += 1) {
    fs.mkdirSync(path.join(bulkRoot, `entry-${String(index).padStart(3, '0')}`));
  }

  const remembered: unknown[] = [];
  let rememberFailure: Error | null = null;
  const service = {
    rememberWorkspace(workspace: unknown): string[] {
      remembered.push(workspace);
      if (rememberFailure) throw rememberFailure;
      return [String(workspace)];
    },
  };

  const app = express();
  app.use('/api/workspaces', createWorkspacePickerRouter(service));
  app.use((error: unknown, _req: unknown, res: ExpressErrorResponse, _next: unknown) => {
    res.status(middlewareErrorStatus(error)).json({ error: 'request body rejected' });
  });
  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}/api/workspaces`;
  const originalHome = process.env.HOME;
  process.env.HOME = pickerRoot;

  try {
    const homeResponse = await fetch(`${baseUrl}/complete`);
    assert.strictEqual(homeResponse.status, 200);
    assert.deepStrictEqual((await homeResponse.json() as CompletionResponse).suggestions, [
      { name: 'alpha', path: `${path.join(pickerRoot, 'alpha')}${path.sep}` },
      { name: 'beta', path: `${path.join(pickerRoot, 'beta')}${path.sep}` },
      { name: 'gamma', path: `${path.join(pickerRoot, 'gamma')}${path.sep}` },
    ]);

    const tildeRootResponse = await fetch(requestUrl(baseUrl, '/complete', {
      path: '~',
      limit: '2',
    }));
    assert.strictEqual(tildeRootResponse.status, 200);
    assert.deepStrictEqual((await tildeRootResponse.json() as CompletionResponse).suggestions, [
      { name: 'alpha', path: `~${path.sep}alpha${path.sep}` },
      { name: 'beta', path: `~${path.sep}beta${path.sep}` },
    ]);

    const tildePrefixResponse = await fetch(requestUrl(baseUrl, '/complete', {
      path: `~${path.sep}a`,
      limit: '10',
    }));
    assert.strictEqual(tildePrefixResponse.status, 200);
    assert.deepStrictEqual((await tildePrefixResponse.json() as CompletionResponse).suggestions, [
      { name: 'alpha', path: `~${path.sep}alpha${path.sep}` },
    ]);

    const prefixResponse = await fetch(requestUrl(baseUrl, '/complete', {
      path: path.join(pickerRoot, 'a'),
      limit: '10',
    }));
    assert.strictEqual(prefixResponse.status, 200);
    assert.strictEqual(prefixResponse.headers.get('cache-control'), null);
    assert.deepStrictEqual(await prefixResponse.json(), {
      suggestions: [{ name: 'alpha', path: `${path.join(pickerRoot, 'alpha')}${path.sep}` }],
    });

    const limitedResponse = await fetch(requestUrl(baseUrl, '/complete', {
      path: `${pickerRoot}${path.sep}`,
      limit: '2',
    }));
    assert.strictEqual(limitedResponse.status, 200);
    assert.deepStrictEqual((await limitedResponse.json() as CompletionResponse).suggestions, [
      { name: 'alpha', path: `${path.join(pickerRoot, 'alpha')}${path.sep}` },
      { name: 'beta', path: `${path.join(pickerRoot, 'beta')}${path.sep}` },
    ]);

    const hiddenResponse = await fetch(requestUrl(baseUrl, '/complete', {
      path: `${pickerRoot}${path.sep}.`,
      limit: '10',
    }));
    assert.strictEqual(hiddenResponse.status, 200);
    assert.deepStrictEqual((await hiddenResponse.json() as CompletionResponse).suggestions, [
      { name: '.hidden', path: `${path.join(pickerRoot, '.hidden')}${path.sep}` },
    ]);

    const zeroLimitResponse = await fetch(requestUrl(baseUrl, '/complete', {
      path: `${pickerRoot}${path.sep}`,
      limit: '0',
    }));
    assert.strictEqual((await zeroLimitResponse.json() as CompletionResponse).suggestions.length, 3);

    const cappedResponse = await fetch(requestUrl(baseUrl, '/complete', {
      path: `${bulkRoot}${path.sep}`,
      limit: '500',
    }));
    const cappedSuggestions = (await cappedResponse.json() as CompletionResponse).suggestions;
    assert.strictEqual(cappedSuggestions.length, 100);
    assert.strictEqual(cappedSuggestions[0].name, 'entry-000');
    assert.strictEqual(cappedSuggestions.at(-1)?.name, 'entry-099');

    const failedCompletion = await fetch(requestUrl(baseUrl, '/complete', {
      path: path.join(temporaryRoot, 'missing', 'child'),
      limit: '10',
    }));
    assert.strictEqual(failedCompletion.status, 200);
    assert.strictEqual(failedCompletion.headers.get('cache-control'), null);
    const failedCompletionBody = await failedCompletion.json() as CompletionResponse;
    assert.deepStrictEqual(failedCompletionBody.suggestions, []);
    assert(failedCompletionBody.error?.includes('ENOENT'));

    const recentResponse = await fetch(`${baseUrl}/recent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: pickerRoot }),
    });
    assert.strictEqual(recentResponse.status, 200);
    assert.strictEqual(recentResponse.headers.get('cache-control'), null);
    assert.deepStrictEqual(await recentResponse.json() as RecentResponse, {
      workspaceHistory: [pickerRoot],
    });
    assert.deepStrictEqual(remembered, [pickerRoot]);

    rememberFailure = new TypeError('Recent workspace must be an existing non-Farming directory');
    const rejectedRecent = await fetch(`${baseUrl}/recent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: '/invalid' }),
    });
    assert.strictEqual(rejectedRecent.status, 400);
    assert.deepStrictEqual(await rejectedRecent.json() as ErrorResponse, {
      error: 'Recent workspace must be an existing non-Farming directory',
    });
    assert.deepStrictEqual(remembered, [pickerRoot, '/invalid']);

    rememberFailure = null;
    const callsBeforeRejectedBodies = remembered.length;
    const invalidJson = await fetch(`${baseUrl}/recent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"workspace":',
    });
    assert.strictEqual(invalidJson.status, 400);
    assert.deepStrictEqual(await invalidJson.json(), { error: 'request body rejected' });
    assert.strictEqual(remembered.length, callsBeforeRejectedBodies);

    const oversizedJson = await fetch(`${baseUrl}/recent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: 'x'.repeat(9 * 1024) }),
    });
    assert.strictEqual(oversizedJson.status, 413);
    assert.deepStrictEqual(await oversizedJson.json(), { error: 'request body rejected' });
    assert.strictEqual(remembered.length, callsBeforeRejectedBodies);

    console.log('workspace picker router behavior passed');
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await closeServer(server);
  }
}

async function run(): Promise<void> {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-workspace-picker-'));
  try {
    await runWithTemporaryRoot(temporaryRoot);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
