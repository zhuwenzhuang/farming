import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  PLAYWRIGHT_WORKSPACE_ROOT,
  test,
} from './fixtures'

test('opens image, PDF, and binary files through their bounded viewers', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'file-viewer-types')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'preview.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgF/2l2fLwAAAABJRU5ErkJggg==',
    'base64',
  ))
  fs.writeFileSync(path.join(workspaceRoot, 'preview.pdf'), Buffer.from(
    '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n',
  ))
  fs.writeFileSync(path.join(workspaceRoot, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0]))

  const rawPaths: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/api/files/raw')) rawPaths.push(url.searchParams.get('path') ?? '')
  })

  const mount = await page.request.post('/farming/api/projects/mount', { data: { workspace: workspaceRoot } })
  expect(mount.ok()).toBe(true)
  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toBeVisible({ timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const activeTab = page.getByTestId('code-file-editor').getByRole('tab', { selected: true })

  const imageResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/api/files/raw') && url.searchParams.get('path') === 'preview.png'
  })
  await files.locator('[data-file-path="preview.png"]').dblclick()
  expect((await imageResponse).headers()['content-type']).toContain('image/png')
  await expect(activeTab).toHaveAttribute('title', 'preview.png')
  await expect(page.getByTestId('code-file-image-preview')).toHaveJSProperty('naturalWidth', 1)

  const pdfResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/api/files/raw') && url.searchParams.get('path') === 'preview.pdf'
  })
  await files.locator('[data-file-path="preview.pdf"]').dblclick()
  const loadedPdf = await pdfResponse
  expect(loadedPdf.ok()).toBe(true)
  expect(loadedPdf.headers()['content-type']).toContain('application/pdf')
  await expect(activeTab).toHaveAttribute('title', 'preview.pdf')
  const pdfViewer = page.getByTestId('code-file-pdf-preview')
  await expect(pdfViewer).toBeVisible()
  const pdfSource = await pdfViewer.getAttribute('src')
  if (!pdfSource) throw new Error('PDF viewer source is missing')
  const pdfBytes = await page.request.get(pdfSource)
  expect(pdfBytes.ok()).toBe(true)
  expect(pdfBytes.headers()['content-type']).toContain('application/pdf')
  expect((await pdfBytes.body()).subarray(0, 5).toString('ascii')).toBe('%PDF-')
  await pdfViewer.evaluate(element => {
    element.dataset.retentionProbe = 'same-viewer'
    element.dataset.loadCountAfterProbe = '0'
    element.addEventListener('load', () => {
      element.dataset.loadCountAfterProbe = String(Number(element.dataset.loadCountAfterProbe || '0') + 1)
    })
  })

  await files.locator('[data-file-path="binary.bin"]').dblclick()
  await expect(activeTab).toHaveAttribute('title', 'binary.bin')
  await expect(page.getByTestId('code-file-metadata-preview-icon')).toBeVisible()
  const retainedPdfViewer = page.locator('iframe.code-file-pdf-preview[title*="preview.pdf"]')
  await expect(retainedPdfViewer).toHaveCount(1)
  expect(await retainedPdfViewer.evaluate(element => ({
    connected: element.isConnected,
    hidden: element.parentElement?.classList.contains('hidden'),
    probe: element.dataset.retentionProbe,
  }))).toEqual({ connected: true, hidden: true, probe: 'same-viewer' })

  await page.getByTestId('code-file-editor').locator('.code-file-editor-tab').filter({ hasText: 'preview.pdf' }).click()
  await expect(activeTab).toHaveAttribute('title', 'preview.pdf')
  await expect(page.getByTestId('code-file-pdf-preview')).toHaveAttribute('data-retention-probe', 'same-viewer')
  await expect(page.getByTestId('code-file-pdf-preview')).toHaveAttribute('data-load-count-after-probe', '0')

  await files.locator('[data-file-path="binary.bin"]').dblclick()
  await expect(activeTab).toHaveAttribute('title', 'binary.bin')
  await expect(page.getByTestId('code-file-metadata-preview-icon')).toBeVisible()
  expect(rawPaths).not.toContain('binary.bin')
  await expect(files.getByTestId('code-file-open-error')).toHaveCount(0)
})
