import { chromium, defineConfig, devices } from '@playwright/test'
import { registry } from 'playwright-core/lib/server/registry/index'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.env.FARMING_PLAYWRIGHT_PORT || 4173)
const baseURL = `http://127.0.0.1:${port}`
const includeInternalTests = process.env.FARMING_PLAYWRIGHT_INTERNAL === '1'
const useRealCodex = process.env.FARMING_E2E_REAL_CODEX === '1'
const useMobileAuth = process.env.FARMING_PLAYWRIGHT_AUTH === '1'
// CI builds the frontend once in the Check job and hands dist/ to every browser
// shard, so the shards set this to skip a rebuild they would only repeat. Local
// runs leave it unset and keep building their own bundle first.
const skipPlaywrightBuild = process.env.FARMING_PLAYWRIGHT_SKIP_BUILD === '1'
const startPlaywrightServer = 'exec tsx scripts/start-playwright-server.ts'
const localChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const executablePath = process.env.FARMING_PLAYWRIGHT_CHROME_PATH
  || (fs.existsSync(localChromePath) ? localChromePath : undefined)
const headlessShellPath = registry
  .findExecutable('chromium-headless-shell')
  .executablePath()
const browserResourceExecutablePath = process.env.FARMING_BROWSER_EXECUTABLE
  || executablePath
  || headlessShellPath
  || chromium.executablePath()
const managedAgentBrowserCandidates = [
  process.env.FARMING_AGENT_BROWSER_BIN,
  path.join(
    os.homedir(),
    '.farming',
    'runtimes',
    'agentBrowser',
    '0.32.3',
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser',
  ),
  path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser'),
].filter((candidate): candidate is string => Boolean(candidate))
const managedAgentBrowserPath = managedAgentBrowserCandidates.find(candidate => fs.existsSync(candidate))
const chromiumLaunchOptions = {
  executablePath,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--proxy-server=direct://',
    '--proxy-bypass-list=*',
  ],
}
const playwrightServerEnv = {
  ...process.env,
  PORT: String(port),
  FARMING_BASE_PATH: '/farming',
  FARMING_DISABLE_AUTH: useMobileAuth ? '0' : '1',
  ...(useMobileAuth ? { FARMING_TOKEN: 'mobile-auth-owner-fixture-token' } : {}),
  FARMING_NATIVE_PTY_HOST_PERSIST: '0',
  FARMING_E2E_REAL_CODEX: useRealCodex ? '1' : '0',
  FARMING_E2E_FAKE_EXECUTABLES: useRealCodex ? '0' : '1',
  FARMING_E2E_FAKE_ACP_AGENT: useRealCodex ? '0' : '1',
  FARMING_ANONYMIZE_SHELL_PROMPT: '1',
  FARMING_BROWSER_EXECUTABLE: browserResourceExecutablePath,
  ...(managedAgentBrowserPath ? { FARMING_AGENT_BROWSER_BIN: managedAgentBrowserPath } : {}),
  FARMING_BROWSER_NO_SANDBOX: process.env.CI ? '1' : '0',
  NODE_ENV: 'test',
}

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: includeInternalTests ? [] : ['**/internal/**'],
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.015,
    },
  },
  reporter: [
    ['html', { open: 'never' }],
    process.env.CI ? ['github'] : ['list'],
  ],
  use: {
    baseURL,
    trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumLaunchOptions,
      },
    },
    {
      name: 'iphone-webkit',
      testMatch: /(iphone-mobile-layout|global-file-search|sidebar-surface-appearance|sidebar-spacing|ui-design-protocol|file-tree-scroll|file-editor-reveal|markdown-math-layout)\.spec\.ts/,
      use: {
        ...devices['iPhone 14 Pro'],
        browserName: 'webkit',
      },
    },
    {
      name: 'iphone-human-webkit',
      testMatch: /(acp-human-cases|backend-connection-status|background-chat-continuity|human-story)\.spec\.ts/,
      grep: /@iphone-human/,
      use: {
        ...devices['iPhone 14 Pro'],
        browserName: 'webkit',
      },
    },
    {
      name: 'android-human-chromium',
      testMatch: /(acp-human-cases|backend-connection-status|background-chat-continuity|human-story|file-tree-scroll)\.spec\.ts/,
      grep: /@iphone-human|@native-file-scroll/,
      use: {
        ...devices['Pixel 7'],
        browserName: 'chromium',
        launchOptions: chromiumLaunchOptions,
      },
    },
    {
      name: 'mobile-auth-chromium',
      testMatch: /mobile-auth-readonly\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        browserName: 'chromium',
        launchOptions: chromiumLaunchOptions,
      },
    },
    {
      name: 'mobile-auth-webkit',
      testMatch: /mobile-auth-readonly\.spec\.ts/,
      use: {
        ...devices['iPhone 14 Pro'],
        browserName: 'webkit',
      },
    },
  ],
  webServer: {
    command: skipPlaywrightBuild ? startPlaywrightServer : `npm run build && ${startPlaywrightServer}`,
    url: `${baseURL}/farming/`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: playwrightServerEnv,
  },
})
