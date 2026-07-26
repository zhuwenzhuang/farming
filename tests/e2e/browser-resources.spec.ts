import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import type { Locator, Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

let targetServer: http.Server
let targetUrl = ''
const execFileAsync = promisify(execFile)

test.beforeAll(async () => {
  targetServer = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width">
      <title>Browser Interaction Lab</title>
      <style>
        body { background: #eef6ff; font: 24px system-ui; margin: 0; }
        h1 { left: 180px; position: absolute; top: 70px; }
        input { font: inherit; height: 48px; left: 180px; position: absolute; top: 180px; width: 300px; }
        button { font: inherit; height: 54px; left: 540px; position: absolute; top: 180px; width: 160px; }
        #result { color: #17663a; font-weight: 700; left: 180px; position: absolute; top: 260px; }
      </style>
      <h1>Browser Interaction Lab</h1>
      <label><span hidden>Name</span><input id="name" aria-label="Name"></label>
      <button id="complete">Complete</button>
      <p id="result">WAITING</p>
      <script>
        document.querySelector('#complete').addEventListener('click', () => {
          const value = document.querySelector('#name').value
          document.querySelector('#result').textContent = 'COMPLETED: ' + value
          document.title = 'Done ' + value
        })
      </script>`)
  })
  await new Promise<void>((resolve, reject) => {
    targetServer.once('error', reject)
    targetServer.listen(0, '127.0.0.1', resolve)
  })
  targetUrl = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}/`
})

test.afterAll(async () => {
  if (!targetServer) return
  await new Promise<void>((resolve, reject) => {
    targetServer.close(error => error ? reject(error) : resolve())
  })
})

async function clickBrowserPoint(canvas: Locator, x: number, y: number) {
  const dimensions = await canvas.evaluate(element => ({
    width: (element as HTMLCanvasElement).width,
    height: (element as HTMLCanvasElement).height,
  }))
  const box = await canvas.boundingBox()
  if (!box || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new Error('Browser canvas has no rendered frame')
  }
  await canvas.click({
    position: {
      x: x * box.width / dimensions.width,
      y: y * box.height / dimensions.height,
    },
  })
}

async function completionResultPixels(canvas: Locator) {
  return canvas.evaluate(element => {
    const browserCanvas = element as HTMLCanvasElement
    const context = browserCanvas.getContext('2d')
    if (!context || browserCanvas.width < 600 || browserCanvas.height < 330) return 0
    const pixels = context.getImageData(310, 260, 290, 70).data
    let matches = 0
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index]
      const green = pixels[index + 1]
      const blue = pixels[index + 2]
      if (red < 80 && green > 70 && blue < 120 && green > red + 20) matches += 1
    }
    return matches
  })
}

async function browserSnapshot(page: Page, browserId: string) {
  const response = await page.request.post(`/farming/api/browsers/${browserId}/action`, {
    data: { kind: 'snapshot' },
  })
  expect(response.ok()).toBeTruthy()
  return response.json() as Promise<{
    title: string
    url: string
    accessibilityTree: string
  }>
}

async function runBrowserCli(args: string[]) {
  const port = Number(process.env.FARMING_PLAYWRIGHT_PORT || 4173)
  return execFileAsync(process.execPath, [
    path.resolve('extensions/browser/bin/farming-browser'),
    ...args,
  ], {
    env: {
      ...process.env,
      FARMING_BROWSER_URL: `http://127.0.0.1:${port}/farming`,
    },
  })
}

