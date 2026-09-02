import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

const { PNG: ScreenshotPng } = require('playwright-core/lib/utilsBundle') as {
  PNG: {
    sync: {
      read: (buffer: Buffer) => { width: number; height: number }
    }
  }
}

type Appearance = 'light' | 'dark' | 'paper'

// Playwright hides native scrollbars in headless Chromium by default. Keep
// their real hit targets for these interaction tests instead of faking scroll.
const scrollbarTest = test.extend({
  launchOptions: async ({ launchOptions }, use) => {
    await use({ ...launchOptions, ignoreDefaultArgs: ['--hide-scrollbars'] })
  },
})

async function createAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

async function setAppearance(page: Page, appearance: Appearance) {
  await page.emulateMedia({
    colorScheme: appearance === 'dark' ? 'dark' : 'light',
    reducedMotion: 'reduce',
  })
  await page.evaluate(nextAppearance => {
    document.documentElement.dataset.appearance = nextAppearance
    document.body.dataset.appearance = nextAppearance
  }, appearance)
}

async function resolvedColor(page: Page, role: string) {
  return page.evaluate(cssRole => {
    const probe = document.createElement('span')
    probe.style.background = `var(${cssRole})`
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  }, role)
}

async function expectFocusedSurface(page: Page, locator: Locator, role: string) {
  await expect(locator).toBeFocused()
  await expect(locator).toHaveCSS('outline-style', 'none')
  await expect(locator).toHaveCSS('box-shadow', 'none')
  await expect(locator).toHaveCSS('background-color', await resolvedColor(page, role))
}

async function expectFocusedContainerWithoutSurface(locator: Locator) {
  await expect(locator).toBeFocused()
  await expect(locator).toHaveCSS('outline-style', 'none')
  await expect(locator).toHaveCSS('box-shadow', 'none')
  await expect(locator).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
}

async function captureFullPage(page: Page, testInfo: TestInfo, appearance: Appearance) {
  const screenshotPath = testInfo.outputPath(`sidebar-focus-${appearance}-full.png`)
  const screenshot = await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  })
  const image = ScreenshotPng.sync.read(screenshot)
  expect(image.width).toBe(1440)
  expect(image.height).toBe(900)
  await testInfo.attach(`sidebar-focus-${appearance}-full`, {
    path: screenshotPath,
    contentType: 'image/png',
  })
}

for (const layout of ['regular', 'compact'] as const) {
  scrollbarTest(`keeps the sidebar scroll container unpainted while dragging its scrollbar (${layout})`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, 'scrollbar-focus')
    fs.mkdirSync(workspace, { recursive: true })
    for (let index = 0; index < 120; index += 1) {
      fs.writeFileSync(path.join(workspace, `file-${String(index).padStart(3, '0')}.txt`), `file ${index}\n`)
    }
    await createAgent(page, workspace)
    // Open Editors, an active file, and sticky Project/Files headers must coexist
    // with the long, virtualized tree, as they do in the reported screenshot.
    await page.setViewportSize({ width: 1440, height: 900 })
    await openFarming(page)
    const project = page.getByTestId('code-project-group').filter({ hasText: 'scrollbar-focus' })
    const files = project.getByTestId('code-files-section')
    const filesTitle = files.locator('.code-files-title')
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
    await files.locator('[data-file-path="file-000.txt"]').click()
    await expect(project.locator('.code-open-editors')).toBeVisible()
    const editorsTitle = project.locator('.code-open-editors-title')
    if (await editorsTitle.getAttribute('aria-expanded') !== 'true') await editorsTitle.click()

    if (layout === 'compact') {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
      const sidebar = page.getByTestId('code-sidebar')
      await expect(sidebar).toHaveClass(/collapsed/)
      await page.getByTestId('code-mobile-back').click()
      await page.getByTestId('code-mobile-menu').click()
      await expect(sidebar).not.toHaveClass(/collapsed/)
    }

    const list = page.getByTestId('code-project-list')
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await setAppearance(page, appearance)
      await list.evaluate(element => { element.scrollTop = 0 })
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0)
      await list.hover({ position: { x: 100, y: 300 } })
      await page.mouse.wheel(0, 240)
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      const geometry = await list.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const thumbHeight = element.clientHeight ** 2 / element.scrollHeight
        return {
          x: bounds.right - 2,
          y: bounds.top + element.scrollTop * element.clientHeight / element.scrollHeight + thumbHeight / 2,
          scrollTop: element.scrollTop,
          overflow: element.scrollHeight - element.clientHeight,
          lane: element.offsetWidth - element.clientWidth,
          hit: document.elementFromPoint(bounds.right - 2, bounds.top + 20)?.className,
        }
      })
      expect(geometry.overflow).toBeGreaterThan(1000)
      expect(geometry.lane).toBeGreaterThan(0)
      expect(geometry.hit).toBe('code-project-list')
      await page.mouse.move(geometry.x, geometry.y)
      await page.mouse.down()
      try {
        await page.mouse.move(geometry.x, geometry.y + 100, { steps: 12 })
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(geometry.scrollTop + 100)
        await expectFocusedContainerWithoutSurface(list)
        const screenshotPath = testInfo.outputPath(`scrollbar-drag-${layout}-${appearance}.png`)
        const screenshot = await list.screenshot({ path: screenshotPath, animations: 'disabled', caret: 'hide' })
        const image = ScreenshotPng.sync.read(screenshot)
        expect(image.width).toBeGreaterThan(200)
        expect(image.height).toBeGreaterThan(400)
        await testInfo.attach(`scrollbar-drag-${layout}-${appearance}`, { path: screenshotPath, contentType: 'image/png' })
      } finally {
        await page.mouse.up()
      }
      await expectFocusedContainerWithoutSurface(list)
      // Keyboard focus remains on the container for navigation; it must not
      // become a selected-row surface in either input modality.
      await list.press('Shift')
      await expectFocusedContainerWithoutSurface(list)
      if (layout === 'regular') {
        const activeEditor = project.locator('.code-open-editor-row.active')
        await expect(activeEditor).toHaveCSS('background-color', await resolvedColor(page, '--code-active-item-surface'))
      }
    }
    if (layout === 'regular') {
      const resizer = page.getByTestId('code-sidebar-resizer')
      const bounds = await resizer.boundingBox()
      expect(bounds).not.toBeNull()
      const widthBefore = await page.getByTestId('code-sidebar').evaluate(element => element.getBoundingClientRect().width)
      // The nine-pixel resize target remains usable on the content side.
      await page.mouse.move(bounds!.x + 4, bounds!.y + 200)
      await page.mouse.down()
      try {
        await page.mouse.move(bounds!.x + 44, bounds!.y + 200, { steps: 8 })
        await expect.poll(() => page.getByTestId('code-sidebar').evaluate(element => element.getBoundingClientRect().width))
          .toBeGreaterThan(widthBefore + 30)
      } finally {
        await page.mouse.up()
      }
    }
  })
}

