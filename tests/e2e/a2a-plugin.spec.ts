import { expect, openFarming, test } from './fixtures'

test('external A2A is optional, configured in Plugins and reconciles uncertain writes', async ({ page, workspaceRoot }, testInfo) => {
  test.setTimeout(120000)
  // Plain HTTP deployments expose getRandomValues but not secure-context randomUUID.
  await page.addInitScript(() => Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined }))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', customTitle: 'Input reviewer', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  let grantId = ''
  try {
    await openFarming(page)
    await page.getByTestId('code-nav-plugins').click()
    const card = page.getByTestId('code-plugin-a2a')
    await expect(card).toContainText('Disabled')
    await card.getByRole('button', { name: 'Configure', exact: true }).click()
    const enabled = card.getByTestId('code-plugin-a2a-enabled')
    await enabled.click()
    await expect(enabled).toBeChecked()
    await expect(enabled).toBeEnabled()
    await card.getByRole('textbox', { name: 'External application name', exact: true }).fill('CI reviewer')
    await card.getByRole('button', { name: 'Create access credential', exact: true }).click()
    const credential = card.getByRole('textbox', { name: 'Credential', exact: true })
    await expect(credential).not.toHaveValue('')
    const token = await credential.inputValue()
    const endpoint = await card.getByRole('textbox', { name: 'A2A endpoint', exact: true }).inputValue()
    expect(endpoint).toContain('/agents/' + agentId)
    const list = await (await page.request.get('/farming/api/communication/grants')).json()
    grantId = list.grants.find((grant: { principal: { name: string } }) => grant.principal.name === 'CI reviewer').id
    const headers = { Authorization: 'Bearer ' + token, 'A2A-Version': '1.0' }
    const agentCard = await page.request.get(endpoint + '/.well-known/agent-card.json', { headers })
    expect(agentCard.ok()).toBeTruthy()
    expect((await agentCard.json()).supportedInterfaces[0].url).toBe(endpoint)
    const sent = await page.request.post(endpoint, { headers, data: {
      jsonrpc: '2.0', id: 'review', method: 'SendMessage', params: {
        message: { messageId: 'plugin-review', role: 'ROLE_USER', parts: [{ text: 'Please review the input validation and return your conclusion.' }] },
      },
    } })
    expect(sent.ok()).toBeTruthy()
    const result = await sent.json()
    expect(result.error).toBeUndefined()
    expect(JSON.stringify(result)).toContain('The input validation is consistent')
    await card.getByRole('button', { name: 'Credential saved', exact: true }).click()
    await expect(credential).toHaveCount(0)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const appearance of ['light', 'dark', 'paper']) {
        await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
        await expect(card.getByRole('button', { name: 'Revoke', exact: true })).toBeEnabled()
        const bounds = await card.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.width).toBeLessThanOrEqual(width)
        await card.screenshot({ path: testInfo.outputPath(`a2a-plugin-${width}-${appearance}.png`), animations: 'disabled' })
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    let writes = 0
    await page.route('**/api/extensions/a2a', async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return }
      writes++
      await route.fetch()
      await route.abort('failed')
    })
    await enabled.click()
    await expect(card.getByRole('alert')).toContainText('outcome is unconfirmed')
    await expect(enabled).toBeDisabled()
    expect(writes).toBe(1)
    await card.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(enabled).toBeEnabled()
    await expect(enabled).not.toBeChecked()
    expect(writes).toBe(1)
    await page.unroute('**/api/extensions/a2a')
    expect((await page.request.get(endpoint + '/.well-known/agent-card.json', { headers })).status()).toBe(403)
    await card.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(card).toContainText('No external grants yet.')
    await card.getByRole('button', { name: 'Collapse', exact: true }).click()
    await expect(card).toContainText('Disabled')
    await card.screenshot({ path: testInfo.outputPath('a2a-plugin-collapsed.png'), animations: 'disabled' })
  } finally {
    if (grantId) await page.request.delete('/farming/api/communication/grants/' + grantId)
    const state = await (await page.request.get('/farming/api/extensions/a2a')).json()
    await page.request.put('/farming/api/extensions/a2a', { data: { enabled: false, expectedRevision: state.revision } })
  }
})
