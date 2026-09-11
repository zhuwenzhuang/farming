import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, interceptWorkspaceRequests, test } from './fixtures'

function gate() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function repository(root: string) {
  const directory = path.join(root, 'blame-fixture')
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'a.txt'), 'first line\nsecond line\nthird line\n')
  fs.writeFileSync(path.join(directory, 'b.txt'), 'other first\nother second\nother third\n')
  fs.writeFileSync(path.join(directory, 'notes.md'), '# Notes\n\nA paragraph.\n')
  fs.writeFileSync(path.join(directory, 'large.ts'), [
    'class Example {', '  method() {',
    ...Array.from({ length: 240 }, (_, index) => `    const value${index} = ${index};`),
    '  }', '}', '',
  ].join('\n'))
  for (const args of [['init'], ['config', 'user.email', 'review@example.test'], ['config', 'user.name', 'First Author'], ['add', '.'], ['commit', '-m', 'Seed blame fixture']]) {
    execFileSync('git', args, { cwd: directory, stdio: 'ignore' })
  }
  fs.writeFileSync(path.join(directory, 'a.txt'), 'first line\nchanged second line\nthird line\n')
  execFileSync('git', ['-c', 'user.name=Second Author', 'commit', '-am', 'Change second line'], { cwd: directory, stdio: 'ignore' })
  fs.writeFileSync(path.join(directory, 'untracked.txt'), 'untracked\n')
  return directory
}

async function openFile(page: Page, directory: string, file = 'a.txt') {
  await page.goto(`/farming/?${new URLSearchParams({ ftarget: 'file', path: path.join(directory, file), line: '2' })}`)
  await expect(page.getByTestId('code-file-monaco')).toBeVisible()
}

async function gutterMenu(page: Page) {
  await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 42, y: 38 } })
  const menu = page.getByTestId('code-editor-context-menu')
  await expect(menu).toBeVisible()
  return menu
}

async function annotate(page: Page) {
  const menu = await gutterMenu(page)
  await menu.getByRole('menuitem', { name: 'Annotate with Blame' }).click()
}

