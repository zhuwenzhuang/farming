import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function rect(locator: Locator) {
  return locator.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  })
}

test('keeps composed sidebar density and alignment through resize, expansion, and row actions', async ({ page, workspaceRoot, isMobile }, testInfo) => {
  testInfo.setTimeout(120_000)
  const workspace = path.join(workspaceRoot, 'sidebar-spacing')
  fs.mkdirSync(path.join(workspace, 'src', 'components', 'nested'), { recursive: true })
  for (const name of ['README.md', 'src/app.ts', 'src/components/card.ts', 'src/components/nested/item.ts']) {
    fs.writeFileSync(path.join(workspace, name), 'Sample content\n')
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' })
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'user.name', 'Sample Author')
  git('config', 'user.email', 'sample@example.test')
  git('add', '.')
  git('commit', '--quiet', '-m', 'Sample files')
  fs.appendFileSync(path.join(workspace, 'README.md'), 'Changed content\n')
  fs.appendFileSync(path.join(workspace, 'src/app.ts'), 'Changed content\n')
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Untracked content\n')
  for (const command of ['bash', 'codex']) {
    const response = await page.request.post('/farming/api/control/agents', { data: { command, workspace } })
    expect(response.ok()).toBeTruthy()
  }
  await openFarming(page)
  const sidebar = page.getByTestId('code-sidebar')
  const openDrawer = async () => {
    if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
      const back = page.getByTestId('code-mobile-back')
      if (await back.isVisible()) await back.click()
      await page.getByTestId('code-mobile-menu').click()
    }
  }
  await openDrawer()
  const project = page.getByTestId('code-project-group').filter({ hasText: 'sidebar-spacing' })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title')
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const readme = files.locator('[data-testid="code-file-row"][data-file-path="README.md"]')
  await readme.click()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await openDrawer()
  const editorsTitle = project.locator('.code-open-editors-title')
  if (await editorsTitle.getAttribute('aria-expanded') !== 'true') await editorsTitle.click()
  const list = page.getByTestId('code-project-list')

  // A touch-capable wide viewport and a narrow mouse viewport both obey width,
  // not a second density policy based on the input device.
  for (const compact of [false, true, false]) {
    await page.setViewportSize(compact ? { width: 393, height: 852 } : { width: 1280, height: 900 })
    // ResizeObserver commits the navigation mode after the viewport changes.
    // Wait for that transition before reading the drawer state or clicking it.
    if (compact) {
      await expect(sidebar).toHaveClass(/collapsed/)
      await openDrawer()
    }
    await expect(sidebar).not.toHaveClass(/collapsed/)
    const height = compact ? 28 : 24
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
      await page.evaluate(value => {
        document.documentElement.dataset.appearance = value
        document.body.dataset.appearance = value
      }, appearance)
      for (const toggle of await files.locator('.code-file-change-group-toggle').all()) {
        if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
      }
      await list.evaluate(element => { element.scrollTop = 0 })
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0)
      await expect.poll(() => rect(project.locator('.code-open-editor-row'))).toMatchObject({ height })
      await expect.poll(() => rect(readme)).toMatchObject({ height })
      expect((await rect(editorsTitle)).x).toBe((await rect(filesTitle)).x)
      const refresh = await rect(files.locator('.code-files-refresh'))
      const close = await rect(project.locator('.code-open-editor-close'))
      await expect(project.locator('.code-open-editors-list')).toHaveCSS('scrollbar-gutter', 'auto')
      expect(close.x + close.width / 2).toBe(refresh.x + refresh.width / 2)
      if (compact) {
        const titleRect = await rect(project.getByTestId('code-project-title'))
        const actionRect = await rect(project.getByTestId('code-project-new-agent'))
        expect(actionRect.y + actionRect.height / 2).toBe(titleRect.y + titleRect.height / 2)
        for (const agent of await project.getByTestId('code-agent-row').all()) {
          expect((await rect(agent)).height).toBe(44)
          const more = await rect(agent.getByTestId('code-agent-row-more'))
          expect(more.height).toBe(44)
          expect(more.x + more.width / 2).toBe(actionRect.x + actionRect.width / 2)
        }
        const fileAction = await rect(readme.locator('.code-file-row-actions'))
        expect(fileAction.x + fileAction.width / 2).toBe(refresh.x + refresh.width / 2)
        expect(fileAction.height).toBe(height)
      }
      await page.mouse.move(0, 0)
      const screenshotPath = testInfo.outputPath(`${isMobile ? 'touch' : 'mouse'}-${compact ? 'compact' : 'desktop'}-${appearance}.png`)
      await list.screenshot({ path: screenshotPath, animations: 'disabled' })
      await testInfo.attach(`${compact ? 'compact' : 'desktop'}-${appearance}`, { path: screenshotPath, contentType: 'image/png' })
    }
    for (const toggle of await files.locator('.code-file-change-group-toggle').all()) {
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    }
    const changes = files.locator('.code-file-change-main')
    await expect(changes).toHaveCount(3)
    for (const change of await changes.all()) expect((await rect(change)).height).toBe(height)
    const changeLabels = await files.locator('.code-file-change-name').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().x))
    expect(new Set(changeLabels).size).toBe(1)
    const labelPositions: number[] = []
    for (const directory of ['src', 'src/components', 'src/components/nested']) {
      const row = files.locator(`[data-testid="code-file-row"][data-file-path="${directory}"]`)
      await row.scrollIntoViewIfNeeded()
      if (await row.getAttribute('aria-expanded') !== 'true') await row.click()
      labelPositions.push((await rect(row.locator('.code-file-name'))).x)
    }
    const deepFile = files.locator('[data-testid="code-file-row"][data-file-path="src/components/nested/item.ts"]')
    await deepFile.scrollIntoViewIfNeeded()
    labelPositions.push((await rect(deepFile.locator('.code-file-name'))).x)
    expect(labelPositions.slice(1).map((x, index) => x - labelPositions[index]!)).toEqual([8, 8, 8])
    await expect.poll(() => files.getByTestId('code-file-row').evaluateAll(rows => {
      const bounds = rows.map(row => row.getBoundingClientRect())
      return bounds.slice(1).map((box, index) => box.y - bounds[index]!.y - bounds[index]!.height)
    })).toEqual(Array((await files.getByTestId('code-file-row').count()) - 1).fill(0))
    if (compact) {
      const action = deepFile.locator('.code-file-row-actions')
      if (isMobile) await action.tap()
      else await action.click()
      await expect(page.getByTestId('code-file-context-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-file-context-menu')).toHaveCount(0)
    }
  }
})
