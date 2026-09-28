import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, interceptWorkspaceRequests, openFarming, test } from './fixtures'

// Native scrollbar dragging must exercise a visible browser scrollbar.
test.use({
  launchOptions: async ({ launchOptions }, use) => {
    await use({ ...launchOptions, ignoreDefaultArgs: ['--hide-scrollbars'] })
  },
})

async function openHeaderWorkspace(page: Page, workspaceRoot: string, appearance: string) {
  const workspace = path.join(workspaceRoot, 'header-context')
  const directories = ['src/components/files', 'tools/extraordinarily-long-directory-name-for-file-exploration']
  for (const directory of directories) {
    fs.mkdirSync(path.join(workspace, directory), { recursive: true })
    for (let index = 0; index < 120; index++) {
      fs.writeFileSync(path.join(workspace, directory, `module-${String(index).padStart(3, '0')}.ts`), `export const value = ${index}\n`)
    }
  }
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Header context\n')
  expect((await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace, name: 'Explorer sample' } })).ok()).toBeTruthy()
  await page.addInitScript(({ workspace, directories }) => {
    localStorage.setItem('farming.code.workspaceViewState.v1', JSON.stringify({
      updatedAt: Date.now(), lastProjectWorkspace: workspace,
      projectFiles: { [workspace]: { filesCollapsed: false, openDirectoryPaths: directories.flatMap(directory => directory.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))) } },
    }))
  }, { workspace, directories })
  await page.request.post('/farming/api/settings', { data: { appearance } })
  await openFarming(page)
  if (await page.getByTestId('code-sidebar').evaluate(element => element.classList.contains('collapsed'))) {
    await page.getByTestId('code-mobile-menu').click()
  }
  const files = page.getByTestId('code-project-group').filter({ hasText: 'header-context' }).getByTestId('code-files-section')
  await expect(files.locator('.code-file-tree-viewport')).toHaveAttribute('data-visible-row-count', '243')
  return { files, directories, workspace }
}

async function scrollToHeaderRow(files: Locator, index: number) {
  await files.evaluate((section, index) => {
    const scroller = section.closest<HTMLElement>('.code-project-list')!
    const viewport = section.querySelector<HTMLElement>('.code-file-tree-viewport')!
    const heading = section.querySelector<HTMLElement>('.code-files-header')!
    const rowHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--code-sidebar-file-row-height'))
    const stickyBottom = scroller.getBoundingClientRect().top + parseFloat(getComputedStyle(heading).top) + heading.offsetHeight
    scroller.scrollTop += viewport.getBoundingClientRect().top + index * rowHeight - stickyBottom
  }, index)
}