async function selectTreeFile(page: Page, file: string) {
  const files = page.getByTestId('code-files-section').first()
  const title = files.locator('.code-files-title').first()
  if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
  await files.locator(`[data-testid="code-file-row"][data-file-path="${file}"]`).dblclick()
  await expect(page.getByRole('tab').filter({ hasText: file })).toHaveAttribute('aria-selected', 'true')
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`blame annotations, detail dismissal, and right-click hiding in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await openFile(page, repository(workspaceRoot))
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    await annotate(page)
    const annotations = page.locator('.code-file-inline-blame')
    await expect(annotations).toHaveCount(3)
    await expect(annotations.nth(0)).toContainText('First Author')
    await expect(annotations.nth(1)).toContainText('Second Author')
    await annotations.nth(1).click()
    const detail = page.getByTestId('code-file-blame-detail')
    await expect(detail).toContainText('Change second line')
    await expect(detail).toContainText('Second Author')
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await expect(annotations.nth(1)).toBeFocused()
    await annotations.nth(0).click()
    await expect(detail).toContainText('Seed blame fixture')
    await page.getByTestId('code-file-monaco').click({ position: { x: 500, y: 38 } })
    await expect(detail).toHaveCount(0)

    // Native contextmenu cancellation is checked separately from menu rendering.
    expect(await annotations.first().evaluate(element => {
      const box = element.getBoundingClientRect()
      return !element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.x + 12, clientY: box.y + 8 }))
    })).toBe(true)
    await page.keyboard.press('Escape')
    await annotations.first().click({ button: 'right' })
    const menu = page.getByTestId('code-editor-context-menu')
    await expect(menu.getByRole('menuitem', { name: 'Hide Blame' })).toBeVisible()
    await page.getByTestId('code-file-editor').screenshot({ path: testInfo.outputPath(`blame-menu-${appearance}.png`) })
    await menu.getByRole('menuitem', { name: 'Hide Blame' }).click()
    await expect(annotations).toHaveCount(0)
    await annotate(page)
    await expect(annotations).toHaveCount(3)
    await (await gutterMenu(page)).getByRole('menuitem', { name: 'Hide Blame' }).click()
    await expect(annotations).toHaveCount(0)
  })

  test(`blame scroll clipping excludes breadcrumbs and sticky headers in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await openFile(page, repository(workspaceRoot), 'large.ts')
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    await annotate(page)
    await expect(page.locator('.code-file-inline-blame').first()).toBeVisible()
    expect(await page.evaluate(() => window.__farmingFileEditorTest?.revealLine(180))).toBe(true)
    const monaco = page.getByTestId('code-file-monaco')
    await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getScrollTop() ?? 0)).toBeGreaterThan(1000)
    await monaco.hover()
    await page.mouse.wheel(0, 13)
    await expect(monaco.locator('.sticky-widget')).toBeVisible()
    const layer = page.locator('.code-file-inline-blame-layer')
    await expect.poll(async () => layer.evaluate(element => Number.parseFloat(getComputedStyle(element).clipPath.replace('inset(', '')))).toBeGreaterThan(0)
    const bounds = await layer.boundingBox()
    const editorBounds = await monaco.boundingBox()
    expect(bounds!.y).toBe(editorBounds!.y)
    expect(bounds!.height).toBe(editorBounds!.height)
    const hitResult = await monaco.evaluate(host => {
      const rect = host.getBoundingClientRect()
      const annotation = document.querySelector('.code-file-inline-blame')!.getBoundingClientRect()
      const sticky = host.querySelector('.sticky-widget')!.getBoundingClientRect()
      const x = annotation.x + 16
      return [rect.top - 1, rect.top + 2, sticky.bottom - 2, rect.bottom + 1].map(y => Boolean(document.elementFromPoint(x, y)?.closest('.code-file-inline-blame')))
    })
    expect(hitResult).toEqual([false, false, false, false])
    expect(await page.locator('.code-file-inline-blame').count()).toBeLessThan(80)
    await page.getByTestId('code-file-editor').screenshot({ path: testInfo.outputPath(`blame-scrolled-${appearance}.png`) })
    await page.setViewportSize({ width: 1000, height: 700 })
    await expect.poll(async () => (await layer.boundingBox())!.height).toBe((await monaco.boundingBox())!.height)
    expect(await page.evaluate(() => window.__farmingFileEditorTest?.revealLine(1))).toBe(true)
    await page.keyboard.press('F1')
    await page.locator('.quick-input-widget input').fill('>Fold All')
    await page.locator('.quick-input-widget').getByRole('option', { name: /^Fold All,/ }).click()
    await expect(monaco.locator('.view-lines')).not.toContainText('const value')
    const visibleLines = await monaco.locator('.margin-view-overlays .line-numbers').evaluateAll(elements => elements.map(element => Number(element.textContent)).filter(line => line > 0 && line <= 244))
    expect(visibleLines.length).toBeLessThan(4)
    await expect.poll(async () => page.locator('.code-file-inline-blame').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-line-number'))))).toEqual(visibleLines)
    await page.keyboard.press('F1')
    await page.locator('.quick-input-widget input').fill('>Unfold All')
    await page.locator('.quick-input-widget').getByRole('option', { name: /^Unfold All,/ }).click()
    await expect.poll(async () => page.locator('.code-file-inline-blame').count()).toBeGreaterThan(10)
  })
}

test('pending capability cannot reopen, replace, or cross file and page navigation', async ({ page, workspaceRoot }) => {
  const directory = repository(workspaceRoot)
  let held = gate()
  let requests = 0
  let results = 0
  await interceptWorkspaceRequests(page, request => {
    if (request.operation !== 'blame-capability') return
    requests += 1
    const currentGate = held
    return { onResult: async result => { await currentGate.promise; results += 1; return result } }
  })
  try {
    await openFile(page, directory)
    const menu = await gutterMenu(page)
    await expect.poll(() => requests).toBe(1)
    await page.keyboard.press('Escape')
    held.release()
    await expect.poll(() => results).toBe(1)
    await expect(menu).toHaveCount(0)

    held = gate()
    await gutterMenu(page)
    await expect.poll(() => requests).toBe(2)
    await page.getByTestId('code-file-monaco').click({ position: { x: 400, y: 38 } })
    held.release()
    await expect.poll(() => results).toBe(2)
    await expect(menu).toHaveCount(0)

    held = gate()
    await gutterMenu(page)
    await expect.poll(() => requests).toBe(3)
    await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 400, y: 38 } })
    held.release()
    await expect.poll(() => results).toBe(3)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Annotate with Blame' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByRole('tab').filter({ hasText: 'a.txt' }).dblclick()
    await selectTreeFile(page, 'b.txt')
    held = gate()
    await gutterMenu(page)
    await expect.poll(() => requests).toBe(4)
    await page.getByRole('tab').filter({ hasText: 'b.txt' }).focus()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('tab').filter({ hasText: 'a.txt' })).toHaveAttribute('aria-selected', 'true')
    held.release()
    await expect.poll(() => results).toBe(4)
    await expect(menu).toHaveCount(0)

    held = gate()
    await gutterMenu(page)
    await expect.poll(() => requests).toBe(5)
    await page.getByTestId('code-nav-search').click()
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    held.release()
    await expect.poll(() => results).toBe(5)
    await expect(menu).toHaveCount(0)
    await selectTreeFile(page, 'a.txt')
    await expect(menu).toHaveCount(0)
  } finally { held.release() }
})

