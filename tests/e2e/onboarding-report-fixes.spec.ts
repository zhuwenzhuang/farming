import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, openNewAgentDialog, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`onboarding retains sign-in and explains invalid input and inventory failure in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await page.request.post('/farming/api/settings', { data: { appearance } })
    await openFarming(page)
    await openNewAgentDialog(page)
    await page.getByTestId('agent-option-bash').click()
    const input = page.getByTestId('workspace-input')
    await input.fill('   ')
    await page.getByTestId('workspace-start').click()
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(input).toBeFocused()
    await expect(page.getByRole('alert')).toContainText('Enter a workspace path')
    await testInfo.attach(`workspace-validation-${appearance}`, { body: await page.getByTestId('input-dialog').screenshot(), contentType: 'image/png' })
    await input.fill(workspaceRoot)
    await expect(input).not.toHaveAttribute('aria-invalid', 'true')
    await page.getByTestId('input-dialog-close').click()

    const workspace = path.join(workspaceRoot, `acp-login-required-${appearance}`)
    fs.mkdirSync(workspace, { recursive: true })
    const created = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
    expect(created.ok(), await created.text()).toBe(true)
    const { agentId } = await created.json() as { agentId: string }
    await page.reload()
    await page.locator(`[data-agent-id="${agentId}"]`).first().click()
    const auth = page.getByTestId('code-acp-authentication')
    await expect(auth).toBeVisible()
    await testInfo.attach(`first-login-${appearance}`, { body: await auth.screenshot(), contentType: 'image/png' })
    await auth.locator('.code-acp-authentication-method').filter({ hasText: 'Sign in to fake Agent' }).getByRole('button', { name: 'Authenticate' }).click()
    await expect(auth).toHaveCount(0)
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/acp-session?includeEntries=0`)
      return (await response.json()).session?.state
    }).toBe('idle')

    await page.route('**/api/agent-extensions', route => route.fulfill({ status: 503, json: { error: 'Home inventory is temporarily unavailable' } }))
    await page.getByTestId('code-nav-plugins').click()
    await page.getByTestId('code-plugin-tab-homes').click()
    const error = page.locator('.code-plugin-error').first()
    await expect(error).toBeVisible()
    await expect(error).toHaveCSS('border-radius', '10px')
    await expect(error).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await testInfo.attach(`inventory-error-${appearance}`, { body: await page.getByTestId('code-plugins-panel').screenshot({ mask: [page.locator('.code-plugin-agent-section')] }), contentType: 'image/png' })
    await page.unroute('**/api/agent-extensions')
    await page.getByTestId('code-plugins-panel').getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.locator('.code-plugin-error')).toHaveCount(0)
  })
}
