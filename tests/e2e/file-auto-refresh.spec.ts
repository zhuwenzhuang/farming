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
}

function recordWorkspaceWatchReady(socket: PlaywrightWebSocket, onReady: () => void) {
  socket.on('framereceived', frame => {
    try {
      const message = JSON.parse(String(frame.payload)) as { type?: string; watching?: boolean }
      if (message.type === 'workspace-file-watch' && message.watching === true) onReady()
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
  fs.writeFileSync(path.join(workspace, 'index.html'), '<h1>HTML before</h1>\n')
  fs.writeFileSync(
    path.join(workspace, 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>\n',
  )
  await createControlAgent(page, workspace)

  let workspaceWatchReady = false
  page.on('websocket', socket => recordWorkspaceWatchReady(socket, () => { workspaceWatchReady = true }))
  await openFarming(page)

  await openProjectFile(page, 'file-auto-refresh', 'plain.txt')
  await expect.poll(() => workspaceWatchReady).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toBe('plain before\n')
  fs.writeFileSync(path.join(workspace, 'plain.txt'), 'plain after\n')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toBe('plain after\n')

  await page.evaluate(() => window.__farmingFileEditorTest?.insertText('local draft'))
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toContain('local draft')
  fs.writeFileSync(path.join(workspace, 'plain.txt'), 'external conflict\n')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toContain('local draft')
  await expect(page.getByTestId('code-file-editor').getByTitle('Changed on disk')).toBeVisible()

  await openProjectFile(page, 'file-auto-refresh', 'guide.md')
  const markdownPreview = page.getByTestId('code-file-markdown-preview')
  await expect(markdownPreview.getByRole('heading', { name: 'Markdown before' })).toBeVisible()
  fs.writeFileSync(path.join(workspace, 'guide.md'), '# Markdown after\n')
  await expect(markdownPreview.getByRole('heading', { name: 'Markdown after' })).toBeVisible()

  await openProjectFile(page, 'file-auto-refresh', 'index.html')
  const htmlFrame = page.frameLocator('[data-testid="code-file-html-preview"]')
  await expect(htmlFrame.getByRole('heading', { name: 'HTML before' })).toBeVisible()
  fs.writeFileSync(path.join(workspace, 'index.html'), '<h1>HTML after</h1>\n')
  await expect(htmlFrame.getByRole('heading', { name: 'HTML after' })).toBeVisible()

  await openProjectFile(page, 'file-auto-refresh', 'icon.svg')
  const imagePreview = page.getByTestId('code-file-image-preview')
  const originalSource = await imagePreview.getAttribute('src')
  expect(originalSource).toBeTruthy()
  fs.writeFileSync(
    path.join(workspace, 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>\n',
  )
  await expect.poll(() => imagePreview.getAttribute('src')).not.toBe(originalSource)
  await expect.poll(() => imagePreview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
})
