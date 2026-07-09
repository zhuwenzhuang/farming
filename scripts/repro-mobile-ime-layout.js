#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const DEFAULT_URL = 'http://localhost:6694/farming/';
const DEFAULT_USER_AGENT = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)',
  'AppleWebKit/605.1.15 (KHTML, like Gecko)',
  'Version/17.5 Mobile/15E148 Safari/604.1',
].join(' ');

const PROFILES = [
  {
    name: 'compact-iphone',
    width: 393,
    layoutHeight: 660,
    keyboardHeight: 420,
  },
  {
    name: 'tall-iphone',
    width: 393,
    layoutHeight: 852,
    keyboardHeight: 466,
  },
];

function usage() {
  console.log([
    'Usage: node scripts/repro-mobile-ime-layout.js [farming-url]',
    '',
    'Defaults to http://localhost:6694/farming/.',
    'Set FARMING_REPRO_URL or pass a URL with token for a remote service.',
    'Set FARMING_REPRO_OUT_DIR to control where screenshots and metrics are written.',
  ].join('\n'));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTarget(rawUrl) {
  const url = new URL(rawUrl || DEFAULT_URL);
  const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const basePath = pathname === '' ? '' : pathname;
  return {
    url,
    basePath,
    api(pathnameSuffix) {
      const apiUrl = new URL(`${basePath}${pathnameSuffix}`, url.origin);
      apiUrl.search = url.search;
      return apiUrl.toString();
    },
  };
}

function redactUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.searchParams.has('token')) {
    url.searchParams.set('token', 'redacted');
  }
  return url.toString().replace('token=redacted', 'token=<redacted>');
}

async function installMobileViewportMock(page, profile) {
  await page.addInitScript(({ width, height }) => {
    window.__FARMING_E2E__ = true;
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    const eventTarget = document.createElement('span');
    const state = {
      width,
      height,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
    };
    const viewport = {
      get width() { return state.width; },
      get height() { return state.height; },
      get offsetTop() { return state.offsetTop; },
      get offsetLeft() { return state.offsetLeft; },
      get pageTop() { return state.pageTop; },
      get pageLeft() { return state.pageLeft; },
      get scale() { return state.scale; },
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    };
    Object.defineProperty(window, 'visualViewport', {
      value: viewport,
      configurable: true,
    });
    window.__farmingImeReproSetVisualViewport = (next, eventNames = ['resize', 'scroll']) => {
      Object.assign(state, next || {});
      for (const eventName of eventNames) {
        eventTarget.dispatchEvent(new Event(eventName));
      }
      window.dispatchEvent(new Event('resize'));
      return { ...state };
    };
  }, { width: profile.width, height: profile.layoutHeight });
}

