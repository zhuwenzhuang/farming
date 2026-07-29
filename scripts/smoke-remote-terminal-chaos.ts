#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { transformSync } from 'esbuild';

const REMOTE_URL = process.env.FARMING_REMOTE_URL || '';
const REMOTE_TOKEN = process.env.FARMING_REMOTE_TOKEN || '';
const RUN_ID = `${Date.now()}-${process.pid}`;
const ARTIFACT_DIR = path.resolve(process.env.FARMING_CHAOS_ARTIFACT_DIR || `.tmp/remote-terminal-chaos/${RUN_ID}`);
const ACTION_DELAY_MS = 35;
const BLANK_LIMIT_MS = 1500;

interface TraceEntry {
  at: number;
  viewer: string;
  action: string;
  socketId?: string;
  type?: string;
  agentId?: string;
  message?: string;
  viewport?: { width: number; height: number };
  sentInputs?: unknown;
  lastActivityBefore?: string;
  lastActivityAfter?: string;
  outputSeqBefore?: number;
  outputSeqAfter?: number;
  ackLines?: string[];
}

interface BlankEntry {
  label: string;
  since: number;
  state: TerminalState;
}

interface Observations {
  trace: TraceEntry[];
  samples: SampleEntry[];
  unexpectedErrors: string[];
  expectedNetworkErrors: string[];
  networkFaultActive: Set<string>;
  unexplainedBlanks: BlankEntry[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizedBaseUrl(): URL {
  assert(REMOTE_URL, 'FARMING_REMOTE_URL is required');
  assert(REMOTE_TOKEN, 'FARMING_REMOTE_TOKEN is required');
  const url = new URL(REMOTE_URL);
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

function apiUrl(baseUrl: URL, relativePath: string): URL {
  const url = new URL(relativePath.replace(/^\/+/, ''), baseUrl);
  url.searchParams.set('token', REMOTE_TOKEN);
  return url;
}

interface ApiOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

async function api(baseUrl: URL, relativePath: string, options: ApiOptions = {}): Promise<Record<string, unknown>> {
  const response = await fetch(apiUrl(baseUrl, relativePath), {
    method: options.method,
    body: options.body,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${relativePath} failed with HTTP ${response.status}`);
  }
  return body as Record<string, unknown>;
}

interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  message?: string;
}

async function waitFor<T>(predicate: () => Promise<T>, options: WaitOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs || 30_000;
  const intervalMs = options.intervalMs || 100;
  const startedAt = Date.now();
  let latest: T | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await predicate();
    if (latest) return latest;
    await delay(intervalMs);
  }
  throw new Error(options.message || `condition did not become true within ${timeoutMs}ms: ${JSON.stringify(latest)}`);
}

function tuiCommand(): string {
  const source = String.raw`
let frame = 0;
let drawing = false;
let pending = false;
let input = '';
const acknowledgements = [];
const rawChunks = [];
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', chunk => {
  rawChunks.push(Buffer.from(chunk).toString('hex'));
  process.stdout.write('\r\nRAW:' + rawChunks[rawChunks.length - 1] + '\r\n');
  input += chunk;
  for (;;) {
    const match = input.match(/^(.*?)[\r\n]/s);
    if (!match) break;
    input = input.slice(match[0].length);
    const line = match[1].replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
    acknowledgements.push(line);
    process.stdout.write('\r\nACK:' + line + '\r\n');
  }
});
function draw() {
  if (drawing) { pending = true; return; }
  drawing = true;
  frame += 1;
  const cols = Math.max(40, process.stdout.columns || 80);
  const filler = ('FRAME-' + frame + '-').padEnd(cols - 1, '.').slice(0, cols - 1);
  let output = '\x1b[?1049h\x1b[2J\x1b[H';
  while (output.length < 131072) output += filler + '\r\n';
  output += '\x1b[2J\x1b[HCHAOS_READY frame=' + frame + ' cols=' + cols + '\r\n';
  output += 'Resize redraw is complete. Input remains available.\r\n';
  for (const rawChunk of rawChunks) output += 'RAW:' + rawChunk + '\r\n';
  for (const acknowledgement of acknowledgements) output += 'ACK:' + acknowledgement + '\r\n';
  process.stdout.write(output, () => {
    drawing = false;
    if (pending) { pending = false; draw(); }
  });
}
process.on('SIGWINCH', draw);
draw();
setInterval(() => {}, 1 << 30);
  `;
  const minified = transformSync(source, { loader: 'js', minify: true }).code;
  const payload = zlib.gzipSync(minified, { level: 9 }).toString('base64');
  const command = `node -e "$(printf %s ${payload} | base64 -d | gzip -dc)"\r`;
  assert(Buffer.byteLength(command) < 900, 'remote chaos bootstrap exceeds a conservative TTY line limit');
  return command;
}

function foregroundPixelCount(buffer: Buffer): number {
  const png = PNG.sync.read(buffer);
  const corner = [png.data[0], png.data[1], png.data[2]];
  let foreground = 0;
  for (let index = 0; index < png.data.length; index += 16) {
    const distance = Math.abs(png.data[index] - corner[0])
      + Math.abs(png.data[index + 1] - corner[1])
      + Math.abs(png.data[index + 2] - corner[2]);
    if (distance > 36) foreground += 1;
  }
  return foreground;
}

async function preparePage(context: BrowserContext, baseUrl: URL, viewport: { width: number; height: number }, label: string, observations: Observations): Promise<Page> {
  const page = await context.newPage();
  let socketSequence = 0;
  page.on('websocket', socket => {
    const socketId = `${label}-${++socketSequence}`;
    observations.trace.push({ at: Date.now(), viewer: label, action: 'socket-open', socketId });
    socket.on('framesent', event => {
      try {
        const message = JSON.parse(String(event.payload));
        if (message.type === 'protocol-hello' || message.type === 'input') {
          observations.trace.push({
            at: Date.now(),
            viewer: label,
            action: 'socket-send',
            socketId,
            type: message.type,
            agentId: message.agentId || '',
          });
        }
      } catch {
        // Terminal input uses JSON in the product path; ignore unrelated frames.
      }
    });
    socket.on('framereceived', event => {
      try {
        const message = JSON.parse(String(event.payload));
        if (message.type === 'protocol-error' || message.type === 'error') {
          observations.trace.push({
            at: Date.now(),
            viewer: label,
            action: 'socket-error-message',
            socketId,
            type: message.type,
            message: message.message || '',
          });
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });
    socket.on('close', () => {
      observations.trace.push({ at: Date.now(), viewer: label, action: 'socket-close', socketId });
    });
  });
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__FARMING_E2E__ = true;
    (window as unknown as Record<string, unknown>).__farmingChaosResizeMessages = [];
    (window as unknown as Record<string, unknown>).__farmingChaosInputMessages = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(
      this: WebSocket,
      data: string | Blob | ArrayBuffer | ArrayBufferView,
    ): void {
      if (typeof data === 'string') {
        try {
          const message = JSON.parse(data);
          if (message.type === 'resize-agent') (window as unknown as Record<string, unknown[]>).__farmingChaosResizeMessages.push(message);
          if (message.type === 'input') (window as unknown as Record<string, unknown[]>).__farmingChaosInputMessages.push(message);
        } catch {
          // Ignore terminal input and non-JSON frames.
        }
      }
      send.call(this, data);
    };
  });
  page.on('pageerror', error => observations.unexpectedErrors.push(`${label}:pageerror:${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const record = `${label}:console:${message.text()}`;
    if (observations.networkFaultActive.has(label)) {
      observations.expectedNetworkErrors.push(record);
    } else {
      observations.unexpectedErrors.push(record);
    }
  });
  const authUrl = new URL(baseUrl.toString());
  authUrl.searchParams.set('token', REMOTE_TOKEN);
  await page.goto(authUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 });
  return page;
}

function visibleAgentRow(page: Page, agentId: string) {
  return page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"]:visible, `
      + `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"]:visible, `
      + `[data-testid="code-pinned-agent-compact"][data-agent-id="${agentId}"]:visible`,
  ).first();
}