test('uses one surface-based sidebar focus language across Light, Dark, and Paper', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'sidebar-focus-appearance')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'focus-target.txt'), 'sidebar focus target\n')
  const agentId = await createAgent(page, workspace)

  await page.setViewportSize({ width: 1440, height: 900 })
  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const projectTitle = project.getByTestId('code-project-title')
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await agentRow.click()

  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title')
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const fileRow = files.locator('[data-testid="code-file-row"][data-file-path="focus-target.txt"]')
  await expect(fileRow).toBeVisible()

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await setAppearance(page, appearance)

    await agentRow.click({ button: 'right' })
    const agentRename = page.getByTestId('code-agent-context-menu').getByRole('menuitem', { name: 'Rename Agent' })
    await agentRename.hover()
    await expect(agentRename).toHaveCSS('outline-style', 'none')
    await agentRename.click()
    const agentRenameInput = page.getByTestId('code-rename-input')
    await expect(agentRenameInput).toBeFocused()
    await agentRenameInput.press('Escape')
    await page.mouse.move(1200, 100)
    await expectFocusedSurface(page, agentRow, '--code-active-item-surface')
    await captureFullPage(page, testInfo, appearance)

    await projectTitle.click({ button: 'right' })
    await page.getByTestId('code-project-context-menu').getByRole('menuitem', { name: 'Rename project' }).click()
    const projectRenameInput = page.getByTestId('code-rename-input')
    await expect(projectRenameInput).toBeFocused()
    await projectRenameInput.press('Escape')
    await page.mouse.move(1200, 100)
    await expectFocusedSurface(page, projectTitle, '--code-active-item-surface')

    const instanceName = page.getByTestId('code-instance-name-edit')
    await instanceName.click()
    const instanceDialog = page.getByTestId('code-instance-name-dialog')
    await expect(instanceDialog).toBeVisible()
    await instanceDialog.locator('input').press('Escape')
    await page.mouse.move(1200, 100)
    await expectFocusedSurface(page, instanceName, '--code-bg-hover')

    const projectList = page.getByTestId('code-project-list')
    const projectListBounds = await projectList.boundingBox()
    expect(projectListBounds).not.toBeNull()
    await page.mouse.click(
      projectListBounds!.x + 4,
      projectListBounds!.y + projectListBounds!.height - 4,
    )
    await expectFocusedContainerWithoutSurface(projectList)
    // A delayed dialog focus-restoration retry must not steal a newer explicit
    // user focus target, including after its final 360 ms retry window.
    await page.waitForTimeout(400)
    await expectFocusedContainerWithoutSurface(projectList)

    await fileRow.click({ button: 'right' })
    const fileMenu = page.getByTestId('code-file-context-menu')
    const refresh = fileMenu.getByRole('menuitem', { name: 'Refresh' })
    await refresh.hover()
    await expect(refresh).toHaveCSS('outline-style', 'none')
    expect(await refresh.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(
      await resolvedColor(page, '--code-bg-hover')
    )
    await page.waitForTimeout(400)
    await refresh.focus()
    await expectFocusedSurface(page, refresh, '--code-bg-hover')
    await refresh.press('Escape')
  }

  const visibleSidebarTargets = page.locator('.code-sidebar button:visible, .code-sidebar [tabindex="0"]:visible')
  const targetCount = await visibleSidebarTargets.count()
  expect(targetCount).toBeGreaterThan(10)
  for (let index = 0; index < targetCount; index += 1) {
    const target = visibleSidebarTargets.nth(index)
    await target.press('Shift')
    const focusBoundary = await target.evaluate(element => {
      const computed = getComputedStyle(element)
      return {
        boxShadow: computed.boxShadow,
        outlineStyle: computed.outlineStyle,
      }
    })
    expect(focusBoundary, `sidebar focus target ${index}`).toEqual({
      boxShadow: 'none',
      outlineStyle: 'none',
    })
  }
})