async function tapHeaderControl(page: Page, control: Locator) {
  // A sticky header is already on screen. Locator.tap's scrollIntoView can
  // scroll to its original layout position before tapping a different path.
  await expect(control).toBeVisible()
  await expect.poll(() => control.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  })).toBe(true)
  const rect = (await control.boundingBox())!
  await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2)
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`Files header context and explicit search in ${appearance}`, async ({ page, workspaceRoot, isMobile }, testInfo) => {
    test.skip(isMobile, 'Desktop sidebar resize and native scrollbar scenario')
    const { files, directories } = await openHeaderWorkspace(page, workspaceRoot, appearance)
    const header = files.locator('.code-files-header')
    const context = files.getByTestId('code-file-header-path')
    const toggle = files.getByTestId('code-files-search-toggle')
    const search = files.getByRole('combobox')
    const tree = files.locator('.code-file-tree-viewport')
    await expect(tree).toHaveAttribute('data-visible-row-count', '243')
    await expect(search).toHaveCount(0)
    await header.hover()
    await expect(search).toHaveCount(0)

    const scrollToRow = (index: number) => scrollToHeaderRow(files, index)
    await scrollToRow(10)
    await expect(context).toHaveAttribute('data-path', directories[0])
    const geometry = () => header.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      refresh: element.querySelector('[data-testid="code-files-refresh"]')!.getBoundingClientRect().x,
      scroll: element.closest('.code-project-list')!.scrollTop,
    }))
    const before = await geometry()
    await context.hover()
    const tooltip = page.getByTestId('code-file-header-path-tooltip')
    await expect(tooltip).toContainText(directories[0])
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await toggle.click()
    await expect(search).toBeFocused()
    expect(await geometry()).toEqual(before)
    await expect(context).toHaveCount(0)
    await search.fill('module-050')
    const results = page.getByTestId('code-file-search-results')
    await expect(results).toContainText('module-050.ts')
    await search.press('Escape')
    await expect(results).toHaveCount(0)
    await expect(search).toHaveValue('module-050')
    await expect(search).toBeFocused()
    await search.press('Enter')
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    await search.press('Escape')
    await expect(search).toHaveCount(0)
    await expect(toggle).toBeFocused()
    await expect(context).toHaveAttribute('data-path', directories[0])
    expect(await geometry()).toEqual(before)
    // Keyboard search entry still opens the explicitly hidden input.
    await files.getByRole('tree').focus()
    await page.keyboard.press('Control+P')
    await expect(search).toBeFocused()
    await search.press('Escape')
    await expect(toggle).toBeFocused()

    // Resize using the real sidebar control; neither the row origin nor header height changes.
    const resizer = page.getByTestId('code-sidebar-resizer')
    const box = (await resizer.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 150)
    await page.mouse.down()
    await page.mouse.move(290, box.y + 150, { steps: 12 })
    await page.mouse.up()
    await expect(context).toContainText('files')
    await expect(context).toHaveAttribute('data-path', directories[0])
    expect((await geometry()).height).toBe(before.height)

    // Crossing a root sibling must clear the old parent before showing the next one.
    await scrollToRow(121)
    await expect(context).toHaveCount(0)
    await scrollToRow(130)
    await expect(context).toHaveAttribute('data-path', directories[1])
    await context.click()
    await expect(tooltip).toContainText(directories[1])
    const tipBounds = (await tooltip.boundingBox())!
    expect(tipBounds.x).toBeGreaterThanOrEqual(0)
    expect(tipBounds.x + tipBounds.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.keyboard.press('Escape')
    const screenshot = await page.screenshot({ path: testInfo.outputPath(`header-path-${appearance}.png`) })
    expect(screenshot.readUInt32BE(16)).toBe(page.viewportSize()!.width)
    expect(screenshot.readUInt32BE(20)).toBe(page.viewportSize()!.height)
    await testInfo.attach(`header-path-${appearance}`, { body: screenshot, contentType: 'image/png' })

    await toggle.click()
    await expect(search).toBeFocused()
    await testInfo.attach(`header-search-${appearance}`, { body: await page.screenshot({ path: testInfo.outputPath(`header-search-${appearance}.png`) }), contentType: 'image/png' })
    await toggle.click()
    await expect(context).toHaveAttribute('data-path', directories[1])

    // Real wheel and native scrollbar gestures exercise the old failure boundary.
    const scroller = page.getByTestId('code-project-list')
    await scroller.hover()
    const previousScroll = await scroller.evaluate(element => element.scrollTop)
    await page.mouse.wheel(0, -300)
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeLessThan(previousScroll)
    // Use a persistent native track instead of macOS's transient overlay thumb.
    await page.addStyleTag({ content: 'body.code-mode .code-project-list { scrollbar-width: auto; scrollbar-color: auto; } body.code-mode .code-project-list::-webkit-scrollbar { width: 16px; } body.code-mode .code-project-list::-webkit-scrollbar-thumb { background: #888; }' })
    await scroller.evaluate(async element => {
      element.scrollTop = 0
      await new Promise(resolve => requestAnimationFrame(resolve))
      await new Promise(resolve => requestAnimationFrame(resolve))
    })
    const thumb = await scroller.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const gutter = element.offsetWidth - element.clientWidth
      if (gutter <= 0) throw new Error('Native scrollbar gutter must be available for drag acceptance')
      return { x: rect.right - gutter / 2, y: rect.top + Math.max(5, element.clientHeight * element.clientHeight / element.scrollHeight / 2), bottom: rect.bottom }
    })
    await testInfo.attach('scrollbar-geometry', { body: Buffer.from(JSON.stringify(thumb)), contentType: 'application/json' })
    await page.mouse.move(thumb.x, thumb.y)
    await page.mouse.down()
    // Native thumb geometry and movement settle in the compositor between input events.
    for (let step = 1; step <= 20; step++) {
      await page.mouse.move(thumb.x, thumb.y + (thumb.bottom - 100 - thumb.y) * step / 20)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    }
    await page.mouse.up()
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    await expect(files.getByTestId('code-file-sticky-stack')).toHaveCount(0)
    expect((await geometry()).height).toBe(before.height)
  })
}

