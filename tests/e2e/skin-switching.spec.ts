import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

test('switches from Farming Code to the same Agent in Farming CRT', async ({ page, workspaceRoot }) => {
  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  await page.getByTestId('code-sidebar-options').click()

  const settings = page.getByTestId('code-settings-panel')
  await expect(settings).toBeVisible()
  await expect(settings.getByTestId('code-settings-skin-code')).toHaveClass(/active/)
  await expect(settings.getByTestId('code-settings-skin-crt')).toBeVisible()

  await settings.getByTestId('code-settings-skin-crt').click()
  await expect(page).toHaveURL(new RegExp(`/farming/crt/\\?agent=${agentId}$`))
  await expect(page.locator('body')).toHaveAttribute('id', 'farming-crt')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)

  await expect(page.getByRole('button', { name: 'Close session, Ctrl+Escape', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await page.keyboard.press('Control+Escape')
  await expect(page.locator('#session-modal')).not.toHaveClass(/active/)
  await page.getByRole('button', { name: '[S] SETTINGS', exact: true }).click()
  await expect(page.getByText('Farming CRT', { exact: true })).toBeVisible()
  await expect(page.getByText('Terminal', { exact: true })).toHaveCount(0)
})
