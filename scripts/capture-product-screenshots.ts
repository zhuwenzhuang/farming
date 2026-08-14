#!/usr/bin/env -S npx tsx
export {};

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const tsxCliPath = require.resolve('tsx/cli');

const repoRoot = path.resolve(__dirname, '..');
const packageVersion = require(path.join(repoRoot, 'package.json')).version;
const screenshotTmpRoot = process.env.FARMING_SCREENSHOT_TMP_ROOT
  || (process.platform === 'win32' ? os.tmpdir() : '/tmp');
const demoRoot = path.join(screenshotTmpRoot, 'farming-product-demo');
const configDir = path.join(demoRoot, 'config');
const homeDir = path.join(demoRoot, 'home');
const agentBrowserSocketDir = path.join(screenshotTmpRoot, `fb${process.pid}`);
const customWorkspace = Boolean(process.env.FARMING_SCREENSHOT_WORKSPACE);
const workspaceDir = path.resolve(process.env.FARMING_SCREENSHOT_WORKSPACE || path.join(homeDir, 'Projects', 'atlas-control-plane'));
const screenshotDir = path.join(repoRoot, 'docs', 'products', 'code', 'assets');
const crtScreenshotDir = path.join(repoRoot, 'docs', 'products', 'crt', 'assets');
const screenshotLocale = process.env.FARMING_SCREENSHOT_LOCALE === 'en' ? 'en' : 'cn';
const publicScreenshotDir = path.join(repoRoot, 'docs-site', 'public', screenshotLocale, 'assets');
type PublicScreenshotSpec = {
  fileName: string;
  clip?: { x: number; y: number; width: number; height: number };
  publicOnly?: boolean;
};
const publicCodeScreenshotSpecs = new Map<string, PublicScreenshotSpec>([
  ['00-code-welcome.png', { fileName: 'welcome.png' }],
  ['01-code-workspace.png', { fileName: 'workspace.png' }],
  ['02-start-agent-picker.png', { fileName: 'start-agent.png' }],
  ['04-files-markdown-preview.png', { fileName: 'files-relational-operators-20260806.png' }],
  ['05-mobile-agent-chat.png', { fileName: 'mobile-chat.png' }],
  ['07-live-model-controls.png', { fileName: 'model-controls.png', clip: { x: 300, y: 0, width: 1140, height: 810 } }],
  ['08-history-search.png', { fileName: 'history.png', clip: { x: 300, y: 0, width: 1140, height: 810 } }],
  ['09-dark-workspace.png', { fileName: 'workspace-dark.png' }],
  ['11-code-agent-process.png', { fileName: 'chat.png', clip: { x: 300, y: 0, width: 1140, height: 810 } }],
  ['12-code-terminal-session.png', { fileName: 'terminal-20260806.png', clip: { x: 300, y: 0, width: 1140, height: 810 } }],
  ['13-code-search.png', { fileName: 'search.png', clip: { x: 300, y: 0, width: 1140, height: 810 } }],
  ['14-code-settings.png', { fileName: 'settings.png', clip: { x: 920, y: 0, width: 520, height: 430 } }],
  ['15-code-usage-activity.png', { fileName: 'usage-activity.png' }],
  ['16-code-pet-soft-glow.png', { fileName: 'pet-soft-glow.png' }],
  ['17-code-pet-black-hole.png', { fileName: 'pet-black-hole.png' }],
  ['18-code-desktop-connections.png', { fileName: 'desktop-connections.png' }],
  ['19-code-agent-homes.png', { fileName: 'agent-homes.png' }],
  ['20-code-share-chat.png', { fileName: 'share-chat.png', clip: { x: 300, y: 0, width: 1140, height: 810 } }],
  ['21-code-share-file.png', { fileName: 'share-file.png', clip: { x: 300, y: 0, width: 1140, height: 810 } }],
  ['22-code-share-qr.png', { fileName: 'share-qr.png', clip: { x: 0, y: 0, width: 650, height: 620 } }],
  ['23-code-files-html-chat.png', { fileName: 'files-html-preview-chat.png', publicOnly: true }],
  ['24-code-browser-docs.png', { fileName: 'browser-viewer.png', publicOnly: true }],
  ['25-code-browser-plugin.png', { fileName: 'browser-plugin.png', publicOnly: true, clip: { x: 300, y: 0, width: 1140, height: 650 } }],
]);
const publicCrtScreenshotSpecs = new Map<string, PublicScreenshotSpec>([
  ['01-crt-dashboard.png', { fileName: 'crt-dashboard.png' }],
  ['02-crt-structured-chat.png', { fileName: 'crt-chat.png' }],
  ['03-crt-terminal.png', { fileName: 'crt-terminal-20260806.png' }],
  ['06-crt-billing-days.png', { fileName: 'crt-usage-20260806.png' }],
]);
const screenshotAppearance = ['dark', 'paper'].includes(process.env.FARMING_SCREENSHOT_APPEARANCE || '')
  ? process.env.FARMING_SCREENSHOT_APPEARANCE as 'dark' | 'paper'
  : 'light';
