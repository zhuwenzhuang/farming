import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  terminalRows,
  test,
} from './fixtures'

async function visibleTerminalText(page: Page, agentId: string) {
  return (await terminalRows(page, agentId, 40)).join('\n')
}

test('Shared configuration validates once, applies to new Agents, and reports stale files', async ({ page, workspaceRoot }, testInfo) => {
  test.setTimeout(90_000)
  const envFile = path.join(workspaceRoot, 'shared-agent.env')
  fs.writeFileSync(envFile, 'SHARED_E2E_SENTINEL=shared-e2e-ready\n', { mode: 0o600 })

  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  const card = panel.getByTestId('code-plugin-shared-config')
  await expect(card).toBeVisible()
  await expect(panel.getByTestId('code-plugin-tab-farming').locator('small')).toHaveText('4')
  await expect(card).toContainText('Shared configuration')
  await card.getByTestId('code-plugin-shared-config-configure').click()
  await card.getByTestId('code-plugin-shared-config-enabled').check()
  await card.getByTestId('code-plugin-shared-config-instructions').fill(
    'Include SHARED_E2E_PROMPT in the operating context.',
  )
  await card.getByTestId('code-plugin-shared-config-path').fill(envFile)
  const saveResponse = page.waitForResponse(response => (
    response.url().endsWith('/farming/api/extensions/shared-config')
    && response.request().method() === 'PUT'
  ))
  await card.getByTestId('code-plugin-shared-config-save').click()
  expect((await saveResponse).status()).toBe(200)
  await expect(card).toContainText('1 environment variable')
  await expect(card).toContainText('Enabled')
  await expect(card.getByTestId('code-plugin-shared-config-instructions')).toHaveCount(0)

  const stateResponse = await page.request.get('/farming/api/extensions/shared-config')
  expect(stateResponse.ok()).toBeTruthy()
  const stateText = await stateResponse.text()
  expect(stateText).not.toContain('shared-e2e-ready')
  expect(stateText).toContain('SHARED_E2E_SENTINEL')

  await card.getByTestId('code-plugin-shared-config-configure').click()
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    await expect(card).toBeVisible()
    await expect(card).toHaveCSS('border-radius', '12px')
    await expect(card.getByTestId('code-plugin-shared-config-instructions')).toBeVisible()
    await card.screenshot({ path: testInfo.outputPath(`shared-config-${appearance}.png`) })
  }
  await card.getByRole('button', { name: 'Cancel', exact: true }).click()

  fs.writeFileSync(envFile, [
    'export SHARED_E2E_SENTINEL=shared-e2e-ready',
    'export LD_LIBRARY_PATH=/must-not-reach-agent',
  ].join('\n'), { mode: 0o600 })
  const shellSave = await page.request.put('/farming/api/extensions/shared-config', {
    data: {
      expectedRevision: 1,
      enabled: true,
      instructions: 'Include SHARED_E2E_PROMPT in the operating context.',
      environment: { format: 'shell', path: envFile },
    },
  })
  expect(shellSave.ok()).toBeTruthy()
  await page.getByTestId('code-nav-search').click()
  await page.getByTestId('code-nav-plugins').click()
  await expect(card.getByTestId('code-plugin-shared-config-ignored'))
    .toHaveText('1 protected variable ignored: LD_LIBRARY_PATH')

  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  await expect.poll(() => visibleTerminalText(page, agentId), { timeout: 15_000 }).toContain('$')
  const input = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
    data: { input: [
      "printf '__SHARED_E2E_VALUE__%s__END__\\n' \"$SHARED_E2E_SENTINEL\"",
      "printf '__SHARED_E2E_PROTECTED__%s__END__\\n' \"$LD_LIBRARY_PATH\"",
      '',
    ].join(';') + '\r' },
  })
  expect(input.ok()).toBeTruthy()
  await expect.poll(() => visibleTerminalText(page, agentId), { timeout: 15_000 })
    .toContain('__SHARED_E2E_VALUE__shared-e2e-ready__END__')
  await expect.poll(() => visibleTerminalText(page, agentId), { timeout: 15_000 })
    .toContain('__SHARED_E2E_PROTECTED__')
  expect(await visibleTerminalText(page, agentId)).not.toContain('must-not-reach-agent')

  fs.writeFileSync(envFile, 'SHARED_E2E_SENTINEL=changed-without-validation\n', { mode: 0o600 })
  await page.getByTestId('code-nav-plugins').click()
  await page.getByTestId('code-nav-search').click()
  await page.getByTestId('code-nav-plugins').click()
  await expect(card).toContainText('Environment file changed; validate and save it again')

  const staleState = await page.request.get('/farming/api/extensions/shared-config')
  expect((await staleState.json() as { status: string }).status).toBe('stale')
})
