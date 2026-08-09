const assert = require('assert');
const express = require('express');
const { createThemeRouter } = require('../theme-router.cjs');

type HttpServer = import('http').Server;

interface ExpressErrorResponse {
  json(value: unknown): ExpressErrorResponse;
  status(code: number): ExpressErrorResponse;
}

interface ThemeConfig {
  displayName: string;
  id: string;
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
  assert.strictEqual(response.headers.get('cache-control'), null);
  assert.deepStrictEqual(await response.json(), body);
}

function postJson(baseUrl: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postRawJson(baseUrl: string, route: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

async function run(): Promise<void> {
  const terminalTheme: ThemeConfig = { id: 'terminal', displayName: 'Farming CRT' };
  const plainTheme: ThemeConfig = { id: 'plain', displayName: 'Plain' };
  const themes = new Map<string, ThemeConfig>([
    [terminalTheme.id, terminalTheme],
    [plainTheme.id, plainTheme],
  ]);
  const settings = new Map<string, Record<string, unknown>>([
    ['terminal', { crtEffects: true }],
  ]);
  const css = new Map<string, string>([['terminal', '.terminal { color: lime; }']]);
  const calls: string[] = [];
  const updateBodies: unknown[] = [];
  let saveSucceeds = true;

  const themeManager = {
    getTheme(themeId: string): ThemeConfig | undefined {
      calls.push(`getTheme:${themeId}`);
      return themes.get(themeId);
    },
    getThemeSettings(themeId: string): Record<string, unknown> {
      calls.push(`getThemeSettings:${themeId}`);
      return settings.get(themeId) || {};
    },
    updateThemeSettings(themeId: string, nextSettings: unknown): boolean {
      calls.push(`updateThemeSettings:${themeId}`);
      updateBodies.push(nextSettings);
      if (!saveSucceeds) return false;
      settings.set(themeId, nextSettings as Record<string, unknown>);
      return true;
    },
    getThemeCSS(themeId: string): string | null {
      calls.push(`getThemeCSS:${themeId}`);
      return css.get(themeId) || null;
    },
  };
  const selectTheme = (themeId: string): void => {
    calls.push(`selectTheme:${themeId}`);
  };

  const app = express();
  app.use('/api/themes', createThemeRouter(themeManager, selectTheme));
  app.use((error: unknown, _req: unknown, res: ExpressErrorResponse, _next: unknown) => {
    res.status(middlewareErrorStatus(error)).json({ error: 'request body rejected' });
  });
  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}/api/themes`;

  try {
    let callStart = calls.length;
    await assertJsonResponse(await postJson(baseUrl, '/terminal/set', {}), 200, {
      success: true,
      theme: 'terminal',
    });
    assert.deepStrictEqual(calls.slice(callStart), [
      'getTheme:terminal',
      'selectTheme:terminal',
    ]);

    callStart = calls.length;
    await assertJsonResponse(await fetch(`${baseUrl}/terminal/settings`), 200, {
      settings: { crtEffects: true },
    });
    assert.deepStrictEqual(calls.slice(callStart), [
      'getTheme:terminal',
      'getThemeSettings:terminal',
    ]);

    callStart = calls.length;
    const nextSettings = { crtEffects: false, scanlines: 0.5 };
    await assertJsonResponse(await postJson(baseUrl, '/terminal/settings', nextSettings), 200, {
      success: true,
      settings: nextSettings,
    });
    assert.deepStrictEqual(updateBodies.at(-1), nextSettings);
    assert.deepStrictEqual(calls.slice(callStart), [
      'getTheme:terminal',
      'updateThemeSettings:terminal',
      'getThemeSettings:terminal',
    ]);

    saveSucceeds = false;
    callStart = calls.length;
    await assertJsonResponse(await postJson(baseUrl, '/terminal/settings', { crtEffects: true }), 500, {
      error: 'Failed to update theme settings',
    });
    assert.deepStrictEqual(calls.slice(callStart), [
      'getTheme:terminal',
      'updateThemeSettings:terminal',
    ]);
    saveSucceeds = true;

    callStart = calls.length;
    await assertJsonResponse(await fetch(`${baseUrl}/plain`), 200, {
      theme: plainTheme,
      css: null,
    });
    assert.deepStrictEqual(calls.slice(callStart), [
      'getTheme:plain',
      'getThemeCSS:plain',
    ]);

    const missingRoutes = [
      { method: 'POST', route: '/missing/set' },
      { method: 'GET', route: '/missing/settings' },
      { method: 'POST', route: '/missing/settings' },
      { method: 'GET', route: '/missing' },
    ];
    for (const { method, route } of missingRoutes) {
      callStart = calls.length;
      const response = method === 'POST'
        ? await postJson(baseUrl, route, {})
        : await fetch(`${baseUrl}${route}`);
      await assertJsonResponse(response, 404, { error: 'Theme not found' });
      assert.deepStrictEqual(calls.slice(callStart), ['getTheme:missing']);
    }

    const parserCases = [
      { body: '{"theme":', expectedStatus: 400 },
      { body: JSON.stringify({ value: 'x'.repeat(128 * 1024) }), expectedStatus: 413 },
    ];
    for (const route of ['/terminal/set', '/terminal/settings']) {
      for (const { body, expectedStatus } of parserCases) {
        callStart = calls.length;
        await assertJsonResponse(
          await postRawJson(baseUrl, route, body),
          expectedStatus,
          { error: 'request body rejected' },
        );
        assert.strictEqual(calls.length, callStart);
      }
    }

    console.log('theme router behavior passed');
  } finally {
    await closeServer(server);
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
