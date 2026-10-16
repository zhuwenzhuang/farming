import { expect, openFarming, openNewAgentDialog, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`creation retry reconciles a lost response without another Agent in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await page.request.post('/farming/api/settings', { data: { appearance } })
    await openFarming(page)
    const requestIds: string[] = []
    const agentIds: string[] = []
    await page.route('**/api/control/agents', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      requestIds.push(route.request().postDataJSON().requestId)
      if (requestIds.length === 2) return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } })
      const response = await route.fetch()
      expect(response.ok(), await response.text()).toBe(true)
      agentIds.push((await response.json()).agentId)
      // The server committed the creation, but the browser never got its receipt.
      if (requestIds.length === 1) return route.abort('failed')
      return route.fulfill({ response })
    })
    await openNewAgentDialog(page)
    const dialog = page.getByTestId('input-dialog')
    await dialog.getByTestId('agent-option-bash').click()
    await dialog.getByTestId('workspace-input').fill(workspaceRoot)
    await dialog.getByTestId('workspace-start').click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(dialog.getByTestId('workspace-start')).toBeEnabled()
    await testInfo.attach(`uncertain-create-${appearance}`, {
      body: await dialog.screenshot({ mask: [
        dialog.getByTestId('workspace-input'), dialog.getByTestId('workspace-history'),
        dialog.locator('.workspace-path-suggestions'),
      ] }), contentType: 'image/png',
    })
    await dialog.getByTestId('input-dialog-close').click()
    await openNewAgentDialog(page)
    await dialog.getByTestId('agent-option-bash').click()
    await dialog.getByTestId('workspace-input').fill(workspaceRoot)
    await dialog.getByTestId('workspace-start').click()
    await expect(dialog.getByRole('alert')).toContainText('Temporarily unavailable')
    await dialog.getByTestId('workspace-start').click()
    await expect(dialog).toBeHidden()
    expect(requestIds).toHaveLength(3)
    expect(requestIds[1]).toBe(requestIds[0])
    expect(requestIds[2]).toBe(requestIds[0])
    expect(agentIds[1]).toBe(agentIds[0])
    const inventory = await (await page.request.get('/farming/api/control/agents')).json()
    expect(inventory.agents.filter((agent: { command: string; cwd: string }) =>
      agent.command === 'bash' && agent.cwd === workspaceRoot)).toHaveLength(1)
  })
}