test('Files search keeps IME, pending replies and project context independent', async ({ page, workspaceRoot, isMobile }) => {
  test.skip(isMobile, 'Desktop keyboard and multiple Project scenario')
  let releaseReply = () => {}
  let replyHeld = false
  let replyReleased = false
  const pendingReply = new Promise<void>(resolve => { releaseReply = resolve })
  await interceptWorkspaceRequests(page, request => {
    if (request.operation !== 'search' || request.query !== 'module-051') return
    return { onResult: async result => {
      replyHeld = true
      await pendingReply
      replyReleased = true
      return result
    } }
  })
  try {
    const { files, directories } = await openHeaderWorkspace(page, workspaceRoot, 'light')
    const toggle = files.getByTestId('code-files-search-toggle')
    const search = files.getByRole('combobox')
    const context = files.getByTestId('code-file-header-path')
    const results = page.getByTestId('code-file-search-results')
    await scrollToHeaderRow(files, 10)
    await expect(context).toHaveAttribute('data-path', directories[0])
    await toggle.click()
    await search.fill('module-050')
    await expect(results).toContainText('module-050.ts')
    await search.evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', isComposing: true, bubbles: true, cancelable: true,
    })))
    await expect(results).toBeVisible()
    await expect(search).toHaveValue('module-050')
    await search.fill('module-051')
    await expect.poll(() => replyHeld).toBe(true)
    await toggle.click()
    await expect(search).toHaveCount(0)
    releaseReply()
    await expect.poll(() => replyReleased).toBe(true)
    await toggle.click()
    await expect(search).toHaveValue('')
    await expect(results).toHaveCount(0)
    await search.fill('module-052')
    await expect(results).toContainText('module-052.ts')
    await files.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(search).toHaveCount(0)
    await expect(results).toHaveCount(0)
    await files.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(search).toHaveCount(0)
    await toggle.click()
    await expect(search).toHaveValue('')
    await expect(results).toHaveCount(0)
    await toggle.click()

    const secondWorkspace = path.join(workspaceRoot, 'other-project')
    fs.mkdirSync(path.join(secondWorkspace, 'other'), { recursive: true })
    fs.writeFileSync(path.join(secondWorkspace, 'other', 'one.ts'), 'export const other = 1\n')
    expect((await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace: secondWorkspace } })).ok()).toBeTruthy()
    const second = page.getByTestId('code-project-group').filter({ hasText: 'other-project' })
    await expect(second).toHaveCount(1)
    await scrollToHeaderRow(files, 130)
    await expect(context).toHaveAttribute('data-path', directories[1])
    const visibility = page.getByTestId('code-project-group').filter({ hasText: 'header-context' }).getByTestId('code-project-agent-visibility')
    // A preceding section changes the sticky boundary without changing tree data.
    await visibility.click({ force: true })
    await expect(context).toHaveAttribute('data-path', directories[1])
    await expect(second.getByTestId('code-file-header-path')).toHaveCount(0)
  } finally {
    releaseReply()
  }
})

test.describe('compact Files header', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    test(`touch path, search and disclosure in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
      const { files, directories } = await openHeaderWorkspace(page, workspaceRoot, appearance)
      const context = files.getByTestId('code-file-header-path')
      const tooltip = page.getByTestId('code-file-header-path-tooltip')
      const toggle = files.getByTestId('code-files-search-toggle')
      const search = files.getByRole('combobox')
      const header = files.locator('.code-files-header')
      await scrollToHeaderRow(files, 130)
      await expect(context).toHaveAttribute('data-path', directories[1])
      const original = await header.boundingBox()
      await tapHeaderControl(page, context)
      await expect(tooltip).toContainText(directories[1])
      const bounds = (await tooltip.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
      const refresh = files.getByTestId('code-files-refresh')
      // Record rendered states so a busy runner cannot miss the brief success
      // indication between assertion polls. Stop observing on completion.
      const refreshAudit = await refresh.evaluateHandle(button => {
        const states: string[] = []
        const observer = new MutationObserver(() => {
          const state = button.getAttribute('data-refresh-status')!
          states.push(state)
          if (state !== 'refreshing') observer.disconnect()
        })
        observer.observe(button, { attributes: true, attributeFilter: ['data-refresh-status'] })
        return { states, stop: () => observer.disconnect() }
      })
      try {
        await tapHeaderControl(page, refresh)
        await expect(tooltip).toHaveCount(0)
        await expect.poll(() => refreshAudit.evaluate(audit => audit.states)).toEqual(['refreshing', 'success'])
      } finally {
        await refreshAudit.evaluate(audit => audit.stop())
        await refreshAudit.dispose()
      }
      await expect(context).toHaveAttribute('data-path', directories[1])
      await testInfo.attach(`compact-path-${appearance}`, { body: await page.screenshot({ path: testInfo.outputPath(`compact-path-${appearance}.png`) }), contentType: 'image/png' })
      await tapHeaderControl(page, toggle)
      await expect(search).toBeFocused()
      expect((await header.boundingBox())!.height).toBe(original!.height)
      await search.fill('module-050')
      await expect(page.getByTestId('code-file-search-results')).toContainText('module-050.ts')
      await testInfo.attach(`compact-search-${appearance}`, { body: await page.screenshot({ path: testInfo.outputPath(`compact-search-${appearance}.png`) }), contentType: 'image/png' })
      await tapHeaderControl(page, toggle)
      await expect(search).toHaveCount(0)
      await expect(context).toHaveAttribute('data-path', directories[1])
      await expect(page.getByTestId('code-sidebar')).not.toHaveClass(/collapsed/)
      await tapHeaderControl(page, files.getByRole('button', { name: 'Files', exact: true }))
      await expect(context).toHaveCount(0)
      await tapHeaderControl(page, files.getByRole('button', { name: 'Files', exact: true }))
      await scrollToHeaderRow(files, 10)
      await expect(context).toHaveAttribute('data-path', directories[0])
      const row = files.locator('[data-file-path="src/components/files/module-012.ts"]')
      await row.tap()
      await expect(page.getByTestId('code-file-editor')).toContainText('module-012.ts')
    })
  }
})
