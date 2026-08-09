import { expect, openFarming, test } from './fixtures'

test('Settings restores focus to its trigger after Escape', async ({ page }) => {
  await openFarming(page)

  const settingsTrigger = page.getByTestId('code-sidebar-options')
  await settingsTrigger.focus()
  await page.keyboard.press('Enter')

  const settings = page.getByTestId('code-settings-panel')
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('button', { name: 'Close' })).toBeFocused()

  await page.keyboard.press('Escape')

  await expect(settings).toBeHidden()
  await expect(settingsTrigger).toBeFocused()
})

test('Settings keeps its light, dark, and narrow surface contract after stylesheet extraction', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openFarming(page)
  await page.evaluate(() => document.body.setAttribute('data-appearance', 'light'))
  await page.getByTestId('code-sidebar-options').click()

  const overlay = page.getByTestId('code-settings-panel')
  const panel = overlay.locator('.code-settings-panel')
  await expect(panel).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(panel).toHaveCSS('width', '460px')

  await page.evaluate(() => document.body.setAttribute('data-appearance', 'dark'))
  await expect(panel).toHaveCSS('background-color', 'rgb(23, 26, 31)')
  await expect(panel).toHaveCSS('color', 'rgb(216, 222, 233)')

  await page.setViewportSize({ width: 390, height: 800 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await expect(panel).toHaveCSS('border-top-right-radius', '18px')
  await expect(panel).toHaveCSS('background-color', 'rgba(13, 17, 23, 0.97)')
  await expect.poll(async () => panel.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return rect.left === 0 && rect.width < window.innerWidth
  })).toBe(true)
})