async function createControlAgent(page, target, workspace) {
  const response = await page.request.post(target.api('/api/control/agents'), {
    data: { command: 'bash', workspace },
  });
  if (!response.ok()) {
    throw new Error(`Failed to create bash agent: ${response.status()} ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.agentId) {
    throw new Error('Control API did not return agentId');
  }
  return data.agentId;
}

async function deleteControlAgent(page, target, agentId) {
  if (!agentId) return;
  await page.request.delete(target.api(`/api/control/agents/${encodeURIComponent(agentId)}`)).catch(() => null);
}

async function revealAgent(page, agentId) {
  const escapedAgentId = JSON.stringify(agentId).slice(1, -1).replace(/"/g, '\\"');
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${escapedAgentId}"]`);
  if (await row.count() === 0 || !(await row.first().isVisible().catch(() => false))) {
    const mobileMenu = page.getByTestId('code-mobile-menu');
    if (await mobileMenu.isVisible().catch(() => false)) {
      await mobileMenu.click();
    }
  }
  await row.first().waitFor({ state: 'visible', timeout: 30_000 });
  await row.first().click();
  const backdrop = page.getByTestId('code-mobile-sidebar-backdrop');
  if (await backdrop.isVisible().catch(() => false)) {
    await backdrop.click();
  }
  const pane = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${escapedAgentId}"]`);
  await pane.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction((id) => {
    return Boolean(window.__farmingTerminalTest?.isReady?.(id));
  }, agentId, { timeout: 30_000 });
}

async function writeTerminalFixture(page, agentId) {
  const lines = [
    '$ mobile IME layout repro',
    ...Array.from({ length: 36 }, (_, index) => `mobile-ime-repro-line-${String(index + 1).padStart(2, '0')}`),
    'MOBILE_IME_BOTTOM_PROMPT $ ',
  ];
  await page.evaluate(async ({ id, text }) => {
    await window.__farmingTerminalTest?.writeFixture?.(id, text);
  }, { id: agentId, text: `${lines.join('\r\n')}\r\n` });
}

async function sampleLayout(page, agentId, label) {
  return page.evaluate(({ id, sampleLabel }) => {
    const rectFor = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
      };
    };
    const composer = document.querySelector('[data-testid="code-composer"]');
    const textarea = document.querySelector('[data-testid="code-composer"] textarea');
    const pane = document.querySelector(`[data-testid="code-terminal-pane"][data-agent-id="${CSS.escape(id)}"]`);
    const terminalContainer = pane?.querySelector('[data-testid="code-terminal-container"]') || null;
    const xterm = pane?.querySelector('.xterm') || null;
    const cursor = pane?.querySelector('.xterm-cursor') || null;
    const rowSamples = Array.from(pane?.querySelectorAll('.xterm-rows > div') || []).map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        text: row.textContent || '',
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
      };
    });
    const composerRect = rectFor(composer);
    const paneRect = rectFor(pane);
    const terminalRect = rectFor(terminalContainer);
    const visualHeight = window.visualViewport?.height ?? window.innerHeight;
    const visualBottom = (window.visualViewport?.offsetTop ?? 0) + visualHeight;
    const composerBackground = composer ? getComputedStyle(composer).backgroundColor : '';
    const alphaMatch = /^rgba?\(([^)]+)\)$/.exec(composerBackground || '');
    const alphaParts = alphaMatch ? alphaMatch[1].split(',').map(part => Number.parseFloat(part.trim())) : [];
    const composerAlpha = alphaParts.length >= 4 && !Number.isNaN(alphaParts[3]) ? alphaParts[3] : 1;
    const rowsBehindComposer = composerRect
      ? rowSamples.filter(row => row.bottom > composerRect.top && row.top < composerRect.bottom)
      : [];
    const promptRowsBehindComposer = rowsBehindComposer.filter(row => row.text.includes('MOBILE_IME_BOTTOM_PROMPT') || /\$\s*$/.test(row.text));
    return {
      label: sampleLabel,
      bodyClasses: document.body.className,
      activeInComposer: Boolean(document.activeElement?.closest?.('.code-composer')),
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      visualViewport: {
        width: Math.round(window.visualViewport?.width ?? window.innerWidth),
        height: Math.round(visualHeight),
        offsetTop: Math.round(window.visualViewport?.offsetTop ?? 0),
        offsetLeft: Math.round(window.visualViewport?.offsetLeft ?? 0),
      },
      cssVars: {
        appVisualHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-visual-height').trim(),
        mobileKeyboardOffset: getComputedStyle(document.documentElement).getPropertyValue('--mobile-keyboard-offset').trim(),
      },
      composer: {
        rect: composerRect,
        background: composerBackground,
        alpha: composerAlpha,
        borderColor: composer ? getComputedStyle(composer).borderColor : '',
      },
      textarea: rectFor(textarea),
      terminalPane: paneRect,
      terminalContainer: terminalRect,
      xterm: rectFor(xterm),
      cursor: cursor ? {
        rect: rectFor(cursor),
        opacity: getComputedStyle(cursor).opacity,
        borderColor: getComputedStyle(cursor).borderColor,
        outlineColor: getComputedStyle(cursor).outlineColor,
      } : null,
      rowsBehindComposer: rowsBehindComposer.slice(-6),
      rowsBehindComposerCount: rowsBehindComposer.length,
      promptRowsBehindComposerCount: promptRowsBehindComposer.length,
      terminalOverlapsComposer: Boolean(paneRect && composerRect && paneRect.bottom > composerRect.top),
      composerBottomBeyondVisualViewport: composerRect ? Math.round(composerRect.bottom - visualBottom) : null,
      composerLeakRisk: Boolean(paneRect && composerRect && paneRect.bottom > composerRect.top && composerAlpha < 0.98),
    };
  }, { id: agentId, sampleLabel: label });
}

