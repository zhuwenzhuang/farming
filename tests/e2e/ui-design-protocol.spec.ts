import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'
import { setupComputerRoutes } from './computer-surface-fixture'

const appearances = ['light', 'dark', 'paper'] as const
async function appearance(page: Page, value: typeof appearances[number]) {
  await page.emulateMedia({ colorScheme: value === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
  await page.evaluate(next => {
    document.documentElement.dataset.appearance = next
    document.body.dataset.appearance = next
  }, value)
}
async function openDrawer(page: Page) {
  const sidebar = page.getByTestId('code-sidebar')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  if (await sidebar.evaluate(el => el.classList.contains('collapsed'))) {
    const back = page.getByTestId('code-mobile-back')
    if (await back.isVisible()) await back.click()
    await page.getByTestId('code-mobile-menu').click()
  }
  await expect(sidebar).not.toHaveClass(/collapsed/)
}
async function capture(locator: Locator, testInfo: TestInfo, name: string) {
  const screenshot = testInfo.outputPath(`${name}.png`)
  await locator.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach(name, { path: screenshot, contentType: 'image/png' })
}
async function menuContract(menu: Locator, compact: boolean) {
  await expect(menu).toBeVisible()
  await expect(menu).toHaveCSS('border-radius', '8px')
  await expect(menu).toHaveCSS('padding', '5px')
  const rows = menu.locator('button:visible, summary:visible')
  expect(await rows.count()).toBeGreaterThan(0)
  const metrics = await rows.evaluateAll(elements => elements.map(el => {
    const css = getComputedStyle(el)
    return { font: css.fontSize, weight: css.fontWeight, line: css.lineHeight, radius: css.borderRadius, height: el.getBoundingClientRect().height }
  }))
  for (const { height, ...metric } of metrics) {
    expect(metric).toEqual({ font: '13px', weight: '400', line: '18px', radius: '6px' })
    expect(height).toBeCloseTo(compact ? 36 : 28, 2)
  }
  const bounds = await menu.evaluate(el => {
    const rect = el.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.top).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height)
  return menu.evaluate(el => {
    const css = getComputedStyle(el)
    return { background: css.backgroundColor, border: css.border, shadow: css.boxShadow, font: css.fontFamily }
  })
}

test('shared sidebar labels, action glyphs and menus survive long names and responsive changes', async ({ page, workspaceRoot, isMobile }, testInfo) => {
  testInfo.setTimeout(120_000)
  const workspace = path.join(workspaceRoot, 'sample-project-with-a-long-descriptive-name')
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), 'Sample content\n')
  fs.writeFileSync(path.join(workspace, 'src/app.ts'), 'export const sample = true\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace })
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'user.name', 'Sample Author')
  git('config', 'user.email', 'sample@example.test')
  git('add', '.')
  git('commit', '--quiet', '-m', 'Sample files')
  fs.appendFileSync(path.join(workspace, 'README.md'), 'Changed content\n')
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Untracked content\n')
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace, name: 'Sample Agent' } })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)
  await openDrawer(page)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title')
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const readme = files.locator('[data-testid="code-file-row"][data-file-path="README.md"]')
  await readme.click()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await openDrawer(page)
  const editorsTitle = project.locator('.code-open-editors-title')
  if (await editorsTitle.getAttribute('aria-expanded') !== 'true') await editorsTitle.click()
  for (const toggle of await files.locator('.code-file-change-group-toggle').all()) {
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  }
  // Initial layout, opposite width, and return exercise the same runtime tree.
  for (const compact of [isMobile, !isMobile, isMobile]) {
    await page.setViewportSize(compact ? { width: 393, height: 852 } : { width: 1280, height: 900 })
    await expect.poll(() => page.locator('body').evaluate(el => el.classList.contains('code-compact-layout'))).toBe(compact)
    await openDrawer(page)
    for (const theme of appearances) {
      await appearance(page, theme)
      await page.getByTestId('code-project-list').evaluate(el => { el.scrollTop = 0 })
      for (const label of [readme.locator('.code-file-name'), project.locator('.code-open-editor-name'), files.locator('.code-file-change-name').first()]) {
        await expect(label).toHaveCSS('font-size', compact ? '14px' : '13px')
        await expect(label).toHaveCSS('line-height', '16px')
      }
      await expect(files.locator('.code-file-change-review').first()).toHaveCSS('font-size', '11px')
      await expect(files.locator('.code-file-change-review').first()).toHaveCSS('font-weight', '500')
      if (compact) {
        const title = await project.locator('.code-project-title-name').boundingBox()
        const actions = await project.locator('.code-project-title-actions').boundingBox()
        expect(title!.x + title!.width).toBeLessThanOrEqual(actions!.x)
        await expect(project.locator('.code-project-title-actions')).toHaveCSS('mask-image', 'none')
        expect((await project.getByTestId('code-project-actions').boundingBox())!.width).toBeCloseTo(44, 2)
        const projectGlyph = await project.getByTestId('code-project-actions').locator('svg').innerHTML()
        expect(await readme.locator('.code-file-row-actions svg').innerHTML()).toBe(projectGlyph)
        expect(await project.getByTestId('code-agent-row-more').locator('svg').innerHTML()).toBe(projectGlyph)
      }
      await page.mouse.move(0, 0)
      const prefix = `${compact ? 'compact' : 'desktop'}-${theme}`
      await capture(page.getByTestId('code-sidebar'), testInfo, `${prefix}-sidebar`)
      if (compact) await readme.locator('.code-file-row-actions').click()
      else await readme.click({ button: 'right' })
      const fileMenu = page.getByTestId('code-file-context-menu')
      const reference = await menuContract(fileMenu, compact)
      await capture(fileMenu, testInfo, `${prefix}-file-menu`)
      await page.keyboard.press('Escape')
      const agent = project.getByTestId('code-agent-row').first()
      if (compact) await agent.getByTestId('code-agent-row-more').click()
      else await agent.click({ button: 'right' })
      const agentMenu = page.locator('.code-context-menu').first()
      expect(await menuContract(agentMenu, compact)).toEqual(reference)
      await capture(agentMenu, testInfo, `${prefix}-agent-menu`)
      await page.keyboard.press('Escape')
      if (!compact) await project.getByTestId('code-project-title').hover()
      await project.getByTestId('code-project-actions').click()
      const projectMenu = page.locator('.code-project-context-menu')
      expect(await menuContract(projectMenu, compact)).toEqual(reference)
      await capture(projectMenu, testInfo, `${prefix}-project-menu`)
      await page.keyboard.press('Escape')
    }
  }
})