async function ensureAgentVisible(page: Page, agentId: string) {
  const deadline = Date.now() + 15_000;
  const workspace = page.getByTestId('code-workspace');
  const project = page.getByTestId('code-project-group').filter({
    has: page.locator(`[data-agent-id="${agentId}"]`),
  }).first();

  while (Date.now() < deadline) {
    if ((await workspace.getAttribute('class'))?.includes('sidebar-collapsed')) {
      const mobileMenu = page.getByTestId('code-mobile-menu');
      const toggle = await mobileMenu.isVisible().catch(() => false)
        ? mobileMenu
        : page.getByTestId('code-sidebar-toggle');
      await toggle.click({ timeout: Math.min(2_000, deadline - Date.now()) }).catch(() => {});
    }

    let row = visibleAgentRow(page, agentId);
    if (await row.isVisible().catch(() => false)) return row;

    if (await project.isVisible().catch(() => false)) {
      const projectTitle = project.getByTestId('code-project-title');
      if (await projectTitle.getAttribute('aria-expanded') !== 'true') {
        await projectTitle.click({ timeout: Math.min(2_000, deadline - Date.now()) }).catch(() => {});
      }

      row = visibleAgentRow(page, agentId);
      if (await row.isVisible().catch(() => false)) return row;

      const visibility = project.getByTestId('code-project-agent-visibility');
      if (await visibility.count() && await visibility.getAttribute('aria-expanded') !== 'true') {
        await visibility.click({ timeout: Math.min(2_000, deadline - Date.now()) }).catch(() => {});
      }
    }
    await delay(50);
  }

  const diagnostic = await page.evaluate((id: string) => ({
    bodyClass: document.body.className,
    workspaceClass: document.querySelector('[data-testid="code-workspace"]')?.className || '',
    mobileMenuVisible: Boolean(document.querySelector('[data-testid="code-mobile-menu"]')?.getClientRects().length),
    sidebarVisible: Boolean(document.querySelector('[data-testid="code-sidebar"]')?.getClientRects().length),
    projectCount: document.querySelectorAll('[data-testid="code-project-group"]').length,
    agentRowCount: document.querySelectorAll(`[data-agent-id="${id}"]`).length,
    visibleAgentRowCount: [...document.querySelectorAll(`[data-agent-id="${id}"]`)]
      .filter(element => element.getClientRects().length > 0).length,
  }), agentId);
  throw new Error(`Agent ${agentId} did not become visible: ${JSON.stringify(diagnostic)}`);
}

