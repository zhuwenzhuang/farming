import type { Locator, Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

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
