import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

const { PNG: ScreenshotPng } = require('playwright-core/lib/utilsBundle') as {
  PNG: { sync: { read(buffer: Buffer): { data: Buffer; width: number; height: number } } }
}

type Appearance = 'light' | 'dark' | 'paper'

async function setAppearance(page: Page, appearance: Appearance) {
  await page.emulateMedia({
    colorScheme: appearance === 'dark' ? 'dark' : 'light',
    reducedMotion: 'reduce',
  })
  await page.evaluate((nextAppearance) => {
    document.documentElement.dataset.appearance = nextAppearance
    document.body.dataset.appearance = nextAppearance
  }, appearance)
  await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
}

async function collapsedSidebarIsolation(page: Page): Promise<{ inert: boolean; ariaHidden: string | null }> {
  return page.getByTestId('code-sidebar').evaluate(element => ({
    inert: (element as HTMLElement).inert === true,
    ariaHidden: element.getAttribute('aria-hidden'),
  }))
}

async function activeElementInsideSidebar(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const sidebar = document.querySelector('[data-testid="code-sidebar"]')
    return Boolean(sidebar && document.activeElement && sidebar.contains(document.activeElement))
  })
}

function assertNotBlankCapture(screenshot: Buffer, label: string) {
  const image = ScreenshotPng.sync.read(screenshot)
  const distinct = new Set<number>()
  for (let offset = 0; offset < image.data.length; offset += 4) {
    distinct.add(((image.data[offset] ?? 0) << 16) | ((image.data[offset + 1] ?? 0) << 8) | (image.data[offset + 2] ?? 0))
    if (distinct.size > 24) break
  }
  expect(distinct.size, `${label} must not be a blank capture`).toBeGreaterThan(8)
}

async function expectFocusCycleWithinDrawer(page: Page, drawer: Locator, shortcut: 'Tab' | 'Shift+Tab') {
  const initialFocus = await page.evaluateHandle(() => document.activeElement)
  let completedCycle = false

  try {
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press(shortcut)
      expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
      await expect(page.getByTestId('code-options-menu')).toHaveCount(0)
      await expect(page.getByTestId('code-mobile-share-sheet')).toHaveCount(0)
      if (await page.evaluate(element => document.activeElement === element, initialFocus)) {
        completedCycle = true
        break
      }
    }
  } finally {
    await initialFocus.dispose()
  }

  expect(completedCycle).toBe(true)
}

