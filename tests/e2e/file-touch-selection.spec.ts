import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, openFarming, test } from './fixtures'

const source = 'Account: sample-user\nToken: example_only_123\n中文说明：仅用于测试。\n'

test('shared context Paste projects native value and caret after replacement @iphone-human', async ({ page, workspaceRoot, isMobile }) => {
  test.skip(!isMobile, 'Native touch clipboard projection')
  const workspace = path.join(workspaceRoot, 'touch-paste')
  fs.mkdirSync(workspace)
  const filePath = path.join(workspace, 'sample.txt')
  fs.writeFileSync(filePath, 'first value\nsecond value\n')
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { readText: async () => 'PASTE\nMULTI' },
  }))
  await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
  await openFarming(page)
  await page.getByTestId('code-mobile-menu').click()
  const files = page.getByTestId('code-project-group').filter({ hasText: 'touch-paste' }).getByTestId('code-files-section')
  const toggle = files.locator('.code-files-title')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await files.locator('[data-testid="code-file-row"][data-file-path="sample.txt"]').click()
  const native = page.getByTestId('code-file-touch-source')
  const textarea = native.getByRole('textbox')
  await expect(textarea).toHaveValue('first value\nsecond value\n')
  await expect(textarea).toBeEditable()
  await textarea.evaluate((element: HTMLTextAreaElement) => { element.setSelectionRange(6, 11) })
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getPosition())).toEqual({ lineNumber: 1, column: 12 })
  await native.getByTestId('code-file-touch-line-actions').tap()
  const paste = page.getByTestId('code-editor-context-menu').getByRole('menuitem', { name: 'Paste', exact: true })
  await expect(paste).toBeEnabled()
  await paste.tap()
  await expect(textarea).toHaveValue('first PASTE\nMULTI\nsecond value\n')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getPosition())).toEqual({ lineNumber: 2, column: 6 })
  await expect(textarea).toBeFocused()
  await expect.poll(() => textarea.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([17, 17])
  const longDraft = 'native editing line\n'.repeat(160)
  await textarea.fill(longDraft)
  await textarea.evaluate((element: HTMLTextAreaElement) => {
    const offset = 'native editing line\n'.length * 89
    element.focus()
    element.setSelectionRange(offset, offset)
    element.scrollTop = 89 * 24 - element.clientHeight / 2
  })
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getPosition())).toEqual({ lineNumber: 90, column: 1 })
  const scrollTop = await textarea.evaluate((element: HTMLTextAreaElement) => element.scrollTop)
  expect(scrollTop).toBeGreaterThan(0)
  await textarea.evaluate((element: HTMLTextAreaElement) => {
    const native = element.setSelectionRange.bind(element)
    const calls: unknown[] = []
    element.setSelectionRange = (...args: Parameters<HTMLTextAreaElement['setSelectionRange']>) => {
      calls.push({ args, scrollTop: element.scrollTop })
      document.documentElement.dataset.nativeSelectionTrace = JSON.stringify(calls)
      native(...args)
    }
  })
  await page.keyboard.insertText('x')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getPosition())).toEqual({ lineNumber: 90, column: 2 })
  expect(await page.evaluate(() => document.documentElement.dataset.nativeSelectionTrace ?? '[]')).toBe('[]')
  expect(await textarea.evaluate((element: HTMLTextAreaElement) => element.scrollTop)).toBe(scrollTop)
})

