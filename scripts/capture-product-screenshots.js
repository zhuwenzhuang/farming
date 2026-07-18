#!/usr/bin/env node
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '..');
const screenshotTmpRoot = process.env.FARMING_SCREENSHOT_TMP_ROOT
  || (process.platform === 'win32' ? os.tmpdir() : '/tmp');
const demoRoot = path.join(screenshotTmpRoot, 'farming-product-demo');
const configDir = path.join(demoRoot, 'config');
const homeDir = path.join(demoRoot, 'home');
const customWorkspace = Boolean(process.env.FARMING_SCREENSHOT_WORKSPACE);
const workspaceDir = path.resolve(process.env.FARMING_SCREENSHOT_WORKSPACE || path.join(homeDir, 'Projects', 'atlas-control-plane'));
const screenshotDir = path.join(repoRoot, 'docs', 'products', 'code', 'assets');
const crtScreenshotDir = path.join(repoRoot, 'docs', 'products', 'crt', 'assets');
const basePath = '/farming';
const localChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.FARMING_PLAYWRIGHT_CHROME_PATH
  || (fs.existsSync(localChromePath) ? localChromePath : undefined);
const matrixReasoning = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const matrixCatalog = ['sol', 'terra', 'luna'].map(variant => ({
  value: `gpt-5.6-${variant}`,
  model: `gpt-5.6-${variant}`,
  label: `5.6-${variant.charAt(0).toUpperCase()}${variant.slice(1)}`,
  displayName: `GPT-5.6-${variant.charAt(0).toUpperCase()}${variant.slice(1)}`,
  defaultEffort: 'medium',
  reasoningLevels: matrixReasoning.map(value => ({ value, effort: value, label: value === 'xhigh' ? 'Extra high' : `${value.charAt(0).toUpperCase()}${value.slice(1)}` })),
  serviceTiers: [
    { value: 'default', label: 'Standard', description: 'Default speed' },
    { value: 'priority', label: 'Fast', description: 'Faster responses' },
  ],
  source: 'fixture',
}));

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
  fs.mkdirSync(crtScreenshotDir, { recursive: true });
  if (!customWorkspace) {
    fs.mkdirSync(path.join(workspaceDir, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), [
      '# Atlas Control Plane',
      '',
      'Release workspace for the terminal recovery protocol and cross-skin verification.',
      '',
      'Current gate: exact checkpoint recovery, contiguous live output, and native PTY cleanup.',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(workspaceDir, 'src', 'components', 'Dashboard.tsx'), [
      "type Metric = { label: string; value: string }",
      '',
      'export function Dashboard({ metrics }: { metrics: Metric[] }) {',
      '  return (',
      '    <section className="dashboard">',
      '      <h1>System overview</h1>',
      '      <div className="metric-grid">',
      '        {metrics.map(metric => (',
      '          <article key={metric.label}>',
      '            <span>{metric.label}</span>',
      '            <strong>{metric.value}</strong>',
      '          </article>',
      '        ))}',
      '      </div>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(workspaceDir, 'tests', 'dashboard.spec.ts'), [
      "import { test, expect } from '@playwright/test'",
      '',
      "test('renders the overview', async ({ page }) => {",
      "  await page.goto('/dashboard')",
      "  await expect(page.getByRole('heading', { name: 'System overview' })).toBeVisible()",
      '})',
      '',
    ].join('\n'));
    run('git', ['init', '-q'], { cwd: workspaceDir });
    run('git', ['add', '.'], { cwd: workspaceDir });
    run('git', ['-c', 'user.name=Alex Chen', '-c', 'user.email=alex@example.invalid', 'commit', '-qm', 'Create dashboard overview'], { cwd: workspaceDir });
    fs.appendFileSync(path.join(workspaceDir, 'src', 'components', 'Dashboard.tsx'), [
      '',
      'export function EmptyDashboard() {',
      '  return <p className="empty-state">No metrics reported yet.</p>',
      '}',
      '',
    ].join('\n'));
    fs.appendFileSync(path.join(workspaceDir, 'tests', 'dashboard.spec.ts'), [
      '',
      "test('renders the empty state', async ({ page }) => {",
      "  await page.goto('/dashboard?fixture=empty')",
      "  await expect(page.getByText('No metrics reported yet.')).toBeVisible()",
      '})',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(workspaceDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'notes', 'review-observations.md'), [
      '# Review observations',
      '',
      '- Verify hidden-page recovery before publishing.',
      '- Confirm Code and CRT preserve one provider session.',
      '- Keep key-to-PTY-output p95 below 250 ms.',
      '',
    ].join('\n'));
  }
  for (const directory of [screenshotDir, crtScreenshotDir]) {
    for (const entry of fs.readdirSync(directory)) {
      if (/^\d{2}-.*\.(?:png|jpg|jpeg)$/i.test(entry)) {
        fs.rmSync(path.join(directory, entry), { force: true });
      }
    }
  }
}

async function ensureApp(page) {
  await page.goto(`${basePath}/`, { waitUntil: 'networkidle' });
  await page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.addStyleTag({
    content: `
      [data-testid="code-usage-panel"] {
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
      projectNames: { [workspaceDir]: 'Atlas Control Plane' },
      appearance: 'light',
      language: 'en',
      defaultLaunchAgent: 'bash',
      codexApprovalMode: 'approve',
      codexModel: 'gpt-5.6-terra',
      codexReasoningEffort: 'medium',
      codexServiceTier: 'default',
      codexModelPreset: 'gpt-5.6-terra:medium',
      agentLaunchProfiles: {
        codex: {
          approvalMode: 'approve',
          model: 'gpt-5.6-terra',
          reasoningEffort: 'medium',
          serviceTier: 'default',
          modelPreset: 'gpt-5.6-terra:medium',
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
    timeout: 60_000,
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

async function sendAgentInput(page, baseUrl, agentId, input) {
  const response = await page.request.post(`${baseUrl}${basePath}/api/control/agents/${encodeURIComponent(agentId)}/input`, {
    data: { input },
  });
  if (!response.ok()) {
    throw new Error(`failed to send input to ${agentId}: ${response.status()} ${await response.text()}`);
  }
}

async function waitForAgentOutput(page, baseUrl, agentId, expectedText) {
  await page.waitForFunction(async ({ url, pathPrefix, id, expected }) => {
    const response = await fetch(`${url}${pathPrefix}/api/control/agents/${encodeURIComponent(id)}/output?tail=12000`);
    return response.ok && (await response.text()).includes(expected);
  }, { url: baseUrl, pathPrefix: basePath, id: agentId, expected: expectedText }, { timeout: 20_000 });
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
  const workspace = page.getByTestId('code-workspace');
  const className = await workspace.getAttribute('class');
  if (className?.includes('sidebar-collapsed')) {
    await page.getByTestId('code-mobile-menu').click();
  }
  await page.getByTestId('code-sidebar').waitFor({ state: 'visible', timeout: 10_000 });
}

async function openAgent(page, agentId) {
  const terminal = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`);
  const chat = page.getByTestId('code-acp-composer');
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).first();
  const rowClassName = await row.getAttribute('class').catch(() => '');
  if (await terminal.isVisible() || (await chat.isVisible() && rowClassName?.includes('active'))) return;

  if (!(await row.isVisible())) {
    await openSidebarOnMobile(page);
  }
  await row.evaluate(element => element.click());
  await page.waitForFunction(id => Boolean(
    document.querySelector(`[data-testid="code-terminal-pane"][data-agent-id="${id}"]`)
    || document.querySelector('[data-testid="code-acp-composer"]')
  ), agentId, { timeout: 20_000 });
}

async function openFile(page, query) {
  const filesSection = page.getByTestId('code-files-section').first();
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
  const filesSection = page.getByTestId('code-files-section').first();
  await filesSection.waitFor({ state: 'visible', timeout: 20_000 });
  const filesToggle = filesSection.getByRole('button', { name: /^Files$/ });
  if (await filesToggle.isVisible()) {
    const expanded = await filesToggle.getAttribute('aria-expanded');
    if (expanded === 'false') await filesToggle.click();
  }
  await page.locator('.code-file-tree-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

async function waitForEditorReady(page, expectedText = '') {
  await page.getByTestId('code-file-editor').waitFor({ state: 'visible', timeout: 20_000 });
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

async function screenshot(page, fileName, directory = screenshotDir) {
  await waitForStableUi(page, 250);
  await page.evaluate(({ linuxPath, macPath }) => {
    const walker = document.createTreeWalker(document.body, window.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue) {
        node.nodeValue = node.nodeValue
          .replaceAll(macPath, '~/Projects/atlas-control-plane')
          .replaceAll(linuxPath, '~/Projects/atlas-control-plane');
      }
      node = walker.nextNode();
    }
  }, {
    linuxPath: `/tmp/farming-product-demo/home/Projects/atlas-control-plane`,
    macPath: `/private/tmp/farming-product-demo/home/Projects/atlas-control-plane`,
  });
  if (directory === crtScreenshotDir) {
    await page.evaluate(() => {
      const replacements = {
        'system-ip': 'demo.lan',
        'cpu-usage': '24',
        'mem-percentage': '38',
        'system-time': '2026-07-18 13:41:00',
        uptime: '12m 34s',
      };
      for (const [id, value] of Object.entries(replacements)) {
        const node = document.getElementById(id);
        if (node) node.textContent = value;
      }
    });
  }
  await page.screenshot({
    path: path.join(directory, fileName),
    fullPage: false,
  });
}

function createUsageFixture() {
  const now = Date.parse('2026-07-14T01:00:00.000Z');
  const bucketMs = 2 * 60 * 1000;
  const timelinePoints = Array.from({ length: 30 }, (_, index) => {
    const totalTokens = index % 7 === 0 ? 24_000 + index * 800 : index % 3 === 0 ? 4_000 + index * 120 : 0;
    return {
      startedAt: now - 60 * 60 * 1000 + index * bucketMs,
      endedAt: now - 60 * 60 * 1000 + (index + 1) * bucketMs,
      totalTokens,
      tokensPerMinute: totalTokens / 2,
      providers: { codex: Math.round(totalTokens * 0.72), claude: Math.round(totalTokens * 0.2), opencode: Math.round(totalTokens * 0.08) },
    };
  });
  const dailyCursor = new Date(now);
  dailyCursor.setHours(12, 0, 0, 0);
  dailyCursor.setDate(dailyCursor.getDate() - 52 * 7 + 1);
  const dailyPoints = Array.from({ length: 52 * 7 }, (_, index) => {
    const date = [dailyCursor.getFullYear(), String(dailyCursor.getMonth() + 1).padStart(2, '0'), String(dailyCursor.getDate()).padStart(2, '0')].join('-');
    const totalTokens = index === 52 * 7 - 1
      ? 486_000
      : index === 302
        ? 1_280_000_000
        : index % 9 === 0 ? 180_000 + index * 1_600 : index % 17 === 0 ? 86_000 : 0;
    dailyCursor.setDate(dailyCursor.getDate() + 1);
    return {
      date,
      totalTokens,
      inputTokens: Math.round(totalTokens * 0.35),
      outputTokens: Math.round(totalTokens * 0.15),
      cacheReadTokens: Math.round(totalTokens * 0.45),
      cacheWriteTokens: Math.round(totalTokens * 0.05),
      unattributedTokens: 0,
      providers: {
        codex: { totalTokens: Math.round(totalTokens * 0.72) },
        claude: { totalTokens: Math.round(totalTokens * 0.2) },
        opencode: { totalTokens: Math.round(totalTokens * 0.08) },
      },
    };
  });
  const sumDays = count => dailyPoints.slice(-count).reduce((sum, point) => sum + point.totalTokens, 0);
  const peakDay = dailyPoints.reduce((peak, point) => point.totalTokens > peak.totalTokens ? point : peak, dailyPoints[0]);
  const timelineTotal = timelinePoints.reduce((sum, point) => sum + point.totalTokens, 0);
  return {
    now,
    dailyPoints,
    usage: {
      sampledAt: now,
      windowMs: 5 * 60 * 1000,
      timeline: {
        source: 'local provider token events',
        sampledAt: now,
        startAt: now - 60 * 60 * 1000,
        endAt: now,
        windowMs: 60 * 60 * 1000,
        bucketMs,
        bucketCount: timelinePoints.length,
        totalTokens: timelineTotal,
        averageTokensPerMinute: timelineTotal / 60,
        peakTokensPerMinute: Math.max(...timelinePoints.map(point => point.tokensPerMinute)),
        activeBucketCount: timelinePoints.filter(point => point.totalTokens > 0).length,
        points: timelinePoints,
      },
      daily: {
        source: 'local provider token events',
        sampledAt: now,
        timeZone: 'Asia/Shanghai',
        days: dailyPoints.length,
        startDate: dailyPoints[0].date,
        endDate: dailyPoints.at(-1).date,
        partial: false,
        coverage: [
          { provider: 'codex', providerName: 'Codex', available: true, homeCount: 2 },
          { provider: 'claude', providerName: 'Claude', available: true, homeCount: 1 },
          { provider: 'opencode', providerName: 'OpenCode', available: true, homeCount: 1 },
          { provider: 'qoder', providerName: 'Qoder', available: false, homeCount: 1, reason: 'Token history unavailable.' },
        ],
        summary: {
          todayTokens: sumDays(1),
          sevenDayTokens: sumDays(7),
          thirtyDayTokens: sumDays(30),
          periodTokens: sumDays(dailyPoints.length),
          peakDate: peakDay.date,
          peakTokens: peakDay.totalTokens,
        },
        points: dailyPoints,
      },
      providers: [
        {
          provider: 'codex',
          providerName: 'Codex',
          auth: { available: true, status: 'Connected', source: 'Codex session' },
          quota: {
            available: true,
            source: 'Codex usage events',
            primary: { usedPercent: 38, windowMinutes: 300, resetsAt: now + 90 * 60 * 1000 },
            secondary: { usedPercent: 71, windowMinutes: 10080, resetsAt: now + 3 * 24 * 60 * 60 * 1000 },
          },
          tokenUsage: { totalTokens: 46_000, tokensPerMinute: 9_200, windowMs: 300_000, eventCount: 4, sampledAt: now, source: 'Codex usage events' },
        },
        {
          provider: 'claude',
          providerName: 'Claude',
          auth: { available: true, status: 'Connected', source: 'Claude session' },
          quota: { available: false, source: 'Claude session', reason: 'Quota unavailable' },
          tokenUsage: { totalTokens: 7_000, tokensPerMinute: 1_400, windowMs: 300_000, eventCount: 2, sampledAt: now, source: 'Claude local usage' },
        },
        {
          provider: 'opencode',
          providerName: 'OpenCode',
          auth: { available: true, status: 'Connected', source: 'OpenCode session' },
          quota: { available: false, source: 'OpenCode session', reason: 'Quota unavailable' },
          tokenUsage: { totalTokens: 2_800, tokensPerMinute: 560, windowMs: 300_000, eventCount: 2, sampledAt: now, source: 'OpenCode session export' },
        },
        {
          provider: 'qoder',
          providerName: 'Qoder',
          auth: { available: true, status: 'Local sessions', source: 'Qoder sessions' },
          quota: { available: false, source: 'Qoder sessions', reason: 'Quota unavailable' },
          tokenUsage: { available: false, totalTokens: null, tokensPerMinute: null, windowMs: 300_000, eventCount: 0, sampledAt: now, source: 'Qoder sessions', reason: 'Token usage unavailable' },
        },
      ],
      agentUsage: null,
      systemStats: null,
    },
  };
}

async function installUsageRoutes(page, fixture) {
  await page.route(/\/api\/usage(?:\/day)?(?:\?|$)/, async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname.endsWith('/api/usage/day')) {
      const date = requestUrl.searchParams.get('date') || fixture.dailyPoints.at(-1).date;
      const point = fixture.dailyPoints.find(candidate => candidate.date === date) || fixture.dailyPoints.at(-1);
      const hourlyWeights = new Map([[3, 0.08], [8, 0.17], [10, 0.25], [14, 0.12], [18, 0.28], [22, 0.10]]);
      const hours = Array.from({ length: 24 }, (_, hour) => {
        const totalTokens = Math.round(point.totalTokens * (hourlyWeights.get(hour) || 0));
        return {
          hour,
          label: String(hour).padStart(2, '0'),
          totalTokens,
          inputTokens: Math.round(totalTokens * 0.35),
          outputTokens: Math.round(totalTokens * 0.15),
          cacheReadTokens: Math.round(totalTokens * 0.45),
          cacheWriteTokens: Math.round(totalTokens * 0.05),
          unattributedTokens: 0,
        };
      });
      await route.fulfill({
        json: {
          detail: {
            source: 'local provider token events',
            date: point.date,
            timeZone: 'Asia/Shanghai',
            total: point,
            hours,
            providers: point.providers,
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { usage: fixture.usage } });
  });
}

async function installSessionSearchRoute(page) {
  const sessions = [
    {
      provider: 'codex',
      providerName: 'Codex',
      providerHomeId: 'default',
      id: '019f-atlas-release-recovery',
      title: 'Release recovery investigation',
      workspace: workspaceDir,
      model: 'gpt-5.6-terra',
      effort: 'high',
      updatedAt: '2026-07-18T05:36:00.000Z',
    },
    {
      provider: 'claude',
      providerName: 'Claude Code',
      providerHomeId: 'default',
      id: '019f-atlas-visual-review',
      title: 'Cross-skin visual review',
      workspace: workspaceDir,
      model: 'sonnet',
      effort: 'medium',
      updatedAt: '2026-07-18T04:52:00.000Z',
    },
    {
      provider: 'opencode',
      providerName: 'OpenCode',
      providerHomeId: 'default',
      id: '019f-atlas-dependency-audit',
      title: 'Release dependency audit',
      workspace: workspaceDir,
      updatedAt: '2026-07-17T15:18:00.000Z',
    },
  ];

  await page.route(`**${basePath}/api/agent-sessions/search?**`, route => {
    const query = (new URL(route.request().url()).searchParams.get('q') || '').trim().toLowerCase();
    const matches = query
      ? sessions.filter(session => [session.title, session.providerName, session.workspace].join('\n').toLowerCase().includes(query))
      : sessions;
    return route.fulfill({
      json: {
        sessions: matches,
        total: matches.length,
        query,
      },
    });
  });
}

async function showBlameFromEditorGutter(page) {
  const gutterLine = page.locator('.monaco-editor .margin-view-overlays .line-numbers').first();
  await gutterLine.waitFor({ state: 'visible', timeout: 20_000 });
  await gutterLine.click({ button: 'right', force: true });
  await page.getByRole('menuitem', { name: 'Annotate with Blame' }).click();
}

async function openNewAgentDialog(page) {
  await page.getByTestId('code-new-agent').click();
  await page.getByTestId('input-dialog').waitFor({ state: 'visible', timeout: 20_000 });
}

async function closeNewAgentDialog(page) {
  await page.getByTestId('input-dialog-close').click();
  await page.getByTestId('input-dialog').waitFor({ state: 'hidden', timeout: 20_000 });
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
      FARMING_E2E_FAKE_ACP_AGENT: '1',
      FARMING_NATIVE_PTY_HOST_PERSIST: '0',
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
      viewport: { width: 1440, height: 810 },
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() => {
      window.__FARMING_E2E__ = true;
    });
    const page = await context.newPage();

    await page.route(`**${basePath}/api/codex/models`, route => route.fulfill({
      json: { catalog: matrixCatalog, source: 'fixture' },
    }));
    await installSessionSearchRoute(page);
    await ensureApp(page);
    await setDemoSettings(page, baseUrl);
    await ensureApp(page);

    const codexAgentId = await startAgent(page, baseUrl, {
      command: 'codex',
      workspace: workspaceDir,
      task: '',
      agentRuntimeMode: 'acp',
    });
    const terminalAgentId = await startAgent(page, baseUrl, {
      command: 'codex',
      workspace: workspaceDir,
      task: '',
      agentRuntimeMode: 'terminal',
    });
    const claudeAgentId = await startAgent(page, baseUrl, {
      command: 'claude',
      workspace: workspaceDir,
      task: '',
    });
    const shellAgentId = await startDemoAgent(page, baseUrl);
    await updateAgent(page, baseUrl, codexAgentId, { customTitle: 'Recovery protocol', pinned: true });
    await updateAgent(page, baseUrl, terminalAgentId, { customTitle: 'Release gate' });
    await updateAgent(page, baseUrl, claudeAgentId, { customTitle: 'Visual QA', unread: true });
    await updateAgent(page, baseUrl, shellAgentId, { customTitle: 'Linux smoke' });

    await ensureApp(page);
    await openAgent(page, terminalAgentId);
    await writeTerminalFixture(page, terminalAgentId, [
      '> Run the terminal recovery release gate',
      '',
      '✓ 182 source and backend checks passed',
      '✓ Code ↔ CRT provider session identity preserved',
      '✓ Hidden-page checkpoint recovery passed',
      '✓ Native PTY host restart recovery passed',
      '',
      'terminal input p95: 59 ms (limit: 250 ms)',
      'Release candidate ready — 2 background checks still reporting',
      '',
      '> Verify release artifacts',
      '✓ darwin-arm64 + darwin-x64',
      '✓ linux-arm64 + linux-x64',
      '✓ linux-x64 legacy glibc 2.28',
      '✓ checksums + update manifest',
      '',
      'Next: publish after both background checks report green',
    ].join('\r\n'));
    await openAgent(page, claudeAgentId);
    await writeTerminalFixture(page, claudeAgentId, [
      'Claude Code — visual review',
      'Inspecting desktop information hierarchy...',
      '✓ Agent status remains readable at a glance',
      '✓ File and Review entry points stay visible',
      '✓ Composer controls no longer compete with the result',
      'Waiting for final screenshot approval',
    ].join('\r\n'));
    await openAgent(page, shellAgentId);
    await writeTerminalFixture(page, shellAgentId, [
      '$ farming status',
      'server: running on http://demo-linux.local:6694/farming',
      'workspace: /workspaces/atlas-control-plane',
      'agents: 4 active, 0 waiting',
      '',
      '$ git status --short',
      ' M tests/e2e/terminal-cross-skin-recovery.spec.ts',
      '',
      '$ npm run check',
      'ok backend tests passed',
      'ok typecheck passed',
      'ok lint passed',
      '$',
    ].join('\r\n'));
    await sendAgentInput(page, baseUrl, shellAgentId, 'stty -echo\r');
    await page.waitForTimeout(150);
    await sendAgentInput(page, baseUrl, shellAgentId, 'clear\r');
    await page.waitForTimeout(150);
    await sendAgentInput(page, baseUrl, shellAgentId, [
      "printf '\\033[1;36mFarming v2.2.12 release console\\033[0m\\n'",
      "printf '\\nSOURCE GATES\\n  backend: 184 passed\\n  typecheck: passed\\n  lint: passed\\n\\nARTIFACT MATRIX\\n  macOS arm64 / x64: verified\\n  Linux arm64 / x64: verified\\n  legacy glibc 2.28: verified\\n  checksums + manifest: verified\\n\\nRUNTIME PROOF\\n  terminal recovery: passed\\n  cross-skin identity: passed\\n  input p95: 58 ms / 250 ms\\n\\nproduction build: ready\\n\\nWORKTREE\\n'",
      'git status --short',
      'stty echo',
    ].join('; ') + '\r');
    await waitForAgentOutput(page, baseUrl, shellAgentId, 'production build: ready');
    await openAgent(page, codexAgentId);
    const acpProfileResponse = await page.request.patch(`${baseUrl}${basePath}/api/agents/${encodeURIComponent(codexAgentId)}/acp-session`, {
      data: {
        configOptions: [
          { configId: 'model', value: 'gpt-5.6-terra' },
          { configId: 'reasoning', value: 'medium' },
        ],
      },
    });
    if (!acpProfileResponse.ok()) {
      throw new Error(`failed to set screenshot ACP profile: ${acpProfileResponse.status()} ${await acpProfileResponse.text()}`);
    }
    const acpInput = page.getByTestId('code-acp-composer-input');
    await acpInput.fill('Audit terminal recovery for the v2.2.12 release. Keep a rich timeline and produce the release readiness story with evidence and residual risk.');
    await page.getByTestId('code-acp-composer-send').click();
    await page.getByText('Release readiness is confirmed.', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });

    await waitForFileTree(page);
    await screenshot(page, '01-code-workspace.png');

    const richTurn = page.locator('.code-codex-transcript-turn').filter({ hasText: 'release readiness story' }).first();
    await richTurn.getByTestId('code-codex-transcript-process-summary').click();
    const processGroup = richTurn.getByTestId('code-codex-transcript-process-group').first();
    await processGroup.getByTestId('code-codex-transcript-process-group-toggle').click();
    await processGroup.getByText('Run cross-skin verification', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('code-codex-transcript-scroll').evaluate((element) => {
      element.scrollTop = Math.min(element.scrollTop + 180, element.scrollHeight - element.clientHeight);
    });
    await waitForStableUi(page, 300);
    await screenshot(page, '11-code-agent-process.png');

    await openNewAgentDialog(page);
    await screenshot(page, '02-start-agent-picker.png');
    await closeNewAgentDialog(page);

    await openAgent(page, codexAgentId);
    await openFile(page, 'src/components/Dashboard.tsx:1');
    await waitForEditorReady(page, 'Dashboard');
    await showBlameFromEditorGutter(page);
    await page.locator('.code-file-inline-blame').first().waitFor({ state: 'visible', timeout: 20_000 });
    await waitForStableUi(page, 1000);
    await screenshot(page, '04-files-editor-blame.png');

    await openAgent(page, terminalAgentId);
    await page.getByTestId('code-composer-model-picker').click();
    await page.getByTestId('code-model-matrix-picker').waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, '07-live-model-controls.png');
    await page.keyboard.press('Escape');
    await page.getByTestId('code-model-matrix-picker').waitFor({ state: 'hidden', timeout: 20_000 });
    await screenshot(page, '12-code-terminal-session.png');

    await page.getByTestId('code-nav-search').click();
    await page.getByTestId('code-search-panel').waitFor({ state: 'visible', timeout: 20_000 });
    const globalSearch = page.getByTestId('code-search-box').locator('input');
    await globalSearch.fill('Atlas');
    await page.getByTestId('code-session-search-result').nth(2).waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, '13-code-search.png');

    const visualHistoryAgentId = await startAgent(page, baseUrl, {
      command: 'codex',
      workspace: workspaceDir,
      task: '',
      agentRuntimeMode: 'terminal',
    });
    await updateAgent(page, baseUrl, visualHistoryAgentId, { customTitle: 'Release visual audit' });
    await updateAgent(page, baseUrl, visualHistoryAgentId, { archived: true });
    const packageHistoryAgentId = await startAgent(page, baseUrl, {
      command: 'codex',
      workspace: workspaceDir,
      task: '',
      agentRuntimeMode: 'terminal',
    });
    await updateAgent(page, baseUrl, packageHistoryAgentId, { customTitle: 'Release package smoke' });
    await updateAgent(page, baseUrl, packageHistoryAgentId, { archived: true });
    const notesHistoryAgentId = await startAgent(page, baseUrl, {
      command: 'claude',
      workspace: workspaceDir,
      task: '',
    });
    await updateAgent(page, baseUrl, notesHistoryAgentId, { customTitle: 'Release notes verification' });
    await updateAgent(page, baseUrl, notesHistoryAgentId, { archived: true });
    await updateAgent(page, baseUrl, terminalAgentId, { archived: true });
    await page.getByTestId('code-nav-history').click();
    await page.getByTestId('code-history-panel').waitFor({ state: 'visible', timeout: 20_000 });
    const historySearch = page.getByRole('searchbox', { name: 'Search history' });
    await historySearch.fill('Release');
    const releaseHistoryCards = page.getByTestId('code-archived-run-card').filter({ hasText: 'Release' });
    await releaseHistoryCards.nth(3).waitFor({ state: 'visible', timeout: 20_000 });
    await waitForStableUi(page, 400);
    await screenshot(page, '08-history-search.png');

    await page.keyboard.press('Escape');
    await page.getByTestId('code-sidebar-options').click();
    await page.getByTestId('code-settings-panel').waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, '14-code-settings.png');
    await page.keyboard.press('Escape');

    await page.request.post(`${baseUrl}${basePath}/api/settings`, { data: { appearance: 'dark' } });
    await ensureApp(page);
    await openAgent(page, codexAgentId);
    await screenshot(page, '09-dark-workspace.png');

    const dependencyAgentId = await startAgent(page, baseUrl, {
      command: 'bash',
      workspace: workspaceDir,
      task: '',
    });
    await updateAgent(page, baseUrl, dependencyAgentId, { customTitle: 'Dependency audit' });
    await sendAgentInput(page, baseUrl, dependencyAgentId, 'stty -echo; clear; printf "DEPENDENCY AUDIT\\n\\nproduction packages: 74\\nknown vulnerabilities: 0\\nlicense conflicts: 0\\nlockfile drift: none\\n\\nready for release\\n"; stty echo\r');
    await waitForAgentOutput(page, baseUrl, dependencyAgentId, 'ready for release');

    const usageFixture = createUsageFixture();
    await installUsageRoutes(page, usageFixture);
    await page.goto(`${basePath}/crt/`, { waitUntil: 'networkidle' });
    await page.locator('body#farming-crt').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.agent-block').first().waitFor({ state: 'visible', timeout: 30_000 });
    await screenshot(page, '01-crt-dashboard.png', crtScreenshotDir);

    await page.goto(`${basePath}/crt/?agent=${encodeURIComponent(codexAgentId)}`, { waitUntil: 'networkidle' });
    await page.locator('#session-modal.active').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#crt-structured-composer.active').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#terminal-output .crt-structured-transcript').waitFor({ state: 'visible', timeout: 30_000 });
    await screenshot(page, '02-crt-structured-chat.png', crtScreenshotDir);

    await page.goto(`${basePath}/crt/?agent=${encodeURIComponent(shellAgentId)}`, { waitUntil: 'networkidle' });
    await page.locator('#session-modal.active').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#terminal-output .xterm').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText('production build: ready', { exact: false }).waitFor({ state: 'visible', timeout: 30_000 });
    await screenshot(page, '03-crt-terminal.png', crtScreenshotDir);
    await page.getByRole('button', { name: 'Close session, Ctrl+Escape', exact: true }).click();

    await page.getByRole('button', { name: '[F] SEARCH', exact: true }).click();
    const crtSearch = page.getByRole('searchbox', { name: 'Search projects, Agents, and sessions' });
    await crtSearch.fill('Atlas');
    await page.locator('.search-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, '04-crt-search.png', crtScreenshotDir);

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '[H] HISTORY', exact: true }).click();
    await page.locator('#history-area:not(.hidden)').waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('.history-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, '05-crt-history.png', crtScreenshotDir);

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '[$] BILLING', exact: true }).click();
    await page.locator('#billing-status').filter({ hasText: 'HISTORY READY' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#billing-day-insight-state').filter({ hasText: '24 HOURLY BINS READY' }).waitFor({ state: 'visible', timeout: 30_000 });
    await screenshot(page, '06-crt-billing-days.png', crtScreenshotDir);
    await page.getByRole('tab', { name: '[L] LIVE', exact: true }).click();
    await page.locator('#billing-status').filter({ hasText: 'SIGNAL LOCKED' }).waitFor({ state: 'visible', timeout: 30_000 });
    await screenshot(page, '07-crt-billing-live.png', crtScreenshotDir);

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '[S] SETTINGS', exact: true }).click();
    await page.locator('#settings-modal.active').waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, '08-crt-settings.png', crtScreenshotDir);

    console.log(`Farming Code screenshots written to ${screenshotDir}`);
    console.log(`Farming CRT screenshots written to ${crtScreenshotDir}`);
  } finally {
    if (browser) await browser.close();
    serverProcess.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
