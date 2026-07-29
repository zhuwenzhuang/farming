#!/bin/sh
':' //; script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; repo_dir="$script_dir"; while [ ! -x "$repo_dir/node_modules/.bin/tsx" ] && [ "$repo_dir" != "/" ]; do repo_dir="$(dirname -- "$repo_dir")"; done; if [ ! -x "$repo_dir/node_modules/.bin/tsx" ]; then echo "Pinned tsx runtime not found above $script_dir" >&2; exit 127; fi; exec "$repo_dir/node_modules/.bin/tsx" "$0" "$@"
import assert from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_BASE_PATH = '/farming';

function log(message: string): void {
  console.log(`==> ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address !== 'string') {
        server.close(() => resolve(address.port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
  });
}

function waitForOutputUrl(child: ChildProcess, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for local server URL on port ${port}\n${output}`));
    }, 20000);

    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = output.match(new RegExp(`http://localhost:${port}[^\\s]+`));
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };

    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Local server exited before URL was printed: ${code}\n${output}`));
    });
  });
}

interface LocalServer {
  baseUrl: string;
  tmpRoot: string;
  configDir: string;
  stop: () => Promise<void>;
}

async function startLocalServer(): Promise<LocalServer> {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync('/tmp/farming-e2e-workspaces-');
  const configDir = path.join(tmpRoot, '.farming');
  const child = spawn(process.execPath, ['backend/server.cjs'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      FARMING_BASE_PATH: process.env.FARMING_BASE_PATH || DEFAULT_BASE_PATH,
      FARMING_CONFIG_DIR: configDir,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = await waitForOutputUrl(child, port);
  return {
    baseUrl,
    tmpRoot,
    configDir,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await sleep(500);
      }
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function appPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}${suffix}`;
  return url.toString();
}

async function assertPageState(page: Page, predicate: () => Promise<boolean> | boolean, label: string, timeout = 15000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(predicate)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function assertDiscoveredWorkspaceVisible(page: Page, expectedDiscovered: string, timeout = 20000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const found = await page.evaluate((expected: string) => (
      Array.from(document.querySelectorAll('.workspace-history-item .workspace-history-path'))
        .some(node => (node.textContent || '') === expected)
    ), expectedDiscovered);
    if (found) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for discovered workspace ${expectedDiscovered}`);
}

async function waitForButtonContaining(page: Page, text: string, timeout = 15000): Promise<void> {
  const needle = text.toLowerCase();
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const found = await page.evaluate((expected: string) => (
      Array.from(document.querySelectorAll('button'))
        .some(node => (node.textContent || '').toLowerCase().includes(expected))
    ), needle);
    if (found) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for button containing "${text}"`);
}

async function clickButtonContaining(page: Page, text: string): Promise<void> {
  const needle = text.toLowerCase();
  await waitForButtonContaining(page, text);
  const clicked = await page.evaluate((expected: string) => {
    const button = Array.from(document.querySelectorAll('button'))
      .find(node => (node.textContent || '').toLowerCase().includes(expected));
    if (!button) return false;
    button.click();
    return true;
  }, needle);
  assert.ok(clicked, `button containing "${text}" should be clickable`);
}