test('mobile navigation is a modal keyboard loop and desktop navigation remains usable', async ({ page }, testInfo) => {
  let shareTicketPosts = 0
  let shareTicketDeletes = 0
  let delayNextShareTicket = false
  let releaseDelayedShareTicket: (() => void) | null = null
  let resolveDelayedShareTicketStarted: (() => void) | null = null
  await page.route('**/api/share/qr-ticket**', async route => {
    if (route.request().method() === 'DELETE') {
      shareTicketDeletes += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revoked: true }) })
      return
    }
    shareTicketPosts += 1
    if (delayNextShareTicket) {
      delayNextShareTicket = false
      await new Promise<void>(resolve => {
        releaseDelayedShareTicket = resolve
        resolveDelayedShareTicketStarted?.()
      })
      releaseDelayedShareTicket = null
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'MOBILEMODAL',
        expiresAt: Date.now() + 5 * 60 * 1000,
        ttlMs: 5 * 60 * 1000,
        shortPath: '/j/MOBILEMODAL',
        shortUrl: 'https://share.example.test/j/MOBILEMODAL',
        longUrl: 'https://share.example.test/farming?token=read-only',
        fullAccessUrl: 'https://share.example.test/farming?token=full-control',
        shortUrlAccessMode: 'owner',
        longUrlAccessMode: 'read-only',
        tokenLabel: 'mobile navigation modal test token',
      }),
    })
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await openFarming(page)

  const trigger = page.getByTestId('code-mobile-menu')
  await trigger.focus()
  await page.keyboard.press('Enter')

  const drawer = page.getByRole('dialog', { name: /Projects and agents|项目与 Agent/ })
  await expect(drawer).toBeVisible()
  await expect(drawer).toHaveAttribute('aria-modal', 'true')
  await expect(drawer.getByRole('button', { name: /Close navigation|关闭导航/ })).toBeFocused()

  await expectFocusCycleWithinDrawer(page, drawer, 'Tab')
  await expectFocusCycleWithinDrawer(page, drawer, 'Shift+Tab')

  const backgroundOptions = page.getByTestId('code-mobile-more')
  const projectList = drawer.getByTestId('code-project-list')
  await projectList.focus()
  await expect(projectList).toBeFocused()
  expect(await backgroundOptions.evaluate(element => {
    element.focus()
    return document.activeElement === element
  })).toBe(false)
  await expect(projectList).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(drawer).toBeVisible()
  await expect(page.getByTestId('code-options-menu')).toHaveCount(0)
  await expect(page.getByTestId('code-mobile-share-sheet')).toHaveCount(0)
  expect(shareTicketPosts).toBe(0)

  const closeButton = drawer.getByRole('button', { name: /Close navigation|关闭导航/ })
  await closeButton.focus()
  await expect(closeButton).toBeFocused()
  const modalScreenshot = testInfo.outputPath('top-level-mobile-navigation-modal.png')
  await page.screenshot({
    path: modalScreenshot,
    animations: 'disabled',
    scale: 'css',
  })
  await testInfo.attach('top-level-mobile-navigation-modal', {
    path: modalScreenshot,
    contentType: 'image/png',
  })

  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('button', { name: /Close navigation|关闭导航/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(trigger).toBeFocused()

  delayNextShareTicket = true
  const delayedShareTicketStarted = new Promise<void>(resolve => {
    resolveDelayedShareTicketStarted = resolve
  })
  await backgroundOptions.click()
  await page.getByRole('menuitem', { name: /Share current page|分享当前页面/ }).click()
  await delayedShareTicketStarted
  expect(shareTicketPosts).toBe(1)

  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('button', { name: /Close navigation|关闭导航/ })).toBeFocused()

  const delayedShareResponse = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && response.url().includes('/api/share/qr-ticket')
  ))
  releaseDelayedShareTicket?.()
  await delayedShareResponse
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  await expect(page.getByTestId('code-mobile-share-sheet')).toHaveCount(0)
  await expect(drawer).toBeVisible()
  await expect.poll(() => shareTicketDeletes).toBe(1)

  const backgroundOptionsBox = await backgroundOptions.boundingBox()
  expect(backgroundOptionsBox).not.toBeNull()
  if (!backgroundOptionsBox) throw new Error('Mobile options button has no layout box')
  await page.mouse.click(
    backgroundOptionsBox.x + backgroundOptionsBox.width / 2,
    backgroundOptionsBox.y + backgroundOptionsBox.height / 2,
  )
  await expect(drawer).toHaveCount(0)
  await expect(page.getByTestId('code-options-menu')).toHaveCount(0)
  await expect(page.getByTestId('code-mobile-share-sheet')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(shareTicketPosts).toBe(1)

  await page.keyboard.press('Enter')
  await expect(drawer).toBeVisible()

  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.getByTestId('code-mobile-topbar')).toBeHidden()
  const desktopSidebar = page.getByTestId('code-sidebar')
  await expect(desktopSidebar).not.toHaveClass(/collapsed/)
  await expect(desktopSidebar).not.toHaveAttribute('role', 'dialog')
  await expect(desktopSidebar).not.toHaveAttribute('aria-modal', 'true')
  await expect(page.getByTestId('code-main')).not.toHaveAttribute('inert', '')
  await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toBeHidden()
  const desktopShare = page.getByTestId('code-share-button')
  await expect(desktopShare).toBeVisible()
  await desktopShare.focus()
  await expect(desktopShare).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('code-share-popover')).toBeVisible()
  expect(shareTicketPosts).toBe(2)
})

