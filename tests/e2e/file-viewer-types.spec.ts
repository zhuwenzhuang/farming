import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import {
  expect,
  openFarming,
  PLAYWRIGHT_WORKSPACE_ROOT,
  test,
} from './fixtures'

test('opens image, PDF, spreadsheet, and binary files through their bounded viewers', async ({ page }, testInfo) => {
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
  fs.writeFileSync(path.join(workspaceRoot, 'table.csv'), 'id,value\n001,12\n002,34\n')
  const workbook = XLSX.utils.book_new()
  const dataSheet = XLSX.utils.aoa_to_sheet([
    ['id', 'value', 'formula'],
    ...Array.from({ length: 12_000 }, (_, index) => [
      String(index + 1).padStart(5, '0'),
      (index + 1) * 42,
      null,
    ]),
  ])
  dataSheet.C2 = { t: 'n', f: 'B2*2', v: 84 }
  dataSheet['!merges'] = [XLSX.utils.decode_range('A1:B1')]
  XLSX.utils.book_append_sheet(workbook, dataSheet, 'Data')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['status'], ['ready']]), 'Summary')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['check'], ['passed']]), 'Diagnostics')
  XLSX.writeFile(workbook, path.join(workspaceRoot, 'workbook.xlsx'))

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

  await files.locator('[data-file-path="workbook.xlsx"]').dblclick()
  await expect(activeTab).toHaveAttribute('title', 'workbook.xlsx')
  const spreadsheet = page.getByTestId('code-spreadsheet-preview')
  await expect(spreadsheet).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('code-spreadsheet-grid').locator('canvas')).toBeVisible()
  const address = spreadsheet.getByRole('textbox', { name: 'Cell address' })
  await address.fill('B2')
  await address.press('Enter')
  await expect(spreadsheet.locator('.code-spreadsheet-inspector strong')).toHaveText('B2')
  await expect(spreadsheet.locator('.code-spreadsheet-inspector span')).toHaveText('42')
  await spreadsheet.getByRole('button', { name: 'Copy selection' }).click()
  await expect(spreadsheet.getByRole('button', { name: 'Copied' })).toBeVisible()
  const find = spreadsheet.getByRole('textbox', { name: 'Find' })
  await find.fill('002')
  await find.press('Enter')
  await expect(spreadsheet.locator('.code-spreadsheet-inspector strong')).toHaveText('A3')
  await page.getByTestId('code-spreadsheet-sheet-select').selectOption({ label: 'Summary' })
  await expect(spreadsheet.locator('.code-spreadsheet-inspector span')).toHaveText('status')

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await expect(page.getByTestId('code-spreadsheet-grid').locator('canvas')).toBeVisible()
    await spreadsheet.screenshot({ path: testInfo.outputPath(`spreadsheet-${appearance}.png`) })
  }

  await files.locator('[data-file-path="table.csv"]').dblclick()
  await expect(activeTab).toHaveAttribute('title', 'table.csv')
  await expect(page.getByTestId('code-spreadsheet-preview')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('code-spreadsheet-preview').locator('.code-spreadsheet-inspector span')).toHaveText('id')
})
