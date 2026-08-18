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
