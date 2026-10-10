import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`first-run optional capabilities and retry feedback stay readable in ${appearance}`, async ({ page }, testInfo) => {
    await page.route('**/api/browsers/capability', route => route.fulfill({ json: {
      enabled: true, available: false, browser: null, sources: [],
      extension: { installed: false, connected: false, integrity: 'missing' },
      isolated: { available: false, dockerAvailable: true, imageReady: false, error: '' },
    } }))
    await page.route('**/api/browsers/extension', route => route.fulfill({ json: {
      installed: false, connected: false, integrity: 'missing',
    } }))
    let changing = true
    await page.route('**/api/agent-extensions', route => changing
      ? route.fulfill({ status: 409, json: {
        code: 'INVENTORY_CHANGED_DURING_READ',
        error: 'Agent Home configuration changed while loading. Refresh to try again.',
      } }) : route.continue())
    await openFarming(page)
    const updated = await page.request.post('/farming/api/settings', { data: { appearance, language: 'en' } })
    expect(updated.ok()).toBeTruthy()
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
    await page.getByTestId('code-nav-plugins').click()
    const panel = page.getByTestId('code-plugins-panel')
    const browser = panel.getByTestId('code-plugin-browser')
    const isolated = browser.locator('.code-plugin-browser-source').filter({ hasText: 'Browser in Docker' })
    await expect(isolated).toContainText('Not installed')
    await expect(isolated.getByRole('button', { name: 'Install (about 2 GB)' })).toBeVisible()
    await expect(browser.getByRole('alert')).toHaveCount(0)
    await expect(browser).not.toContainText(/Command failed|sha256:|image inspect/)
    await browser.screenshot({ path: testInfo.outputPath(`optional-browser-${appearance}.png`) })

    await panel.getByTestId('code-plugin-tab-homes').click()
    const warning = panel.getByRole('alert')
    await expect(warning).toHaveText('Agent Home configuration changed while loading. Refresh to try again.')
    await expect(panel).not.toContainText(/"version":3|reconciling|homePath/)
    await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    await panel.screenshot({ path: testInfo.outputPath(`inventory-retry-${appearance}.png`) })
    const chinese = await page.request.post('/farming/api/settings', { data: { language: 'zh' } })
    expect(chinese.ok()).toBeTruthy()
    await page.reload()
    await page.getByTestId('code-nav-plugins').click()
    await panel.getByTestId('code-plugin-tab-homes').click()
    await expect(panel.getByRole('alert')).toHaveText('Agent Home 配置在读取期间发生变化，请刷新重试。')
    changing = false
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel.locator('.code-plugin-agent-section').first()).toBeVisible()
  })
}
