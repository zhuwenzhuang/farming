import fs from 'node:fs'
import path from 'node:path'
import type { Page, WebSocket as PlaywrightWebSocket } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createControlAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
}

async function openProjectFile(page: Page, projectName: string, filePath: string) {
  const project = page.getByTestId('code-project-group').filter({ hasText: projectName })
  await expect(project).toBeVisible({ timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  const segments = filePath.split('/')
  for (let index = 0; index < segments.length - 1; index += 1) {
    const directoryPath = segments.slice(0, index + 1).join('/')
    const directory = files.locator(`[data-testid="code-file-row"][data-file-path="${directoryPath}"]`)
    await expect(directory).toBeVisible()
    if (await directory.getAttribute('aria-expanded') !== 'true') await directory.click()
  }

  const file = files.locator(`[data-testid="code-file-row"][data-file-path="${filePath}"]`)
  await expect(file).toBeVisible()
  await file.dblclick()
  const tab = page.locator(`.code-file-editor-tab[title="${filePath}"]`)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(tab).not.toHaveAttribute('data-preview', 'true')
}

function recordWorkspaceWatchReady(socket: PlaywrightWebSocket, onReady: (paths: string[]) => void) {
  socket.on('framereceived', frame => {
    try {
      const message = JSON.parse(String(frame.payload)) as { type?: string; paths?: string[]; watching?: boolean }
      if (message.type === 'workspace-file-watch' && message.watching === true && Array.isArray(message.paths)) {
        onReady(message.paths)
      }
    } catch {
      // Ignore terminal and other non-JSON websocket frames.
    }
  })
}

test('restores and refreshes one hundred expanded directories without overflowing the request queue', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'restored-tree')
  const directories = Array.from({ length: 100 }, (_, i) => `directory-${String(i).padStart(3, '0')}`)
  for (const directory of directories) {
    fs.mkdirSync(path.join(workspace, directory), { recursive: true })
    fs.writeFileSync(path.join(workspace, directory, 'guide.md'), '# Restored file\n')
  }
  await createControlAgent(page, workspace)
  await page.addInitScript(({ workspace, directories }) => {
    localStorage.setItem('farming.code.workspaceViewState.v1', JSON.stringify({
      updatedAt: Date.now(), lastProjectWorkspace: workspace,
      projectFiles: { [workspace]: { filesCollapsed: false, openDirectoryPaths: directories } },
    }))
  }, { workspace, directories })
  const errors: string[] = []
  const loaded = new Set<string>()
  page.on('websocket', socket => {
    socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload)) as {
        type?: string; ok?: boolean; error?: { code: string }; result?: { path?: string; items?: unknown[] }
      }
      if (message.type !== 'workspace-result') return
      if (!message.ok) errors.push(message.error?.code || 'unknown')
      if (Array.isArray(message.result?.items) && message.result.path) loaded.add(message.result.path)
    })
  })
  await openFarming(page)
  await expect.poll(() => directories.filter(directory => loaded.has(directory)).length).toBe(100)
  const project = page.getByTestId('code-project-group').filter({ hasText: 'restored-tree' })
  const refresh = project.getByTestId('code-files-refresh')
  await refresh.focus()
  await refresh.press('Enter')
  await expect(refresh).toHaveAttribute('data-refresh-status', 'success')
  await openProjectFile(page, 'restored-tree', 'directory-000/guide.md')
  await expect(page.getByTestId('code-file-markdown-preview').getByRole('heading', { name: 'Restored file' })).toBeVisible()
  expect(errors).toEqual([])
})