async function setInputValue(page: Page, selector: string, value: string): Promise<void> {
  await page.$eval(selector, (input: HTMLInputElement, nextValue: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function fetchJson(baseUrl: string, suffix: string, options?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(appPath(baseUrl, suffix), options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${suffix}: ${await response.text()}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

interface WorkspaceFlowOptions {
  baseUrl: string;
  mainWorkspace?: string;
  recentWorkspaces: string[];
  internalWorkspace: string;
  expectedDiscovered?: string;
}

async function runWorkspaceFlow({ baseUrl, mainWorkspace, recentWorkspaces, internalWorkspace, expectedDiscovered }: WorkspaceFlowOptions): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    headless: process.env.FARMING_E2E_HEADLESS === 'false' ? false : true,
    protocolTimeout: 90000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check'],
  });

  try {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    const hasMainDialog = await page.evaluate(() => (
      /Start Main Agent/i.test(document.querySelector('.input-dialog h3')?.textContent || '')
    ));
    if (hasMainDialog) {
      await clickButtonContaining(page, 'bash');
      await assertPageState(
        page,
        () => document.querySelector<HTMLInputElement>('.workspace-input input')?.value === '~/.farming',
        'Main Agent default workspace'
      );
      const mainHistoryCount = await page.$$eval('.workspace-history-item', nodes => nodes.length);
      assert.strictEqual(mainHistoryCount, 0, 'Main Agent should not show recent workspaces');

      if (mainWorkspace) {
        await setInputValue(page, '.workspace-input input', mainWorkspace);
      }
      await page.focus('.workspace-input input');
      await page.keyboard.press('Enter');
      await assertPageState(page, () => !document.querySelector('.input-dialog'), 'Main Agent started', 20000);

      const settingsAfterMain = await fetchJson(baseUrl, '/api/settings') as { settings: { lastMainWorkspace?: string; workspaceHistory?: string[] } };
      if (mainWorkspace) {
        assert.strictEqual(settingsAfterMain.settings.lastMainWorkspace, mainWorkspace);
        assert.ok(
          !(settingsAfterMain.settings.workspaceHistory || []).includes(mainWorkspace),
          'Main Agent workspace should not leak into New Agent history'
        );
      }
    } else {
      log('Main Agent already exists; skipping fresh Main Agent default assertion for this target');
    }

    await fetchJson(baseUrl, '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceHistory: [internalWorkspace, ...recentWorkspaces, recentWorkspaces[0]].filter(Boolean),
      }),
    });

    await page.keyboard.press('n');
    await assertPageState(
      page,
      () => /Start New Agent/i.test(document.querySelector('.input-dialog h3')?.textContent || ''),
      'Start New Agent dialog'
    );
    await clickButtonContaining(page, 'bash');
    await assertPageState(page, () => document.querySelectorAll('.workspace-history-item').length > 0, 'New Agent workspace options');
    if (expectedDiscovered) {
      await assertDiscoveredWorkspaceVisible(page, expectedDiscovered);
    }

    const items = await page.$$eval('.workspace-history-item .workspace-history-path', nodes => nodes.map(node => node.textContent || ''));
    log(`Workspace options:\n${items.join('\n')}`);
    assert.ok(
      !items.some(item => item.includes('/.farming') || item.includes('~/.farming')),
      'New Agent options should not include Farming internal workspace'
    );
    recentWorkspaces.forEach((workspace, index) => {
      assert.strictEqual(items[index], workspace, 'recent workspaces should stay first and deduped');
    });
    if (expectedDiscovered) {
      assert.ok(items.includes(expectedDiscovered), 'discovered workspace should be appended after recent workspaces');
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] || 'local';
  let localServer: LocalServer | null = null;

  try {
    if (mode === 'local') {
      localServer = await startLocalServer();
      const mainWorkspace = path.join(localServer.tmpRoot, 'main-workspace');
      const recentWorkspaces = [
        path.join(localServer.tmpRoot, 'project-a'),
        path.join(localServer.tmpRoot, 'project-b'),
      ];
      [mainWorkspace, ...recentWorkspaces].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

      log(`Workspace E2E target: ${localServer.baseUrl}`);
      await runWorkspaceFlow({
        baseUrl: localServer.baseUrl,
        mainWorkspace,
        recentWorkspaces,
        internalWorkspace: localServer.configDir,
      });
    } else if (mode === 'remote') {
      const baseUrl = process.env.FARMING_E2E_REMOTE_URL;
      if (!baseUrl) {
        throw new Error('Set FARMING_E2E_REMOTE_URL to the remote /farming?token=... URL');
      }

      log(`Workspace E2E target: ${baseUrl}`);
      await runWorkspaceFlow({
        baseUrl,
        mainWorkspace: process.env.FARMING_E2E_REMOTE_MAIN_WORKSPACE || '',
        recentWorkspaces: (process.env.FARMING_E2E_REMOTE_RECENT_WORKSPACES || '/home/farming-user/farming')
          .split(',')
          .map(item => item.trim())
          .filter(Boolean),
        internalWorkspace: process.env.FARMING_E2E_REMOTE_INTERNAL_WORKSPACE || '/home/farming-user/.farming',
        expectedDiscovered: process.env.FARMING_E2E_REMOTE_DISCOVERED_WORKSPACE || '/home/farming-user/example-project',
      });
    } else {
      throw new Error(`Unknown mode "${mode}". Use "local" or "remote".`);
    }

    log(`${mode} workspace E2E passed`);
  } finally {
    if (localServer) {
      await localServer.stop();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