test('resources can expand on initial phone load, after reload and across widths', async ({ page, workspaceRoot }, testInfo) => {
  testInfo.setTimeout(90_000)
  await page.setViewportSize({ width: 393, height: 852 })
  const workspace = path.join(workspaceRoot, 'sample-resources')
  fs.mkdirSync(workspace)
  await setupComputerRoutes(page, workspace).routes.install()
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await openDrawer(page)
  const agent = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await agent.getByTestId('code-agent-row-more').click()
  await page.getByRole('menuitem', { name: 'Create Desktop in Docker (Experimental)' }).click()
  const viewer = page.getByTestId('farming-computer-viewer')
  await expect(viewer).toBeVisible()
  await viewer.getByRole('button', { name: 'Back to Agent' }).click()
  await openDrawer(page)
  const toggle = agent.getByTestId('code-agent-resources-toggle')
  const section = page.getByTestId('farming-computer-section')
  for (const theme of appearances) {
    await appearance(page, theme)
    await expect(toggle).toBeVisible()
    expect((await toggle.boundingBox())!.width).toBeCloseTo(44, 2)
    expect((await toggle.boundingBox())!.height).toBeCloseTo(44, 2)
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
    await expect(section).toBeHidden()
    await capture(page.getByTestId('code-sidebar'), testInfo, `${theme}-resource-collapsed`)
    await toggle.click()
    await expect(section).toBeVisible()
    await capture(page.getByTestId('code-sidebar'), testInfo, `${theme}-resource-expanded`)
    await section.getByRole('button', { name: 'More', exact: true }).click()
    const menu = page.locator('.farming-computer-more-menu')
    await menuContract(menu, true)
    await capture(menu, testInfo, `${theme}-computer-menu`)
    await page.keyboard.press('Escape')
    await toggle.click()
  }
  await page.reload()
  await openDrawer(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(section).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.locator('body')).not.toHaveClass(/code-compact-layout/)
  await agent.hover()
  await toggle.click()
  await expect(section).toBeHidden()
  await page.setViewportSize({ width: 393, height: 852 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await openDrawer(page)
  await toggle.click()
  await expect(section).toBeVisible()
})

test('standalone Review uses shared choice menu metrics and neutral selection', async ({ page }, testInfo) => {
  for (const theme of appearances) {
    await page.goto('/farming/review?fixture=1')
    await expect(page.getByTestId('review-page')).toBeVisible()
    await appearance(page, theme)
    await page.getByLabel('Patch set', { exact: true }).click()
    const menu = page.locator('.code-select-menu')
    await menuContract(menu, (page.viewportSize()?.width || 1280) <= 980)
    const selected = menu.locator('[aria-selected="true"]')
    const selectedColor = await selected.evaluate(el => getComputedStyle(el).backgroundColor)
    const option = menu.locator('[role="option"]').first()
    await option.hover()
    await expect(option).toHaveCSS('background-color', selectedColor)
    await capture(page.getByTestId('review-page'), testInfo, `${theme}-review-menu`)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Diff preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Diff Preferences' })
    for (const field of [preferences.getByLabel('Context', { exact: true }), preferences.getByLabel('Diff width')]) {
      await expect(field).toHaveCSS('height', '34px')
      await expect(field).toHaveCSS('font-size', '14px')
      await expect(field).toHaveCSS('border-radius', '6px')
    }
    const dialogBounds = await preferences.boundingBox()
    for (const field of await preferences.locator('input, [role="combobox"], footer button').all()) {
      const box = await field.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(dialogBounds!.x)
      expect(box!.x + box!.width).toBeLessThanOrEqual(dialogBounds!.x + dialogBounds!.width)
    }
    await expect(preferences.getByRole('button', { name: 'SAVE', exact: true })).toHaveCSS('border-style', 'none')
    await capture(preferences, testInfo, `${theme}-review-preferences`)
    await preferences.getByRole('button', { name: 'CANCEL', exact: true }).click()
  }
})

test('Composer menus keep their shared chrome in each appearance and input layout', async ({ page, workspaceRoot, isMobile }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'sample-composer')
  fs.mkdirSync(workspace)
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace } })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await openDrawer(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  for (const theme of appearances) {
    await appearance(page, theme)
    await page.getByTestId('code-composer-add').click()
    const plus = page.getByTestId('code-composer-plus-menu')
    await menuContract(plus, isMobile)
    await capture(page.getByTestId('code-main'), testInfo, `${theme}-composer-menu`)
    await page.keyboard.press('Escape')
    await expect(plus).toBeHidden()
    await page.getByTestId('code-composer-approval').click()
    const approval = page.getByTestId('code-approval-menu')
    await expect(approval).toHaveCSS('border-radius', '8px')
    for (const row of await approval.getByRole('menuitemradio').all()) {
      await expect(row).toHaveCSS('border-radius', '6px')
      await expect(row).toHaveCSS('font-size', '13px')
    }
    await capture(page.getByTestId('code-main'), testInfo, `${theme}-composer-permissions`)
    await page.keyboard.press('Escape')
  }
})
