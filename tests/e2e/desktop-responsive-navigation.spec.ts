import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`keeps desktop navigation at intermediate widths in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 800 })
    await openFarming(page)
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    const sidebar = page.getByTestId('code-sidebar')
    const mobileMenu = page.getByTestId('code-mobile-menu')
    await expect(mobileMenu).toBeHidden()
    await expect(sidebar).not.toHaveClass(/collapsed/)
    await expect(page.getByTestId('code-sidebar-resizer')).toBeVisible()

    const projectDir = path.join(workspaceRoot, 'responsive-desktop')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Responsive workspace\n')
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace: projectDir },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(row).toBeVisible()
    await row.click()
    await expect(sidebar).not.toHaveClass(/collapsed/)
    await row.hover()
    await expect(row.getByTestId('code-agent-row-pin')).toBeVisible()
    await expect(row.getByTestId('code-agent-row-more')).toBeHidden()
    await expect(page.getByTestId('code-composer')).toBeVisible()
    await page.getByTestId('code-composer-input').fill('printf "Responsive desktop ready\\n"')
    await page.getByTestId('code-composer-send').click()
    await expect.poll(async () => page.evaluate(
      id => (window.__farmingTerminalTest?.getRows(id, 100) ?? []).join('\n'), agentId,
    )).toContain('Responsive desktop ready')
    await page.getByTestId('code-composer-input').fill('Keep this draft while resizing')
    await page.mouse.move(880, 50)
    await page.screenshot({ path: testInfo.outputPath(`desktop-900-${appearance}.png`), animations: 'disabled' })

    for (const width of [980, 900, 899, 844, 768]) {
      await page.setViewportSize({ width, height: 800 })
      await expect(page.locator('body')).not.toHaveClass(/code-compact-layout/)
      await expect(mobileMenu).toBeHidden()
      await expect(sidebar).not.toHaveAttribute('aria-modal', 'true')
      await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toBeHidden()
      if (width < 900) await expect(sidebar).toHaveClass(/collapsed/)
      await expect(page.getByTestId('code-sidebar-toggle')).toBeVisible()
      expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true)
    }
    await page.getByTestId('code-sidebar-toggle').click()
    await expect(row).toBeVisible()
    await row.click()
    await expect(sidebar).not.toHaveClass(/collapsed/)
    await page.screenshot({ path: testInfo.outputPath(`desktop-768-${appearance}.png`), animations: 'disabled' })

    await page.setViewportSize({ width: 767, height: 800 })
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await expect(sidebar).toHaveClass(/collapsed/)
    await mobileMenu.click()
    await expect(sidebar).toHaveAttribute('aria-modal', 'true')
    await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toBeVisible()
    await expect(row.getByTestId('code-agent-row-more')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`compact-767-${appearance}.png`), animations: 'disabled' })

    await page.setViewportSize({ width: 900, height: 800 })
    await expect(mobileMenu).toBeHidden()
    await expect(sidebar).not.toHaveAttribute('aria-modal', 'true')
    await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toBeHidden()
    await expect(sidebar).not.toHaveClass(/collapsed/)
    await row.click()
    await expect(page.getByTestId('code-composer-input')).toHaveValue('Keep this draft while resizing')
    await page.setViewportSize({ width: 844, height: 800 })
    await page.reload()
    await expect(mobileMenu).toBeHidden()
    await expect(sidebar).toHaveClass(/collapsed/)
    await page.getByTestId('code-sidebar-toggle').click()
    await expect(row).toBeVisible()
    await expect(sidebar).not.toHaveAttribute('aria-modal', 'true')
  })
}

test.describe('touch layout', () => {
  test.use({ hasTouch: true, isMobile: true })
  test('preserves compact navigation for a landscape phone', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await openFarming(page)
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await page.getByTestId('code-mobile-menu').click()
    await expect(page.getByTestId('code-sidebar')).toHaveAttribute('aria-modal', 'true')
    const session = await page.context().newCDPSession(page)
    try {
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await expect(page.locator('body')).not.toHaveClass(/code-compact-layout/)
      await expect(page.getByTestId('code-sidebar')).not.toHaveAttribute('aria-modal', 'true')
      await expect(page.getByTestId('code-mobile-menu')).toBeHidden()
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: true })
      await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
      await expect(page.getByTestId('code-mobile-menu')).toBeVisible()
    } finally {
      await session.detach()
    }
    await page.setViewportSize({ width: 981, height: 800 })
    await expect(page.getByTestId('code-mobile-menu')).toBeHidden()
    await expect(page.getByTestId('code-sidebar')).not.toHaveAttribute('aria-modal', 'true')
  })
})

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`pins the desktop Agent rail across compact widths in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await page.setViewportSize({ width: 1000, height: 800 })
    await openFarming(page)
    const sidebar = page.getByTestId('code-sidebar')
    const pin = page.getByTestId('code-sidebar-pin-toggle')
    const workspace = page.getByTestId('code-workspace')
    const projectDir = path.join(workspaceRoot, 'pinned-navigation')
    fs.mkdirSync(projectDir, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace: projectDir },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await page.getByTestId('code-composer-input').fill('Preserve this draft while pinned')
    await expect(pin).toHaveAttribute('aria-pressed', 'false')
    await pin.click()
    await expect(pin).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)

    for (const width of [844, 767, 600, 393]) {
      await page.setViewportSize({ width, height: 800 })
      await expect(sidebar).toHaveClass(/collapsed/)
      await expect(pin).toBeVisible()
      await expect(sidebar).not.toHaveAttribute('aria-hidden', 'true')
      await expect(sidebar).not.toHaveAttribute('inert')
      const rail = page.locator(`[data-testid="code-agent-rail-item"][data-agent-id="${agentId}"]`)
      await expect(rail).toBeVisible()
      await rail.click()
      await expect(rail).toHaveClass(/active/)
      await expect(page.getByTestId('code-composer-input')).toHaveValue('Preserve this draft while pinned')
      await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toBeHidden()
      await expect.poll(async () => sidebar.evaluate(element => {
        const sidebarBounds = element.getBoundingClientRect()
        const mainBounds = document.querySelector('.code-main')!.getBoundingClientRect()
        return sidebarBounds.x >= 0 && sidebarBounds.width <= 60 && mainBounds.x >= sidebarBounds.right
          && mainBounds.right <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth
      })).toBe(true)
      await expect.poll(async () => page.getByTestId('code-composer-send').evaluate(element => {
        const send = element.getBoundingClientRect()
        const composer = element.closest('.code-composer')!.getBoundingClientRect()
        const main = element.closest('.code-main')!.getBoundingClientRect()
        return composer.left >= main.left && composer.right <= main.right + 1
          && send.left >= composer.left && send.right <= composer.right + 1
      })).toBe(true)
      if (width <= 767) {
        await expect.poll(async () => page.getByTestId('code-mobile-topbar').evaluate(element => {
          const topbar = element.getBoundingClientRect()
          const main = document.querySelector('.code-main')!.getBoundingClientRect()
          return Math.abs(topbar.left - main.left) <= 1 && Math.abs(topbar.right - main.right) <= 1
        })).toBe(true)
      }
      if (width === 600) {
        await page.screenshot({ path: testInfo.outputPath(`pinned-rail-${appearance}.png`), animations: 'disabled' })
      }
    }
    await expect(workspace).toHaveClass(/pinned-sidebar-rail/)
    await page.getByTestId('code-sidebar-toggle').click()
    await expect(sidebar).toHaveAttribute('aria-modal', 'true')
    await expect(workspace).not.toHaveClass(/pinned-sidebar-rail/)
    await page.keyboard.press('Escape')
    await expect(workspace).toHaveClass(/pinned-sidebar-rail/)
    await expect(sidebar).not.toHaveAttribute('aria-modal', 'true')

    await page.reload()
    await expect(pin).toHaveAttribute('aria-pressed', 'true')
    await expect(workspace).toHaveClass(/pinned-sidebar-rail/)
    await pin.focus()
    await page.keyboard.press('Enter')
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await expect(page.getByTestId('code-mobile-menu')).toBeFocused()
    await page.setViewportSize({ width: 1000, height: 800 })
    await expect(pin).toHaveAttribute('aria-pressed', 'false')
    await expect(sidebar).not.toHaveClass(/collapsed/)
    await page.reload()
    await expect(pin).toHaveAttribute('aria-pressed', 'false')
  })
}

test('suspends a saved desktop pin for a coarse primary pointer', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 800 })
  await openFarming(page)
  const pin = page.getByTestId('code-sidebar-pin-toggle')
  await pin.click()
  await page.setViewportSize({ width: 600, height: 800 })
  const workspace = page.getByTestId('code-workspace')
  await expect(workspace).toHaveClass(/pinned-sidebar-rail/)
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true })
    await expect(pin).toHaveCount(0)
    await expect(workspace).not.toHaveClass(/pinned-sidebar-rail/)
    await expect(page.getByTestId('code-sidebar')).toHaveAttribute('aria-hidden', 'true')
    await page.getByTestId('code-mobile-menu').click()
    await expect(page.getByTestId('code-sidebar')).toHaveAttribute('aria-modal', 'true')
    await page.keyboard.press('Escape')
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await expect(pin).toHaveAttribute('aria-pressed', 'true')
    await expect(workspace).toHaveClass(/pinned-sidebar-rail/)
  } finally {
    await session.detach()
  }
})
