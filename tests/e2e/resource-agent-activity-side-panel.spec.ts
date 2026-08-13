import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { projectFilesWorkspaceId } from '../../src/lib/project-workspaces'
import { expect, openFarming, test } from './fixtures'

let targetServer: http.Server
let targetUrl = ''

test.beforeAll(async () => {
  targetServer = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Side panel Browser</title><h1>Side panel Browser</h1>')
  })
  await new Promise<void>((resolve, reject) => {
    targetServer.once('error', reject)
    targetServer.listen(0, '127.0.0.1', resolve)
  })
  targetUrl = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}/`
})

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    targetServer.close(error => error ? reject(error) : resolve())
  })
})

test('keeps another Browser preview above the Composer beside the current Browser', async ({
  page,
  workspaceRoot,
}, testInfo) => {
  await page.setViewportSize({ width: 1680, height: 900 })
  const workspace = path.join(workspaceRoot, 'resource-agent-activity-side-panel')
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })

  const enableResponse = await page.request.post('/farming/api/settings', {
    data: { browserExtensionEnabled: true },
  })
  expect(enableResponse.ok()).toBeTruthy()
  await openFarming(page)

  const agentResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  const agent = await agentResponse.json() as { agentId?: string, error?: string }
  expect(agentResponse.ok(), agent.error || 'Failed to create side-panel Agent').toBeTruthy()
  const agentId = agent.agentId as string
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(agentRow).toBeVisible({ timeout: 30_000 })
  await agentRow.click()

  const createBrowser = async (name: string) => {
    const response = await page.request.post('/farming/api/browsers', {
      data: {
        rootId: projectFilesWorkspaceId(workspace),
        agentId,
        name,
        url: targetUrl,
      },
    })
    expect(response.ok()).toBeTruthy()
    const browser = await response.json() as { id: string }
    const startResponse = await page.request.post(`/farming/api/browsers/${browser.id}/start`)
    expect(startResponse.ok()).toBeTruthy()
    return browser.id
  }

  const currentBrowserId = await createBrowser('Current Browser')
  const previewBrowserId = await createBrowser('Other Browser')
  const resourcesToggle = agentRow.getByTestId('code-agent-resources-toggle')
  await expect(resourcesToggle).toBeVisible({ timeout: 30_000 })
  if (await resourcesToggle.getAttribute('aria-expanded') !== 'true') await resourcesToggle.click()
  const browserSection = page.locator(
    `[data-testid="code-agent-resource-slot"][data-agent-id="${agentId}"]`,
  ).getByTestId('farming-browser-section')
  const currentBrowserRow = browserSection.locator(
    `[data-testid="farming-browser-row"][data-browser-id="${currentBrowserId}"]`,
  )
  await expect(currentBrowserRow).toBeVisible({ timeout: 30_000 })
  await currentBrowserRow.click()

  const viewer = page.getByTestId('farming-browser-viewer')
  await expect(viewer).toBeVisible()
  await viewer.getByRole('button', { name: 'Show Agent beside resource' }).click()
  const main = page.getByTestId('code-main')
  await expect(main).toHaveClass(/resource-agent-side-open/)

  const preview = page.getByTestId('farming-browser-activity-preview')
  const previewCards = preview.getByTestId('farming-browser-activity-preview-card')
  await expect(previewCards).toHaveCount(1)
  await expect(preview.locator(`[data-browser-resource-id="${currentBrowserId}"]`)).toHaveCount(0)
  const otherBrowserCard = preview.locator(`[data-browser-resource-id="${previewBrowserId}"]`)
  await expect(otherBrowserCard).toBeVisible()

  const resizer = page.getByTestId('code-resource-agent-resizer')
  const mainBox = await main.boundingBox()
  const resizerBox = await resizer.boundingBox()
  if (!mainBox || !resizerBox) throw new Error('Side-panel resize geometry is unavailable')
  await resizer.hover()
  await page.mouse.down()
  await page.mouse.move(mainBox.x, resizerBox.y + (resizerBox.height / 2))
  await page.mouse.up()

  await otherBrowserCard.locator('.farming-browser-activity-title').click()
  await expect(otherBrowserCard.locator('.farming-browser-activity-frame')).toBeVisible()
  const geometry = await main.evaluate(element => {
    const panel = element.querySelector<HTMLElement>('[data-testid="code-terminal-grid"]')
    const dock = element.querySelector<HTMLElement>('[data-testid="code-agent-activity-dock"]')
    const card = element.querySelector<HTMLElement>('[data-testid="farming-browser-activity-preview-card"]')
    const composer = element.querySelector<HTMLElement>(':scope > .code-composer-shell')
    if (!panel || !dock || !card || !composer) {
      throw new Error('Side-panel activity geometry is unavailable')
    }
    const panelBox = panel.getBoundingClientRect()
    const dockBox = dock.getBoundingClientRect()
    const cardBox = card.getBoundingClientRect()
    const composerBox = composer.getBoundingClientRect()
    return {
      panelWidth: panelBox.width,
      dockPosition: getComputedStyle(dock).position,
      dockInsidePanel: dockBox.left >= panelBox.left && dockBox.right <= panelBox.right,
      cardComposerGap: composerBox.top - cardBox.bottom,
    }
  })
  expect(geometry.panelWidth).toBeGreaterThanOrEqual(798)
  expect(geometry.panelWidth).toBeLessThanOrEqual(801)
  expect(geometry.dockPosition).toBe('relative')
  expect(geometry.dockInsidePanel).toBe(true)
  expect(geometry.cardComposerGap).toBeGreaterThanOrEqual(5)

  const screenshot = testInfo.outputPath('browser-activity-agent-side-panel.png')
  await main.screenshot({ path: screenshot })
  await testInfo.attach('browser-activity-agent-side-panel', {
    path: screenshot,
    contentType: 'image/png',
  })
})