async function clickAgentWithoutReady(page: Page, agentId: string, trace: TraceEntry[], viewer: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const row = await ensureAgentVisible(page, agentId);
      await row.click({ timeout: Math.min(2_000, deadline - Date.now()) });
      trace.push({ at: Date.now(), viewer, action: 'click', agentId });
      return;
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError || new Error(`Agent ${agentId} did not remain clickable`);
}

async function rapidSwitch(page: Page, agentIds: string[], count: number, trace: TraceEntry[], viewer: string): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await clickAgentWithoutReady(page, agentIds[index % agentIds.length], trace, viewer);
    await delay(ACTION_DELAY_MS);
  }
}

interface TerminalState {
  agentId: string;
  paneVisible: boolean;
  nonblankRows: number;
  recoveryVisible: boolean;
  failureVisible: boolean;
  diagnostics: {
    renderer: string;
    queuedTransitions: number;
    replayInProgress: boolean;
    checkpointRequestInFlight: boolean;
    needsReconnectOutputSync: boolean;
    outputSeq: number;
    stateRevision: number;
  } | null;
  foregroundPixels: number;
}

type SampleEntry = {
  at: number;
  label: string;
  sampleError: string;
} | ({
  at: number;
  label: string;
} & TerminalState);

async function terminalSnapshot(page: Page, label: string, artifactName = ''): Promise<TerminalState> {
  const state = await page.evaluate(() => {
    const activePane = document.querySelector('[data-testid="code-terminal-pane"].active');
    const agentId = activePane?.getAttribute('data-agent-id') || '';
    const testHost = (window as unknown as Record<string, unknown>).__farmingTerminalTest as {
      getBufferDiagnostics?: (id: string) => {
        renderer: string;
        queuedTransitions: number;
        replayInProgress: boolean;
        checkpointRequestInFlight: boolean;
        needsReconnectOutputSync: boolean;
        lastOutputSeq: number;
        stateRevision: number;
      };
      getRows?: (id: string, limit: number) => string[];
    } | undefined;
    const diagnostics = agentId && testHost?.getBufferDiagnostics ? testHost.getBufferDiagnostics(agentId) : null;
    const rows = agentId && testHost?.getRows ? testHost.getRows(agentId, 500) ?? [] : [];
    const recovery = document.querySelector('[data-testid="code-terminal-recovery"]');
    const failure = activePane?.querySelector('.terminal-error, [data-testid="terminal-error"]');
    return {
      agentId,
      paneVisible: Boolean(activePane && activePane.getClientRects().length > 0),
      nonblankRows: rows.filter(row => row.trim()).length,
      recoveryVisible: Boolean(recovery && recovery.getClientRects().length > 0),
      failureVisible: Boolean(failure && failure.getClientRects().length > 0),
      diagnostics: diagnostics ? {
        renderer: diagnostics.renderer,
        queuedTransitions: diagnostics.queuedTransitions,
        replayInProgress: diagnostics.replayInProgress,
        checkpointRequestInFlight: diagnostics.checkpointRequestInFlight,
        needsReconnectOutputSync: diagnostics.needsReconnectOutputSync,
        outputSeq: diagnostics.lastOutputSeq,
        stateRevision: diagnostics.stateRevision,
      } : null,
    };
  });
  const pane = page.locator('[data-testid="code-terminal-pane"].active');
  let foregroundPixels = 0;
  if (await pane.count()) {
    const screenshot = await pane.screenshot({ timeout: 5_000 });
    foregroundPixels = foregroundPixelCount(screenshot);
    if (artifactName) fs.writeFileSync(path.join(ARTIFACT_DIR, `${artifactName}-${label}.png`), screenshot);
  }
  return { ...state, foregroundPixels };
}