for (const appearance of ['light', 'dark', 'paper']) {
  test(`oversized directory fails locally while ordinary files remain usable in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, 'bounded-tree')
    const large = path.join(workspace, 'large')
    fs.mkdirSync(large, { recursive: true })
    for (let i = 0; i < 4097; i++) fs.writeFileSync(path.join(large, `entry-${i}`), '')
    fs.writeFileSync(path.join(large, 'target-find-me.md'), '# Found in large directory\n')
    fs.writeFileSync(path.join(workspace, 'target-find-me-outside.md'), '# Outside large directory\n')
    fs.writeFileSync(path.join(workspace, 'guide.md'), '# Responsive file\n')
    await createControlAgent(page, workspace)
    await page.request.post('/farming/api/settings', { data: { appearance } })
    await openFarming(page)
    await openProjectFile(page, 'bounded-tree', 'guide.md')
    const project = page.getByTestId('code-project-group').filter({ hasText: 'bounded-tree' })
    const files = project.getByTestId('code-files-section')
    await files.locator('[data-file-path="large"]').click()
    await expect(files).toContainText('This directory has more than 4096 entries.')
    await testInfo.attach(`oversized-directory-${appearance}`, {
      body: await files.screenshot(),
      contentType: 'image/png',
    })
    await files.getByRole('button', { name: 'Search this directory' }).click()
    const searchInput = files.getByRole('combobox', { name: 'Search in large' })
    await expect(searchInput).toBeFocused()
    await searchInput.fill('target-find-me')
    await expect(files.getByTestId('code-file-search-results')).toContainText('target-find-me.md')
    await expect(files.getByTestId('code-file-search-results')).not.toContainText('target-find-me-outside.md')
    await files.getByTestId('code-file-search-results').getByRole('option', { name: /target-find-me/ }).click()
    await expect(page.getByTestId('code-file-markdown-preview').getByRole('heading', { name: 'Found in large directory' })).toBeVisible()
    // Collapse the failed branch and refresh the ordinary project through the UI.
    await files.locator('[data-file-path="large"]').click()
    await project.getByTestId('code-files-refresh').focus()
    await project.getByTestId('code-files-refresh').press('Enter')
    await expect(project.getByTestId('code-files-refresh')).toHaveAttribute('data-refresh-status', 'success')
    await openProjectFile(page, 'bounded-tree', 'guide.md')
    await expect(page.getByTestId('code-file-markdown-preview').getByRole('heading', { name: 'Responsive file' })).toBeVisible()
  })

  test(`missing parent watch stays file-local while switching documents in ${appearance}`, async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'watch-isolation')
    const removed = path.join(workspace, 'removed')
    fs.mkdirSync(removed, { recursive: true })
    fs.writeFileSync(path.join(removed, 'old.md'), '# Previous document\n')
    fs.writeFileSync(path.join(workspace, 'one.md'), '# First document\n')
    fs.writeFileSync(path.join(workspace, 'two.md'), '# Second document\n')
    await createControlAgent(page, workspace)
    await page.request.post('/farming/api/settings', { data: { appearance } })
    let deleted = false
    const globalErrors: string[] = []
    const admitted = new Set<string>()
    await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
      const server = socket.connectToServer()
      socket.onMessage(message => {
        const payload = JSON.parse(String(message)) as { type?: string; paths?: string[] }
        if (!deleted && payload.type === 'watch-workspace-files' && payload.paths?.includes('removed/old.md')) {
          deleted = true
          fs.rmSync(removed, { recursive: true })
        }
        server.send(message)
      })
      server.onMessage(message => {
        const payload = JSON.parse(String(message)) as { type?: string; message?: string; paths?: string[] }
        if (payload.type === 'error') globalErrors.push(payload.message || '')
        if (payload.type === 'workspace-file-watch') payload.paths?.forEach(file => admitted.add(file))
        socket.send(message)
      })
    })
    await openFarming(page)
    const project = page.getByTestId('code-project-group').filter({ hasText: 'watch-isolation' })
    const files = project.getByTestId('code-files-section')
    const title = files.locator('.code-files-title').first()
    if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
    await files.locator('[data-file-path="removed"]').click()
    await files.locator('[data-file-path="removed/old.md"]').click()
    await expect(page.getByTestId('code-file-editor-alert')).toContainText('path not found')
    await expect(page.getByTestId('code-file-editor')).toHaveScreenshot(`missing-watch-${appearance}.png`)
    for (const file of ['one.md', 'two.md', 'one.md', 'two.md']) {
      await openProjectFile(page, 'watch-isolation', file)
      await expect(page.getByTestId('code-file-editor-alert')).toHaveCount(0)
    }
    await expect.poll(() => admitted.has('two.md')).toBe(true)
    fs.writeFileSync(path.join(workspace, 'two.md'), '# Updated second document\n')
    await expect(page.getByTestId('code-file-markdown-preview').getByRole('heading', { name: 'Updated second document' })).toBeVisible()
    expect(deleted).toBe(true)
    expect(globalErrors).toEqual([])
  })
}

test('automatically refreshes every open file viewer while preserving dirty drafts', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'file-auto-refresh')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'plain.txt'), 'plain before\n')
  fs.writeFileSync(path.join(workspace, 'guide.md'), '# Markdown before\n')
  fs.writeFileSync(path.join(workspace, 'index.html'), '<h1>HTML before</h1><img src="asset.svg" alt="linked asset">\n')
  fs.writeFileSync(
    path.join(workspace, 'asset.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="orange"/></svg>\n',
  )
  fs.writeFileSync(
    path.join(workspace, 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>\n',
  )
  const burstPaths = Array.from({ length: 8 }, (_, index) => `burst-${index}.txt`)
  const burstPathSet = new Set(burstPaths)
  const expectedBurstWatchPaths = [
    ...burstPaths,
    'guide.md',
    'icon.svg',
    'index.html',
    'plain.txt',
  ].sort()
  burstPaths.forEach(filePath => fs.writeFileSync(path.join(workspace, filePath), 'before\n'))
  await createControlAgent(page, workspace)

  let watchedPaths: string[] = []
  const watchedBurstPaths = new Set<string>()
  const redundantWatchReadyReads = new Set<string>()
  let trackBurstRefresh = false
  let activeRefreshReads = 0
  let maxActiveRefreshReads = 0
  let completedRefreshReads = 0
  const activeBurstRequests = new Set<string>()
  page.on('websocket', socket => {
    recordWorkspaceWatchReady(socket, paths => {
      watchedPaths = paths
      paths.forEach(filePath => {
        if (burstPathSet.has(filePath)) watchedBurstPaths.add(filePath)
      })
    })
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as {
          type?: string
          requestId?: string
          request?: { operation?: string; path?: string }
        }
        if (message.type !== 'workspace-request' || message.request?.operation !== 'read-file') return
        const filePath = message.request.path || ''
        if (watchedBurstPaths.has(filePath) && !trackBurstRefresh) redundantWatchReadyReads.add(filePath)
        if (!trackBurstRefresh || !burstPathSet.has(filePath) || !message.requestId) return
        activeBurstRequests.add(message.requestId)
        activeRefreshReads += 1
        maxActiveRefreshReads = Math.max(maxActiveRefreshReads, activeRefreshReads)
      } catch {
        // Ignore terminal and other non-JSON websocket frames.
      }
    })
    socket.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as { type?: string; requestId?: string }
        if (message.type !== 'workspace-result' || !message.requestId || !activeBurstRequests.delete(message.requestId)) return
        activeRefreshReads -= 1
        completedRefreshReads += 1
      } catch {
        // Ignore terminal and other non-JSON websocket frames.
      }
    })
  })
  await openFarming(page)

  await openProjectFile(page, 'file-auto-refresh', 'plain.txt')
  await expect.poll(() => watchedPaths).toEqual(['plain.txt'])
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toBe('plain before\n')
  fs.writeFileSync(path.join(workspace, 'plain.txt'), 'plain after\n')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toBe('plain after\n')

  await page.evaluate(() => window.__farmingFileEditorTest?.insertText('local draft'))
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toContain('local draft')
  fs.writeFileSync(path.join(workspace, 'plain.txt'), 'external conflict\n')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toContain('local draft')
  await expect(page.getByTestId('code-file-editor').getByTitle('Changed on disk')).toBeVisible()

  await openProjectFile(page, 'file-auto-refresh', 'guide.md')
  await expect.poll(() => watchedPaths).toEqual(['guide.md', 'plain.txt'])
  const markdownPreview = page.getByTestId('code-file-markdown-preview')
  await expect(markdownPreview.getByRole('heading', { name: 'Markdown before' })).toBeVisible()
  fs.writeFileSync(path.join(workspace, 'guide.md'), '# Markdown after\n')
  await expect(markdownPreview.getByRole('heading', { name: 'Markdown after' })).toBeVisible()

  await openProjectFile(page, 'file-auto-refresh', 'index.html')
  await expect.poll(() => watchedPaths).toEqual(['guide.md', 'index.html', 'plain.txt'])
  const htmlFrame = page.frameLocator('[data-testid="code-file-html-preview"]')
  await expect(htmlFrame.getByRole('heading', { name: 'HTML before' })).toBeVisible()
  fs.writeFileSync(path.join(workspace, 'index.html'), '<h1>HTML after</h1><img src="asset.svg" alt="linked asset">\n')
  await expect(htmlFrame.getByRole('heading', { name: 'HTML after' })).toBeVisible()

  const htmlPreview = page.getByTestId('code-file-html-preview')
  const previewDocumentBeforeDependencyReload = await htmlPreview.getAttribute('srcdoc')
  fs.writeFileSync(
    path.join(workspace, 'asset.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>\n',
  )
  await expect.poll(() => watchedPaths).toEqual(['guide.md', 'index.html', 'plain.txt'])
  const reloadButton = page.getByTestId('code-file-editor').getByRole('button', { name: 'Reload file' })
  await expect(reloadButton.locator('svg')).toBeVisible()
  await expect(reloadButton.locator('path')).toHaveCount(2)
  await reloadButton.click()
  await expect.poll(() => htmlPreview.getAttribute('srcdoc')).not.toBe(previewDocumentBeforeDependencyReload)
  await expect.poll(() => htmlFrame.getByRole('img', { name: 'linked asset' }).evaluate(
    (image: HTMLImageElement) => image.naturalWidth,
  )).toBeGreaterThan(0)

  await openProjectFile(page, 'file-auto-refresh', 'icon.svg')
  await expect.poll(() => watchedPaths).toEqual(['guide.md', 'icon.svg', 'index.html', 'plain.txt'])
  const imagePreview = page.getByTestId('code-file-image-preview')
  const originalSource = await imagePreview.getAttribute('src')
  expect(originalSource).toBeTruthy()
  fs.writeFileSync(
    path.join(workspace, 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>\n',
  )
  await expect.poll(() => imagePreview.getAttribute('src')).not.toBe(originalSource)
  await expect.poll(() => imagePreview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)

  for (const filePath of burstPaths) await openProjectFile(page, 'file-auto-refresh', filePath)
  await expect.poll(() => watchedPaths).toEqual(expectedBurstWatchPaths)
  expect([...redundantWatchReadyReads]).toEqual([])
  trackBurstRefresh = true
  burstPaths.forEach(filePath => fs.writeFileSync(path.join(workspace, filePath), 'after\n'))
  await expect.poll(() => completedRefreshReads).toBe(burstPaths.length)
  expect(maxActiveRefreshReads).toBeGreaterThan(1)
  expect(maxActiveRefreshReads).toBeLessThanOrEqual(4)
})
