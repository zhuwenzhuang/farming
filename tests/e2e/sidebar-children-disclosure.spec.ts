import type { BrowserResource } from '../../extensions/browser/frontend/types'
import { projectFilesWorkspaceId } from '../../src/lib/project-workspaces'
import { expect, openFarming, test } from './fixtures'

test('one Agent disclosure controls Browser resources and subagents across reload and appearances', async ({ page, workspaceRoot }, testInfo) => {
  testInfo.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const settings = await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  expect(settings.ok(), await settings.text()).toBeTruthy()
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, customTitle: 'Sample review with Browser and subagents', agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  const resource: BrowserResource = {
    id: 'review-browser', ownerAgentId: agentId, projectRootId: projectFilesWorkspaceId(workspaceRoot),
    workspace: workspaceRoot, name: 'Review Browser', status: 'stopped', generation: 0,
    revision: 1, collectionRevision: 2, url: 'about:blank', title: '', browserKind: 'chrome',
    error: '', createdAt: Date.now(), updatedAt: Date.now(),
  }
  let resourcesVisible = false
  let publishResources: (() => void) | undefined
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    publishResources = () => socket.send(JSON.stringify({
      type: 'browser-resource-snapshot',
      snapshot: { collectionRevision: resourcesVisible ? 2 : 1, resources: resourcesVisible ? [resource] : [] },
    }))
    server.onMessage(payload => {
      const message = JSON.parse(String(payload)) as { type?: string }
      if (message.type === 'browser-resource-snapshot') publishResources?.()
      else socket.send(payload)
    })
  })
  await page.route('**/api/browsers/capability', route => route.fulfill({ json: {
    enabled: true, available: true, browser: { kind: 'chrome', path: '/mock/chrome' }, message: '',
  } }))
  await openFarming(page)
  const parent = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(parent.locator('.code-agent-name')).toHaveText('Sample review with Browser and subagents')
  const toggle = parent.getByTestId('code-agent-children-toggle')
  const resourceSlot = page.locator(`[data-testid="code-agent-resource-slot"][data-agent-id="${agentId}"]`)
  const browsers = resourceSlot.getByTestId('farming-browser-section')
  await parent.locator('.code-agent-name').click({ position: { x: 5, y: 8 } })
  await expect(toggle).toHaveCount(0)
  await expect.poll(() => Boolean(publishResources)).toBe(true)
  resourcesVisible = true
  publishResources?.()
  await parent.hover()
  await expect(toggle).toHaveCount(1)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(browsers).toBeVisible()
  await toggle.click()
  await expect(browsers).toBeHidden()

  // Later child discovery must respect the explicit hide choice for this Agent.
  await page.getByTestId('code-acp-composer-input').fill('related workflow demo')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Review group ready.')
  const children = page.getByTestId('code-native-related-finished')
  await expect(children).toBeAttached()
  await expect(children).toBeHidden()
  await expect(toggle).toHaveCount(1)
  await expect(parent.locator('.code-agent-row-actions button[aria-expanded]')).toHaveCount(1)
  await page.reload()
  await parent.locator('.code-agent-name').click({ position: { x: 5, y: 8 } })
  await parent.hover()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(children).toBeHidden()
  await toggle.click()
  await expect(children).toBeVisible()
  await expect(browsers).toBeVisible()
  await page.reload()
  await parent.locator('.code-agent-name').click({ position: { x: 5, y: 8 } })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(children).toBeVisible()
  await expect(browsers).toBeVisible()

  for (const width of [1440, 393]) {
    await page.setViewportSize({ width, height: 900 })
    const sidebar = page.getByTestId('code-sidebar')
    if (width === 393 && await sidebar.evaluate(el => el.classList.contains('collapsed'))) {
      await page.getByTestId('code-mobile-menu').click()
    }
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        document.documentElement.dataset.appearance = value
      }, appearance)
      if (width > 767) await parent.hover()
      await expect(toggle).toBeVisible()
      await expect(toggle).toHaveCount(1)
      const expanded = await sidebar.screenshot({ path: testInfo.outputPath(`${width}-${appearance}-expanded.png`), animations: 'disabled' })
      expect(expanded.readUInt32BE(16)).toBeGreaterThan(200)
      expect(expanded.readUInt32BE(20)).toBeGreaterThan(500)
      await toggle.focus()
      await page.keyboard.press('Enter')
      await expect(children).toBeHidden()
      await expect(browsers).toBeHidden()
      await sidebar.screenshot({ path: testInfo.outputPath(`${width}-${appearance}-collapsed.png`), animations: 'disabled' })
      if (width > 767) await parent.click({ button: 'right' })
      else await parent.getByTestId('code-agent-row-more').click()
      await page.getByRole('menuitem', { name: 'Show resources and subagents', exact: true }).click()
      await expect(children).toBeVisible()
      await expect(browsers).toBeVisible()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    }
  }
})
