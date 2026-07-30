import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import type { Locator, Page } from '@playwright/test'
import { projectFilesWorkspaceId } from '../../src/lib/project-workspaces'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

let targetServer: http.Server
let targetUrl = ''
const execFileAsync = promisify(execFile)

test.beforeAll(async () => {
  targetServer = http.createServer((request, response) => {
    if (request.url === '/closed') {
      request.socket.destroy()
      return
    }
    if (request.url === '/frame') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<button id="inside-frame">Inside frame</button>')
      return
    }
    if (request.url === '/tab-destination') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<!doctype html>
        <meta charset="utf-8">
        <title>Popup destination</title>
        <style>body { background: #7a1f5c; color: white; font: 32px system-ui; padding: 48px; }</style>
        <h1>Popup destination</h1>`)
      return
    }
    if (request.url === '/download') {
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.setHeader('content-disposition', 'attachment; filename="browser-report.txt"')
      response.end('browser-download-body')
      return
    }
    if (request.url === '/api/status') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ready: true }))
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width">
      <title>Browser Interaction Lab</title>
      <style>
        body { background: #eef6ff; font: 24px system-ui; margin: 0; }
        h1 { left: 180px; position: absolute; top: 70px; }
        #name { font: inherit; height: 48px; left: 180px; position: absolute; top: 180px; width: 300px; }
        button { font: inherit; height: 54px; left: 540px; position: absolute; top: 180px; width: 160px; }
        #result { color: #17663a; font-weight: 700; left: 180px; position: absolute; top: 260px; }
        #moving { background: #2d6cdf; height: 50px; position: absolute; top: 370px; width: 50px; }
        #advanced { display: grid; font-size: 16px; gap: 8px; grid-template-columns: max-content; left: 180px; position: absolute; top: 470px; }
        #advanced iframe { height: 90px; width: 220px; }
      </style>
      <h1>Browser Interaction Lab</h1>
      <label><span hidden>Name</span><input id="name" aria-label="Name"></label>
      <button id="complete">Complete</button>
      <p id="result">WAITING</p>
      <div id="moving"></div>
      <section id="advanced">
        <label><input id="agree" type="checkbox"> Agree</label>
        <select id="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>
        <input id="upload" aria-label="Upload" type="file">
        <a id="download" href="/download" download>Download report</a>
        <a id="new-tab" href="/tab-destination" target="_blank">Open destination tab</a>
        <span id="async-status">ASYNC WAITING</span>
        <iframe id="embedded" title="Embedded lab" src="/frame"></iframe>
      </section>
      <script>
        console.log('browser-lab-ready')
        fetch('/api/status')
        setTimeout(() => {
          document.querySelector('#async-status').textContent = 'ASYNC READY'
        }, 100)
        document.querySelector('#complete').addEventListener('click', () => {
          const value = document.querySelector('#name').value
          document.querySelector('#result').textContent = 'COMPLETED: ' + value
          document.title = 'Done ' + value
        })
        let frame = 0
        const timer = setInterval(() => {
          frame += 1
          document.querySelector('#moving').style.left = (frame % 900) + 'px'
          if (frame >= 180) clearInterval(timer)
        }, 16)
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
  if (!response.ok()) {
    throw new Error(`Browser snapshot failed with HTTP ${response.status()}: ${await response.text()}`)
  }
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

test('does not show a Browser section before the first Browser is created', async ({
  page,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'empty-browser-project')
  fs.mkdirSync(workspace, { recursive: true })
  await page.route('**/api/browsers/capability', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      enabled: true,
      available: true,
      browser: { kind: 'chrome', path: '/mock/chrome' },
      message: 'Browser is available',
    }),
  }))
  await page.route('**/api/browsers', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ collectionRevision: 1, resources: [] }),
  }))
  await page.request.post('/farming/api/projects/mount', { data: { workspace } })
  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  await expect(project.getByTestId('farming-browser-section')).toHaveCount(0)
})

test('mounts Agent-owned Browsers behind nested resource controls without layout noise', async ({
  page,
  workspaceRoot,
}, testInfo) => {
  const workspace = path.join(workspaceRoot, 'agent-owned-browser-project')
  fs.mkdirSync(workspace, { recursive: true })
  const enableResponse = await page.request.post('/farming/api/settings', {
    data: { browserExtensionEnabled: true },
  })
  expect(enableResponse.ok()).toBeTruthy()
  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', workspace)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(agentRow.getByTestId('code-agent-resources-toggle')).toHaveCount(0)
  await expect(agentRow).not.toContainText('0')

  const createResponse = await page.request.post('/farming/api/browsers', {
    data: {
      rootId: projectFilesWorkspaceId(workspace),
      agentId,
      name: 'Agent Browser with a deliberately long title that must stay within the sidebar',
    },
  })
  expect(createResponse.ok()).toBeTruthy()
  const createdBrowser = await createResponse.json() as { id: string }

  const resourcesToggle = agentRow.getByTestId('code-agent-resources-toggle')
  const rowActions = agentRow.locator('.code-agent-row-actions')
  await expect(rowActions).toHaveCSS('opacity', '0')
  await expect(resourcesToggle).toHaveAttribute('aria-expanded', 'false')
  await agentRow.hover()
  await expect(rowActions).toHaveCSS('opacity', '1')
  const resourcesToggleBox = await resourcesToggle.boundingBox()
  const pinBox = await agentRow.getByTestId('code-agent-row-pin').boundingBox()
  if (!resourcesToggleBox || !pinBox) throw new Error('Agent row actions must have measurable bounds')
  expect(resourcesToggleBox.x).toBeLessThan(pinBox.x)
  const resourceSlot = page.locator(
    `[data-testid="code-agent-resource-slot"][data-agent-id="${agentId}"]`,
  )
  await expect(resourceSlot.getByTestId('farming-browser-section')).toHaveCount(0)

  await resourcesToggle.click()
  await expect(resourcesToggle).toHaveAttribute('aria-expanded', 'true')
  const browserSection = resourceSlot.getByTestId('farming-browser-section')
  await expect(browserSection).toBeVisible()
  const agentRowBox = await agentRow.boundingBox()
  const browserSectionBox = await browserSection.boundingBox()
  if (!agentRowBox || !browserSectionBox) throw new Error('Agent Browser hierarchy must have measurable bounds')
  expect(Math.round(browserSectionBox.x - agentRowBox.x)).toBe(14)
  const browserRow = browserSection.getByTestId('farming-browser-row')
  await expect(browserRow).toBeVisible()
  expect(await browserRow.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const sidebarScreenshot = testInfo.outputPath('agent-owned-browser-sidebar.png')
  await page.getByTestId('code-sidebar').screenshot({ path: sidebarScreenshot })
  await testInfo.attach('agent-owned-browser-sidebar', {
    path: sidebarScreenshot,
    contentType: 'image/png',
  })

  await browserSection.locator('.farming-browser-section-toggle').click()
  await expect(browserSection.locator('.farming-browser-section-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(browserRow).toHaveCount(0)
  await browserSection.locator('.farming-browser-section-toggle').click()
  await browserSection.getByTestId('farming-browser-row').click()
  await expect(page.getByTestId('farming-browser-viewer')).toBeVisible()
  await agentRow.hover()
  await resourcesToggle.click()
  await expect(resourceSlot.getByTestId('farming-browser-section')).toHaveCount(0)
  await expect(page.getByTestId('farming-browser-viewer')).toBeVisible()
  const resourcesResponse = await page.request.get('/farming/api/browsers')
  expect(resourcesResponse.ok()).toBeTruthy()
  const resourcesSnapshot = await resourcesResponse.json() as {
    resources: Array<{ id: string, status: string }>
  }
  expect(resourcesSnapshot.resources.find(resource => resource.id === createdBrowser.id)?.status)
    .toBe('stopped')
})

test('shows a passive active-Agent Browser preview and opens the full Viewer on demand', async ({
  page,
  workspaceRoot,
}, testInfo) => {
  const workspace = path.join(workspaceRoot, 'agent-browser-activity-preview')
  fs.mkdirSync(workspace, { recursive: true })
  const enableResponse = await page.request.post('/farming/api/settings', {
    data: { browserExtensionEnabled: true },
  })
  expect(enableResponse.ok()).toBeTruthy()
  await openFarming(page)
  const agentResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace },
  })
  const agent = await agentResponse.json() as { agentId?: string, error?: string }
  expect(agentResponse.ok(), agent.error || 'Failed to create preview Agent').toBeTruthy()
  const agentId = agent.agentId as string
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(agentRow).toBeVisible({ timeout: 30_000 })
  await agentRow.click()

  const createResponse = await page.request.post('/farming/api/browsers', {
    data: {
      rootId: projectFilesWorkspaceId(workspace),
      agentId,
      name: 'Live Browser work',
      url: targetUrl,
    },
  })
  expect(createResponse.ok()).toBeTruthy()
  const createdBrowser = await createResponse.json() as { id: string }
  const startResponse = await page.request.post(`/farming/api/browsers/${createdBrowser.id}/start`)
  expect(startResponse.ok()).toBeTruthy()

  const preview = page.getByTestId('farming-browser-activity-preview')
  await expect(preview).toBeVisible({ timeout: 30_000 })
  await expect(preview.locator('img')).toBeVisible({ timeout: 30_000 })
  const previewBox = await preview.boundingBox()
  expect(previewBox?.width).toBeGreaterThanOrEqual(230)
  expect(previewBox?.width).toBeLessThanOrEqual(250)
  expect(previewBox?.height).toBeLessThan(190)
  const previewScreenshot = testInfo.outputPath('agent-browser-activity-preview.png')
  await page.getByTestId('code-main').screenshot({ path: previewScreenshot })
  await testInfo.attach('agent-browser-activity-preview', {
    path: previewScreenshot,
    contentType: 'image/png',
  })

  await preview.locator('.farming-browser-activity-frame').click()
  const viewer = page.getByTestId('farming-browser-viewer')
  await expect(viewer).toBeVisible()
  await viewer.getByRole('button', { name: 'Back to Agent' }).click()
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: 'Hide browser preview' }).click()
  await expect(preview).toHaveCount(0)

  const resourcesResponse = await page.request.get('/farming/api/browsers')
  const resourcesSnapshot = await resourcesResponse.json() as {
    resources: Array<{ id: string, status: string }>
  }
  expect(resourcesSnapshot.resources.find(resource => resource.id === createdBrowser.id)?.status)
    .toBe('running')
})

test('deletes a Browser directly without a confirmation dialog', async ({
  page,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'browser-direct-delete')
  fs.mkdirSync(workspace, { recursive: true })
  const enableResponse = await page.request.post('/farming/api/settings', {
    data: { browserExtensionEnabled: true },
  })
  expect(enableResponse.ok()).toBeTruthy()
  await page.request.post('/farming/api/projects/mount', { data: { workspace } })
  const createResponse = await page.request.post('/farming/api/browsers', {
    data: { rootId: projectFilesWorkspaceId(workspace) },
  })
  expect(createResponse.ok()).toBeTruthy()
  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const row = project.getByTestId('farming-browser-row')
  await expect(row).toBeVisible()
  const dialogs: string[] = []
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message())
    await dialog.dismiss()
  })

  await row.hover()
  await row.getByRole('button', { name: 'Close Tab' }).click()
  await expect(project.getByTestId('farming-browser-section')).toHaveCount(0)
  expect(dialogs).toEqual([])
})

test('offers an explicit managed Chromium install when no browser is available', async ({
  page,
}, testInfo) => {
  let installed = false
  await page.route('**/api/browsers/capability', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      enabled: false,
      available: installed,
      browser: installed ? { kind: 'managed-chromium', path: '/mock/farming/chrome' } : null,
      installation: {
        state: installed ? 'ready' : 'absent',
        agentBrowserVersion: '0.32.3',
        installedVersion: installed ? '0.32.3' : '',
        updateAvailable: false,
        error: '',
      },
      message: installed ? 'Browser extension is disabled' : 'Install Farming-managed Chromium',
    }),
  }))
  await page.route('**/api/browsers/install', route => {
    installed = true
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    })
  })
  await openFarming(page)
  await expect(page.getByTestId('farming-browser-section')).toHaveCount(0)
  await page.getByTestId('code-nav-plugins').click()
  const pluginsPanel = page.getByTestId('code-plugins-panel')
  await expect(pluginsPanel.getByRole('heading', { name: 'Browser', exact: true })).toBeVisible()
  await expect(pluginsPanel.locator('small').filter({
    hasText: 'Install Farming-managed Chromium, choose a system browser, or use an external CDP endpoint on loopback.',
  })).toBeVisible()
  await expect(pluginsPanel.getByText('Not ready', { exact: true })).toBeVisible()
  const browserPlugin = pluginsPanel.getByTestId('code-plugin-browser')
  await expect(browserPlugin.getByRole('button', { name: 'Enable' })).toBeDisabled()
  await pluginsPanel.getByRole('button', { name: 'Install managed Chromium' }).click()
  await expect(pluginsPanel.getByRole('option', { name: 'Farming-managed Chromium' })).toBeEnabled()
  await expect(pluginsPanel.getByRole('button', { name: 'Install managed Chromium' })).toHaveCount(0)
  await expect(browserPlugin.getByRole('button', { name: 'Enable' })).toBeEnabled()
  const screenshot = testInfo.outputPath('browser-plugin-install-required.png')
  await pluginsPanel.screenshot({ path: screenshot })
  await testInfo.attach('browser-plugin-install-required', {
    path: screenshot,
    contentType: 'image/png',
  })
})

test('keeps extension cards compact and opens the full description on demand', async ({
  page,
}) => {
  const longDescription = [
    'A deliberately long extension description that should stay compact in the grid.',
    'It contains enough text to span several lines and prove that one verbose item cannot stretch its row.',
    'The complete text remains available in the explicit details dialog.',
  ].join(' ')
  await page.route('**/api/agent-extensions', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      agents: [{
        id: 'codex',
        name: 'codex',
        description: 'Codex CLI',
        discoverySupported: true,
        homes: [{
          id: 'default',
          extensions: [{
            id: '$short',
            command: '$short',
            name: 'Short skill',
            description: 'Short description.',
            kind: 'skill',
            scope: 'Personal',
          }, {
            id: '$long',
            command: '$long',
            name: 'Long skill',
            description: longDescription,
            kind: 'skill',
            scope: 'Personal',
          }, {
            id: 'plugin:sample',
            command: 'plugin:sample',
            name: 'Sample plugin',
            description: 'Plugin description.',
            kind: 'plugin',
            scope: 'Plugin',
          }, {
            id: '/sample',
            command: '/sample',
            name: 'Sample command',
            description: 'Command description.',
            kind: 'command',
            scope: 'Personal',
          }, {
            id: 'hook:sample',
            command: 'hook:sample',
            name: 'Sample hook',
            description: 'Hook description.',
            kind: 'hook',
            scope: 'Plugin',
          }],
        }],
      }],
    }),
  }))
  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()

  const cards = page.locator('.code-plugin-extension')
  await expect(cards).toHaveCount(5)
  const geometry = await cards.evaluateAll(elements => elements.map(element => {
    const description = element.querySelector('p')
    return {
      height: element.getBoundingClientRect().height,
      lineClamp: description ? getComputedStyle(description).webkitLineClamp : '',
    }
  }))
  expect(geometry.every(item => item.height === 126 && item.lineClamp === '3')).toBe(true)

  const skillSection = page.locator('.code-plugin-kind-section[data-kind="skill"]')
  const pluginSection = page.locator('.code-plugin-kind-section[data-kind="plugin"]')
  const commandSection = page.locator('.code-plugin-kind-section[data-kind="command"]')
  const hookSection = page.locator('.code-plugin-kind-section[data-kind="hook"]')
  await expect(skillSection.locator('summary').getByText('Skill', { exact: true })).toBeVisible()
  await expect(pluginSection.locator('summary').getByText('Plugin', { exact: true })).toBeVisible()
  await expect(commandSection.locator('summary').getByText('Command', { exact: true })).toBeVisible()
  await expect(hookSection.locator('summary').getByText('Hook', { exact: true })).toBeVisible()
  await skillSection.locator('summary').click()
  await expect(skillSection).toHaveJSProperty('open', false)
  await expect(pluginSection).toHaveJSProperty('open', true)

  await skillSection.locator('summary').click()
  await pluginSection.locator('summary').click()
  await cards.filter({ hasText: 'Long skill' }).click()
  const detail = page.getByTestId('code-plugin-detail-dialog')
  await expect(detail).toBeVisible()
  await expect(detail.getByText(longDescription, { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  await expect(pluginSection).toHaveJSProperty('open', false)
})

test('keeps an edited browser address until Enter submits it', async ({
  page,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'browser-address-draft')
  fs.mkdirSync(workspace, { recursive: true })
  const enableResponse = await page.request.post('/farming/api/settings', {
    data: { browserExtensionEnabled: true },
  })
  expect(enableResponse.ok()).toBeTruthy()
  await page.request.post('/farming/api/projects/mount', { data: { workspace } })
  await openFarming(page)

  const createResponse = await page.request.post('/farming/api/browsers', {
    data: { rootId: projectFilesWorkspaceId(workspace) },
  })
  expect(createResponse.ok()).toBeTruthy()
  const createdBrowser = await createResponse.json() as { id: string }
  const startResponse = await page.request.post(`/farming/api/browsers/${createdBrowser.id}/start`)
  expect(startResponse.ok()).toBeTruthy()

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  await expect(project.getByTestId('farming-browser-section')).toBeVisible()
  await project.getByTestId('farming-browser-row').click()
  const addressInput = page.getByRole('textbox', { name: 'Browser address' })
  await expect(addressInput).toBeVisible({ timeout: 30_000 })
  await addressInput.fill(targetUrl)

  const competingUrl = `${targetUrl}?agent-navigation=1`
  const competingNavigation = await page.request.post(`/farming/api/browsers/${createdBrowser.id}/navigate`, {
    data: { url: competingUrl },
  })
  expect(competingNavigation.ok()).toBeTruthy()
  await expect.poll(async () => (await browserSnapshot(page, createdBrowser.id)).url).toBe(competingUrl)
  await expect(addressInput).toHaveValue(targetUrl)

  await addressInput.press('Enter')
  await expect.poll(async () => (await browserSnapshot(page, createdBrowser.id)).url).toBe(targetUrl)
})

test('normalizes a bare address and clears a recovered navigation error', async ({
  page,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'browser-address-recovery')
  fs.mkdirSync(workspace, { recursive: true })
  const enableResponse = await page.request.post('/farming/api/settings', {
    data: { browserExtensionEnabled: true },
  })
  expect(enableResponse.ok()).toBeTruthy()
  await page.request.post('/farming/api/projects/mount', { data: { workspace } })
  const createResponse = await page.request.post('/farming/api/browsers', {
    data: { rootId: projectFilesWorkspaceId(workspace) },
  })
  expect(createResponse.ok()).toBeTruthy()
  const createdBrowser = await createResponse.json() as { id: string }
  const startResponse = await page.request.post(`/farming/api/browsers/${createdBrowser.id}/start`)
  expect(startResponse.ok()).toBeTruthy()
  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  await project.getByTestId('farming-browser-row').click()
  const viewer = page.getByTestId('farming-browser-viewer')
  const addressInput = viewer.getByRole('textbox', { name: 'Browser address' })
  await expect(addressInput).toBeVisible({ timeout: 30_000 })

  const bareTarget = targetUrl.replace(/^http:\/\//, '')
  await addressInput.fill(bareTarget)
  await addressInput.press('Enter')
  await expect.poll(async () => (await browserSnapshot(page, createdBrowser.id)).url).toBe(targetUrl)
  await expect(addressInput).toHaveValue(targetUrl)

  await addressInput.fill(`${targetUrl}closed`)
  await addressInput.press('Enter')
  await expect(viewer.getByRole('alert')).toContainText('ERR_EMPTY_RESPONSE')

  await addressInput.fill(bareTarget)
  await addressInput.press('Enter')
  await expect.poll(async () => (await browserSnapshot(page, createdBrowser.id)).title)
    .toBe('Browser Interaction Lab')
  await expect(viewer.getByRole('alert')).toHaveCount(0)
  await expect(viewer.locator('form')).toHaveAttribute('aria-busy', 'false')
})

test('promotes a website popup into a shared Browser tab Resource', async ({
  page,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'browser-tabs')
  fs.mkdirSync(workspace, { recursive: true })
  const enableResponse = await page.request.post('/farming/api/settings', {
    data: { browserExtensionEnabled: true },
  })
  expect(enableResponse.ok()).toBeTruthy()
  await page.request.post('/farming/api/projects/mount', { data: { workspace } })
  const createResponse = await page.request.post('/farming/api/browsers', {
    data: {
      rootId: projectFilesWorkspaceId(workspace),
      url: targetUrl,
    },
  })
  expect(createResponse.ok()).toBeTruthy()
  const createdBrowser = await createResponse.json() as { id: string }
  const startResponse = await page.request.post(`/farming/api/browsers/${createdBrowser.id}/start`)
  expect(startResponse.ok()).toBeTruthy()
  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const browserSection = project.getByTestId('farming-browser-section')
  await browserSection.getByTestId('farming-browser-row').click()
  const viewer = page.getByTestId('farming-browser-viewer')
  await expect(viewer.locator('canvas')).toBeVisible({ timeout: 30_000 })
  const popupResponse = await page.request.post(`/farming/api/browsers/${createdBrowser.id}/action`, {
    data: { kind: 'click', selector: '#new-tab' },
  })
  expect(popupResponse.ok()).toBeTruthy()

  await expect(browserSection.getByTestId('farming-browser-row')).toHaveCount(2)
  await expect(viewer.getByRole('textbox', { name: 'Browser address' }))
    .toHaveValue(`${targetUrl}tab-destination`)
  await expect(browserSection.locator('.farming-browser-row.active')).toContainText('Popup destination')

  const originalRow = browserSection.locator(`[data-browser-id="${createdBrowser.id}"]`)
  await originalRow.click()
  await expect(viewer.getByRole('textbox', { name: 'Browser address' })).toHaveValue(targetUrl)
})

test('keeps Browser startup, navigation, frames, and interaction within local budgets', async ({
  page,
  workspaceRoot,
}, testInfo) => {
  const workspace = path.join(workspaceRoot, 'browser-performance')
  fs.mkdirSync(workspace, { recursive: true })
  const enableResponse = await page.request.post('/farming/api/settings', {
    data: { browserExtensionEnabled: true },
  })
  expect(enableResponse.ok()).toBeTruthy()
  await page.request.post('/farming/api/projects/mount', { data: { workspace } })
  const createResponse = await page.request.post('/farming/api/browsers', {
    data: { rootId: projectFilesWorkspaceId(workspace) },
  })
  expect(createResponse.ok()).toBeTruthy()
  const createdBrowser = await createResponse.json() as { id: string }

  const startupAt = performance.now()
  const startResponse = await page.request.post(`/farming/api/browsers/${createdBrowser.id}/start`)
  expect(startResponse.ok()).toBeTruthy()
  const startupMs = performance.now() - startupAt
  await openFarming(page)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  await project.getByTestId('farming-browser-row').click()
  const viewer = page.getByTestId('farming-browser-viewer')
  const canvas = viewer.locator('canvas')
  await expect(canvas).toBeVisible({ timeout: 30_000 })
  await canvas.evaluate(element => {
    const context = (element as HTMLCanvasElement).getContext('2d')
    if (!context) throw new Error('Browser canvas has no 2D context')
    const originalDrawImage = context.drawImage.bind(context)
    const frameTimes: number[] = []
    ;(window as typeof window & { __farmingBrowserFrameTimes?: number[] }).__farmingBrowserFrameTimes = frameTimes
    context.drawImage = ((...args: Parameters<CanvasRenderingContext2D['drawImage']>) => {
      frameTimes.push(performance.now())
      return originalDrawImage(...args)
    }) as CanvasRenderingContext2D['drawImage']
  })

  const navigationAt = performance.now()
  const addressInput = viewer.getByRole('textbox', { name: 'Browser address' })
  await addressInput.fill(`${targetUrl}?performance=1`)
  await addressInput.press('Enter')
  await expect.poll(async () => (await browserSnapshot(page, createdBrowser.id)).title)
    .toBe('Browser Interaction Lab')
  const navigationMs = performance.now() - navigationAt
  await expect.poll(async () => canvas.evaluate(() =>
    (window as typeof window & { __farmingBrowserFrameTimes?: number[] }).__farmingBrowserFrameTimes?.length || 0
  )).toBeGreaterThanOrEqual(20)
  const frameTimes = await canvas.evaluate(() =>
    (window as typeof window & { __farmingBrowserFrameTimes?: number[] }).__farmingBrowserFrameTimes || []
  )

  const interactionAt = performance.now()
  await clickBrowserPoint(canvas, 330, 207)
  const textInput = viewer.getByRole('textbox', { name: 'Browser text input' })
  await expect(textInput).toBeFocused()
  await page.keyboard.insertText('性能测试')
  await clickBrowserPoint(canvas, 620, 207)
  await expect.poll(async () => (await browserSnapshot(page, createdBrowser.id)).title)
    .toBe('Done 性能测试')
  const interactionMs = performance.now() - interactionAt
  const frameWindowMs = Math.max(1, frameTimes.at(-1)! - frameTimes[0])
  const metrics = {
    startupMs: Math.round(startupMs),
    navigationMs: Math.round(navigationMs),
    interactionMs: Math.round(interactionMs),
    frameCount: frameTimes.length,
    observedFps: Math.round(frameTimes.length * 1_000 / frameWindowMs),
  }
  console.log(`browser-performance ${JSON.stringify(metrics)}`)
  await testInfo.attach('browser-performance.json', {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: 'application/json',
  })
  expect(metrics.startupMs).toBeLessThan(5_000)
  expect(metrics.navigationMs).toBeLessThan(2_000)
  expect(metrics.interactionMs).toBeLessThan(2_000)
  expect(metrics.observedFps).toBeGreaterThanOrEqual(20)

  await page.request.delete(`/farming/api/browsers/${createdBrowser.id}`)
})

test('uses dark native colors for the Browser source menu', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const pluginsPanel = page.getByTestId('code-plugins-panel')
  const browserSource = pluginsPanel.getByRole('combobox', { name: 'Browser source' })

  await page.evaluate(() => {
    document.body.dataset.appearance = 'dark'
  })
  await expect(browserSource).toHaveCSS('color-scheme', 'dark')
  const optionColors = await browserSource.locator('option').first().evaluate(option => {
    const style = getComputedStyle(option)
    return {
      background: style.backgroundColor,
      color: style.color,
    }
  })
  expect(optionColors).toEqual({
    background: 'rgb(33, 33, 33)',
    color: 'rgb(255, 255, 255)',
  })
})

test('selects the Browser source in Plugins without restarting Farming', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const pluginsPanel = page.getByTestId('code-plugins-panel')
  const browserSource = pluginsPanel.getByRole('combobox', { name: 'Browser source' })
  const apply = pluginsPanel.getByRole('button', { name: 'Apply' })

  await expect(pluginsPanel.getByRole('combobox', { name: 'Browser permissions' })).toHaveCount(0)
  await expect(browserSource.locator('option')).toContainText([
    'Choose an available Chromium automatically',
    'Google Chrome',
    'Farming-managed Chromium',
    'External CDP',
  ])
  await browserSource.selectOption('system:')
  if (await apply.isEnabled()) await apply.click()
  await expect(browserSource).toHaveValue('system:')
  await expect(apply).toBeDisabled()

  await browserSource.selectOption('external-cdp')
  const cdpAddress = pluginsPanel.getByRole('textbox', { name: 'CDP address' })
  await expect(cdpAddress).toHaveValue('http://127.0.0.1:9222')
  await apply.click()
  await expect(apply).toBeDisabled()
  await expect(pluginsPanel.locator('small').filter({ hasText: 'External CDP ·' })).toBeVisible()

  await browserSource.selectOption('system:')
  await apply.click()
  await expect(apply).toBeDisabled()
  await expect(pluginsPanel.locator('small').filter({ hasText: 'System Chromium ·' })).toBeVisible()
})

test('matches the focused Viewer viewport and restores the previous Viewer on close', async ({
  browser,
  page,
  workspaceRoot,
}, testInfo) => {
  const workspace = path.join(workspaceRoot, 'browser-project')
  fs.mkdirSync(workspace, { recursive: true })
  await testInfo.attach('target-url', { body: targetUrl, contentType: 'text/plain' })
  const enableResponse = await page.request.post('/farming/api/settings', {
    data: { browserExtensionEnabled: true },
  })
  expect(enableResponse.ok()).toBeTruthy()
  await page.request.post('/farming/api/projects/mount', { data: { workspace } })
  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const browserSection = project.getByTestId('farming-browser-section')
  await expect(browserSection).toHaveCount(0)
  await page.getByTestId('code-nav-plugins').click()
  const pluginsPanel = page.getByTestId('code-plugins-panel')
  await expect(pluginsPanel.getByTestId('code-plugin-section-farming')).toBeVisible()
  await expect(pluginsPanel.getByTestId('code-plugin-section-agent-codex')).toBeVisible()
  await expect(pluginsPanel.getByTestId('code-plugin-section-agent-claude')).toBeVisible()
  const browserPlugin = pluginsPanel.getByTestId('code-plugin-browser')
  const browserToggle = browserPlugin.getByRole('button', { name: 'Disable' })
  const browserHint = pluginsPanel.getByText(
    'Let Agents operate webpages and view the same browser in Farming.',
    { exact: true },
  )
  await expect(pluginsPanel.getByRole('heading', { name: 'Browser', exact: true })).toBeVisible()
  await expect(pluginsPanel.locator('small').filter({ hasText: /System Chromium|Google Chrome|Chromium|Brave|Microsoft Edge/ })).toBeVisible()
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
  const pluginScreenshot = testInfo.outputPath('browser-plugin-system-browser.png')
  await pluginsPanel.screenshot({ path: pluginScreenshot })
  await testInfo.attach('browser-plugin-system-browser', {
    path: pluginScreenshot,
    contentType: 'image/png',
  })
  await browserToggle.click()
  await expect(browserPlugin.getByRole('button', { name: 'Enable' })).toHaveAttribute('aria-pressed', 'false')
  await expect(browserSection).toHaveCount(0)
  await browserPlugin.getByRole('button', { name: 'Enable' }).click()
  await expect(browserPlugin.getByRole('button', { name: 'Disable' })).toHaveAttribute('aria-pressed', 'true')
  await expect(browserSection).toHaveCount(0)
  await pluginsPanel.getByRole('button', { name: 'Back to workspace' }).click()
  const createResponse = await page.request.post('/farming/api/browsers', {
    data: { rootId: projectFilesWorkspaceId(workspace) },
  })
  expect(createResponse.ok()).toBeTruthy()
  const createdBrowser = await createResponse.json() as { id: string }
  const startResponse = await page.request.post(`/farming/api/browsers/${createdBrowser.id}/start`)
  expect(startResponse.ok()).toBeTruthy()
  await expect(browserSection).toBeVisible()
  await expect(browserSection.locator('.farming-browser-section-toggle small')).toHaveText('1')
  await browserSection.getByTestId('farming-browser-row').click()
  const viewer = page.getByTestId('farming-browser-viewer')
  const desktopCanvas = viewer.locator('canvas')
  await expect(desktopCanvas).toBeVisible({ timeout: 30_000 })
  await expect(viewer.getByRole('button', { name: 'Back to Agent' })).toBeVisible()

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
  await expect.poll(async () => viewer.locator('.farming-browser-viewport').evaluate(element => {
    const canvas = element.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) {
      return false
    }
    const rect = canvas.getBoundingClientRect()
    return canvas.width >= element.clientWidth
      && canvas.height >= element.clientHeight
      && Math.round(rect.width) === element.clientWidth
      && Math.round(rect.height) === element.clientHeight
  })).toBe(true)
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

  const waited = JSON.parse((await runBrowserCli([
    'wait',
    browserId!,
    '--text',
    'ASYNC READY',
    '--timeout',
    '5000',
  ])).stdout) as { waited: string }
  expect(waited.waited).toBe('text')
  const exactText = JSON.parse((await runBrowserCli([
    'get',
    browserId!,
    'text',
    'css=#async-status',
  ])).stdout) as { text: string }
  expect(exactText.text).toBe('ASYNC READY')

  await runBrowserCli(['check', browserId!, 'css=#agree'])
  const checked = JSON.parse((await runBrowserCli([
    'is',
    browserId!,
    'checked',
    'css=#agree',
  ])).stdout) as { checked: boolean }
  expect(checked.checked).toBe(true)
  await runBrowserCli(['select', browserId!, 'css=#choice', 'b'])
  const evaluated = JSON.parse((await runBrowserCli([
    'eval',
    browserId!,
    '({choice:document.querySelector("#choice").value,title:document.title})',
  ])).stdout) as { result: { choice: string, title: string } }
  expect(evaluated.result).toEqual({ choice: 'b', title: 'Done ssh-agent-cli' })

  await runBrowserCli(['storage', browserId!, 'local', 'set', 'theme', 'dark'])
  const storageValue = JSON.parse((await runBrowserCli([
    'storage',
    browserId!,
    'local',
    'get',
    'theme',
  ])).stdout) as { value: string }
  expect(storageValue.value).toBe('dark')
  await runBrowserCli(['cookies', browserId!, 'set', 'browser_mode', 'test'])
  const cookies = JSON.parse((await runBrowserCli([
    'cookies',
    browserId!,
    'get',
  ])).stdout) as { cookies: Array<{ name: string, value: string }> }
  expect(cookies.cookies).toContainEqual(expect.objectContaining({
    name: 'browser_mode',
    value: 'test',
  }))

  const consoleMessages = JSON.parse((await runBrowserCli([
    'console',
    browserId!,
  ])).stdout) as { messages: Array<{ text: string }> }
  expect(consoleMessages.messages.some(message => message.text.includes('browser-lab-ready'))).toBe(true)
  const networkRequests = JSON.parse((await runBrowserCli([
    'network',
    browserId!,
    'requests',
    '--filter',
    'api/status',
  ])).stdout) as { requests: Array<{ url: string }> }
  expect(networkRequests.requests.some(request => request.url.includes('/api/status'))).toBe(true)

  const uploadPath = path.join(workspace, 'browser-upload.txt')
  fs.writeFileSync(uploadPath, 'browser-upload-body')
  await runBrowserCli(['upload', browserId!, 'css=#upload', uploadPath])
  const uploadName = JSON.parse((await runBrowserCli([
    'eval',
    browserId!,
    'document.querySelector("#upload").files[0].name',
  ])).stdout) as { result: string }
  expect(uploadName.result).toBe('browser-upload.txt')

  await runBrowserCli(['frame', browserId!, 'css=#embedded'])
  const frameText = JSON.parse((await runBrowserCli([
    'get',
    browserId!,
    'text',
    'css=#inside-frame',
  ])).stdout) as { text: string }
  expect(frameText.text).toBe('Inside frame')
  await runBrowserCli(['frame', browserId!, 'main'])

  const downloadPath = path.join(workspace, 'browser-report.txt')
  const downloaded = JSON.parse((await runBrowserCli([
    'download',
    browserId!,
    'css=#download',
    downloadPath,
    '--timeout',
    '10000',
  ])).stdout) as { path: string, size: number }
  expect(downloaded.path).toBe('browser-report.txt')
  expect(downloaded.size).toBe(Buffer.byteLength('browser-download-body'))
  expect(fs.readFileSync(downloadPath, 'utf8')).toBe('browser-download-body')

  await runBrowserCli([
    'eval',
    browserId!,
    'setTimeout(()=>{window.promptResult=prompt("Code?")},50);true',
  ])
  await expect.poll(async () => {
    const status = JSON.parse((await runBrowserCli([
      'dialog',
      browserId!,
      'status',
    ])).stdout) as { hasDialog: boolean }
    return status.hasDialog
  }).toBe(true)
  await runBrowserCli(['dialog', browserId!, 'accept', 'Farming'])
  const promptResult = JSON.parse((await runBrowserCli([
    'eval',
    browserId!,
    'window.promptResult',
  ])).stdout) as { result: string }
  expect(promptResult.result).toBe('Farming')

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
  await mobilePage.bringToFront()
  await mobilePage.goto(page.url())
  const mobileCanvas = mobilePage.getByTestId('farming-browser-viewer').locator('canvas')
  await expect(mobileCanvas).toBeVisible({ timeout: 30_000 })
  const readMobileFrameSize = () => mobileCanvas.evaluate(canvas => [
    (canvas as HTMLCanvasElement).width,
    (canvas as HTMLCanvasElement).height,
  ])
  await expect.poll(async () => mobilePage.getByTestId('farming-browser-viewer')
    .locator('.farming-browser-viewport')
    .evaluate(element => {
      const canvas = element.querySelector('canvas') as HTMLCanvasElement | null
      if (!canvas || canvas.width <= 0 || canvas.height <= 0) return false
      const rect = canvas.getBoundingClientRect()
      return Math.round(rect.width) === element.clientWidth
        && Math.round(rect.height) === element.clientHeight
    })).toBe(true)
  const mobileFrameSize = await readMobileFrameSize()
  await expect.poll(async () => Promise.all([desktopCanvas, mobileCanvas].map(async canvas => [
    await canvas.evaluate(element => (element as HTMLCanvasElement).width),
    await canvas.evaluate(element => (element as HTMLCanvasElement).height),
  ]))).toEqual([mobileFrameSize, mobileFrameSize])
  const mobileScreenshot = testInfo.outputPath('browser-mobile.png')
  await mobilePage.screenshot({ path: mobileScreenshot, fullPage: true })
  await testInfo.attach('browser-mobile', { path: mobileScreenshot, contentType: 'image/png' })
  await mobileContext.close()
  await expect.poll(readDesktopFrameSize).toEqual(desktopFrameSize)

  const row = browserSection.getByTestId('farming-browser-row')
  await row.hover()
  await row.getByRole('button', { name: 'Rename Tab' }).click()
  await row.getByRole('textbox', { name: 'Tab name' }).fill('Frontend Smoke')
  await row.getByRole('textbox', { name: 'Tab name' }).press('Enter')
  await expect(row).toContainText('Frontend Smoke')

  await viewer.getByRole('button', { name: 'More', exact: true }).click()
  await viewer.getByRole('menuitem', { name: 'Stop', exact: true }).click()
  await expect(viewer.getByText('Tab stopped', { exact: true })).toBeVisible({ timeout: 15_000 })
  await viewer.getByRole('button', { name: 'Start Tab' }).click()
  await expect(viewer.locator('canvas')).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await browserSnapshot(page, browserId!)).url).toBe(targetUrl)

  await row.hover()
  await row.getByRole('button', { name: 'Close Tab' }).click()
  await expect(browserSection).toHaveCount(0)
  await page.request.post('/farming/api/projects/remove', { data: { workspace } })
})
