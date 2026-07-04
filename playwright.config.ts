import { defineConfig, devices } from '@playwright/test'
import fs from 'node:fs'

const port = Number(process.env.FARMING_PLAYWRIGHT_PORT || 4173)
const baseURL = `http://127.0.0.1:${port}`
const includeInternalTests = process.env.FARMING_PLAYWRIGHT_INTERNAL === '1'
const localChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const executablePath = process.env.FARMING_PLAYWRIGHT_CHROME_PATH
  || (fs.existsSync(localChromePath) ? localChromePath : undefined)

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: includeInternalTests ? [] : ['**/internal/**'],
  globalTeardown: './tests/e2e/global-teardown.js',
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
    launchOptions: {
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--proxy-server=direct://',
        '--proxy-bypass-list=*',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run build && exec node scripts/start-playwright-server.js',
    url: `${baseURL}/farming/`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      ...process.env,
      PORT: String(port),
      FARMING_BASE_PATH: '/farming',
      FARMING_DISABLE_AUTH: '1',
      FARMING_E2E_FAKE_EXECUTABLES: '1',
      VITE_FARMING_BLAME_AUTHOR_URL_TEMPLATE: 'https://example.invalid/users/{author}',
      NODE_ENV: 'test',
    },
  },
})