test('native line actions preserve Git inspection and selected text on touch screens @iphone-human', async ({ page, workspaceRoot, isMobile }) => {
  test.skip(!isMobile, 'Native touch Git surface')
  const workspace = path.join(workspaceRoot, 'touch-git')
  fs.mkdirSync(workspace)
  const filePath = path.join(workspace, 'sample.txt')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-15T12:00:00Z', GIT_COMMITTER_DATE: '2026-01-15T12:00:00Z' } })
  git('init', '-q')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'user.email', 'example@example.test')
  git('config', 'user.name', 'First Author')
  fs.writeFileSync(filePath, 'first line\nsecond line\nthird line\n')
  git('add', '.')
  git('commit', '-qm', 'Seed touch Git fixture')
  fs.writeFileSync(filePath, 'first line\nchanged second line\nthird line\n')
  git('-c', 'user.name=Second Author', 'commit', '-qam', 'Change second line')
  fs.writeFileSync(filePath, 'working first\nchanged second line\nthird line\n')
  await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
  await page.goto(`/farming/?${new URLSearchParams({ ftarget: 'file', path: filePath, line: '2' })}`)
  const editor = page.getByTestId('code-file-editor')
  const native = editor.getByTestId('code-file-touch-source')
  const textarea = native.getByRole('textbox')
  await expect(textarea).toHaveValue('working first\nchanged second line\nthird line\n')
  await expect(editor.getByTestId('code-file-monaco')).toBeHidden()
  const lineActions = native.getByTestId('code-file-touch-line-actions')
  await expect(lineActions).toHaveText('Line 2')
  const menu = page.getByTestId('code-editor-context-menu')
  const openLineMenu = async () => {
    await lineActions.tap()
    await expect(menu).toBeVisible()
  }
  await openLineMenu()
  await menu.getByRole('menuitem', { name: 'Annotate with Blame', exact: true }).tap()
  const annotation = native.getByTestId('code-file-touch-blame')
  await expect(annotation).toContainText('Second Author')
  await expect(annotation).toHaveAttribute('data-line-number', '2')
  const detail = editor.getByTestId('code-file-blame-detail')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await annotation.tap()
    await expect(detail).toContainText('Change second line')
    await expect(detail).toContainText('Second Author')
    await expect(editor).toHaveScreenshot(`touch-git-${appearance}.png`)
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
  }
  await openLineMenu()
  await menu.getByRole('menuitem', { name: 'Open Line Changes with Previous Revision', exact: true }).tap()
  const changes = editor.getByTestId('code-file-line-changes-panel')
  await expect(changes).toContainText('Line 2')
  await expect(changes).toContainText('Change second line')
  await expect(changes.locator('pre')).toContainText('+changed second line')
  await changes.getByRole('button', { name: 'Close line changes', exact: true }).tap()
  await textarea.evaluate((element: HTMLTextAreaElement) => { element.setSelectionRange(0, 7) })
  await expect(lineActions).toHaveText('Line 1')
  await openLineMenu()
  await menu.getByRole('menuitem', { name: 'Open Line Changes with Working File', exact: true }).tap()
  await expect(changes).toContainText('Line 1')
  await expect(changes.locator('pre')).toContainText('-first line')
  await expect(changes.locator('pre')).toContainText('+working first')
  await changes.getByRole('button', { name: 'Close line changes', exact: true }).tap()
  // Shared menu selection restores focus to the actual editable source.
  await openLineMenu()
  await menu.getByRole('menuitem', { name: 'Select All', exact: true }).tap()
  await expect(textarea).toBeFocused()
  expect(await textarea.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, (await textarea.inputValue()).length])
  const draft = await textarea.inputValue()
  await textarea.fill(draft + 'unsaved line\n')
  await expect(annotation).toHaveCount(0)
  await expect(editor.getByTestId('code-file-blame-state')).toHaveText('Save or undo changes to refresh blame.')
  await textarea.fill(draft)
  await textarea.evaluate((element: HTMLTextAreaElement) => {
    const start = element.value.indexOf('changed second line')
    element.setSelectionRange(start, start)
  })
  await expect(annotation).toBeVisible()
  await openLineMenu()
  await menu.getByRole('menuitem', { name: 'Hide Blame', exact: true }).tap()
  await expect(annotation).toHaveCount(0)
})

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

test('file-line navigation reveals native touch selection across viewport transitions @iphone-human', async ({ page, workspaceRoot, isMobile }) => {
  test.skip(!isMobile, 'Touch navigation surface')
  const workspace = path.join(workspaceRoot, 'touch-file-navigation')
  fs.mkdirSync(workspace, { recursive: true })
  const lines = Array.from({ length: 120 }, (_, index) => `Line ${index + 1}: native file navigation`)
  const text = lines.join('\n') + '\n'
  fs.writeFileSync(path.join(workspace, 'target.txt'), text.replaceAll('\n', '\r\n'))
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  const identityResponse = await page.request.get(`/farming/api/agents/${agentId}/acp-transcript?maxTurns=5&media=external-v1`)
  expect(identityResponse.ok()).toBeTruthy()
  const identity = await identityResponse.json() as { sessionId: string; runtimeEpoch: string; toRevision: number }
  const revision = Number(identity.toRevision) + 1_000_000
  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({
    json: {
      version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
      fromRevision: null, toRevision: revision, replace: true, settled: true, hasMoreBefore: false,
      transcript: { sessionId: identity.sessionId, provider: 'codex', revision, state: 'idle', entries: [
        { id: 'question', type: 'message', role: 'user', content: [{ type: 'text', text: 'Locate the file line.' }] },
        { id: 'answer', type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: 'Inspect `target.txt:80`.' }] },
      ] },
    },
  }))
  await openFarming(page)
  await page.getByTestId('code-mobile-menu').tap()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
  await page.getByRole('link', { name: 'target.txt:80', exact: true }).tap()
  const input = page.getByTestId('code-file-touch-source').getByRole('textbox')
  await expect(input).toHaveValue(text)
  const offset = lines.slice(0, 79).reduce((sum, line) => sum + line.length + 1, 0)
  await expect.poll(() => input.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([offset, offset])
  await expect(input).toBeFocused()
  expect(await input.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  // Native selection remains owned by the shared model when switching surfaces.
  await input.evaluate((element, start) => element.setSelectionRange(start + 2, start + 9), offset)
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getPosition())).toEqual({ lineNumber: 80, column: 10 })
  const compact = page.viewportSize()!
  await page.setViewportSize({ width: 1200, height: 900 })
  await expect(input).toHaveCount(0)
  await expect(page.getByTestId('code-file-monaco')).toBeVisible()
  await page.setViewportSize(compact)
  await expect(input).toHaveValue(text)
  await expect.poll(() => input.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([offset + 2, offset + 9])
  expect(await input.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
})