test('mobile share owns focus and Escape without closing the underlying view', async ({ page }) => {
  await page.route('**/api/share/qr-ticket', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      code: 'MOBILEFOCUS',
      expiresAt: Date.now() + 5 * 60 * 1000,
      ttlMs: 5 * 60 * 1000,
      shortPath: '/j/MOBILEFOCUS',
      shortUrl: 'https://share.example.test/j/MOBILEFOCUS',
      longUrl: 'https://share.example.test/farming?token=read-only',
      fullAccessUrl: 'https://share.example.test/farming?token=full-control',
      shortUrlAccessMode: 'owner',
      longUrlAccessMode: 'read-only',
      tokenLabel: 'mobile focus token',
    }),
  }))
  await page.setViewportSize({ width: 390, height: 844 })
  await openFarming(page)

  await page.getByTestId('code-mobile-menu').click()
  await page.getByTestId('code-nav-history').click()
  const history = page.getByTestId('code-history-panel')
  await expect(history).toBeVisible()
  await expect(page.getByTestId('code-history-loading')).toBeHidden()

  const optionsTrigger = page.getByTestId('code-mobile-more')
  await optionsTrigger.click()
  const ticketResponse = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && response.url().includes('/api/share/qr-ticket')
  ))
  await page.getByRole('menuitem', { name: /Share current page|分享当前页面/ }).click()
  expect((await ticketResponse).status()).toBe(200)

  const sheet = page.getByTestId('code-mobile-share-sheet')
  const dialog = sheet.getByRole('dialog')
  const closeButton = dialog.getByRole('button', { name: /Cancel|取消/ })
  await expect(closeButton).toBeFocused()

  const focusable = dialog.locator('button:not(:disabled)')
  const focusableCount = await focusable.count()
  expect(focusableCount).toBeGreaterThanOrEqual(3)
  for (let index = 0; index < focusableCount; index += 1) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await expect(closeButton).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(focusable.last()).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(history).toBeVisible()
  await expect(optionsTrigger).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(history).toHaveCount(0)

  await page.getByTestId('code-mobile-menu').click()
  await page.getByTestId('code-nav-search').click()
  const search = page.getByTestId('code-search-panel')
  await expect(search).toBeVisible()

  await optionsTrigger.click()
  await expect(search).toBeVisible()
  const searchTicketResponse = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && response.url().includes('/api/share/qr-ticket')
  ))
  await page.getByRole('menuitem', { name: /Share current page|分享当前页面/ }).click()
  expect((await searchTicketResponse).status()).toBe(200)
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(search).toBeVisible()
  await expect(optionsTrigger).toBeFocused()
})
test('compact closed navigation drawer is isolated from keyboard and accessibility exposure', async ({ page }) => {
  await page.setViewportSize({ width: 404, height: 844 })
  await openFarming(page)

  const sidebar = page.getByTestId('code-sidebar')
  await expect(sidebar).toHaveClass(/collapsed/)
  const box = await sidebar.boundingBox()
  expect(box, 'the closed compact drawer must have a layout box').not.toBeNull()
  if (!box) throw new Error('Closed compact drawer has no layout box')
  expect(box.x, 'the closed compact drawer must be translated offscreen').toBeLessThan(0)

  // The closed drawer is removed from the tab order and the accessibility
  // tree, including its New Agent, project rows, rest reminder, and footer.
  const isolation = await collapsedSidebarIsolation(page)
  expect(isolation.inert, 'the closed compact drawer must be inert').toBe(true)
  expect(isolation.ariaHidden, 'the closed compact drawer must be aria-hidden').toBe('true')
  // The compact empty workspace deliberately keeps its own New Agent action
  // available. Verify that it is the only exposed match and that the sidebar
  // action itself remains under the isolated drawer.
  const exposedNewAgentButtons = page.getByRole('button', { name: /New Agent|新建 Agent/ })
  await expect(exposedNewAgentButtons).toHaveCount(1)
  await expect(exposedNewAgentButtons).toHaveAttribute('data-testid', 'code-empty-compact-new-agent')
  expect(await page.getByTestId('code-new-agent').evaluate(element => (
    element.closest('[inert][aria-hidden="true"]')?.getAttribute('data-testid') === 'code-sidebar'
  ))).toBe(true)

  // Keyboard evidence: tabbing from the navigation trigger never reaches a
  // sidebar control while the drawer is closed.
  const trigger = page.getByTestId('code-mobile-menu')
  await trigger.focus()
  for (let step = 0; step < 24; step += 1) {
    await page.keyboard.press('Tab')
    expect(await activeElementInsideSidebar(page), `tab stop ${step + 1} must stay outside the closed drawer`).toBe(false)
  }
})