async function runProfile(browser, target, outputDir, profile) {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.layoutHeight },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    userAgent: DEFAULT_USER_AGENT,
  });
  const page = await context.newPage();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `farming-ime-${profile.name}-`));
  let agentId = '';
  const samples = [];
  const screenshots = [];

  try {
    await installMobileViewportMock(page, profile);
    await page.goto(target.url.toString(), { waitUntil: 'networkidle', timeout: 45_000 });
    try {
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 });
    } catch (error) {
      const timeoutScreenshot = path.join(outputDir, `${profile.name}-app-shell-timeout.png`);
      await page.screenshot({ path: timeoutScreenshot, fullPage: false }).catch(() => null);
      const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
      throw new Error([
        `Farming app shell did not load for ${redactUrl(target.url.toString())}.`,
        'If auth is enabled, pass a URL with ?token=... or set FARMING_REPRO_URL.',
        `Saved timeout screenshot: ${timeoutScreenshot}`,
        `Page text: ${bodyText.slice(0, 500)}`,
        `Original error: ${error.message || String(error)}`,
      ].join('\n'), { cause: error });
    }
    agentId = await createControlAgent(page, target, workspace);
    await revealAgent(page, agentId);
    await writeTerminalFixture(page, agentId);
    await delay(250);

    const textarea = page.getByTestId('code-composer').locator('textarea');
    await textarea.focus();
    await textarea.fill('mobile ime repro');
    await delay(250);
    samples.push(await sampleLayout(page, agentId, 'focused-before-keyboard'));

    await page.evaluate((height) => {
      window.__farmingImeReproSetVisualViewport?.({ height, offsetTop: 0, offsetLeft: 0 });
    }, profile.keyboardHeight);
    await delay(300);
    samples.push(await sampleLayout(page, agentId, 'keyboard-open'));
    const keyboardOpenScreenshot = `${profile.name}-keyboard-open.png`;
    await page.screenshot({
      path: path.join(outputDir, keyboardOpenScreenshot),
      fullPage: false,
    });
    screenshots.push(keyboardOpenScreenshot);

    await page.evaluate((height) => {
      window.__farmingImeReproSetVisualViewport?.({ height, offsetTop: 0, offsetLeft: 0 });
    }, profile.layoutHeight);
    await delay(300);
    samples.push(await sampleLayout(page, agentId, 'keyboard-closed'));
    const keyboardClosedScreenshot = `${profile.name}-keyboard-closed.png`;
    await page.screenshot({
      path: path.join(outputDir, keyboardClosedScreenshot),
      fullPage: false,
    });
    screenshots.push(keyboardClosedScreenshot);

    return {
      profile,
      workspace,
      agentId,
      samples,
      screenshots,
      reproduced: samples.some(sample => sample.composerLeakRisk || (sample.composerBottomBeyondVisualViewport ?? 0) > 0),
    };
  } finally {
    await deleteControlAgent(page, target, agentId);
    await context.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  const rawUrl = process.argv[2] || process.env.FARMING_REPRO_URL || DEFAULT_URL;
  const outputDir = process.env.FARMING_REPRO_OUT_DIR
    || fs.mkdtempSync(path.join(os.tmpdir(), 'farming-mobile-ime-repro-'));
  fs.mkdirSync(outputDir, { recursive: true });
  const target = parseTarget(rawUrl);
  const browser = await chromium.launch({
    headless: process.env.FARMING_REPRO_HEADFUL === '1' ? false : true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--proxy-server=direct://',
      '--proxy-bypass-list=*',
    ],
  });

  try {
    const runs = [];
    for (const profile of PROFILES) {
      runs.push(await runProfile(browser, target, outputDir, profile));
    }
    const report = {
      ok: true,
      target: redactUrl(target.url.toString()),
      outputDir,
      runs,
    };
    report.screenshotFiles = runs.flatMap(run => run.screenshots);
    fs.writeFileSync(path.join(outputDir, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
