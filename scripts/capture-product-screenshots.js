#!/usr/bin/env node
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '..');
const demoRoot = path.join(os.tmpdir(), 'farming-product-demo');
const workspaceDir = path.resolve(process.env.FARMING_SCREENSHOT_WORKSPACE || repoRoot);
const configDir = path.join(demoRoot, 'config');
const homeDir = path.join(demoRoot, 'home');
const screenshotDir = path.join(repoRoot, 'docs', 'products', 'code', 'assets');
const basePath = '/farming';
const localChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.FARMING_PLAYWRIGHT_CHROME_PATH
  || (fs.existsSync(localChromePath) ? localChromePath : undefined);

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    stdio: options.stdio || 'ignore',
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (!port) reject(new Error('failed to allocate a port'));
        else resolve(port);
      });
    });
  });
}

async function waitForServer(url, timeoutMs = 45_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`server did not become ready at ${url}: ${lastError?.message || 'timeout'}`);
}

function prepareRuntimeDirectories() {
  fs.rmSync(demoRoot, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(screenshotDir, { recursive: true });
  for (const entry of fs.readdirSync(screenshotDir)) {
    if (/^\d{2}-.*\.(?:png|jpg|jpeg)$/i.test(entry)) {
      fs.rmSync(path.join(screenshotDir, entry), { force: true });
    }
  }
}

async function ensureApp(page) {
  await page.goto(`${basePath}/`, { waitUntil: 'networkidle' });
  await page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.addStyleTag({
    content: `
      [data-testid="codex-usage-panel"] {
        display: none !important;
      }
    `,
  });
}

async function setDemoSettings(page, baseUrl) {
  await page.request.post(`${baseUrl}${basePath}/api/settings`, {
    data: {
      lastMainWorkspace: workspaceDir,
      workspaceHistory: [workspaceDir],
      appearance: 'light',
      language: 'en',
      defaultLaunchAgent: 'bash',
      codexApprovalMode: 'approve',
      codexModel: 'gpt-5.5',
      codexReasoningEffort: 'xhigh',
      codexServiceTier: 'default',
      codexModelPreset: 'gpt-5.5:xhigh',
      agentLaunchProfiles: {
        codex: {
          approvalMode: 'approve',
          model: 'gpt-5.5',
          reasoningEffort: 'xhigh',
          serviceTier: 'default',
          modelPreset: 'gpt-5.5:xhigh',
        },
        claude: {
          permissionMode: 'default',
          model: 'config',
          effort: 'config',
        },
      },
    },
  });
}

async function startDemoAgent(page, baseUrl) {
  return startAgent(page, baseUrl, {
    command: 'bash',
    workspace: workspaceDir,
    task: '',
  });
}

async function startAgent(page, baseUrl, options) {
  const response = await page.request.post(`${baseUrl}${basePath}/api/control/agents`, {
    data: options,
  });
  if (!response.ok()) {
    throw new Error(`failed to start demo agent: ${response.status()} ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.agentId) throw new Error('demo agent response did not include agentId');
  return data.agentId;
}

async function updateAgent(page, baseUrl, agentId, patch) {
  const response = await page.request.patch(`${baseUrl}${basePath}/api/agents/${encodeURIComponent(agentId)}`, {
    data: patch,
  });
  if (!response.ok()) {
    throw new Error(`failed to update agent ${agentId}: ${response.status()} ${await response.text()}`);
  }
  return response.json();
}

async function writeTerminalFixture(page, agentId, text) {
  await page.waitForFunction(
    id => Boolean(window.__farmingTerminalTest?.getCellCenter(id, 0, 0)),
    agentId,
    { timeout: 20_000 },
  );
  await page.evaluate(
    async ({ id, fixture }) => {
      await window.__farmingTerminalTest?.writeFixture(id, fixture);
    },
    { id: agentId, fixture: text },
  );
}

async function openSidebarOnMobile(page) {
  const workspace = page.getByTestId('codex-workspace');
  const className = await workspace.getAttribute('class');
  if (className?.includes('sidebar-collapsed')) {
    await page.getByTestId('codex-mobile-menu').click();
  }
  await page.getByTestId('codex-sidebar').waitFor({ state: 'visible', timeout: 10_000 });
}

async function openAgent(page, agentId) {
  const terminal = page.locator(`[data-testid="codex-terminal-pane"][data-agent-id="${agentId}"]`);
  if (await terminal.isVisible()) return;

  const row = page.locator(`[data-testid="codex-agent-row"][data-agent-id="${agentId}"]`).first();
  if (!(await row.isVisible())) {
    await openSidebarOnMobile(page);
  }
  await row.evaluate(element => element.click());
  await terminal.waitFor({ state: 'visible', timeout: 20_000 });
}

async function openFile(page, query) {
  const filesSection = page.getByTestId('codex-files-section').first();
  await filesSection.waitFor({ state: 'visible', timeout: 20_000 });
  const filesToggle = filesSection.getByRole('button', { name: /^Files$/ });
  if (await filesToggle.isVisible()) {
    const expanded = await filesToggle.getAttribute('aria-expanded');
    if (expanded === 'false') await filesToggle.click();
  }
  const searchInput = filesSection.getByPlaceholder('Search or path:line');
  await searchInput.fill(query);
  await searchInput.press('Enter');
  await waitForEditorReady(page);
}

async function waitForFileTree(page) {
  const filesSection = page.getByTestId('codex-files-section').first();
  await filesSection.waitFor({ state: 'visible', timeout: 20_000 });
  const filesToggle = filesSection.getByRole('button', { name: /^Files$/ });
  if (await filesToggle.isVisible()) {
    const expanded = await filesToggle.getAttribute('aria-expanded');
    if (expanded === 'false') await filesToggle.click();
  }
  await page.locator('.codex-file-tree-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

async function waitForEditorReady(page, expectedText = '') {
  await page.getByTestId('codex-file-editor').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('.monaco-editor .view-line').first().waitFor({ state: 'visible', timeout: 20_000 });
  if (expectedText) {
    await page.locator('.monaco-editor .view-line', { hasText: expectedText }).first().waitFor({ state: 'visible', timeout: 20_000 });
  }
  try {
    await page.waitForFunction(() => {
      const editor = document.querySelector('.monaco-editor');
      if (!editor) return false;
      return editor.querySelectorAll('.view-line .mtk1, .view-line [class*="mtk"]').length >= 8;
    }, null, { timeout: 5000 });
  } catch {
    // Monaco token class names vary by version; the fixed delay below is the important part for screenshots.
  }
  await page.waitForTimeout(4000);
}

async function waitForStableUi(page, delayMs = 500) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (delayMs > 0) await page.waitForTimeout(delayMs);
}

async function screenshot(page, fileName) {
  await waitForStableUi(page, 250);
  await page.screenshot({
    path: path.join(screenshotDir, fileName),
    fullPage: false,
  });
}

async function showBlameFromEditorGutter(page) {
  const gutterLine = page.locator('.monaco-editor .margin-view-overlays .line-numbers').first();
  await gutterLine.waitFor({ state: 'visible', timeout: 20_000 });
  await gutterLine.click({ button: 'right', force: true });
  await page.getByRole('menuitem', { name: 'Annotate with Blame' }).click();
}

async function openNewAgentDialog(page) {
  await page.getByTestId('codex-new-agent').click();
  await page.getByTestId('input-dialog').waitFor({ state: 'visible', timeout: 20_000 });
}

async function closeNewAgentDialog(page) {
  await page.getByTestId('input-dialog-close').click();
  await page.getByTestId('input-dialog').waitFor({ state: 'hidden', timeout: 20_000 });
}

async function ensureMobile(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('codex-mobile-topbar').waitFor({ state: 'visible', timeout: 20_000 });
}

async function fillComposer(page, value) {
  const textarea = page.getByTestId('codex-composer').locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 20_000 });
  await textarea.fill(value);
}

async function main() {
  prepareRuntimeDirectories();

  console.log('Building Farming Code front-end...');
  run('npm', ['run', 'build'], {
    cwd: repoRoot,
    env: { ...process.env, FARMING_BASE_PATH: basePath },
    stdio: 'inherit',
  });

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverProcess = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'start-playwright-server.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      FARMING_PLAYWRIGHT_PORT: String(port),
      FARMING_BASE_PATH: basePath,
      FARMING_CONFIG_DIR: configDir,
      FARMING_DISABLE_AUTH: '1',
      FARMING_E2E_FAKE_EXECUTABLES: '1',
      FARMING_ANONYMIZE_SHELL_PROMPT: '1',
      HOME: homeDir,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', chunk => process.stdout.write(chunk));
  serverProcess.stderr.on('data', chunk => process.stderr.write(chunk));

  let browser;
  try {
    await waitForServer(`${baseUrl}${basePath}/`);
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--proxy-server=direct://', '--proxy-bypass-list=*'],
    });
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() => {
      window.__FARMING_E2E__ = true;
    });
    const page = await context.newPage();

    await ensureApp(page);
    await setDemoSettings(page, baseUrl);
    await ensureApp(page);

    const codexAgentId = await startAgent(page, baseUrl, {
      command: 'codex',
      workspace: workspaceDir,
      task: 'Audit Farming 2 release docs',
    });
    const claudeAgentId = await startAgent(page, baseUrl, {
      command: 'claude',
      workspace: workspaceDir,
      task: 'Review mobile follow-up flow',
    });
    const shellAgentId = await startDemoAgent(page, baseUrl);
    await updateAgent(page, baseUrl, codexAgentId, { customTitle: 'Release docs audit', pinned: true });
    await updateAgent(page, baseUrl, claudeAgentId, { customTitle: 'Mobile QA review', unread: true });
    await updateAgent(page, baseUrl, shellAgentId, { customTitle: 'Build smoke terminal' });

    await ensureApp(page);
    await openAgent(page, codexAgentId);
    await writeTerminalFixture(page, codexAgentId, [
      '> Review release documentation and screenshot coverage',
      '',
      '- Ran npm run docs:product:screenshots',
      '  - captured 10 product story frames',
      '- Read README.md, README.zh_cn.md, docs/products/code/README.md',
      '- Opened scripts/capture-product-screenshots.js:11 from terminal output',
      '',
      'Working (42s - esc to interrupt) - 2 background terminals running - /ps to view',
      '',
      '> Ask for follow-up changes',
    ].join('\r\n'));
    await openAgent(page, claudeAgentId);
    await writeTerminalFixture(page, claudeAgentId, [
      'Fake Claude Code ready',
      'Reviewing mobile composer layout...',
      'Found: microphone button no longer overlaps text input',
      'Waiting for next instruction',
    ].join('\r\n'));
    await openAgent(page, shellAgentId);
    await writeTerminalFixture(page, shellAgentId, [
      '$ farming status',
      'server: running on http://demo-linux.local:6694/farming',
      'workspace: /workspaces/farming',
      'agents: 3 active, 0 waiting',
      '',
      '$ git status --short',
      ' M README.md',
      ' M scripts/capture-product-screenshots.js',
      '',
      '$ npm run check',
      'ok backend tests passed',
      'ok typecheck passed',
      'ok lint passed',
      '$',
    ].join('\r\n'));
    await openAgent(page, codexAgentId);

    await waitForFileTree(page);
    await screenshot(page, '01-code-workspace.png');

    await openNewAgentDialog(page);
    await screenshot(page, '02-start-agent-picker.png');
    await page.getByTestId('input-dialog').screenshot({
      path: path.join(screenshotDir, '03-start-agent-workspace.png'),
    });
    await closeNewAgentDialog(page);

    await openAgent(page, codexAgentId);
    await fillComposer(page, 'Please tighten the install section and keep the screenshots anonymous.');
    await fillComposer(page, '');

    await openFile(page, 'scripts/capture-product-screenshots.js:1');
    await waitForEditorReady(page, 'chromium');
    await showBlameFromEditorGutter(page);
    await page.locator('.codex-file-inline-blame').first().waitFor({ state: 'visible', timeout: 20_000 });
    await waitForStableUi(page, 1000);
    await screenshot(page, '04-files-editor-blame.png');

    await ensureMobile(page);
    await openAgent(page, codexAgentId);
    await writeTerminalFixture(page, codexAgentId, [
      '> Mobile check-in',
      '',
      '- Remote agent still running',
      '- Output readable on phone',
      '- Composer clear of controls',
      '',
      'Working 2m14s - ready to steer',
    ].join('\r\n'));
    await fillComposer(page, 'Looks good. Please continue with the README cleanup.');
    await screenshot(page, '05-mobile-agent-chat.jpg');

    await openSidebarOnMobile(page);
    await page.getByTestId('codex-sidebar').waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, '06-mobile-files-sidebar.jpg');

    console.log(`Product screenshots written to ${screenshotDir}`);
  } finally {
    if (browser) await browser.close();
    serverProcess.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
