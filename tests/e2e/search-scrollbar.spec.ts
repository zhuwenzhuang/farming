import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chromium, type Page } from '@playwright/test'
import { expect, openFarming, test as base } from './fixtures'

// Playwright normally hides native scrollbars in headless mode. Preserve the
// configured browser executable and options while exercising the real thumb.
const test = base.extend({
  launchOptions: async ({ launchOptions }, use) => {
    const options = { ...launchOptions, ignoreDefaultArgs: ['--hide-scrollbars'] }
    if (process.platform !== 'darwin') return use(options)
    // Cocoa's argument domain overrides only this browser process. Do not
    // change the user's global scrollbar preference. Playwright disallows the
    // bare Cocoa argument value in args, so append it in an owned launcher.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-scrollbar-'))
    const launcher = path.join(directory, 'chrome')
    const executable = launchOptions.executablePath || chromium.executablePath()
    const quotedExecutable = `'${executable.replace(/'/g, `'"'"'`)}'`
    fs.writeFileSync(launcher, `#!/bin/sh\nexec ${quotedExecutable} "$@" -AppleShowScrollBars Always\n`, { mode: 0o700 })
    try {
      await use({ ...options, executablePath: launcher })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
})

async function createControlAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  const result = await response.json() as { agentId?: string; error?: string }
  expect(response.ok(), result.error || JSON.stringify(result)).toBeTruthy()
  expect(result.agentId).toBeTruthy()
  await mountProject(page, workspace)
  return result.agentId as string
}

async function mountProject(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/projects/mount', {
    data: { workspace },
  })
  expect(response.ok()).toBeTruthy()
}

async function mockSessionSearch(page: Page) {
  await page.route(/\/farming\/api\/agent-sessions\/search(?:\?.*)?$/, route => (
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sessions: [] }) })
  ))
}

async function openGlobalSearch(page: Page) {
  await page.getByTestId('code-nav-search').click()
  await expect(page.getByTestId('code-search-box')).toBeVisible()
  return page.getByTestId('code-search-box').locator('input')
}

function writeFixture(workspace: string, filePath: string, content: string) {
  const absolutePath = path.join(workspace, filePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, content)
  return absolutePath
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`keeps search open while dragging its scrollbar in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'native scrollbar dragging requires a desktop pointer')
    await page.setViewportSize({ width: 1_440, height: 720 })
    await mockSessionSearch(page)
    await page.route('**/api/agent-sessions?**', route => route.fulfill({ json: { sessions: [] } }))
    await openFarming(page)
    for (let project = 0; project < 3; project += 1) {
      const workspace = path.join(workspaceRoot, 'example', 'team', `search-project-${project}`)
      for (let index = 0; index < 16; index += 1) {
        writeFixture(workspace, `src/sql-insight-${String(index).padStart(2, '0')}.ts`, `TARGET_${index}\n`)
      }
      if (project === 0) await createControlAgent(page, workspace)
      else await mountProject(page, workspace)
    }
    await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)

    const input = await openGlobalSearch(page)
    await input.fill('sql-insight')
    await expect(page.getByTestId('code-global-file-search-result')).toHaveCount(48)
    const view = page.locator('.code-search-view')
    await expect.poll(() => view.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const geometry = await view.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        height: element.clientHeight,
        scrollbarWidth: element.offsetWidth - element.clientWidth,
        thumbHeight: element.clientHeight ** 2 / element.scrollHeight,
      }
    })
    expect(geometry.scrollbarWidth).toBeGreaterThan(0)
    const scrollbarX = geometry.right - geometry.scrollbarWidth / 2

    // Native pointer events on the scrollbar target the outer Search view,
    // not the centered result column. They must not dismiss Search.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await page.mouse.move(scrollbarX, geometry.top + geometry.thumbHeight / 2)
      await page.mouse.down()
      try {
        await page.mouse.move(scrollbarX, geometry.top + geometry.height / 2, { steps: 8 })
      } finally {
        await page.mouse.up()
      }
      await expect(input).toHaveValue('sql-insight')
      await expect.poll(() => view.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
      await page.mouse.move(geometry.right - 24, geometry.top + geometry.height / 2)
      await page.mouse.wheel(0, -10_000)
      await expect.poll(() => view.evaluate(element => element.scrollTop)).toBe(0)
    }

    // The view's padding is also inside Search; the sidebar remains outside.
    await page.mouse.click(geometry.left + 12, geometry.top + 120)
    await expect(input).toHaveValue('sql-insight')
    await page.mouse.move(0, 0)
    await expect(page.getByTestId('code-main')).toHaveScreenshot(`search-scrollbar-${appearance}.png`)
    await page.getByTestId('code-sidebar').click({ position: { x: 2, y: 350 } })
    await expect(page.getByTestId('code-search-panel')).toBeHidden()
  })
}