async function startBlankMonitor(pages: [string, Page][], observations: Observations): Promise<() => Promise<void>> {
  let stopped = false;
  const blankSince = new Map<string, number>();
  const promise = (async () => {
    while (!stopped) {
      for (const [label, page] of pages) {
        let state: TerminalState;
        try {
          state = await terminalSnapshot(page, label);
        } catch (error) {
          observations.samples.push({ at: Date.now(), label, sampleError: (error as Error).message });
          continue;
        }
        observations.samples.push({ at: Date.now(), label, ...state });
        const explained = state.recoveryVisible || state.failureVisible;
        const blank = state.paneVisible && state.nonblankRows === 0 && !explained;
        if (!blank) {
          blankSince.delete(label);
        } else if (!blankSince.has(label)) {
          blankSince.set(label, Date.now());
        } else if (Date.now() - blankSince.get(label)! > BLANK_LIMIT_MS) {
          observations.unexplainedBlanks.push({ label, since: blankSince.get(label)!, state });
          await terminalSnapshot(page, label, `unexplained-blank-${Date.now()}`).catch(() => null);
          blankSince.set(label, Date.now());
        }
      }
      await delay(200);
    }
  })();
  return async () => {
    stopped = true;
    await promise;
  };
}

async function waitForSettledTerminal(page: Page, agentId: string): Promise<void> {
  await waitFor(async () => page.evaluate((id: string) => {
    const activePane = document.querySelector(`[data-testid="code-terminal-pane"][data-agent-id="${CSS.escape(id)}"].active`);
    const testHost = (window as unknown as Record<string, unknown>).__farmingTerminalTest as {
      getBufferDiagnostics?: (id: string) => {
        renderer: string;
        queuedTransitions: number;
        replayInProgress: boolean;
        checkpointRequestInFlight: boolean;
        needsReconnectOutputSync: boolean;
      };
      getRows?: (id: string, limit: number) => string[];
    } | undefined;
    const diagnostics = testHost?.getBufferDiagnostics?.(id);
    const rows = testHost?.getRows?.(id, 500) ?? [];
    const recovery = document.querySelector('[data-testid="code-terminal-recovery"]');
    return Boolean(
      activePane
      && activePane.getClientRects().length > 0
      && (!recovery || recovery.getClientRects().length === 0)
      && diagnostics?.renderer === 'webgl'
      && diagnostics.queuedTransitions === 0
      && diagnostics.replayInProgress === false
      && diagnostics.checkpointRequestInFlight === false
      && diagnostics.needsReconnectOutputSync === false
      && rows.some(row => row.includes('CHAOS_READY')),
    );
  }, agentId), {
    timeoutMs: 30_000,
    message: `terminal ${agentId} did not settle after network chaos`,
  });
}

