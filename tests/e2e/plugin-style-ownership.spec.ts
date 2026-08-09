import { expect, openFarming, test } from './fixtures'

test('Plugin style owners preserve the light, dark, and narrow runtime cascade', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()

  const panel = page.getByTestId('code-plugins-panel')
  const pluginView = page.locator('.code-plugins-view')
  const tabs = panel.locator('.code-plugin-tabs')
  const selectedTab = tabs.locator('[aria-selected="true"]')
  const firstCard = panel.locator('.code-plugin-card').first()

  await expect(panel).toBeVisible()
  await expect(pluginView).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(tabs).toHaveCSS('background-color', 'rgb(243, 244, 241)')
  await expect(selectedTab).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(firstCard).toHaveCSS('background-color', 'rgb(255, 255, 255)')

  await page.locator('body').evaluate(body => { body.dataset.appearance = 'dark' })
  await expect(tabs).toHaveCSS('background-color', 'rgb(28, 28, 28)')
  await expect(selectedTab).toHaveCSS('background-color', 'rgb(24, 24, 24)')
  await expect(firstCard).toHaveCSS('background-color', 'rgb(28, 28, 28)')

  await panel.getByTestId('code-plugin-tab-homes').click()
  await panel.getByRole('button', { name: 'Add Agent', exact: true }).click()
  const form = panel.getByTestId('code-plugin-agent-form')
  await expect(form).toBeVisible()
  await expect.poll(() => form.evaluate(element => (
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length
  ))).toBeGreaterThan(1)

  await page.setViewportSize({ width: 680, height: 900 })
  await expect.poll(() => form.evaluate(element => (
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length
  ))).toBe(1)
})
