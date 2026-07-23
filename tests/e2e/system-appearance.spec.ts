import {
  expect,
  openFarming,
  test,
} from './fixtures'

test('follows the browser color scheme when System appearance is selected', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.request.post('/farming/api/settings', {
    data: { appearance: 'light' },
  })

  await openFarming(page)
  await expect(page.locator('body')).toHaveAttribute('data-appearance', 'light')

  await page.getByTestId('code-sidebar-options').click()
  const settingsPanel = page.getByTestId('code-settings-panel')
  await expect(settingsPanel).toBeVisible()
  await settingsPanel
    .getByRole('group', { name: 'Appearance' })
    .getByRole('button', { name: 'System', exact: true })
    .click()

  await expect(page.locator('body')).toHaveAttribute('data-appearance-preference', 'system')
  await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    const body = await response.json() as { settings?: { appearance?: string } }
    return body.settings?.appearance
  }).toBe('system')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('body')).toHaveAttribute('data-appearance', 'light')

  await expect(
    settingsPanel.getByRole('group', { name: 'Appearance' }).getByRole('button', { name: 'System', exact: true }),
  ).toHaveClass(/active/)
})
