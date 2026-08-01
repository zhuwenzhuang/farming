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
