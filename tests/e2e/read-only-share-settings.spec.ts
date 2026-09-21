import { expect, openFarming, test } from './fixtures'

test('read-only share slider persists its range and matches Settings in every appearance', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const slider = page.getByTestId('code-settings-read-only-share-duration')
  await expect(slider).toHaveValue('24')
  await slider.focus()
  await slider.press('End')
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    return (await response.json()).settings.readOnlyShareHours
  }).toBe(168)
  await expect(slider).toBeEnabled()
  await page.reload()
  await page.getByTestId('code-sidebar-options').click()
  await expect(slider).toHaveValue('168')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.setAttribute('data-appearance', value)
      document.body.setAttribute('data-appearance', value)
    }, appearance)
    await slider.scrollIntoViewIfNeeded()
    await slider.locator('xpath=ancestor::section').screenshot({
      path: test.info().outputPath(`share-duration-${appearance}.png`),
    })
  }
  await slider.press('Home')
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    return (await response.json()).settings.readOnlyShareHours
  }).toBe(1)
  for (const value of [0, 169, 1.5, '24', null]) {
    const response = await page.request.post('/farming/api/settings', { data: { readOnlyShareHours: value } })
    expect(response.status()).toBe(400)
  }
})
