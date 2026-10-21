import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('browser tab follows unread inventory with a shared blue dot across appearances', async ({ page, workspaceRoot }, testInfo) => {
  const settings = await page.request.post('/farming/api/settings', { data: { instanceName: 'Preview Farm' } })
  expect(settings.ok()).toBeTruthy()
  const workspace = path.join(workspaceRoot, 'tab-attention')
  fs.mkdirSync(workspace, { recursive: true })
  const ids: string[] = []
  for (let i = 0; i < 3; i++) {
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace, name: `Agent ${i + 1}` },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json() as { agentId: string }
    ids.push(body.agentId)
  }
  await openFarming(page)
  const baseTitle = 'Preview Farm · Farming Code'
  await expect(page).toHaveTitle(baseTitle)
  const activeId = await page.locator('[data-testid="code-agent-row"].active').getAttribute('data-agent-id')
  const unreadIds = ids.filter(id => id !== activeId).slice(0, 2)
  expect(unreadIds).toHaveLength(2)
  for (const id of unreadIds) {
    const response = await page.request.patch(`/farming/api/agents/${id}`, { data: { unread: true } })
    expect(response.ok()).toBeTruthy()
  }
  await expect(page).toHaveTitle(`(2) ${baseTitle}`)
  await expect(page.locator('#farming-favicon')).toHaveAttribute('href', '/farming/farming-2/favicon-v4-unread.svg')

  // Folding a collection and returning focus never acknowledges other Agents.
  await page.getByTestId('code-project-title').filter({ hasText: 'tab-attention' }).click()
  await page.bringToFront()
  await expect(page).toHaveTitle(`(2) ${baseTitle}`)
  await page.getByTestId('code-project-title').filter({ hasText: 'tab-attention' }).click()

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light' })
    const response = await page.request.post('/farming/api/settings', { data: { appearance } })
    expect(response.ok()).toBeTruthy()
    await page.reload()
    await expect(page).toHaveTitle(`(2) ${baseTitle}`)
    await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
    const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${unreadIds[0]}"]`)
    await expect(row.locator('.code-agent-unread')).toBeVisible()
    const color = await row.locator('.code-agent-unread').evaluate(element => getComputedStyle(element).backgroundColor)
    expect(color).toBe(appearance === 'dark' ? 'rgb(51, 156, 255)' : 'rgb(9, 105, 218)')

    // Render the real favicon URL beside the workbench: browser chrome itself
    // is outside Playwright screenshots. This also checks embedded SVG media.
    const dot = await page.evaluate(async () => {
      const icon = document.querySelector<HTMLLinkElement>('#farming-favicon')!
      const preview = document.createElement('div')
      preview.dataset.testid = 'browser-tab-icon-preview'
      preview.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:100000;display:flex;align-items:center;gap:16px;padding:20px;border-radius:12px;background:var(--code-bg-chrome);color:var(--code-text)'
      const image = document.createElement('img')
      image.width = 64
      image.height = 64
      image.src = icon.href
      preview.append(image, document.createTextNode(document.title))
      document.body.append(preview)
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 64
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0, 64, 64)
      return [...context.getImageData(54, 10, 1, 1).data]
    })
    expect(dot).toEqual(appearance === 'dark' ? [51, 156, 255, 255] : [9, 105, 218, 255])
    await testInfo.attach(`browser-tab-${appearance}`, {
      body: await page.screenshot({ path: testInfo.outputPath(`browser-tab-${appearance}.png`) }), contentType: 'image/png',
    })
    await page.getByTestId('browser-tab-icon-preview').evaluate(element => element.remove())
    await page.getByTestId('code-sidebar-toggle').click()
    const railDot = page.locator(`[data-testid="code-agent-rail-item"][data-agent-id="${unreadIds[0]}"] .code-agent-rail-unread`)
    await expect(railDot).toHaveCSS('background-color', color)
    await expect(page).toHaveTitle(`(2) ${baseTitle}`)
    await page.getByTestId('code-sidebar-toggle').click()
  }

  const archived = await page.request.patch(`/farming/api/agents/${unreadIds[0]}`, { data: { archived: true } })
  expect(archived.ok()).toBeTruthy()
  await expect(page).toHaveTitle(`(1) ${baseTitle}`)
  const read = await page.request.patch(`/farming/api/agents/${unreadIds[1]}`, { data: { unread: false } })
  expect(read.ok()).toBeTruthy()
  await expect(page).toHaveTitle(baseTitle)
  await expect(page.locator('#farming-favicon')).toHaveAttribute('href', '/farming/farming-2/favicon-v4.svg')
})