async function sendTerminalLine(page: Page, agentId: string, marker: string, trace: TraceEntry[], viewer: string): Promise<void> {
  let input = page.getByTestId('code-composer-input');
  if (!await input.isVisible().catch(() => false)) {
    const restore = page.getByTestId('code-composer-restore');
    await restore.waitFor({ state: 'visible', timeout: 10_000 });
    await restore.click();
    input = page.getByTestId('code-composer-input');
    await input.waitFor({ state: 'visible', timeout: 10_000 });
  }
  await input.fill(marker);
  await input.press('Enter');
  const sentInputs = await page.evaluate(() => ((window as unknown as Record<string, unknown[]>).__farmingChaosInputMessages || []).slice(-3));
  trace.push({ at: Date.now(), viewer, action: 'input', agentId, sentInputs });
}

async function waitForAcknowledgement(baseUrl: URL, agentId: string, marker: string, viewer: string): Promise<void> {
  await waitFor(async () => {
    const body = await api(baseUrl, `api/agents/${agentId}/session-view`);
    const session = body?.session as { renderOutput?: string } | undefined;
    const output = session?.renderOutput || '';
    return output.split(`ACK:${marker}`).length - 1 === 1;
  }, { timeoutMs: 15_000, message: `${viewer} post-recovery composer input was lost or duplicated` });
}