test('blame failure stays visible, retries, pauses for drafts, and refreshes after save', async ({ page, workspaceRoot }, testInfo) => {
  const directory = repository(workspaceRoot)
  let fail = true
  await interceptWorkspaceRequests(page, request => {
    if (request.operation === 'blame' && fail) return { response: { ok: false, error: { code: 'FIXTURE_TIMEOUT', status: 504, message: 'git blame timed out (fixture)' } } }
  })
  await openFile(page, directory)
  await annotate(page)
  const state = page.getByTestId('code-file-blame-state')
  await expect(state).toContainText('git blame timed out (fixture)')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    await expect(state.getByRole('button', { name: 'Retry' })).toBeVisible()
    await state.screenshot({ path: testInfo.outputPath(`blame-error-${appearance}.png`) })
  }
  fail = false
  await state.getByRole('button', { name: 'Retry' }).click()
  const annotations = page.locator('.code-file-inline-blame')
  await expect(annotations).toHaveCount(3)
  await annotations.nth(1).click()
  await expect(page.getByTestId('code-file-blame-detail')).toContainText('Change second line')
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.insertText('draft line\n'))).toBe(true)
  await expect(annotations).toHaveCount(0)
  await expect(page.getByTestId('code-file-blame-detail')).toHaveCount(0)
  await expect(state).toContainText('Save or undo changes')
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.undo())).toBe(true)
  await expect(annotations).toHaveCount(3)
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.insertText('saved line\n'))).toBe(true)
  await page.getByTestId('code-file-editor').getByRole('button', { name: 'Save file', exact: true }).click()
  await expect.poll(() => fs.readFileSync(path.join(directory, 'a.txt'), 'utf8')).toContain('saved line')
  await expect(annotations).toHaveCount(4)
  await expect(page.locator('.code-file-inline-blame.uncommitted').first()).toBeVisible()
  await expect(state).toHaveCount(0)
  await selectTreeFile(page, 'b.txt')
  await expect(annotations).toHaveCount(3)
  await expect(annotations.first()).toContainText('First Author')
  await selectTreeFile(page, 'untracked.txt')
  await expect(state).toContainText('not tracked by git')
  await (await gutterMenu(page)).getByRole('menuitem', { name: 'Hide Blame' }).click()
  await expect(state).toHaveCount(0)
})

test('late blame results cannot undo hide or replace the current file annotations', async ({ page, workspaceRoot }) => {
  const directory = repository(workspaceRoot)
  let held = gate()
  let requests = 0
  let results = 0
  await interceptWorkspaceRequests(page, request => {
    if (request.operation !== 'blame' || request.path !== 'a.txt') return
    requests += 1
    const currentGate = held
    return { onResult: async result => { await currentGate.promise; results += 1; return result } }
  })
  try {
    await openFile(page, directory)
    await annotate(page)
    await expect.poll(() => requests).toBe(1)
    await (await gutterMenu(page)).getByRole('menuitem', { name: 'Hide Blame' }).click()
    held.release()
    await expect.poll(() => results).toBe(1)
    await expect(page.locator('.code-file-inline-blame')).toHaveCount(0)
    await expect(page.getByTestId('code-file-blame-state')).toHaveCount(0)
    held = gate()
    await annotate(page)
    await expect.poll(() => requests).toBe(2)
    await selectTreeFile(page, 'b.txt')
    await expect(page.locator('.code-file-inline-blame')).toHaveCount(3)
    held.release()
    await expect.poll(() => results).toBe(2)
    await expect(page.locator('.code-file-inline-blame').nth(1)).toContainText('First Author')
    await expect(page.locator('.code-file-inline-blame').nth(1)).not.toContainText('Second Author')
  } finally { held.release() }
})