const nativeDarkCodeScreenshots = new Set([
  '09-dark-workspace.png',
  '17-code-pet-black-hole.png',
]);
const browserDocumentationScreenshots = new Set([
  '24-code-browser-docs.png',
  '25-code-browser-plugin.png',
  '26-existing-chrome-install.png',
  '27-existing-chrome-select-folder.png',
  '28-existing-chrome-menu.png',
  '29-existing-chrome-remove.png',
]);
const existingChromeScreenshotFiles = new Map([
  ['26-existing-chrome-install.png', 'existing-chrome-install.png'],
  ['27-existing-chrome-select-folder.png', 'existing-chrome-select-folder.png'],
  ['28-existing-chrome-menu.png', 'existing-chrome-menu.png'],
  ['29-existing-chrome-remove.png', 'existing-chrome-remove.png'],
]);
const documentationHomeScreenshots = new Set([
  '23-code-files-html-chat.png',
  '24-code-browser-docs.png',
]);
const requestedScreenshotFiles = new Set(
  String(process.env.FARMING_SCREENSHOT_FILES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
);
const capturedScreenshotFiles = new Set();
const basePath = '/farming';
const localChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.FARMING_PLAYWRIGHT_CHROME_PATH
  || (fs.existsSync(localChromePath) ? localChromePath : undefined);
const agentBrowserPlatformKey = `${process.platform}-${process.arch === 'x64' ? 'x64' : 'arm64'}`;
const localAgentBrowserPath = process.env.FARMING_AGENT_BROWSER_BIN
  || path.join(
    repoRoot,
    '.farming-runtime-seed',
    'runtimes',
    'agentBrowser',
    '0.32.3',
    agentBrowserPlatformKey,
    process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser',
  );
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
const defaultAgentHomeSettings = {
  codex: [{ id: 'default', path: '~/.codex', order: 0, newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' } }],
  claude: [{ id: 'default', path: '~/.claude', order: 1000, newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' } }],
  opencode: [{ id: 'default', path: '~/.opencode', order: 2000, newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' } }],
  qoder: [{ id: 'default', path: '~/.qoder', order: 3000, newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' } }],
  qwen: [{ id: 'default', path: '~/.qwen', order: 4000, newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' } }],
};
const multipleAgentHomeSettings = {
  ...defaultAgentHomeSettings,
  codex: [
    defaultAgentHomeSettings.codex[0],
    { id: 'work', path: '~/.codex-work', order: 1, newAgentDefaults: { model: 'inherit', reasoning: 'high', fast: 'on' } },
    { id: 'personal', path: '~/.codex-personal', order: 2, newAgentDefaults: { model: 'inherit', reasoning: 'medium', fast: 'inherit' } },
  ],
  claude: [
    defaultAgentHomeSettings.claude[0],
    { id: 'team', path: '~/.claude-team', order: 1001, newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' } },
  ],
};

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: import('node:child_process').StdioOptions;
}

function run(command: string, args: string[], options: RunOptions = {}): void {
  execFileSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    stdio: options.stdio || 'ignore',
  });
}

function commandOutput(command: string, args: string[], cwd = workspaceDir): string {
  return execFileSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
  }).trimEnd();
}

function createWorkspaceTerminalTranscript(): string {
  return [
    '$ git log --oneline -3',
    commandOutput('git', ['log', '--oneline', '-3']),
    '',
    '$ git diff --stat',
    commandOutput('git', ['diff', '--stat']),
    '',
    '$ git diff --check',
    'no whitespace errors',
    '',
    '$ git status --short',
    commandOutput('git', ['status', '--short']),
    '',
    '$',
  ].join('\r\n');
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

async function startDocumentationSite() {
  run('npm', ['run', 'build'], {
    cwd: path.join(repoRoot, 'docs-site'),
    env: processEnvWithoutColor(),
    stdio: 'inherit',
  });
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/farming/${screenshotLocale}/?theme=${screenshotAppearance}`;
  const process = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: path.join(repoRoot, 'docs-site'),
    env: processEnvWithoutColor(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.on('data', chunk => process.stdout.write(chunk));
  process.stderr.on('data', chunk => process.stderr.write(chunk));
  await waitForServer(url);
  return {
    origin,
    process,
    title: documentationSiteTitle(),
    url,
    publicUrl: `https://zhuwenzhuang.github.io/farming/${screenshotLocale}/?theme=${screenshotAppearance}`,
  };
}

function processEnvWithoutColor() {
  return { ...process.env, NO_COLOR: '1' };
}

async function writeDocumentationHomeFixture(documentationSite: { url: string }, browser) {
  const context = await browser.newContext({
    viewport: { width: 960, height: 640 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await page.goto(documentationSite.url, { waitUntil: 'networkidle' });
    await page.locator('.VPHero .name').filter({ hasText: 'Farming' })
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(image => image.complete
        ? Promise.resolve()
        : new Promise(resolve => image.addEventListener('load', resolve, { once: true }))));
    });
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
    const html = [
      '<!doctype html>',
      `<html lang="${screenshotLocale === 'en' ? 'en' : 'zh-CN'}">`,
      '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
      `<title>${documentationSiteTitle()}</title>`,
      `<style>html,body{margin:0;min-height:100%;background:${background}}img{display:block;width:100%;height:auto}</style></head>`,
      `<body><img src="data:image/jpeg;base64,${screenshot.toString('base64')}" alt="${documentationSiteTitle()}"></body>`,
      '</html>',
    ].join('');
    fs.writeFileSync(path.join(workspaceDir, 'docs', 'farming-home.html'), html);
  } finally {
    await context.close();
  }
}

function documentationSiteTitle() {
  return screenshotLocale === 'en' ? 'Farming Documentation' : 'Farming 文档';
}

async function waitForServer(url: string, timeoutMs = 45_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`server did not become ready at ${url}: ${lastError?.message || 'timeout'}`);
}

function prepareRuntimeDirectories() {
  fs.rmSync(demoRoot, { recursive: true, force: true });
  fs.rmSync(agentBrowserSocketDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.mkdirSync(crtScreenshotDir, { recursive: true });
  fs.mkdirSync(publicScreenshotDir, { recursive: true });
  if (!customWorkspace) {
    fs.mkdirSync(path.join(workspaceDir, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), [
      '# Atlas Control Plane',
      '',
      'Release workspace for the terminal recovery protocol and cross-skin verification.',
      '',
      'Current gate: exact checkpoint recovery, contiguous live output, and native PTY cleanup.',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(workspaceDir, 'docs', 'relational-operators.md'), [
      '# Relational Algebra and Logical Optimization Rules',
      '',
      'Logical optimization rewrites a query into an equivalent, lower-cost form. Relational algebra gives these rewrites a compact language that is independent of a particular optimizer implementation.',
      '',
      '## Foundations',
      '',
      'The definitions below use bag semantics. A relation is a bag of tuples, $\\mathcal{A}(e)$ is the attribute set of expression $e$, and $\\mathfrak{m}$ is tuple multiplicity.',
      '',
      'Logical operators describe changes to data. Hash Join, Sort Merge Join, and other physical implementations may change execution cost without changing the logical result.',
      '',
      '## Relational Operator Definition Summary',
      '',
      '$$',
      '\\begin{aligned}',
      '\\sigma_p(e) :=& \\{x \\mid x \\in e,\\ p(x)\\}_b \\\\',
      '\\Pi_A(e) :=& \\{[a_1:x.a_1, \\ldots, a_n:x.a_n] \\mid x \\in e\\}_b \\\\',
      '\\Pi^D(e) :=& {}_{\\mathfrak m=1}(e) \\\\',
      '\\chi_{a:f}(e) :=& \\{x \\circ [a:f(x)] \\mid x \\in e\\}_b \\\\',
      '\\chi_F(e) :=& \\{x \\circ [a_1:f_1(x), \\ldots, a_n:f_n(x)] \\mid x \\in e\\}_b',
      '\\end{aligned}',
      '$$',
      '',
      '$$',
      '\\begin{aligned}',
      '\\Gamma_{G;g:f}(e) :=& \\{y \\circ [g:x] \\mid y \\in \\Pi_G^D(e),\\ x=f(\\{z \\mid z \\in e,\\ z.G \\dot= y.G\\})\\}_b \\\\',
      '\\nu_{G;g}(e) :=& \\Gamma_{G;g:\\Pi_{\\overline G}}(e) \\\\',
      '\\mu_g(e) :=& \\{y.[\\mathcal{A}(e)/g] \\circ x \\mid y \\in e,\\ x \\in y.g\\}_b \\\\',
      'e_1 \\cup_b e_2 :=& {}_{\\mathfrak m=m_1+m_2}(e_1,e_2)',
      '\\end{aligned}',
      '$$',
      '',
      '$$',
      '\\begin{aligned}',
      'e_1 \\times e_2 :=& \\{y \\circ x \\mid y \\in e_1,\\ x \\in e_2\\}_b \\\\',
      'e_1 \\bowtie_p e_2 :=& \\{y \\circ x \\mid y \\in e_1,\\ x \\in e_2,\\ p(y,x)\\}_b \\\\',
      'e_1 \\ltimes_p e_2 :=& \\{y \\mid y \\in e_1,\\ \\exists x \\in e_2,\\ p(y,x)\\}_b \\\\',
      'e_1 \\vartriangleright_p e_2 :=& \\{y \\mid y \\in e_1,\\ \\nexists x \\in e_2,\\ p(y,x)\\}_b',
      '\\end{aligned}',
      '$$',
      '',
      '> These definitions summarize the logical behavior of the operators; execution strategies remain a separate physical-planning concern.',
      '',
      '## Core Properties of Logical Operators',
      '',
      'The next stage of analysis classifies each operator by linearity, row and column cardinality, ordering requirements, and the way free variables are bound.',
      '',
      '- **Linearity** determines whether an operator can be distributed across bag union.',
      '- **Schema effects** describe which attributes an operator consumes, preserves, or produces.',
      '- **Cardinality effects** describe whether rows can be filtered, duplicated, grouped, or expanded.',
      '- **Reordering constraints** identify when adjacent operators can safely exchange positions.',
      '',
      'These properties provide the guards for equivalence rules such as predicate pushdown, projection pruning, and join reordering.',
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
    fs.writeFileSync(path.join(workspaceDir, 'src', 'recovery.js'), [
      'const CHECKPOINT_TIMEOUT_MS = 15_000',
      '',
      'export async function recoverSession({ sessionId, expectedEpoch, api }) {',
      '  const checkpoint = await api.fetchCheckpoint(sessionId, CHECKPOINT_TIMEOUT_MS)',
      '',
      '  if (checkpoint.epoch !== expectedEpoch) {',
      "    return { status: 'reload', checkpoint }",
      '  }',
      '',
      '  if (!checkpoint.exact) {',
      "    throw new Error('Recovery requires an exact checkpoint')",
      '  }',
      '',
      "  return { status: 'ready', checkpoint }",
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
    run('git', ['-c', 'user.name=Alex Chen', '-c', 'user.email=alex@example.invalid', 'commit', '-qm', 'Create dashboard overview', '--date=2026-07-08T09:30:00Z'], {
      cwd: workspaceDir,
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-07-08T09:30:00Z' },
    });
    fs.appendFileSync(path.join(workspaceDir, 'src', 'recovery.js'), [
      'export function acceptTransition(checkpoint, transition) {',
      '  const isNext = transition.outputSeq === checkpoint.outputSeq + 1',
      '  const isSameEpoch = transition.epoch === checkpoint.epoch',
      '  return isNext && isSameEpoch',
      '}',
      '',
    ].join('\n'));
    run('git', ['add', 'src/recovery.js'], { cwd: workspaceDir });
    run('git', ['-c', 'user.name=Maya Ortiz', '-c', 'user.email=maya@example.invalid', 'commit', '-qm', 'Fence contiguous recovery output', '--date=2026-07-15T14:20:00Z'], {
      cwd: workspaceDir,
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-07-15T14:20:00Z' },
    });
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
    const paginationPath = path.join(workspaceDir, 'src', 'pagination.ts');
    run('git', ['rm', '-q', 'src/recovery.js'], { cwd: workspaceDir });
    fs.writeFileSync(path.join(workspaceDir, 'src', 'users-api.ts'), [
      'export type UserRecord = { id: string; name: string }',
      '',
      'export function listUsers(cursor?: string): Promise<Response> {',
      "  const query = cursor ? '?cursor=' + encodeURIComponent(cursor) : ''",
      "  return fetch('/api/users' + query)",
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(paginationPath, [
      'export interface Page<T> {',
      '  items: T[]',
      '  nextCursor: string | null',
      '}',
      '',
      'type RetryPolicy = {',
      '  attempts: number',
      '  baseDelayMs: number',
      '}',
      '',
      'export const RETRY_POLICY: RetryPolicy = {',
      '  attempts: 3,',
      '  baseDelayMs: 200,',
      '}',
      '',
    ].join('\n'));
    run('git', ['add', 'src/pagination.ts', 'src/users-api.ts'], { cwd: workspaceDir });
    run('git', ['-c', 'user.name=Lena Park', '-c', 'user.email=lena@example.invalid', 'commit', '-qm', 'Define bounded pagination retry policy', '--date=2026-07-17T11:25:00Z'], {
      cwd: workspaceDir,
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-07-17T11:25:00Z' },
    });
    fs.appendFileSync(paginationPath, [
      'export function mergePage<T extends { id: string }>(',
      '  seen: Set<string>,',
      '  page: Page<T>,',
      '): T[] {',
      '  const unique = page.items.filter(item => !seen.has(item.id))',
      '  unique.forEach(item => seen.add(item.id))',
      '  return unique',
      '}',
      '',
      'export function shouldRetry(',
      '  attempt: number,',
      '  status: number,',
      '): boolean {',
      '  const retryable = status === 429 || status === 503',
      '  return retryable && attempt < RETRY_POLICY.attempts',
      '}',
      '',
    ].join('\n'));
    run('git', ['add', 'src/pagination.ts'], { cwd: workspaceDir });
    run('git', ['-c', 'user.name=Omar Rahman', '-c', 'user.email=omar@example.invalid', 'commit', '-qm', 'Deduplicate adjacent API pages', '--date=2026-07-18T16:40:00Z'], {
      cwd: workspaceDir,
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-07-18T16:40:00Z' },
    });
  }
  for (const directory of [screenshotDir, crtScreenshotDir]) {
    for (const entry of fs.readdirSync(directory)) {
      const appearanceSuffix = screenshotAppearance === 'light' ? null : screenshotAppearance;
      const requestedEntry = appearanceSuffix && directory === screenshotDir
        ? entry.replace(new RegExp(`-${appearanceSuffix}(?=\\.(?:png|jpg|jpeg)$)`, 'i'), '')
        : entry;
      const themedSuffix = /-(?:dark|paper)\.(?:png|jpg|jpeg)$/i;
      const isSelectedAppearance = appearanceSuffix
        ? directory !== screenshotDir || new RegExp(`-${appearanceSuffix}\\.(?:png|jpg|jpeg)$`, 'i').test(entry) || nativeDarkCodeScreenshots.has(entry)
        : !themedSuffix.test(entry);
      if (/^\d{2}-.*\.(?:png|jpg|jpeg)$/i.test(entry)
        && isSelectedAppearance
        && (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has(requestedEntry))) {
        fs.rmSync(path.join(directory, entry), { force: true });
      }
    }
  }
}

function themedScreenshotFileName(fileName: string, directory: string) {
  if (screenshotAppearance === 'light'
    || directory !== screenshotDir
    || nativeDarkCodeScreenshots.has(fileName)) {
    return fileName;
  }
  return fileName.replace(/(\.[^.]+)$/, `-${screenshotAppearance}$1`);
}

async function ensureApp(page, { hideUsagePanel = true } = {}) {
  await page.goto(`${basePath}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  if (hideUsagePanel) {
    await page.addStyleTag({
      content: `
        [data-testid="code-usage-panel"] {
          display: none !important;
        }
      `,
    });
  }
}

async function setDemoSettings(page, baseUrl) {
  const captureBrowserDocumentation = requestedScreenshotFiles.size === 0
    || Array.from(browserDocumentationScreenshots).some(fileName => requestedScreenshotFiles.has(fileName));
  await page.request.post(`${baseUrl}${basePath}/api/settings`, {
    data: {
      lastMainWorkspace: workspaceDir,
      workspaceHistory: [workspaceDir],
      projectNames: { [workspaceDir]: 'Northstar API' },
      instanceName: 'Farming Demo',
      appearance: screenshotAppearance,
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
      agentHomes: defaultAgentHomeSettings,
      ...(captureBrowserDocumentation ? {
        browserExtensionEnabled: true,
        browserSource: 'system',
        browserExecutablePath: executablePath || '',
      } : {}),
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
  if (requestedScreenshotFiles.size > 0 && !requestedScreenshotFiles.has(fileName)) return;
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
        'system-time': '2026-08-06 09:00:00',
        uptime: '12m 34s',
      };
      for (const [id, value] of Object.entries(replacements)) {
        const node = document.getElementById(id);
        if (node) node.textContent = value;
      }
    });
  }
  const outputFileName = themedScreenshotFileName(fileName, directory);
  const publicSpec = directory === screenshotDir
    ? publicCodeScreenshotSpecs.get(fileName)
    : directory === crtScreenshotDir
      ? publicCrtScreenshotSpecs.get(fileName)
      : undefined;
  const publicOnly = directory === screenshotDir
    && (screenshotAppearance === 'paper' || publicSpec?.publicOnly === true);
  const screenshotPath = publicOnly
    ? path.join(demoRoot, 'public-screenshot-staging', outputFileName)
    : path.join(directory, outputFileName);
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
  });
  if (publicSpec) {
    const publicFileName = screenshotAppearance !== 'light'
      && directory === screenshotDir
      && !nativeDarkCodeScreenshots.has(fileName)
      ? publicSpec.fileName.replace(/(\.[^.]+)$/, `-${screenshotAppearance}$1`)
      : publicSpec.fileName;
    const publicPath = path.join(publicScreenshotDir, publicFileName);
    if (publicSpec.clip) {
      await page.screenshot({
        path: publicPath,
        fullPage: false,
        clip: publicSpec.clip,
      });
    } else {
      fs.copyFileSync(screenshotPath, publicPath);
    }
  }
  capturedScreenshotFiles.add(fileName);
}

async function waitForBrowserPage(page, baseUrl, browserId, expectedTitle, expectedContent) {
  const startedAt = Date.now();
  let lastTitle = '';
  let lastContent = '';
  while (Date.now() - startedAt < 30_000) {
    const response = await page.request.post(`${baseUrl}${basePath}/api/browsers/${encodeURIComponent(browserId)}/action`, {
      data: { kind: 'snapshot' },
    });
    if (response.ok()) {
      const snapshot = await response.json();
      lastTitle = String(snapshot.title || '');
      lastContent = String(snapshot.accessibilityTree || '');
      if (lastTitle === expectedTitle && lastContent.includes(expectedContent)) return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(
    `Browser did not load ${expectedTitle} with ${expectedContent}; last title was ${lastTitle || '(empty)'}`,
  );
}

async function projectRootId(page) {
  const response = await page.request.get(`${basePath}/api/files/roots`);
  if (!response.ok()) throw new Error(`failed to read screenshot workspace roots: ${response.status()}`);
  const body = await response.json();
  const canonicalWorkspace = fs.realpathSync(workspaceDir);
  const root = Array.isArray(body.roots)
    ? body.roots.find(candidate => candidate.canonicalPath === canonicalWorkspace)
    : null;
  if (!root?.rootId) throw new Error(`screenshot workspace root was not registered: ${canonicalWorkspace}`);
  return root.rootId;
}

function requestedScreenshotsComplete() {
  return requestedScreenshotFiles.size > 0
    && Array.from(requestedScreenshotFiles).every(fileName => capturedScreenshotFiles.has(fileName));
}

function createUsageFixture() {
  return JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'scripts', 'fixtures', 'documentation-usage-snapshot.json'),
    'utf8',
  ));
}

async function installUsageRoutes(page, fixture) {
  await page.route(/\/api\/usage(?:\/day)?(?:\?|$)/, async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname.endsWith('/api/usage/day')) {
      if (fixture.detail) {
        await route.fulfill({ json: { detail: fixture.detail } });
        return;
      }
      const date = requestUrl.searchParams.get('date') || fixture.dailyPoints.at(-1).date;
      const point = fixture.dailyPoints.find(candidate => candidate.date === date) || fixture.dailyPoints.at(-1);
      const hourlyWeights = new Map([[3, 0.08], [8, 0.17], [10, 0.25], [14, 0.12], [18, 0.28], [22, 0.10]]);
      const breakdown = totalTokens => ({
        totalTokens,
        inputTokens: Math.round(totalTokens * 0.35),
        outputTokens: Math.round(totalTokens * 0.15),
        cacheReadTokens: Math.round(totalTokens * 0.45),
        cacheWriteTokens: Math.round(totalTokens * 0.05),
        unattributedTokens: 0,
      });
      const agentSpecs = [
        { key: 'codex:release-audit', provider: 'codex', sessionId: 'release-audit', label: 'Release audit', share: 0.72 },
        { key: 'claude:visual-review', provider: 'claude', sessionId: 'visual-review', label: 'Visual review', share: 0.20 },
        { key: 'opencode:package-smoke', provider: 'opencode', sessionId: 'package-smoke', label: 'Package smoke', share: 0.08 },
      ];
      const hours = Array.from({ length: 24 }, (_, hour) => {
        const totalTokens = Math.round(point.totalTokens * (hourlyWeights.get(hour) || 0));
        const agentTotals = agentSpecs.map((agent, index) => (
          index === agentSpecs.length - 1
            ? totalTokens - Math.round(totalTokens * 0.72) - Math.round(totalTokens * 0.20)
            : Math.round(totalTokens * agent.share)
        ));
        return {
          hour,
          label: String(hour).padStart(2, '0'),
          ...breakdown(totalTokens),
          agents: Object.fromEntries(agentSpecs.map((agent, index) => [
            agent.key,
            breakdown(agentTotals[index]),
          ])),
        };
      });
      const agents = agentSpecs.map((agent, index) => {
        const totalTokens = index === agentSpecs.length - 1
          ? point.totalTokens - Math.round(point.totalTokens * 0.72) - Math.round(point.totalTokens * 0.20)
          : Math.round(point.totalTokens * agent.share);
        return {
          key: agent.key,
          provider: agent.provider,
          sessionId: agent.sessionId,
          label: agent.label,
          ...breakdown(totalTokens),
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
            providers: Object.fromEntries(agents.map(agent => [agent.provider, breakdown(agent.totalTokens)])),
            agents,
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { usage: fixture.usage } });
  });
}

async function installShareRoutes(page) {
  let ticketSequence = 0;
  await page.route(`**${basePath}/api/share/qr-ticket**`, async route => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ json: { revoked: true } });
      return;
    }
    ticketSequence += 1;
    const code = `DEMO${String(ticketSequence).padStart(6, '0')}`;
    await route.fulfill({
      json: {
        code,
        expiresAt: Date.now() + 5 * 60 * 1000,
        ttlMs: 5 * 60 * 1000,
        shortPath: `/j/${code}`,
        shortUrl: `https://demo.example.invalid/j/${code}`,
        longUrl: `https://demo.example.invalid/farming?share=read-only-${ticketSequence}`,
        fullAccessUrl: 'https://demo.example.invalid/farming?token=full-control-demo',
        shortUrlAccessMode: 'owner',
        longUrlAccessMode: 'read-only',
        tokenLabel: 'spring-rain-softly-falls',
      },
    });
  });
}

async function captureDesktopConnections(browser, baseUrl) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await page.addInitScript({ content: `
      (() => {
        const state = {
        activeBackendId: 'local',
        profiles: [{
          id: 'local',
          kind: 'local',
          name: 'This Mac',
          transport: 'direct',
          sshHost: '',
          remoteHost: '127.0.0.1',
          remotePort: 0,
          basePath: '/farming',
          directUrl: 'http://127.0.0.1:43121',
          farmingHome: '/tmp/farming-desktop',
          hasToken: true,
        }, {
          id: 'remote-a',
          kind: 'remote',
          name: 'Build host',
          transport: 'ssh',
          sshHost: 'build-host',
          remoteHost: '127.0.0.1',
          remotePort: 0,
          basePath: '/farming',
          directUrl: '',
          farmingHome: '~/.farming-desktop',
          hasToken: false,
        }, {
          id: 'remote-b',
          kind: 'remote',
          name: 'GPU host',
          transport: 'ssh',
          sshHost: 'gpu-host',
          remoteHost: '127.0.0.1',
          remotePort: 0,
          basePath: '/farming',
          directUrl: '',
          farmingHome: '~/.farming-desktop',
          hasToken: false,
        }],
        connections: [{
          backendId: 'local',
          generation: 1,
          status: 'ready',
          error: '',
          message: 'Connected',
          server: null,
        }, {
          backendId: 'remote-a',
          generation: 1,
          status: 'ready',
          error: '',
          message: 'Connected',
          server: {
            version: '0.4.0',
            platform: 'linux',
            arch: 'x64',
            runtime: 'node 22',
          },
        }, {
          backendId: 'remote-b',
          generation: 0,
          status: 'disconnected',
          error: '',
          message: 'Disconnected',
          server: null,
        }],
        };
        Object.defineProperty(window, 'farmingDesktop', {
          configurable: true,
          value: {
            getState: async () => state,
            saveAndActivateBackend: async () => state,
            removeBackend: async () => state,
            connectBackend: async () => state,
            disconnectBackend: async () => state,
            activateBackend: async () => state,
            showNotification: async () => {},
            onStateChanged: () => () => {},
          },
        });
      })();
    ` });
    await page.request.post(`${baseUrl}${basePath}/api/settings`, {
      data: {
        appearance: screenshotAppearance,
        instanceName: 'Farming Desktop',
        language: 'en',
      },
    });
    await ensureApp(page);
    const desktopBridgeAvailable = await page.evaluate(() => Boolean(window.farmingDesktop));
    if (!desktopBridgeAvailable) throw new Error('desktop screenshot bridge was not installed');
    await page.getByTestId('code-nav-plugins').click();
    await page.getByTestId('desktop-connections-panel').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('desktop-connections-panel').getByText('Build host', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, '18-code-desktop-connections.png');
  } finally {
    await context.close();
  }
}

function existingChromeFixtureDocument(content: string, width: number, height: number): string {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { margin: 0; min-height: 100%; background: #eef1f5; }
          body { padding: 32px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202124; }
          #shot { width: ${width}px; height: ${height}px; overflow: hidden; background: #fff; border: 1px solid #d8dce3; border-radius: 18px; box-shadow: 0 18px 55px rgba(31, 35, 41, .16); }
          button { font: inherit; }
        </style>
      </head>
      <body><main id="shot">${content}</main></body>
    </html>`;
}

async function writeExistingChromeScreenshot(page, fileName: string): Promise<void> {
  if (requestedScreenshotFiles.size > 0 && !requestedScreenshotFiles.has(fileName)) return;
  const publicFileName = existingChromeScreenshotFiles.get(fileName);
  if (!publicFileName) throw new Error(`unknown existing Chrome screenshot: ${fileName}`);
  await page.locator('#shot').screenshot({
    path: path.join(publicScreenshotDir, publicFileName),
    animations: 'disabled',
    type: 'png',
  });
  capturedScreenshotFiles.add(fileName);
}

async function captureExistingChromeDocumentationScreenshots(browser, baseUrl) {
  const requested = requestedScreenshotFiles.size === 0
    || Array.from(existingChromeScreenshotFiles.keys()).some(fileName => requestedScreenshotFiles.has(fileName));
  if (!requested) return;

  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const en = screenshotLocale === 'en';
  const copy = en ? {
    chooserTitle: 'Select the extension directory',
    favorites: 'Favorites',
    applications: 'Applications',
    documents: 'Documents',
    downloads: 'Downloads',
    name: 'Name',
    modified: 'Date Modified',
    today: 'Today, 4:27 PM',
    cancel: 'Cancel',
    select: 'Select',
    extensions: 'Extensions',
    connectorDescription: 'Let Agents in Farming use your browser.',
    details: 'Details',
    remove: 'Remove',
  } : {
    chooserTitle: '选择扩展程序目录',
    favorites: '个人收藏',
    applications: '应用程序',
    documents: '文稿',
    downloads: '下载',
    name: '名称',
    modified: '修改日期',
    today: '今天 16:27',
    cancel: '取消',
    select: '选择',
    extensions: '扩展程序',
    connectorDescription: '让 Farming 中的 Agent 使用你的浏览器。',
    details: '详细信息',
    remove: '删除',
  };
  const iconData = fs.readFileSync(
    path.join(repoRoot, 'extensions', 'browser', 'chrome-extension', 'icons', 'farming-128.png'),
  ).toString('base64');
  const icon = `data:image/png;base64,${iconData}`;

  try {
    if (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has('26-existing-chrome-install.png')) {
      await setDemoSettings(page, baseUrl);
      await page.request.post(`${baseUrl}${basePath}/api/settings`, {
        data: { language: en ? 'en' : 'zh' },
      });
      await ensureApp(page);
      await page.getByTestId('code-nav-plugins').click();
      const pluginsPanel = page.getByTestId('code-plugins-panel');
      await pluginsPanel.waitFor({ state: 'visible', timeout: 20_000 });
      await pluginsPanel.getByTestId('code-plugin-tab-farming').click();
      const browserPlugin = pluginsPanel.getByTestId('code-plugin-browser');
      await browserPlugin.waitFor({ state: 'visible', timeout: 20_000 });
      await browserPlugin.getByRole('button', {
        name: en ? 'Disable' : '停用',
      }).waitFor({ state: 'visible', timeout: 20_000 });
      await browserPlugin.getByText(en ? 'Available' : '可用', { exact: true })
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 });
      const prepareConnector = browserPlugin.getByRole('button', {
        name: en ? 'Prepare Chrome extension folder' : '准备 Chrome 扩展目录',
      });
      await prepareConnector.waitFor({ state: 'visible', timeout: 20_000 });
      await prepareConnector.click();
      await browserPlugin.getByRole('button', {
        name: en ? 'Remove Chrome extension folder' : '删除 Chrome 扩展目录',
      }).waitFor({ state: 'visible', timeout: 20_000 });
      const connectorPath = browserPlugin.getByTestId('browser-connector-directory');
      await connectorPath.waitFor({ state: 'visible', timeout: 20_000 });
      await connectorPath.evaluate(element => {
        element.textContent = '~/farming-browser-connector';
        element.setAttribute('title', '~/farming-browser-connector');
      });
      await browserPlugin.screenshot({
        path: path.join(
          publicScreenshotDir,
          existingChromeScreenshotFiles.get('26-existing-chrome-install.png') as string,
        ),
        animations: 'disabled',
        type: 'png',
      });
      capturedScreenshotFiles.add('26-existing-chrome-install.png');
    }

    await page.setContent(existingChromeFixtureDocument(`
      <header style="height:88px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid #dadde3;font-size:20px;font-weight:600;position:relative">
        ${copy.chooserTitle}
      </header>
      <section style="display:grid;grid-template-columns:250px 1fr;height:530px">
        <aside style="padding:26px 22px;background:#f4f5f7;border-right:1px solid #d8dce3">
          <div style="font-size:14px;color:#737780;font-weight:600;margin-bottom:16px">${copy.favorites}</div>
          <div style="display:grid;gap:18px;font-size:18px">
            <div>▦&nbsp;&nbsp;${copy.applications}</div><div>▤&nbsp;&nbsp;${copy.documents}</div><div>⇩&nbsp;&nbsp;${copy.downloads}</div>
          </div>
        </aside>
        <div style="padding:22px 26px">
          <div style="display:grid;grid-template-columns:1fr 220px;color:#737780;font-size:15px;border-bottom:1px solid #d8dce3;padding:0 14px 12px">
            <span>${copy.name}</span><span>${copy.modified}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 220px;align-items:center;margin-top:10px;padding:14px;border-radius:9px;background:#1a73e8;color:#fff;font-size:18px">
            <strong>📁&nbsp;&nbsp;farming-browser-connector</strong><span>${copy.today}</span>
          </div>
        </div>
      </section>
      <footer style="height:92px;display:flex;align-items:center;justify-content:flex-end;gap:14px;padding:0 28px;border-top:1px solid #d8dce3;background:#fafafa">
        <button style="padding:11px 24px;border:1px solid #c8ccd3;border-radius:9px;background:#fff">${copy.cancel}</button>
        <button style="padding:11px 24px;border:0;border-radius:9px;background:#1a73e8;color:#fff;font-weight:600">${copy.select}</button>
      </footer>
    `, 1180, 710));
    await writeExistingChromeScreenshot(page, '27-existing-chrome-select-folder.png');

    await page.setContent(existingChromeFixtureDocument(`
      <div style="height:72px;display:flex;align-items:center;gap:16px;padding:0 24px;border-bottom:1px solid #dadde3;background:#f8f9fa">
        <span style="font-size:26px">←</span><div style="height:42px;flex:1;border-radius:21px;background:#eef1f5"></div><span style="font-size:22px">⋮</span>
      </div>
      <section style="width:560px;margin:34px 34px 0 auto;border:1px solid #d8dce3;border-radius:14px;box-shadow:0 16px 42px rgba(31,35,41,.18);overflow:hidden">
        <h1 style="font-size:22px;margin:0;padding:22px 24px;border-bottom:1px solid #e4e7eb">${copy.extensions}</h1>
        <div style="display:grid;grid-template-columns:56px 1fr 44px;align-items:center;gap:14px;padding:22px 24px">
          <img src="${icon}" width="48" height="48" style="border-radius:50%">
          <div><strong style="display:block;font-size:18px">Farming Browser Connector</strong><span style="display:block;margin-top:5px;color:#68707c">${copy.connectorDescription}</span></div>
          <span style="font-size:24px;color:#5f6368">📌</span>
        </div>
      </section>
    `, 1180, 520));
    await writeExistingChromeScreenshot(page, '28-existing-chrome-menu.png');

    await page.setContent(existingChromeFixtureDocument(`
      <header style="height:92px;display:flex;align-items:center;padding:0 42px;border-bottom:1px solid #dadde3;font-size:28px">${copy.extensions}</header>
      <section style="padding:46px">
        <article style="width:720px;min-height:300px;border:1px solid #d8dce3;border-radius:16px;box-shadow:0 5px 16px rgba(31,35,41,.14);padding:30px">
          <div style="display:grid;grid-template-columns:72px 1fr;gap:20px;align-items:center">
            <img src="${icon}" width="64" height="64" style="border-radius:50%">
            <div><strong style="font-size:22px">Farming Browser Connector</strong><p style="font-size:17px;color:#68707c;margin:8px 0 0">${copy.connectorDescription}</p></div>
          </div>
          <div style="display:flex;align-items:center;gap:14px;margin-top:58px">
            <button style="padding:11px 24px;border:1px solid #aecbfa;border-radius:22px;background:#fff;color:#1967d2;font-weight:600">${copy.details}</button>
            <button style="padding:11px 24px;border:1px solid #aecbfa;border-radius:22px;background:#fff;color:#1967d2;font-weight:600">${copy.remove}</button>
            <span style="margin-left:auto;width:44px;height:24px;border-radius:12px;background:#1a73e8;position:relative"><i style="position:absolute;right:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff"></i></span>
          </div>
        </article>
      </section>
    `, 1180, 520));
    await writeExistingChromeScreenshot(page, '29-existing-chrome-remove.png');
  } finally {
    await context.close();
  }
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

async function openNewAgentDialog(page) {
  await page.getByTestId('code-new-agent').click();
  await page.getByTestId('input-dialog').waitFor({ state: 'visible', timeout: 20_000 });
}

async function closeNewAgentDialog(page) {
  await page.getByTestId('input-dialog-close').click();
  await page.getByTestId('input-dialog').waitFor({ state: 'hidden', timeout: 20_000 });
}

async function projectNorthstarChat(page, { mobile = false } = {}) {
  await page.evaluate(({ version, mobileLayout }) => {
    const replacements = new Map([
      [`Audit terminal recovery for the v${version} release. Keep a rich timeline and produce the release readiness story with evidence and residual risk.`, 'Fix duplicate items in the users API pagination. Keep the response contract stable, add bounded retry, and verify page boundaries.'],
      ['Release decision · Ready', 'Pagination duplicates fixed'],
      ['Release readiness is confirmed.', 'The users endpoint now returns each record once across page boundaries.'],
      ['Gate', 'Case'],
      ['Evidence', 'Before'],
      ['Result', 'After'],
      ['Source + backend', 'Page boundary'],
      ['182 checks', 'duplicate user_104'],
      ['Cross-skin recovery', 'Concurrent refresh'],
      ['12 scenarios', 'overlap reproduced'],
      ['Terminal input', 'Retry policy'],
      ['p95 59 ms / 250 ms', 'unbounded'],
      ['Release artifacts', 'Regression tests'],
      ['6 bundles verified', '8 cases'],
      ['Passed', 'Fixed'],
      ['What is now proven', 'What changed'],
      ['Code and CRT restore one exact checkpoint before live output resumes.', 'The cursor advances only after the last accepted record, so adjacent pages cannot overlap.'],
      ['Gap, epoch change, and hidden-page recovery converge on the authoritative PTY state.', 'Transient 429 and 503 responses retry at most three times with capped backoff.'],
      ['Residual risk:', 'Verification:'],
      ['none in the supported WebGL path.', '8 focused tests pass; the existing JSON response shape is unchanged.'],
      ['Inspect terminal recovery protocol', 'Inspect pagination cursor flow'],
      ['Update recovery invariant test', 'Patch bounded retry and dedupe'],
      ['Run cross-skin verification', 'Run API pagination tests'],
      ['Trace the authoritative checkpoint state', 'Reproduce the page overlap'],
      ['Exercise reconnect and gap recovery', 'Patch cursor and retry guards'],
      ['Verify release gates and residual risk', 'Run focused regression tests'],
      ['The PTY host owns the exact screen state. I am checking reconnect, hidden-page resume, and cross-skin continuity against that boundary.', 'I reproduced the duplicate at a page boundary, then traced cursor advancement and retry behavior through the request path.'],
      ['docs/products/code/terminal-state-protocol.md', 'src/api/users.ts'],
      ['tests/e2e/terminal-cross-skin-recovery.spec.ts', 'tests/api/users-pagination.test.ts'],
      ['atlas-control-plane', 'Northstar API'],
    ]);
    const walker = document.createTreeWalker(document.body, window.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue) {
        for (const [before, after] of replacements) {
          node.nodeValue = node.nodeValue.replaceAll(before, after);
        }
      }
      node = walker.nextNode();
    }

    document.querySelectorAll('.code-agent-transcript-process-title-text').forEach((title) => {
      if (title.textContent.trim() !== 'Reasoning') return;
      const row = title.closest('.code-agent-transcript-process-item, .code-agent-transcript-process-group');
      if (row instanceof HTMLElement) row.style.display = 'none';
    });

    const changeSummary = document.querySelector('[data-testid="code-agent-transcript-result-summary"]');
    const summaryLabel = changeSummary && changeSummary.querySelector(':scope > span');
    const added = changeSummary && changeSummary.querySelector('.added');
    const removed = changeSummary && changeSummary.querySelector('.removed');
    if (summaryLabel) summaryLabel.textContent = '3 files changed';
    if (added) added.textContent = '+42';
    if (removed) removed.textContent = '-18';
    if (changeSummary) changeSummary.setAttribute('aria-label', '3 files changed. Show changes');

    let style = document.getElementById('northstar-screenshot-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'northstar-screenshot-style';
      style.textContent = [
        '.code-agent-transcript-process-item.plan,',
        '.code-acp-progress-update { display: none !important; }',
        '.code-agent-transcript-assistant table { min-width: 470px; }',
        'body.code-mobile-touch .code-agent-transcript-process { display: none !important; }',
        'body.code-mobile-touch .code-agent-transcript-assistant table { min-width: 0; }',
      ].join('\n');
      document.head.appendChild(style);
    }

    if (!mobileLayout) return;
    document.body.classList.add('code-mobile-touch');
    const turn = document.querySelector('.code-agent-transcript-turn');
    const userMessage = turn && turn.querySelector('.code-agent-transcript-user > div');
    if (userMessage) userMessage.textContent = 'Fix duplicate users across API page boundaries and keep retries bounded.';
    const answer = turn && turn.querySelector('.code-agent-transcript-assistant');
    if (answer) {
      answer.innerHTML = [
        '<h2>Pagination duplicates fixed</h2>',
        '<p><small>Northstar API · Agent running on development machine</small></p>',
        '<p>Each user now appears once when the client loads consecutive pages.</p>',
        '<ul>',
        '<li>The cursor advances after the last accepted record.</li>',
        '<li>429 and 503 responses retry at most three times.</li>',
        '<li>Adjacent pages no longer return duplicate IDs.</li>',
        '</ul>',
        '<p>The client now follows the returned cursor without overlapping adjacent pages.</p>',
        '<h3>Verification</h3>',
        '<ul>',
        '<li>Eight focused boundary tests pass.</li>',
        '<li>The existing JSON response contract is unchanged.</li>',
        '</ul>',
      ].join('');
    }
  }, { version: packageVersion, mobileLayout: mobile });
}

async function projectDocsPreviewChat(page) {
  await page.evaluate((locale) => {
    const copy = locale === 'en'
      ? {
          user: 'Refine the Farming documentation home page and keep the Paper palette restrained.',
          heading: 'Documentation home updated',
          intro: 'The rendered page now uses the current documentation home and keeps the primary action clear.',
          changes: 'What changed',
          bullets: [
            'Aligned the hero and navigation spacing.',
            'Kept the existing documentation content and structure.',
            'Verified the page in the selected appearance.',
          ],
          verification: 'Verification: the HTML preview is ready for visual review.',
        }
      : {
          user: '调整 Farming 文档首页，并保持 Paper 配色克制。',
          heading: '文档首页已更新',
          intro: '渲染后的页面沿用当前文档首页，并保持主要操作清晰。',
          changes: '本轮调整',
          bullets: [
            '对齐 Hero 与导航间距。',
            '保留现有文档内容和结构。',
            '在当前外观下核对页面效果。',
          ],
          verification: '验证：HTML 预览已可用于视觉检查。',
        };
    const turn = document.querySelector('.code-agent-transcript-turn');
    const userMessage = turn?.querySelector('.code-agent-transcript-user > div');
    if (userMessage) {
      userMessage.textContent = copy.user;
    }
    const answer = turn?.querySelector('.code-agent-transcript-assistant');
    if (answer) {
      answer.innerHTML = [
        `<h2>${copy.heading}</h2>`,
        `<p>${copy.intro}</p>`,
        `<h3>${copy.changes}</h3>`,
        '<ul>',
        ...copy.bullets.map(item => `<li>${item}</li>`),
        '</ul>',
        `<p><strong>${copy.verification}</strong></p>`,
      ].join('');
    }
    const changeSummary = document.querySelector('[data-testid="code-agent-transcript-result-summary"]');
    const summaryLabel = changeSummary?.querySelector(':scope > span');
    const added = changeSummary?.querySelector('.added');
    const removed = changeSummary?.querySelector('.removed');
    if (summaryLabel) summaryLabel.textContent = '2 files changed';
    if (added) added.textContent = '+28';
    if (removed) removed.textContent = '-12';
  }, screenshotLocale);
}

async function stabilizeCrtDashboard(page) {
  await page.addStyleTag({
    content: [
      '#farming-crt .agent-output-afterimage { display: none !important; }',
      '#farming-crt .agent-block.working .agent-output:not(.structured-preview) { animation: none !important; }',
      '#farming-crt #map-area .agent-block.unread:not(:hover) { box-shadow: 0 0 7px rgba(12, 204, 104, 0.15), inset 0 0 10px rgba(12, 204, 104, 0.025) !important; }',
    ].join('\n'),
  });
}

async function main() {
  prepareRuntimeDirectories();

  const needsDocumentationHome = requestedScreenshotFiles.size === 0
    || Array.from(documentationHomeScreenshots).some(fileName => requestedScreenshotFiles.has(fileName));
  let documentationSite: Awaited<ReturnType<typeof startDocumentationSite>> | null = null;

  console.log('Building Farming Code front-end...');
  run('npm', ['run', 'build'], {
    cwd: repoRoot,
    env: { ...process.env, FARMING_BASE_PATH: basePath },
    stdio: 'inherit',
  });

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverProcess = spawn(process.execPath, [tsxCliPath, path.join(repoRoot, 'scripts', 'start-playwright-server.ts')], {
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
      ...((requestedScreenshotFiles.size === 0
        || Array.from(browserDocumentationScreenshots).some(fileName => requestedScreenshotFiles.has(fileName)))
        && fs.existsSync(localAgentBrowserPath)
        ? {
            FARMING_AGENT_BROWSER_BIN: localAgentBrowserPath,
            FARMING_AGENT_BROWSER_EXECUTABLE: localAgentBrowserPath,
          }
        : {}),
      AGENT_BROWSER_SOCKET_DIR: agentBrowserSocketDir,
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
    if (needsDocumentationHome) {
      documentationSite = await startDocumentationSite();
    }
    await waitForServer(`${baseUrl}${basePath}/`);
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--proxy-server=direct://', '--proxy-bypass-list=*'],
    });
    await captureExistingChromeDocumentationScreenshots(browser, baseUrl);
    if (requestedScreenshotsComplete()) return;
    if (documentationSite) await writeDocumentationHomeFixture(documentationSite, browser);
    if (
      requestedScreenshotFiles.size === 1
      && requestedScreenshotFiles.has('18-code-desktop-connections.png')
    ) {
      await captureDesktopConnections(browser, baseUrl);
      return;
    }
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 1440, height: 810 },
      deviceScaleFactor: 1,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    await context.addInitScript(() => {
      window.__FARMING_E2E__ = true;
    });
    const page = await context.newPage();
    const usageFixture = createUsageFixture();

    await page.route(`**${basePath}/api/codex/models`, route => route.fulfill({
      json: { catalog: matrixCatalog, source: 'fixture' },
    }));
    await installShareRoutes(page);
    await installSessionSearchRoute(page);
    await installUsageRoutes(page, usageFixture);
    await ensureApp(page);
    await setDemoSettings(page, baseUrl);
    await ensureApp(page);

    if (
      requestedScreenshotFiles.size === 1
      && requestedScreenshotFiles.has('15-code-usage-activity.png')
    ) {
      await startDemoAgent(page, baseUrl);
      await ensureApp(page, { hideUsagePanel: false });
      await page.waitForTimeout(2500);
      const usageToggle = page.getByTestId('code-usage-toggle');
      if (await usageToggle.getAttribute('aria-expanded') !== 'true') {
        await usageToggle.evaluate(element => element.click());
      }
      const usagePanel = page.getByTestId('code-usage-panel');
      await usagePanel.getByTestId('code-usage-daily-heatmap').waitFor({ state: 'attached', timeout: 20_000 });
      await usagePanel.getByTestId('code-usage-open-year').evaluate(element => element.click());
      const usageDialog = page.getByTestId('code-usage-detail-dialog');
      await usageDialog.waitFor({ state: 'visible', timeout: 20_000 });
      await usageDialog.getByTestId('code-usage-day-histogram').waitFor({ state: 'visible', timeout: 20_000 });
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addStyleTag({
        content: `
          [data-testid='code-usage-detail-dialog'] {
            max-height: calc(100vh - 48px) !important;
          }
        `,
      });
      await screenshot(page, '15-code-usage-activity.png');
      return;
    }

    await screenshot(page, '00-code-welcome.png');
    if (requestedScreenshotsComplete()) return;

    if (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has('19-code-agent-homes.png')) {
      await page.request.post(`${baseUrl}${basePath}/api/settings`, {
        data: { agentHomes: multipleAgentHomeSettings },
      });
      await page.getByTestId('code-nav-plugins').click();
      await page.getByTestId('code-plugins-panel').waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByTestId('code-plugin-tab-homes').click();
      await page.getByTestId('code-plugin-agent-sections').waitFor({ state: 'visible', timeout: 20_000 });
      await screenshot(page, '19-code-agent-homes.png');
      if (requestedScreenshotsComplete()) return;
      await setDemoSettings(page, baseUrl);
      await page.getByTestId('code-plugins-panel').getByRole('button', { name: 'Back', exact: true }).click();
    }

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
    await updateAgent(page, baseUrl, codexAgentId, { customTitle: 'Fix duplicate page items' });
    await updateAgent(page, baseUrl, codexAgentId, { pinned: true });
    await updateAgent(page, baseUrl, terminalAgentId, { customTitle: 'Pagination regression' });
    await updateAgent(page, baseUrl, claudeAgentId, { customTitle: 'Settings UI check' });
    await updateAgent(page, baseUrl, shellAgentId, { customTitle: 'Inspect pagination changes' });

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
      "printf '$ git log --oneline -3\\n'",
      'git log --oneline -3',
      "printf '\\n$ git diff --stat\\n'",
      'git diff --stat',
      "printf '\\n$ git diff --check\\n'",
      "git diff --check && printf 'no whitespace errors\\n'",
      "printf '\\n$ git status --short\\n'",
      'git status --short',
      'stty echo',
    ].join('; ') + '\r');
    await waitForAgentOutput(page, baseUrl, shellAgentId, 'no whitespace errors');
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
    await acpInput.fill(`Audit terminal recovery for the v${packageVersion} release. Keep a rich timeline and produce the release readiness story with evidence and residual risk.`);
    await page.getByTestId('code-acp-composer-send').click();
    await page.getByText('Release readiness is confirmed.', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });

    await Promise.all([
      codexAgentId,
      terminalAgentId,
      claudeAgentId,
      shellAgentId,
    ].map(agentId => updateAgent(page, baseUrl, agentId, { unread: false })));
    await page.waitForFunction(() => !document.querySelector('.code-agent-unread, .code-project-agent-compact-unread'));
    await waitForFileTree(page);
    const richTurn = page.locator('.code-agent-transcript-turn').last();
    await richTurn.getByTestId('code-agent-transcript-process-summary').click();
    await richTurn.getByTestId('code-agent-transcript-process-group').first().waitFor({ state: 'visible', timeout: 20_000 });
    await projectNorthstarChat(page);
    await page.getByTestId('code-agent-transcript-scroll').evaluate((element) => {
      element.scrollTop = 0;
    });

    if (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has('20-code-share-chat.png')) {
      await page.getByTestId('code-agent-transcript-share-answer').last().click();
      await page.getByTestId('code-copy-toast').waitFor({ state: 'visible', timeout: 20_000 });
      await screenshot(page, '20-code-share-chat.png');
      if (requestedScreenshotsComplete()) return;
    }

    if (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has('22-code-share-qr.png')) {
      await page.getByTestId('code-share-button').click();
      const sharePopover = page.getByTestId('code-share-popover');
      await sharePopover.waitFor({ state: 'visible', timeout: 20_000 });
      await sharePopover.locator('svg[aria-label="QR code"]').waitFor({ state: 'visible', timeout: 20_000 });
      await screenshot(page, '22-code-share-qr.png');
      if (requestedScreenshotsComplete()) return;
      await page.getByTestId('code-share-button').click();
    }

    await screenshot(page, '01-code-workspace.png');
    if (requestedScreenshotsComplete()) return;

    const processGroup = richTurn.getByTestId('code-agent-transcript-process-group')
      .filter({ hasText: 'Read a file, edited a file, ran a command' })
      .first();
    await processGroup.getByTestId('code-agent-transcript-process-group-toggle').click();
    await processGroup.getByText('Run cross-skin verification', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    await projectNorthstarChat(page);
    await processGroup.getByText('Run API pagination tests', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('code-agent-transcript-scroll').evaluate((element) => {
      element.scrollTop = Math.min(112, element.scrollHeight - element.clientHeight);
    });
    await waitForStableUi(page, 300);
    await screenshot(page, '11-code-agent-process.png');
    if (requestedScreenshotsComplete()) return;

    await page.setViewportSize({ width: 390, height: 844 });
    await projectNorthstarChat(page, { mobile: true });
    await page.getByTestId('code-agent-transcript-scroll').evaluate((element) => {
      element.scrollTop = 0;
    });
    await waitForStableUi(page, 500);
    const mobileResultCard = page.getByTestId('code-agent-transcript-result-card').last();
    const mobileResultGeometry = await mobileResultCard.evaluate(element => {
      const summary = element.querySelector('.code-agent-transcript-result-summary')?.getBoundingClientRect();
      const actions = element.querySelector('.code-agent-transcript-result-actions')?.getBoundingClientRect();
      return summary && actions
        ? { summaryRight: summary.right, actionsLeft: actions.left }
        : null;
    });
    if (mobileResultGeometry && mobileResultGeometry.summaryRight > mobileResultGeometry.actionsLeft + 1) {
      throw new Error('mobile result summary overlaps its actions');
    }
    await screenshot(page, '05-mobile-agent-chat.png');
    if (requestedScreenshotsComplete()) return;
    await page.setViewportSize({ width: 1440, height: 810 });
    await page.evaluate(() => document.body.classList.remove('code-mobile-touch'));
    await ensureApp(page);
    await openAgent(page, codexAgentId);

    await openNewAgentDialog(page);
    await screenshot(page, '02-start-agent-picker.png');
    if (requestedScreenshotsComplete()) return;
    await closeNewAgentDialog(page);

    await openAgent(page, codexAgentId);
    await Promise.all([
      updateAgent(page, baseUrl, codexAgentId, { unread: false }),
      updateAgent(page, baseUrl, terminalAgentId, { unread: false }),
      updateAgent(page, baseUrl, claudeAgentId, { unread: false }),
      updateAgent(page, baseUrl, shellAgentId, { unread: false }),
    ]);
    const filesSection = page.getByTestId('code-files-section').first();
    const filesToggle = filesSection.getByRole('button', { name: /^Files$/ });
    if (await filesToggle.getAttribute('aria-expanded') === 'false') await filesToggle.click();
    const docsDirectory = filesSection.locator('[data-testid="code-file-row"][data-file-path="docs"]');
    await docsDirectory.waitFor({ state: 'visible', timeout: 20_000 });
    if (await docsDirectory.getAttribute('aria-expanded') === 'false') await docsDirectory.click();
    const relationalOperatorsFile = filesSection.locator('[data-testid="code-file-row"][data-file-path="docs/relational-operators.md"]');
    await relationalOperatorsFile.waitFor({ state: 'visible', timeout: 20_000 });
    await relationalOperatorsFile.click();
    const markdownPreview = page.getByTestId('code-file-markdown-preview');
    await page.getByTestId('code-file-editor').waitFor({ state: 'visible', timeout: 20_000 });
    if (!await markdownPreview.isVisible()) {
      await page.getByTestId('code-file-editor').locator('.code-file-editor-action.source-preview').click();
    }
    await markdownPreview.waitFor({ state: 'visible', timeout: 20_000 });
    const operatorSummaryHeading = markdownPreview.getByRole('heading', { name: 'Relational Operator Definition Summary' });
    await operatorSummaryHeading.waitFor({ state: 'visible', timeout: 20_000 });
    await markdownPreview.locator('.katex-display').first().waitFor({ state: 'visible', timeout: 20_000 });
    await markdownPreview.evaluate((panel: HTMLElement) => {
      const heading = Array.from(panel.querySelectorAll<HTMLElement>('h2')).find(element => (
        element.textContent?.includes('Relational Operator Definition Summary')
      ));
      if (heading instanceof HTMLElement) panel.scrollTop = Math.max(0, heading.offsetTop - 24);
    });
    await Promise.all([
      codexAgentId,
      terminalAgentId,
      claudeAgentId,
      shellAgentId,
    ].map(agentId => updateAgent(page, baseUrl, agentId, { unread: false })));
    await page.waitForFunction(() => !document.querySelector('.code-agent-unread, .code-project-agent-compact-unread'));
    await waitForStableUi(page, 1000);
    if (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has('21-code-share-file.png')) {
      await page.getByTestId('code-file-editor-share').click();
      await page.getByTestId('code-copy-toast').waitFor({ state: 'visible', timeout: 20_000 });
      await screenshot(page, '21-code-share-file.png');
      if (requestedScreenshotsComplete()) return;
    }
    await screenshot(page, '04-files-markdown-preview.png');
    if (requestedScreenshotsComplete()) return;

    if (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has('23-code-files-html-chat.png')) {
      await openAgent(page, codexAgentId);
      const farmingHomeFile = filesSection.locator('[data-testid="code-file-row"][data-file-path="docs/farming-home.html"]');
      await farmingHomeFile.waitFor({ state: 'visible', timeout: 20_000 });
      await farmingHomeFile.click();
      const htmlPreview = page.getByTestId('code-file-html-preview');
      await htmlPreview.waitFor({ state: 'visible', timeout: 20_000 });
      const htmlFrame = page.frameLocator('[data-testid="code-file-html-preview"]');
      await htmlFrame.getByRole('img', { name: documentationSiteTitle(), exact: true })
        .waitFor({ state: 'visible', timeout: 20_000 });
      const fileEditor = page.getByTestId('code-file-editor');
      await fileEditor.getByRole('button', { name: 'Show Agent beside resource' }).click();
      await page.getByTestId('code-main').waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForFunction(() => document.querySelector('[data-testid="code-main"]')?.classList.contains('resource-agent-side-open'));
      await page.getByTestId('code-agent-chat-view').waitFor({ state: 'visible', timeout: 20_000 });
      await projectDocsPreviewChat(page);
      await page.getByRole('heading', { name: screenshotLocale === 'en' ? 'Documentation home updated' : '文档首页已更新' })
        .waitFor({ state: 'visible', timeout: 20_000 });
      await screenshot(page, '23-code-files-html-chat.png');
      if (requestedScreenshotsComplete()) return;
      await fileEditor.getByRole('button', { name: 'Hide Agent beside resource' }).click();
    }

    const shouldCaptureBrowserDocumentation = requestedScreenshotFiles.size === 0
      || Array.from(browserDocumentationScreenshots).some(fileName => requestedScreenshotFiles.has(fileName));
    if (shouldCaptureBrowserDocumentation) {
      if (!fs.existsSync(localAgentBrowserPath)) {
        throw new Error(`agent-browser ${localAgentBrowserPath} is required for documentation screenshots`);
      }
      if (!executablePath) throw new Error('A local Chromium browser is required for documentation screenshots');
      if (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has('25-code-browser-plugin.png')) {
        await page.getByTestId('code-nav-plugins').click();
        const pluginsPanel = page.getByTestId('code-plugins-panel');
        await pluginsPanel.waitFor({ state: 'visible', timeout: 20_000 });
        await pluginsPanel.getByTestId('code-plugin-tab-farming').click();
        const browserPlugin = pluginsPanel.getByTestId('code-plugin-browser');
        await browserPlugin.waitFor({ state: 'visible', timeout: 20_000 });
        await browserPlugin.getByRole('button', { name: 'Disable' }).waitFor({ state: 'visible', timeout: 20_000 });
        await screenshot(page, '25-code-browser-plugin.png');
        if (requestedScreenshotsComplete()) return;
        await pluginsPanel.getByRole('button', { name: 'Back', exact: true }).click();
      }

      if (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has('24-code-browser-docs.png')) {
        if (!documentationSite) throw new Error('documentation site was not started');
        await updateAgent(page, baseUrl, codexAgentId, { customTitle: 'Review Farming documentation' });
        try {
          const rootId = await projectRootId(page);
          const createResponse = await page.request.post(`${baseUrl}${basePath}/api/browsers`, {
            data: {
              rootId,
              agentId: codexAgentId,
              name: 'Farming documentation',
              url: documentationSite.url,
            },
          });
          if (!createResponse.ok()) {
            throw new Error(`failed to create documentation Browser: ${createResponse.status()} ${await createResponse.text()}`);
          }
          const createdBrowser = await createResponse.json();
          const startResponse = await page.request.post(`${baseUrl}${basePath}/api/browsers/${encodeURIComponent(createdBrowser.id)}/start`);
          if (!startResponse.ok()) {
            throw new Error(`failed to start documentation Browser: ${startResponse.status()} ${await startResponse.text()}`);
          }
          await waitForBrowserPage(
            page,
            baseUrl,
            createdBrowser.id,
            documentationSite.title,
            screenshotLocale === 'en'
              ? 'A browser workspace for AI coding agents'
              : '浏览器中的 AI Coding Agent 工作区',
          );
          await ensureApp(page);
          await openAgent(page, codexAgentId);
          const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${codexAgentId}"]`).first();
          const resourcesToggle = agentRow.getByTestId('code-agent-resources-toggle');
          await resourcesToggle.waitFor({ state: 'visible', timeout: 20_000 });
          if (await resourcesToggle.getAttribute('aria-expanded') !== 'true') {
            await resourcesToggle.evaluate(element => (element as HTMLButtonElement).click());
          }
          const resourceSlot = page.locator(`[data-testid="code-agent-resource-slot"][data-agent-id="${codexAgentId}"]`);
          const browserRow = resourceSlot.getByTestId('farming-browser-row').filter({ hasText: 'Farming documentation' });
          await browserRow.waitFor({ state: 'visible', timeout: 20_000 });
          await browserRow.click();
          const viewer = page.getByTestId('farming-browser-viewer');
          await viewer.waitFor({ state: 'visible', timeout: 20_000 });
          await viewer.locator('canvas').waitFor({ state: 'visible', timeout: 20_000 });
          const addressInput = viewer.getByRole('textbox', { name: 'Browser address' });
          await addressInput.waitFor({ state: 'visible', timeout: 20_000 });
          const publicDisplayUrl = documentationSite.publicUrl;
          await addressInput.evaluate((element, value) => {
            const input = element as HTMLInputElement;
            input.value = value;
            input.setAttribute('value', value);
          }, publicDisplayUrl);
          await browserRow.evaluate((element, value) => {
            const subtitle = element.querySelector('.farming-browser-row-detail');
            if (subtitle) subtitle.textContent = value;
          }, new URL(documentationSite.publicUrl).host + new URL(documentationSite.publicUrl).pathname + new URL(documentationSite.publicUrl).search);
          await screenshot(page, '24-code-browser-docs.png');
          if (requestedScreenshotsComplete()) return;
        } finally {
          await updateAgent(page, baseUrl, codexAgentId, { customTitle: 'Fix duplicate page items' }).catch(() => {});
        }
      }
    }

    await openAgent(page, terminalAgentId);
    await writeTerminalFixture(page, terminalAgentId, `\u001b[2J\u001b[H${createWorkspaceTerminalTranscript()}`);
    await page.getByTestId('code-composer-model-picker').click();
    await page.getByTestId('code-model-matrix-picker').waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, '07-live-model-controls.png');
    await page.keyboard.press('Escape');
    await page.getByTestId('code-model-matrix-picker').waitFor({ state: 'hidden', timeout: 20_000 });
    const composerCollapse = page.getByTestId('code-composer-collapse');
    if (await composerCollapse.isVisible()) await composerCollapse.evaluate(element => element.click());
    await page.getByTestId('code-composer-restore-bar').waitFor({ state: 'visible', timeout: 20_000 });
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
    await releaseHistoryCards.nth(2).waitFor({ state: 'visible', timeout: 20_000 });
    await waitForStableUi(page, 400);
    await screenshot(page, '08-history-search.png');

    await page.keyboard.press('Escape');
    const latestScreenshotVersion = packageVersion.replace(
      /(\d+)$/,
      value => String(Number(value) + 1),
    );
    await page.route(`**${basePath}/api/update*`, route => route.fulfill({
      json: {
        update: {
          method: 'npm',
          current: {
            releaseVersion: packageVersion,
            packageVersion,
            type: 'npm',
          },
          latest: {
            version: latestScreenshotVersion,
            assetName: latestScreenshotVersion,
            blockedReason: '',
          },
          selected: {
            version: latestScreenshotVersion,
            assetName: latestScreenshotVersion,
            available: true,
            installable: true,
          },
          versions: [{
            version: latestScreenshotVersion,
            assetName: latestScreenshotVersion,
            available: true,
            installable: true,
          }],
          available: true,
          installable: true,
          state: {
            phase: 'idle',
            version: latestScreenshotVersion,
            previousVersion: packageVersion,
          },
        },
      },
    }));
    await page.getByTestId('code-sidebar-options').click();
    await page.getByTestId('code-settings-panel').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('code-settings-update-card').getByText(latestScreenshotVersion, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, '14-code-settings.png');

    const shouldCapturePet = requestedScreenshotFiles.size === 0
      || requestedScreenshotFiles.has('16-code-pet-soft-glow.png')
      || requestedScreenshotFiles.has('17-code-pet-black-hole.png');
    if (shouldCapturePet) {
      if (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has('16-code-pet-soft-glow.png')) {
        await page.getByRole('button', { name: 'Preview soft glow' }).click();
        const softGlowScene = page.getByTestId('pet-rest-scene');
        await softGlowScene.waitFor({ state: 'visible', timeout: 20_000 });
        await screenshot(page, '16-code-pet-soft-glow.png');
        if (requestedScreenshotsComplete()) return;
        await softGlowScene.getByRole('button', { name: 'End break' }).click();
        await page.getByTestId('code-settings-panel').waitFor({ state: 'visible', timeout: 20_000 });
      }
      if (requestedScreenshotFiles.size === 0 || requestedScreenshotFiles.has('17-code-pet-black-hole.png')) {
        await page.evaluate(() => {
          const testWindow = window as Window & {
            __farmingBlackHoleEvolutionSeed?: number;
            __farmingBlackHoleElapsedSeconds?: number;
          };
          testWindow.__farmingBlackHoleEvolutionSeed = 1;
          testWindow.__farmingBlackHoleElapsedSeconds = 82.55;
        });
        await page.getByRole('button', { name: 'Preview black hole' }).click();
        const blackHoleScene = page.getByTestId('pet-rest-scene');
        await blackHoleScene.waitFor({ state: 'visible', timeout: 20_000 });
        await blackHoleScene.locator('.code-pet-black-hole-canvas').waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForFunction(() => typeof (window as Window & {
          __farmingBlackHoleRenderFrames?: (count?: number) => Promise<void>;
        }).__farmingBlackHoleRenderFrames === 'function');
        await page.evaluate(async () => (window as Window & {
          __farmingBlackHoleRenderFrames?: (count?: number) => Promise<void>;
        }).__farmingBlackHoleRenderFrames?.(4));
        await screenshot(page, '17-code-pet-black-hole.png');
        if (requestedScreenshotsComplete()) return;
        await ensureApp(page);
      }
    }
    await page.keyboard.press('Escape');

    const shouldCaptureDesktop = requestedScreenshotFiles.size === 0
      || requestedScreenshotFiles.has('18-code-desktop-connections.png');
    if (shouldCaptureDesktop) {
      await captureDesktopConnections(browser, baseUrl);
      if (requestedScreenshotsComplete()) return;
    }

    await page.request.post(`${baseUrl}${basePath}/api/settings`, { data: { appearance: 'dark' } });
    await ensureApp(page);
    await openAgent(page, codexAgentId);
    await screenshot(page, '09-dark-workspace.png');

    const shouldCaptureUsage = requestedScreenshotFiles.size === 0
      || requestedScreenshotFiles.has('15-code-usage-activity.png');
    if (shouldCaptureUsage) {
      await page.request.post(`${baseUrl}${basePath}/api/settings`, { data: { appearance: screenshotAppearance } });
      await ensureApp(page, { hideUsagePanel: false });
      await page.waitForTimeout(2500);
      const usageToggle = page.getByTestId('code-usage-toggle');
      if (await usageToggle.getAttribute('aria-expanded') !== 'true') {
        await usageToggle.evaluate(element => element.click());
      }
      const usagePanel = page.getByTestId('code-usage-panel');
      await usagePanel.getByTestId('code-usage-daily-heatmap').waitFor({ state: 'attached', timeout: 20_000 });
      await usagePanel.getByTestId('code-usage-open-year').evaluate(element => element.click());
      const usageDialog = page.getByTestId('code-usage-detail-dialog');
      await usageDialog.waitFor({ state: 'visible', timeout: 20_000 });
      await usageDialog.getByTestId('code-usage-day-histogram').waitFor({ state: 'visible', timeout: 20_000 });
      await page.setViewportSize({ width: 1440, height: 960 });
      const usageScreenshotStyle = await page.addStyleTag({
        content: `
          [data-testid='code-usage-detail-dialog'] {
            max-height: calc(100vh - 48px) !important;
          }
        `,
      });
      await screenshot(page, '15-code-usage-activity.png');
      if (requestedScreenshotsComplete()) return;
      await usageScreenshotStyle.evaluate(element => element.remove());
      await page.setViewportSize({ width: 1440, height: 810 });
      await page.keyboard.press('Escape');
    }

    const releaseOpsWorkspace = path.join(homeDir, 'Projects', 'release-ops');
    fs.mkdirSync(releaseOpsWorkspace, { recursive: true });
    const dependencyAgentId = await startAgent(page, baseUrl, {
      command: 'bash',
      workspace: releaseOpsWorkspace,
      task: '',
    });
    await updateAgent(page, baseUrl, dependencyAgentId, { customTitle: 'Dependency audit' });
    await sendAgentInput(page, baseUrl, dependencyAgentId, 'stty -echo; clear; printf "DEPENDENCY AUDIT\\n\\nproduction packages: 74\\nknown vulnerabilities: 0\\nlicense conflicts: 0\\nlockfile drift: none\\n\\nready for release\\n"; stty echo\r');
    await waitForAgentOutput(page, baseUrl, dependencyAgentId, 'ready for release');

    const recoveryWorkspace = path.join(homeDir, 'Projects', 'terminal-lab');
    fs.mkdirSync(recoveryWorkspace, { recursive: true });
    const crtRecoveryAgentId = await startAgent(page, baseUrl, {
      command: 'bash',
      workspace: recoveryWorkspace,
      task: '',
    });
    await updateAgent(page, baseUrl, crtRecoveryAgentId, { customTitle: 'Watch checkpoint recovery' });
    await sendAgentInput(page, baseUrl, crtRecoveryAgentId, [
      'stty -echo',
      'clear',
      `printf '\\033[1;35mCHECKPOINT RECOVERY\\033[0m\\n\\nreplaying epoch \\033[36m7f2c…91ab\\033[0m\\n  output sequence      \\033[32mcontiguous\\033[0m\\n  resize boundary      \\033[32mcommitted\\033[0m\\n  hidden-page resume   \\033[33mverifying\\033[0m\\n\\nwatch mode · waiting for the next transition\\n'`,
      'stty echo',
    ].join('; ') + '\r');
    await waitForAgentOutput(page, baseUrl, crtRecoveryAgentId, 'waiting for the next transition');

    const docsWorkspace = path.join(homeDir, 'Projects', 'docs-ui');
    fs.mkdirSync(docsWorkspace, { recursive: true });
    const crtChatAgentId = await startAgent(page, baseUrl, {
      command: 'claude',
      workspace: docsWorkspace,
      task: 'Check markdown typography in the structured Chat preview.',
      agentRuntimeMode: 'acp',
    });
    await updateAgent(page, baseUrl, crtChatAgentId, { customTitle: 'Audit Chat rendering' });
    await updateAgent(page, baseUrl, crtChatAgentId, { unread: false });
    await updateAgent(page, baseUrl, shellAgentId, { customTitle: 'Inspect pagination changes' });
    await updateAgent(page, baseUrl, claudeAgentId, { archived: true });

    await page.goto(`${basePath}/crt/`, { waitUntil: 'networkidle' });
    await page.locator('body#farming-crt').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.agent-block').first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(500);
    await Promise.all([
      codexAgentId,
      shellAgentId,
      dependencyAgentId,
      crtRecoveryAgentId,
      crtChatAgentId,
    ].map(agentId => updateAgent(page, baseUrl, agentId, { unread: false })));
    await page.locator('.agent-block').nth(4).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(900);
    const dashboardCardsVisible = await page.locator('#map-area .agent-block').count();
    if (dashboardCardsVisible !== 5) {
      throw new Error(`expected 5 visible CRT dashboard cards, found ${dashboardCardsVisible}`);
    }
    await stabilizeCrtDashboard(page);
    await page.locator(`#map-area .agent-block[data-agent-id="${dependencyAgentId}"]`).hover();
    await screenshot(page, '01-crt-dashboard.png', crtScreenshotDir);
    if (requestedScreenshotsComplete()) return;

    await page.goto(`${basePath}/crt/?agent=${encodeURIComponent(codexAgentId)}`, { waitUntil: 'networkidle' });
    await page.locator('#session-modal.active').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#crt-structured-composer.active').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#terminal-output .crt-structured-transcript').waitFor({ state: 'visible', timeout: 30_000 });
    await screenshot(page, '02-crt-structured-chat.png', crtScreenshotDir);

    await page.goto(`${basePath}/crt/?agent=${encodeURIComponent(shellAgentId)}`, { waitUntil: 'networkidle' });
    await page.locator('#session-modal.active').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#terminal-output .xterm').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText('no whitespace errors', { exact: false }).waitFor({ state: 'visible', timeout: 30_000 });
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
    await page.setViewportSize({ width: 1440, height: 960 });
    await screenshot(page, '06-crt-billing-days.png', crtScreenshotDir);
    if (requestedScreenshotsComplete()) return;
    await page.setViewportSize({ width: 1440, height: 810 });
    await page.getByRole('tab', { name: '[L] LIVE', exact: true }).click();
    await page.locator('#billing-window-label').filter({ hasText: 'TOKENS · 1H' }).waitFor({ state: 'visible', timeout: 30_000 });
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
    documentationSite?.process.kill('SIGTERM');
    fs.rmSync(agentBrowserSocketDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
