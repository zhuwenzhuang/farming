import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chromium, type BrowserContext } from '@playwright/test'
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
  await expect(page).toHaveTitle('Preview Farm · 2 unread · Farming Code')
  await expect(page.locator('#farming-favicon')).toHaveAttribute('href', '/farming/farming-2/favicon-v4-unread.svg')

  // Folding a collection and returning focus never acknowledges other Agents.
  await page.getByTestId('code-project-title').filter({ hasText: 'tab-attention' }).click()
  await page.bringToFront()
  await expect(page).toHaveTitle('Preview Farm · 2 unread · Farming Code')
  await page.getByTestId('code-project-title').filter({ hasText: 'tab-attention' }).click()

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light' })
    const response = await page.request.post('/farming/api/settings', { data: { appearance } })
    expect(response.ok()).toBeTruthy()
    await page.reload()
    await expect(page).toHaveTitle('Preview Farm · 2 unread · Farming Code')
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
    await expect(page).toHaveTitle('Preview Farm · 2 unread · Farming Code')
    await page.getByTestId('code-sidebar-toggle').click()
  }

  await page.getByTestId('code-sidebar-options').click()
  const settingsPanel = page.getByTestId('code-settings-panel')
  await expect(settingsPanel).toBeVisible()
  await settingsPanel.getByRole('button', { name: '中文' }).click()
  await expect(page).toHaveTitle('Preview Farm · 2 条未读 · Farming Code')
  await settingsPanel.getByRole('button', { name: '关闭' }).click()

  const archived = await page.request.patch(`/farming/api/agents/${unreadIds[0]}`, { data: { archived: true } })
  expect(archived.ok()).toBeTruthy()
  await expect(page).toHaveTitle('Preview Farm · 1 条未读 · Farming Code')
  const read = await page.request.patch(`/farming/api/agents/${unreadIds[1]}`, { data: { unread: false } })
  expect(read.ok()).toBeTruthy()
  await expect(page).toHaveTitle(baseTitle)
  await expect(page.locator('#farming-favicon')).toHaveAttribute('href', '/farming/farming-2/favicon-v4.svg')
})


test('Chrome selects the actual dynamic favicon through unread and read transitions', async ({ page, workspaceRoot }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-favicon-'))
  const extension = path.join(root, 'extension')
  fs.mkdirSync(extension)
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Favicon selection observer', version: '1.0',
    permissions: ['tabs'], background: { service_worker: 'worker.js' },
  }))
  fs.writeFileSync(path.join(extension, 'worker.js'), 'chrome.tabs.onUpdated.addListener(() => {});')
  let context: BrowserContext | undefined
  try {
    expect((await page.request.post('/farming/api/settings', { data: { instanceName: 'Icon Farm', language: 'en' } })).ok()).toBeTruthy()
    const workspace = path.join(workspaceRoot, 'favicon-selection')
    fs.mkdirSync(workspace, { recursive: true })
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const response = await page.request.post('/farming/api/control/agents', {
        data: { command: 'bash', workspace, name: `Icon Agent ${i + 1}` },
      })
      expect(response.ok()).toBeTruthy()
      ids.push((await response.json() as { agentId: string }).agentId)
    }
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    })
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
    const subject = await context.newPage()
    const baseURL = new URL((await page.request.get('/farming')).url()).origin
    await subject.goto(`${baseURL}/farming`)
    await expect(subject.getByTestId('code-workspace')).toBeVisible()
    const selectedIcon = () => worker.evaluate(async url => {
      const browser = globalThis as unknown as {
        chrome: { tabs: { query: (query: object) => Promise<{ url?: string; favIconUrl?: string }[]> } }
      }
      return (await browser.chrome.tabs.query({})).find(tab => tab.url === url)?.favIconUrl
    }, subject.url())
    await expect.poll(selectedIcon).toBe(`${baseURL}/farming/farming-2/favicon-v4.svg`)
    const activeId = await subject.locator('[data-testid="code-agent-row"].active').getAttribute('data-agent-id')
    const unreadId = ids.find(id => id !== activeId)!
    expect((await page.request.patch(`/farming/api/agents/${unreadId}`, { data: { unread: true } })).ok()).toBeTruthy()
    await expect(subject).toHaveTitle('Icon Farm · 1 unread · Farming Code')
    await expect.poll(selectedIcon).toBe(`${baseURL}/farming/farming-2/favicon-v4-unread.svg`)
    expect((await page.request.patch(`/farming/api/agents/${unreadId}`, { data: { unread: false } })).ok()).toBeTruthy()
    await expect(subject).toHaveTitle('Icon Farm · Farming Code')
    await expect.poll(selectedIcon).toBe(`${baseURL}/farming/farming-2/favicon-v4.svg`)
  } finally {
    await context?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