test('explains which system browser must be installed when none is available', async ({
  page,
}, testInfo) => {
  await page.route('**/api/browsers/capability', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      enabled: true,
      available: false,
      browser: null,
      message: 'Install a Chromium-based browser to use the system Browser in Farming',
    }),
  }))
  await openFarming(page)
  await expect(page.getByTestId('farming-browser-section')).toHaveCount(0)
  await page.getByTestId('code-sidebar-options').click()
  const settingsPanel = page.getByTestId('code-settings-panel')
  await expect(settingsPanel.getByText('System browser', { exact: true })).toBeVisible()
  await expect(settingsPanel.getByText(
    'Install a Chromium-based browser to use a system browser in Farming.',
    { exact: true },
  )).toBeVisible()
  await expect(settingsPanel.getByText('Chromium required', { exact: true })).toBeVisible()
  await expect(settingsPanel.getByRole('button', { name: 'System browser' })).toHaveCount(0)
  const screenshot = testInfo.outputPath('browser-settings-install-required.png')
  await settingsPanel.locator('.code-settings-panel').screenshot({ path: screenshot })
  await testInfo.attach('browser-settings-install-required', {
    path: screenshot,
    contentType: 'image/png',
  })
})

test('shares one fixed Browser viewport across desktop, mobile, and Agent actions', async ({
  browser,
  page,
  workspaceRoot,
}, testInfo) => {
  const workspace = path.join(workspaceRoot, 'browser-project')
  fs.mkdirSync(workspace, { recursive: true })
  await testInfo.attach('target-url', { body: targetUrl, contentType: 'text/plain' })
  await page.request.post('/farming/api/projects/mount', { data: { workspace } })
  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const browserSection = project.getByTestId('farming-browser-section')
  await expect(browserSection).toBeVisible()
  await page.getByTestId('code-sidebar-options').click()
  const settingsPanel = page.getByTestId('code-settings-panel')
  const browserToggle = settingsPanel.getByRole('button', { name: 'System browser' })
  const browserHint = settingsPanel.getByText(
    'Show an installed system Chromium browser in Farming and let Agents operate it on demand.',
    { exact: true },
  )
  await expect(settingsPanel.getByText('System browser', { exact: true })).toBeVisible()
  await expect(browserHint).toBeVisible()
  expect(await browserHint.evaluate(element => ({
    horizontallyClipped: element.scrollWidth > element.clientWidth,
    verticallyClipped: element.scrollHeight > element.clientHeight,
    textOverflow: getComputedStyle(element).textOverflow,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }))).toEqual({
    horizontallyClipped: false,
    verticallyClipped: false,
    textOverflow: 'clip',
    whiteSpace: 'normal',
  })
  await expect(browserToggle).toHaveAttribute('aria-pressed', 'true')
  const settingsScreenshot = testInfo.outputPath('browser-settings-system-browser.png')
  await settingsPanel.locator('.code-settings-panel').screenshot({ path: settingsScreenshot })
  await testInfo.attach('browser-settings-system-browser', {
    path: settingsScreenshot,
    contentType: 'image/png',
  })
  await browserToggle.click()
  await expect(browserToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(browserSection).toHaveCount(0)
  await browserToggle.click()
  await expect(browserToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(browserSection).toBeVisible()
  await settingsPanel.getByRole('button', { name: 'Close' }).click()
  await browserSection.getByRole('button', { name: 'New Browser' }).click()
  const viewer = page.getByTestId('farming-browser-viewer')
  const desktopCanvas = viewer.locator('canvas')
  await expect(desktopCanvas).toBeVisible({ timeout: 30_000 })

  const browserId = new URL(page.url()).searchParams.get('browser')
  expect(browserId).toMatch(/^browser_/)
  await page.getByRole('textbox', { name: 'Browser address' }).fill(targetUrl)
  await page.getByRole('textbox', { name: 'Browser address' }).press('Enter')
  await expect.poll(async () => (await browserSnapshot(page, browserId!)).title).toBe('Browser Interaction Lab')
  const readDesktopFrameSize = () => desktopCanvas.evaluate(canvas => [
    (canvas as HTMLCanvasElement).width,
    (canvas as HTMLCanvasElement).height,
  ])
  await expect.poll(async () => {
    const [width, height] = await readDesktopFrameSize()
    return width >= 320 && height >= 240
  }).toBe(true)
  const desktopFrameSize = await readDesktopFrameSize()

  await clickBrowserPoint(desktopCanvas, 330, 207)
  await page.keyboard.type('ssh-human-e2e')
  await clickBrowserPoint(desktopCanvas, 620, 207)
  await expect.poll(async () => (await browserSnapshot(page, browserId!)).title).toBe('Done ssh-human-e2e')
  await expect.poll(async () => (await browserSnapshot(page, browserId!)).accessibilityTree)
    .toContain('COMPLETED: ssh-human-e2e')
  await expect.poll(
    () => completionResultPixels(desktopCanvas),
    { message: 'Browser Viewer should paint the completed page before screenshot capture' },
  ).toBeGreaterThan(20)

  const desktopScreenshot = testInfo.outputPath('browser-desktop.png')
  await page.screenshot({ path: desktopScreenshot, fullPage: true })
  await testInfo.attach('browser-desktop', { path: desktopScreenshot, contentType: 'image/png' })

  const cliSnapshot = JSON.parse((await runBrowserCli(['snapshot', browserId!])).stdout) as {
    title: string
    accessibilityTree: string
  }
  expect(cliSnapshot.title).toBe('Done ssh-human-e2e')
  expect(cliSnapshot.accessibilityTree).toContain('COMPLETED: ssh-human-e2e')
  await runBrowserCli(['fill', browserId!, 'css=#name', 'ssh-agent-cli'])
  await runBrowserCli(['click', browserId!, 'css=#complete'])
  await expect.poll(async () => (await browserSnapshot(page, browserId!)).title).toBe('Done ssh-agent-cli')
  const cliScreenshot = testInfo.outputPath('browser-agent-cli.png')
  await runBrowserCli(['screenshot', browserId!, cliScreenshot])
  expect(fs.readFileSync(cliScreenshot).subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )
  await testInfo.attach('browser-agent-cli', { path: cliScreenshot, contentType: 'image/png' })

  const mobileContext = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  })
  const mobilePage = await mobileContext.newPage()
  await mobilePage.goto(page.url())
  const mobileCanvas = mobilePage.getByTestId('farming-browser-viewer').locator('canvas')
  await expect(mobileCanvas).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => Promise.all([desktopCanvas, mobileCanvas].map(async canvas => [
    await canvas.evaluate(element => (element as HTMLCanvasElement).width),
    await canvas.evaluate(element => (element as HTMLCanvasElement).height),
  ]))).toEqual([desktopFrameSize, desktopFrameSize])
  const mobileScreenshot = testInfo.outputPath('browser-mobile.png')
  await mobilePage.screenshot({ path: mobileScreenshot, fullPage: true })
  await testInfo.attach('browser-mobile', { path: mobileScreenshot, contentType: 'image/png' })
  await mobileContext.close()

  const row = browserSection.getByTestId('farming-browser-row')
  await row.hover()
  await row.getByRole('button', { name: 'Rename Browser' }).click()
  await row.getByRole('textbox', { name: 'Browser name' }).fill('Frontend Smoke')
  await row.getByRole('textbox', { name: 'Browser name' }).press('Enter')
  await expect(row).toContainText('Frontend Smoke')

  await viewer.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(viewer.getByText('Browser stopped', { exact: true })).toBeVisible({ timeout: 15_000 })
  await viewer.getByRole('button', { name: 'Start Browser' }).click()
  await expect(viewer.locator('canvas')).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await browserSnapshot(page, browserId!)).url).toBe(targetUrl)

  page.once('dialog', dialog => dialog.accept())
  await row.hover()
  await row.getByRole('button', { name: 'Delete Browser' }).click()
  await expect(browserSection.getByTestId('farming-browser-row')).toHaveCount(0)
  await page.request.post('/farming/api/projects/remove', { data: { workspace } })
})