test('opening the drawer removes isolation and closing restores trigger focus', async ({ page }) => {
  await page.setViewportSize({ width: 404, height: 844 })
  await openFarming(page)

  const trigger = page.getByTestId('code-mobile-menu')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const drawer = page.getByRole('dialog', { name: /Projects and agents|项目与 Agent/ })
  await expect(drawer).toBeVisible()
  const openIsolation = await collapsedSidebarIsolation(page)
  expect(openIsolation.inert, 'the open drawer must not be inert').toBe(false)
  expect(openIsolation.ariaHidden, 'the open drawer must not be aria-hidden').not.toBe('true')
  await expect(drawer.getByRole('button', { name: /Close navigation|关闭导航/ })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
  await expect(trigger).toBeFocused()
  const closedIsolation = await collapsedSidebarIsolation(page)
  expect(closedIsolation.inert, 'the closed drawer must be inert again').toBe(true)
  expect(closedIsolation.ariaHidden, 'the closed drawer must be aria-hidden again').toBe('true')
})

test('desktop collapsed rail stays keyboard-usable and viewport transitions clear isolation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openFarming(page)

  const sidebar = page.getByTestId('code-sidebar')
  await page.getByTestId('code-sidebar-toggle').click()
  await expect(sidebar).toHaveClass(/collapsed/)
  let isolation = await collapsedSidebarIsolation(page)
  expect(isolation.inert, 'the desktop collapsed rail must stay interactive').toBe(false)
  expect(isolation.ariaHidden, 'the desktop collapsed rail must not be hidden').not.toBe('true')
  const railNewAgent = page.getByTestId('code-new-agent')
  await railNewAgent.focus()
  await expect(railNewAgent).toBeFocused()

  // Compact transition: the drawer auto-closes and becomes isolated.
  await page.setViewportSize({ width: 404, height: 844 })
  await expect(sidebar).toHaveClass(/collapsed/)
  await expect.poll(() => collapsedSidebarIsolation(page)).toEqual({
    inert: true,
    ariaHidden: 'true',
  })

  // Back to desktop: the visible rail clears the isolation.
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.getByTestId('code-mobile-topbar')).toBeHidden()
  isolation = await collapsedSidebarIsolation(page)
  expect(isolation.inert, 'the compact-to-desktop transition must clear inert').toBe(false)
  expect(isolation.ariaHidden, 'the compact-to-desktop transition must clear aria-hidden').not.toBe('true')
  await railNewAgent.focus()
  await expect(railNewAgent).toBeFocused()
})

test('collapsed sidebar surfaces render in Light, Dark, and Paper across regular and compact', async ({ page }, testInfo) => {
  const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-sidebar-a11y-'))
  try {
    const capture = async (locator: Locator, name: string) => {
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      })
      const screenshot = await locator.screenshot({ animations: 'disabled', scale: 'css' })
      assertNotBlankCapture(screenshot, name)
      const filePath = path.join(screenshotDir, `${name}.png`)
      fs.writeFileSync(filePath, screenshot)
      await testInfo.attach(`${name}.png`, { path: filePath, contentType: 'image/png' })
    }

    // Compact: closed drawer over the workspace topbar.
    await page.setViewportSize({ width: 404, height: 844 })
    await openFarming(page)
    await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await setAppearance(page, appearance)
      await capture(page.locator('body'), `compact-collapsed-${appearance}`)
    }

    // Regular: desktop collapsed rail.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId('code-sidebar-toggle').click()
    await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await setAppearance(page, appearance)
      await capture(page.locator('body'), `regular-rail-${appearance}`)
    }
  } finally {
    fs.rmSync(screenshotDir, { recursive: true, force: true })
  }
})