test('source-preview navigation dismisses the menu and restores clipped blame in split view', async ({ page, workspaceRoot }) => {
  await openFile(page, repository(workspaceRoot))
  await selectTreeFile(page, 'notes.md')
  const editor = page.getByTestId('code-file-editor')
  await editor.getByRole('button', { name: 'Show Markdown source' }).click()
  await annotate(page)
  await expect(page.locator('.code-file-inline-blame')).toHaveCount(3)
  const menu = await gutterMenu(page)
  // Keyboard activation has no outside-pointer event to incidentally dismiss the menu.
  const previewButton = editor.getByRole('button', { name: 'Open Markdown preview', exact: true })
  await previewButton.focus()
  await page.keyboard.press('Enter')
  await expect(editor.getByTestId('code-file-markdown-preview')).toBeVisible()
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.code-file-inline-blame')).toHaveCount(0)
  await editor.getByRole('button', { name: 'Show Markdown source' }).click()
  await editor.getByRole('button', { name: 'Open Markdown preview to side' }).click()
  await expect(page.locator('.code-file-inline-blame')).toHaveCount(3)
  const monaco = editor.getByTestId('code-file-monaco')
  const layer = page.locator('.code-file-inline-blame-layer')
  await expect.poll(async () => Math.abs((await layer.boundingBox())!.width - (await monaco.boundingBox())!.width)).toBeLessThanOrEqual(1)
  await page.locator('.code-file-inline-blame').first().click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Hide Blame' }).click()
  await expect(page.locator('.code-file-inline-blame')).toHaveCount(0)
})

test('delayed clipboard actions cannot edit another file after switching tabs', async ({ page, workspaceRoot }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: () => new Promise<string>(resolve => {
        document.addEventListener('release-test-clipboard', () => resolve('clipboard fixture'), { once: true })
        document.body.dataset.clipboardPending = 'true'
      }),
    } })
  })
  await openFile(page, repository(workspaceRoot))
  await page.getByRole('tab').filter({ hasText: 'a.txt' }).dblclick()
  await selectTreeFile(page, 'b.txt')
  await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 400, y: 38 } })
  await page.getByTestId('code-editor-context-menu').getByRole('menuitem', { name: 'Paste', exact: true }).click()
  await expect(page.locator('body')).toHaveAttribute('data-clipboard-pending', 'true')
  await page.getByRole('tab').filter({ hasText: 'a.txt' }).click()
  await page.evaluate(async () => {
    document.dispatchEvent(new Event('release-test-clipboard'))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe('first line\nchanged second line\nthird line\n')
  await page.getByRole('tab').filter({ hasText: 'b.txt' }).click()
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe('other first\nother second\nother third\n')
})

test('a save supersedes pending blame for the previous saved version', async ({ page, workspaceRoot }) => {
  const directory = repository(workspaceRoot)
  const held = gate()
  let requests = 0
  let oldResultReleased = false
  await interceptWorkspaceRequests(page, request => {
    if (request.operation !== 'blame') return
    requests += 1
    if (requests === 1) return { onResult: async result => {
      await held.promise
      oldResultReleased = true
      return result
    } }
  })
  try {
    await openFile(page, directory)
    await annotate(page)
    await expect.poll(() => requests).toBe(1)
    expect(await page.evaluate(() => window.__farmingFileEditorTest?.insertText('new line\n'))).toBe(true)
    await page.getByRole('button', { name: 'Save file', exact: true }).click()
    await expect(page.locator('.code-file-inline-blame')).toHaveCount(4)
    held.release()
    await expect.poll(() => oldResultReleased).toBe(true)
    await expect(page.locator('.code-file-inline-blame')).toHaveCount(4)
    await expect(page.locator('.code-file-inline-blame.uncommitted').first()).toBeVisible()
  } finally { held.release() }
})

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`failed clipboard writes preserve cut text in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async () => {
          if (document.body.dataset.clipboardAccept === 'true') return
          throw new DOMException('Clipboard permission denied', 'NotAllowedError')
        },
      } })
      const original = document.execCommand.bind(document)
      document.execCommand = (command, ...args) => command === 'copy' ? false : original(command, ...args)
    })
    await openFile(page, repository(workspaceRoot))
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    const editor = page.getByTestId('code-file-monaco')
    await editor.click({ button: 'right', position: { x: 400, y: 38 } })
    await page.getByTestId('code-editor-context-menu').getByRole('menuitem', { name: 'Select All', exact: true }).click()
    await editor.click({ button: 'right', position: { x: 400, y: 38 } })
    await page.getByTestId('code-editor-context-menu').getByRole('menuitem', { name: 'Cut', exact: true }).click()
    await expect(page.getByTestId('code-file-clipboard-alert')).toHaveText('Copy failed')
    expect(await page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe('first line\nchanged second line\nthird line\n')
    await page.screenshot({ path: testInfo.outputPath(`clipboard-failed-${appearance}.png`), animations: 'disabled' })
    await page.locator('body').evaluate(body => { body.dataset.clipboardAccept = 'true' })
    await editor.click({ button: 'right', position: { x: 400, y: 38 } })
    await page.getByTestId('code-editor-context-menu').getByRole('menuitem', { name: 'Cut', exact: true }).click()
    await expect(page.getByTestId('code-file-clipboard-alert')).toHaveCount(0)
    expect(await page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe('')
  })
}
