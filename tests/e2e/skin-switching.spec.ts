import { expect, openFarming, test } from './fixtures'

test('switches from Farming Code to Farming CRT in Settings', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()

  const settings = page.getByTestId('code-settings-panel')
  await expect(settings).toBeVisible()
  await expect(settings.getByTestId('code-settings-skin-code')).toHaveClass(/active/)
  await expect(settings.getByTestId('code-settings-skin-crt')).toBeVisible()

  await settings.getByTestId('code-settings-skin-crt').click()
  await expect(page).toHaveURL(/\/farming\/crt\/$/)
  await expect(page.locator('body')).toHaveAttribute('id', 'farming-crt')

  await page.getByRole('button', { name: '[S] Settings', exact: true }).click()
  await expect(page.getByText('Farming CRT', { exact: true })).toBeVisible()
  await expect(page.getByText('Terminal', { exact: true })).toHaveCount(0)
})