async function main(): Promise<void> {
  const baseUrl = normalizedBaseUrl();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const observations: Observations = {
    trace: [],
    samples: [],
    unexpectedErrors: [],
    expectedNetworkErrors: [],
    networkFaultActive: new Set(),
    unexplainedBlanks: [],
  };
  const agentIds: string[] = [];
  let browser: Browser | undefined;
  let stopMonitor: () => Promise<void> = async () => {};
  try {
    for (let index = 0; index < 2; index += 1) {
      const created = await api(baseUrl, 'api/control/agents', {
        method: 'POST',
        body: JSON.stringify({ command: 'bash', workspace: '/tmp' }),
      });
      assert(created?.agentId, 'remote control API did not return an agent id');
      agentIds.push(created.agentId as string);
    }
    const [targetAgentId, alternateAgentId] = agentIds;
    await api(baseUrl, `api/control/agents/${targetAgentId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: tuiCommand() }),
    });
    await waitFor(async () => {
      const body = await api(baseUrl, `api/agents/${targetAgentId}/session-view`).catch(() => null);
      const session = body?.session as { renderOutput?: string } | undefined;
      return session?.renderOutput?.includes('CHAOS_READY');
    }, { timeoutMs: 30_000, message: 'remote resize-redraw TUI did not start' });

    browser = await chromium.launch({ headless: true });
    const desktopContext = await browser.newContext();
    const mobileContext = await browser.newContext({
      viewport: { width: 430, height: 900 },
      hasTouch: true,
      isMobile: true,
    });
    const desktop = await preparePage(
      desktopContext,
      baseUrl,
      { width: 1280, height: 720 },
      'desktop',
      observations,
    );
    const mobile = await preparePage(
      mobileContext,
      baseUrl,
      { width: 430, height: 900 },
      'mobile',
      observations,
    );
    const pages: [string, Page][] = [['desktop', desktop], ['mobile', mobile]];

    await Promise.all(pages.map(async ([label, page]) => {
      await clickAgentWithoutReady(page, targetAgentId, observations.trace, label);
    }));
    stopMonitor = await startBlankMonitor(pages, observations);

    await Promise.all([
      rapidSwitch(desktop, [alternateAgentId, targetAgentId], 18, observations.trace, 'desktop'),
      rapidSwitch(mobile, [targetAgentId, alternateAgentId, targetAgentId], 18, observations.trace, 'mobile'),
    ]);

    const desktopCdp = await desktopContext.newCDPSession(desktop);
    await desktopCdp.send('Network.enable');
    await desktopCdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 800,
      downloadThroughput: 16 * 1024,
      uploadThroughput: 8 * 1024,
      connectionType: 'cellular3g',
    });
    observations.networkFaultActive.add('desktop');
    observations.trace.push({ at: Date.now(), viewer: 'desktop', action: 'network-slow' });

    for (const viewport of [
      { width: 1000, height: 680 },
      { width: 1480, height: 900 },
      { width: 920, height: 640 },
      { width: 1360, height: 820 },
    ]) {
      await desktop.setViewportSize(viewport);
      observations.trace.push({ at: Date.now(), viewer: 'desktop', action: 'viewport', viewport });
      await clickAgentWithoutReady(desktop, targetAgentId, observations.trace, 'desktop');
      await delay(ACTION_DELAY_MS);
    }

    await desktopContext.setOffline(true);
    observations.trace.push({ at: Date.now(), viewer: 'desktop', action: 'offline' });
    await Promise.all([
      rapidSwitch(desktop, [alternateAgentId, targetAgentId], 12, observations.trace, 'desktop'),
      rapidSwitch(mobile, [alternateAgentId, targetAgentId], 12, observations.trace, 'mobile'),
    ]);
    await delay(900);
    await desktopContext.setOffline(false);
    observations.trace.push({ at: Date.now(), viewer: 'desktop', action: 'online' });
    await desktopCdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: 'none',
    });
    observations.networkFaultActive.delete('desktop');

    await desktop.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    observations.trace.push({ at: Date.now(), viewer: 'desktop', action: 'reload' });
    await Promise.all([
      rapidSwitch(desktop, [targetAgentId, alternateAgentId, targetAgentId], 15, observations.trace, 'desktop'),
      rapidSwitch(mobile, [alternateAgentId, targetAgentId], 15, observations.trace, 'mobile'),
    ]);

    await Promise.all(pages.map(([label, page]) => (
      clickAgentWithoutReady(page, targetAgentId, observations.trace, label)
    )));
    await Promise.all(pages.map(([, page]) => waitForSettledTerminal(page, targetAgentId)));
    await stopMonitor();
    stopMonitor = async () => {};

    const finalSnapshots: Record<string, TerminalState> = {};
    for (const [label, page] of pages) {
      finalSnapshots[label] = await terminalSnapshot(page, label, 'final');
      assert(finalSnapshots[label].nonblankRows > 0, `${label} terminal settled blank`);
      assert(finalSnapshots[label].foregroundPixels > 100, `${label} terminal screenshot has no visible ink`);
    }

    const markers = [`CHAOS_DESKTOP_${RUN_ID}`, `CHAOS_MOBILE_${RUN_ID}`];
    const beforeDesktopInput = await api(baseUrl, `api/agents/${targetAgentId}/session-view`);
    await sendTerminalLine(desktop, targetAgentId, markers[0], observations.trace, 'desktop');
    await delay(500);
    const afterDesktopInput = await api(baseUrl, `api/agents/${targetAgentId}/session-view`);
    const beforeSession = beforeDesktopInput.session as { lastActivity?: string; outputSeq?: number } | undefined;
    const afterSession = afterDesktopInput.session as { lastActivity?: string; outputSeq?: number; renderOutput?: string } | undefined;
    observations.trace.push({
      at: Date.now(),
      viewer: 'desktop',
      action: 'input-boundary',
      lastActivityBefore: beforeSession?.lastActivity,
      lastActivityAfter: afterSession?.lastActivity,
      outputSeqBefore: beforeSession?.outputSeq,
      outputSeqAfter: afterSession?.outputSeq,
      ackLines: String(afterSession?.renderOutput || '')
        .split(/\r?\n/)
        .filter(line => line.includes('ACK:'))
        .slice(-5),
    });
    await waitForAcknowledgement(baseUrl, targetAgentId, markers[0], 'desktop');
    await sendTerminalLine(mobile, targetAgentId, markers[1], observations.trace, 'mobile');
    await waitForAcknowledgement(baseUrl, targetAgentId, markers[1], 'mobile');

    const beforeStable = await api(baseUrl, `api/agents/${targetAgentId}/session-view`);
    await delay(1500);
    const afterStable = await api(baseUrl, `api/agents/${targetAgentId}/session-view`);
    const beforeStableSession = beforeStable.session as { outputSeq?: number; stateRevision?: number };
    const afterStableSession = afterStable.session as { outputSeq?: number; stateRevision?: number };
    assert(
      beforeStableSession.outputSeq === afterStableSession.outputSeq
        && beforeStableSession.stateRevision === afterStableSession.stateRevision,
      'terminal state continued changing after the chaos run settled',
    );
    assert(observations.unexplainedBlanks.length === 0, 'an unexplained blank terminal persisted beyond the limit');
    assert(
      observations.unexpectedErrors.length === 0,
      `unexpected browser errors occurred: ${observations.unexpectedErrors.join(' | ')}`,
    );

    const result = {
      ok: true,
      runId: RUN_ID,
      agentsCreated: agentIds.length,
      actions: observations.trace.length,
      samples: observations.samples.length,
      expectedNetworkErrors: observations.expectedNetworkErrors.length,
      unexplainedBlanks: observations.unexplainedBlanks.length,
      finalSnapshots,
      finalRevision: afterStableSession.stateRevision,
      artifactDir: ARTIFACT_DIR,
    };
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'trace.json'), JSON.stringify({
      ...observations,
      networkFaultActive: [...observations.networkFaultActive],
    }, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const err = error as Error;
    const failedAgentId = agentIds[0];
    const failureViewBeforeControl = failedAgentId
      ? await api(baseUrl, `api/agents/${failedAgentId}/session-view`).catch(() => null)
      : null;
    const controlMarker = `CHAOS_CONTROL_${RUN_ID}`;
    let controlInputAccepted = false;
    if (failedAgentId) {
      controlInputAccepted = Boolean(await api(baseUrl, `api/control/agents/${failedAgentId}/input`, {
        method: 'POST',
        body: JSON.stringify({ input: `${controlMarker}\r` }),
      }).catch(() => null));
      await delay(1000);
    }
    const failureView = failedAgentId
      ? await api(baseUrl, `api/agents/${failedAgentId}/session-view`).catch(() => null)
      : null;
    const failureViewSession = failureView?.session as { renderOutput?: string; lastActivity?: string; outputSeq?: number; stateRevision?: number } | undefined;
    const failureViewBeforeSession = (failureViewBeforeControl as { session?: { lastActivity?: string } } | null)?.session;
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'trace.json'), JSON.stringify({
      ...observations,
      networkFaultActive: [...observations.networkFaultActive],
      failureView: failureView ? {
        controlInputAccepted,
        controlMarkerVisible: String(failureViewSession?.renderOutput || '').includes(controlMarker),
        lastActivityBeforeControl: failureViewBeforeSession?.lastActivity,
        lastActivityAfterControl: failureViewSession?.lastActivity,
        outputSeq: failureViewSession?.outputSeq,
        stateRevision: failureViewSession?.stateRevision,
        renderOutputTail: String(failureViewSession?.renderOutput || '').slice(-4000),
      } : null,
      failure: err.stack || err.message || String(error),
    }, null, 2));
    throw error;
  } finally {
    await stopMonitor().catch(() => null);
    if (browser) await browser.close().catch(() => null);
    await Promise.all(agentIds.map(agentId => api(baseUrl, `api/control/agents/${agentId}`, {
      method: 'DELETE',
    }).catch(() => null)));
  }
}

main().catch(error => {
  console.error((error as Error).stack || (error as Error).message || String(error));
  process.exit(1);
});
