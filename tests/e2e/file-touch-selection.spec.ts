import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

const source = 'Account: sample-user\nToken: example_only_123\n中文说明：仅用于测试。\n'

test('native file selection, copy and edits on touch screens @iphone-human', async ({ page, workspaceRoot, isMobile }, testInfo) => {
  test.skip(!isMobile, 'Touch source surface')
  const workspace = path.join(workspaceRoot, 'touch-files')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'sample.txt'), source.replaceAll('\n', '\r\n'))
  const largeSource = 'Read-only large file\n' + 'x'.repeat(2 * 1024 * 1024)
  fs.writeFileSync(path.join(workspace, 'large.txt'), largeSource)
  // Exercise HTTP/insecure-context copying without depending on the host clipboard.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const nativeExecCommand = document.execCommand.bind(document)
    document.execCommand = (command: string) => {
      const input = document.activeElement
      if (command !== 'copy' || !(input instanceof HTMLTextAreaElement)) return false
      document.documentElement.dataset.copied = input.value.slice(input.selectionStart, input.selectionEnd)
      return document.documentElement.dataset.copyFailure !== 'true' && nativeExecCommand(command)
    }
  })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)
  if (await page.getByTestId('code-mobile-menu').isVisible()) await page.getByTestId('code-mobile-menu').click()
  const project = page.getByTestId('code-project-group').filter({ hasText: 'touch-files' })
  const files = project.getByTestId('code-files-section')
  if (await files.locator('.code-files-title').getAttribute('aria-expanded') !== 'true') await files.locator('.code-files-title').click()
  await files.locator('[data-file-path="sample.txt"][data-testid="code-file-row"]').click()
  const surface = page.getByTestId('code-file-touch-source')
  const textarea = surface.getByRole('textbox')
  await expect(textarea).toHaveValue(source)
  await expect(page.getByTestId('code-file-monaco')).toBeHidden()
  await expect(textarea).toHaveCSS('font-size', '16px')
  await expect(textarea).toHaveCSS('touch-action', 'manipulation')
  await expect(page.getByTestId('code-file-editor')).toHaveCSS('touch-action', 'manipulation')
  await surface.getByRole('button', { name: 'Select All', exact: true }).tap()
  expect(await textarea.evaluate((e: HTMLTextAreaElement) => [e.selectionStart, e.selectionEnd])).toEqual([0, source.length])
  await surface.getByRole('button', { name: 'Copy', exact: true }).tap()
  await expect(surface.getByRole('status')).toHaveText('Copied')
  await expect(page.locator('html')).toHaveAttribute('data-copied', source)
  await textarea.evaluate((e: HTMLTextAreaElement) => {
    e.focus()
    const start = e.value.indexOf('example_only_123')
    e.setSelectionRange(start, start + 'example_only_123'.length)
  })
  await surface.getByRole('button', { name: 'Copy', exact: true }).tap()
  await expect(page.locator('html')).toHaveAttribute('data-copied', 'example_only_123')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getPosition())).toEqual({
    lineNumber: 2, column: 'Token: example_only_123'.length + 1,
  })
  await page.evaluate(() => { document.documentElement.dataset.copyFailure = 'true' })
  await surface.getByRole('button', { name: 'Copy', exact: true }).tap()
  await expect(surface.getByRole('alert')).toHaveText('Copy failed')
  await expect(textarea).toHaveValue(source)
  await page.evaluate(() => { document.documentElement.dataset.copyFailure = 'false' })
  const edited = source + 'A short mobile edit.\n'
  await textarea.fill(edited)
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe(edited.replaceAll('\n', '\r\n'))
  const save = page.getByTestId('code-file-editor').getByRole('button', { name: 'Save file', exact: true })
  await save.tap()
  await expect.poll(() => fs.readFileSync(path.join(workspace, 'sample.txt'), 'utf8')).toBe(edited.replaceAll('\n', '\r\n'))
  await textarea.evaluate((e: HTMLTextAreaElement) => { e.blur() })
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await expect(textarea).toHaveValue(edited)
    await expect(page.getByTestId('code-file-editor')).toHaveScreenshot(`touch-file-${appearance}.png`)
  }
  // A delayed secure-context write belongs only to the initiating file.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: () => new Promise<void>(resolve => {
        window.addEventListener('finish-touch-copy', () => resolve(), { once: true })
      }),
    } })
  })
  await surface.getByRole('button', { name: 'Copy', exact: true }).tap()
  await expect(surface.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled()
  await expect(surface.getByRole('alert')).toHaveText('Copy unconfirmed. Try again')
  await page.evaluate(() => window.dispatchEvent(new Event('finish-touch-copy')))
  await expect(surface.getByRole('alert')).toHaveText('Copy unconfirmed. Try again')
  await surface.getByRole('button', { name: 'Copy', exact: true }).tap()
  const reveal = page.getByTestId('code-file-editor-reveal')
  if (await reveal.isVisible()) await reveal.tap()
  else {
    await page.getByTestId('code-file-editor-more').tap()
    await page.getByTestId('code-file-editor-more-reveal').tap()
  }
  await files.locator('[data-file-path="large.txt"][data-testid="code-file-row"]').tap()
  await expect(textarea).toHaveValue(largeSource)
  await expect(textarea).toHaveAttribute('readonly', '')
  await page.evaluate(() => window.dispatchEvent(new Event('finish-touch-copy')))
  await expect(surface.getByRole('status')).toHaveCount(0)
  await textarea.focus()
  await page.keyboard.type('must not edit')
  await expect(textarea).toHaveValue(largeSource)
  await expect(save).toHaveCount(0)
  await expect(page.getByTestId('code-file-large-text-alert')).toBeVisible()
})
