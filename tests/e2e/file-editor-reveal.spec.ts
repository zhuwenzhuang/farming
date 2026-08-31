import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

function observeFileReads(page: Page, reads: string[]) {
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try {
      const message = JSON.parse(String(payload)) as { type?: string; request?: { operation?: string; path?: string } }
      if (message.type === 'workspace-request' && message.request?.operation === 'read-file') reads.push(message.request.path || '')
    } catch {
      // Terminal frames are not Workspace requests.
    }
  }))
}

async function closeSidebar(page: Page) {
  const sidebar = page.getByTestId('code-sidebar')
  if (!await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
    await page.getByTestId('code-sidebar-toggle').click()
  }
  await expect(sidebar).toHaveClass(/collapsed/)
}

async function expectLocated(row: Locator) {
  await expect(row).toHaveClass(/selected/)
  await expect.poll(() => row.evaluate(element => {
    const scroller = element.closest('.code-project-list')
    const header = element.closest('.code-files-section')?.querySelector('.code-files-header')
    if (!element.isConnected || !scroller || !header) return false
    const rect = element.getBoundingClientRect()
    return rect.top >= header.getBoundingClientRect().bottom - 1 && rect.bottom <= scroller.getBoundingClientRect().bottom + 1
  })).toBe(true)
}

test('editor reveal expands and relocates the current file without rereading or replacing its draft', async ({ page, workspaceRoot, isMobile }, testInfo) => {
  testInfo.setTimeout(90_000)
  const workspace = path.join(workspaceRoot, 'editor-reveal-demo')
  const filePath = 'docs/guide/current.md'
  const original = '# Current file\n\nOriginal content.\n'
  fs.mkdirSync(path.join(workspace, 'docs/guide'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'sources'), { recursive: true })
  fs.writeFileSync(path.join(workspace, filePath), original)
  // Avoid compact single-child paths so both ancestor disclosures are exercised.
  fs.writeFileSync(path.join(workspace, 'docs/index.md'), '# Documentation\n')
  for (let index = 0; index < 700; index++) {
    fs.writeFileSync(path.join(workspace, 'sources', `module-${String(index).padStart(4, '0')}.ts`), `export const value = ${index}\n`)
  }
  const reads: string[] = []
  observeFileReads(page, reads)
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace, name: 'Reveal sample' } })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)
  const sidebar = page.getByTestId('code-sidebar')
  if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) await page.getByTestId('code-mobile-menu').click()
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const files = project.getByTestId('code-files-section')
  const title = files.locator('.code-files-title')
  if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
  const docs = files.locator('[data-file-path="docs"][data-testid="code-file-row"]')
  const guide = files.locator('[data-file-path="docs/guide"][data-testid="code-file-row"]')
  await docs.click()
  await guide.click()
  const target = files.locator(`[data-file-path="${filePath}"][data-testid="code-file-row"]`)
  await target.click()
  const editor = page.getByTestId('code-file-editor')
  const reveal = editor.getByTestId('code-file-editor-reveal')
  await expect(reveal).toHaveAccessibleName(`Reveal ${filePath} in Explorer`)
  await closeSidebar(page)
  const preview = editor.locator('.code-file-editor-action.source-preview')
  if (await preview.getAttribute('aria-pressed') === 'true') await preview.click()
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe(original)
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.insertText('Unsaved draft\n'))).toBe(true)
  const draft = await page.evaluate(() => window.__farmingFileEditorTest?.getValue())
  const modelId = await page.evaluate(() => window.__farmingFileEditorTest?.getModelId())
  expect(draft).toContain('Unsaved draft')
  reads.length = 0

  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    // The explicit action works even when all containing surfaces were closed.
    await reveal.click()
    await expect(sidebar).not.toHaveClass(/collapsed/)
    await expectLocated(target)
    await guide.click()
    await docs.click()
    await title.click()
    await project.getByTestId('code-project-title').click()
    await closeSidebar(page)
    await expect(reveal).toBeVisible()
    expect((await reveal.boundingBox())!.width).toBe(isMobile ? 44 : 22)
    expect((await reveal.locator('svg').boundingBox())!.width).toBe(16)
    await editor.locator('.code-file-editor-header').screenshot({ path: testInfo.outputPath(`${appearance}-reveal-header.png`), animations: 'disabled' })
    await reveal.click()
    await expect(project.getByTestId('code-project-title')).toHaveAttribute('aria-expanded', 'true')
    await expect(title).toHaveAttribute('aria-expanded', 'true')
    await expect(docs).toHaveAttribute('aria-expanded', 'true')
    await expect(guide).toHaveAttribute('aria-expanded', 'true')
    await expectLocated(target)

    // Explicit keyboard navigation revokes the previous reveal lease before
    // moving away; a raw scrollTop write is not a new user navigation intent.
    const sources = files.locator('[data-file-path="sources"][data-testid="code-file-row"]')
    if (await sources.getAttribute('aria-expanded') !== 'true') await sources.click()
    const scroller = page.getByTestId('code-project-list')
    await expect(files.locator('.code-file-tree-viewport')).toHaveAttribute('data-visible-row-count', '705')
    await files.getByRole('tree').press('End')
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(10_000)
    await expect.poll(async () => {
      if (!await target.count()) return true
      return target.evaluate(element => {
        const bounds = element.closest('.code-project-list')?.getBoundingClientRect()
        if (!bounds) return true
        const rect = element.getBoundingClientRect()
        return rect.bottom < bounds.top || rect.top > bounds.bottom
      })
    }).toBe(true)
    await closeSidebar(page)
    await reveal.click()
    await expectLocated(target)
    await sidebar.screenshot({ path: testInfo.outputPath(`${appearance}-located-file.png`), animations: 'disabled' })
    await closeSidebar(page)
    expect(await page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe(draft)
    expect(await page.evaluate(() => window.__farmingFileEditorTest?.getModelId())).toBe(modelId)
    await expect(preview).toHaveAttribute('aria-pressed', 'false')
    expect(reads.filter(value => value === filePath)).toEqual([])
  }

  await preview.click()
  await expect(preview).toHaveAttribute('aria-pressed', 'true')
  await expect(reveal).toBeVisible()
  await reveal.click()
  await expectLocated(target)
  await closeSidebar(page)
  await expect(preview).toHaveAttribute('aria-pressed', 'true')
  await preview.click()
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe(draft)
  expect(reads.filter(value => value === filePath)).toEqual([])
  expect(fs.readFileSync(path.join(workspace, filePath), 'utf8')).toBe(original)
})

test('exact external files do not offer a Project-tree reveal action', async ({ page, workspaceRoot }) => {
  const externalFile = path.join(workspaceRoot, 'unmounted-external.md')
  fs.writeFileSync(externalFile, '# External file\n')
  const params = new URLSearchParams({ ftarget: 'file', path: externalFile, view: 'editor' })
  await page.goto(`/farming/?${params.toString()}`, { waitUntil: 'domcontentloaded' })
  const editor = page.getByTestId('code-file-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toContainText('unmounted-external.md')
  await expect(editor.getByTestId('code-file-editor-share')).toBeVisible()
  await expect(editor.getByTestId('code-file-editor-reveal')).toHaveCount(0)
})
