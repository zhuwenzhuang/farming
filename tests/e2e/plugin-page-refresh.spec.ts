import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`Plugins keeps current Home and extension inventory after page refresh in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    expect((await page.request.post('/farming/api/settings', { data: { appearance } })).ok()).toBe(true)
    await openFarming(page)
    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
    await expect(page.getByTestId('code-project-group').first()).toBeVisible()
    await page.getByTestId('code-nav-plugins').click()
    const panel = page.getByTestId('code-plugins-panel')
    await panel.getByTestId('code-plugin-tab-homes').click()
    const add = panel.getByRole('button', { name: 'Add Agent', exact: true })
    await expect(add).toBeEnabled()
    await expect(panel.getByTestId('code-plugin-section-agent-codex-default')).toBeVisible()
    for (let index = 0; index < 2; index++) {
      const settings = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'GET')
      const extensions = page.waitForResponse(response => response.url().endsWith('/api/agent-extensions'))
      await page.reload()
      expect((await settings).ok()).toBe(true)
      expect((await extensions).ok()).toBe(true)
      await page.getByTestId('code-nav-plugins').click()
      await panel.getByTestId('code-plugin-tab-homes').click()
      await expect(add).toBeEnabled()
      await expect(panel.getByTestId('code-plugin-section-agent-codex-default')).toBeVisible()
      await expect(panel.getByTestId('code-plugin-tab-homes').locator('small')).not.toHaveText('!')
      await expect(panel.getByTestId('code-plugin-tab-extensions').locator('small')).not.toHaveText('!')
      await expect(panel.locator('.code-plugin-error')).toHaveCount(0)
    }
    await testInfo.attach(`plugins-after-refresh-${appearance}`, { body: await page.screenshot({ mask: [panel.locator('.code-plugin-agent-section')] }), contentType: 'image/png' })
  })
}
