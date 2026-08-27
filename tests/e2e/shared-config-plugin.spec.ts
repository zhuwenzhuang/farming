import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { selectCodeOption } from './code-select'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  terminalRows,
  test,
} from './fixtures'

async function visibleTerminalText(page: Page, agentId: string) {
  return (await terminalRows(page, agentId, 60)).join('\n')
}

async function agentOutput(page: Page, agentId: string) {
  const response = await page.request.get(`/farming/api/control/agents/${agentId}/output?tail=6000`)
  expect(response.ok()).toBeTruthy()
  return response.text()
}

async function captureStory(card: Locator, testInfo: TestInfo, name: string) {
  await expect(card).toBeVisible()
  await card.screenshot({ path: testInfo.outputPath(name), animations: 'disabled' })
}

async function expectAgentVariable(
  page: Page,
  agentId: string,
  marker: string,
  expected: string,
) {
  const input = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
    data: { input: `printf '__${marker}__%s__END__\\n' \"$SHARED_E2E_SENTINEL\"\r` },
  })
  expect(input.ok()).toBeTruthy()
  await expect.poll(() => agentOutput(page, agentId), { timeout: 15_000 })
    .toContain(`__${marker}__${expected}__END__`)
}

test('Shared configuration follows an editable-file user story', async ({ page, workspaceRoot }, testInfo) => {
  test.setTimeout(120_000)
  const envFile = path.join(workspaceRoot, 'shared-agent.sh')
  fs.writeFileSync(envFile, [
    'export SHARED_E2E_SENTINEL=first-version',
    'export LD_LIBRARY_PATH=/must-not-reach-agent',
  ].join('\n'), { mode: 0o664 })

  await openFarming(page)
  await page.locator('body').evaluate(body => { body.dataset.appearance = 'light' })
  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  const card = panel.getByTestId('code-plugin-shared-config')
  await expect(card).toBeVisible()
  await expect(panel.getByTestId('code-plugin-tab-farming').locator('small')).toHaveText('4')
  await expect(card).toContainText('Disabled')
  await captureStory(card, testInfo, '01-disabled.png')

  await card.getByTestId('code-plugin-shared-config-configure').click()
  await card.getByTestId('code-plugin-shared-config-enabled').check()
  await card.getByTestId('code-plugin-shared-config-instructions').fill(
    'Include SHARED_E2E_PROMPT in the operating context.',
  )
  await selectCodeOption(card.getByTestId('code-plugin-shared-config-format'), 'shell')
  await card.getByTestId('code-plugin-shared-config-path').fill('~/zzbashrc')
  await expect(card).toContainText('File edits apply automatically')
  await captureStory(card, testInfo, '02-configure-zzbashrc-light.png')
  for (const appearance of ['dark', 'paper'] as const) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    await captureStory(card, testInfo, `02-configure-zzbashrc-${appearance}.png`)
  }
  await page.locator('body').evaluate(body => { body.dataset.appearance = 'light' })

  await card.getByTestId('code-plugin-shared-config-path').fill(envFile)
  const saveResponse = page.waitForResponse(response => (
    response.url().endsWith('/farming/api/extensions/shared-config')
    && response.request().method() === 'PUT'
  ))
  await card.getByTestId('code-plugin-shared-config-save').click()
  expect((await saveResponse).status()).toBe(200)
  await expect(card).toContainText('1 environment variable')
  await expect(card).toContainText('Enabled')
  await expect(card.getByTestId('code-plugin-shared-config-live-file'))
    .toHaveText('The latest file contents are read whenever an Agent starts.')
  await expect(card.getByTestId('code-plugin-shared-config-ignored'))
    .toHaveText('1 protected variable ignored: LD_LIBRARY_PATH')
  await captureStory(card, testInfo, '03-enabled.png')

  const stateResponse = await page.request.get('/farming/api/extensions/shared-config')
  expect(stateResponse.ok()).toBeTruthy()
  const stateText = await stateResponse.text()
  expect(stateText).not.toContain('first-version')
  expect(stateText).not.toContain('must-not-reach-agent')
  expect(stateText).toContain('SHARED_E2E_SENTINEL')

  await openNewAgentDialog(page)
  const firstAgentId = await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  await expect.poll(() => visibleTerminalText(page, firstAgentId), { timeout: 15_000 }).toContain('$')
  await expectAgentVariable(page, firstAgentId, 'FIRST_AGENT', 'first-version')

  fs.writeFileSync(envFile, [
    'export SHARED_E2E_SENTINEL=second-version',
    'export SHARED_EXTRA=added-without-saving',
    'export LD_LIBRARY_PATH=/still-must-not-reach-agent',
  ].join('\n'))
  fs.chmodSync(envFile, 0o664)
  await page.getByTestId('code-nav-search').click()
  await page.getByTestId('code-nav-plugins').click()
  await expect(card).toContainText('Enabled')
  await expect(card).toContainText('2 environment variables')
  await expect(card).not.toContainText('validate and save')
  await captureStory(card, testInfo, '04-file-edited-automatically-ready.png')

  await expectAgentVariable(page, firstAgentId, 'FIRST_AGENT_AFTER_EDIT', 'first-version')
  await openNewAgentDialog(page)
  const secondAgentId = await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  await expect.poll(() => visibleTerminalText(page, secondAgentId), { timeout: 15_000 }).toContain('$')
  await expectAgentVariable(page, secondAgentId, 'SECOND_AGENT', 'second-version')

  fs.rmSync(envFile)
  await page.getByTestId('code-nav-search').click()
  await page.getByTestId('code-nav-plugins').click()
  await expect(card).toContainText('Check failed')
  await expect(card.getByRole('alert')).toContainText('Environment file was not found')
  await captureStory(card, testInfo, '05-file-missing.png')
  const blocked = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: workspaceRoot },
  })
  expect(blocked.status()).toBe(400)

  fs.writeFileSync(envFile, 'export SHARED_E2E_SENTINEL=recovered-without-saving\n', { mode: 0o664 })
  await page.getByTestId('code-nav-search').click()
  await page.getByTestId('code-nav-plugins').click()
  await expect(card).toContainText('Enabled')
  await expect(card.getByRole('alert')).toHaveCount(0)
  await captureStory(card, testInfo, '06-file-fixed-automatically-ready.png')
  await openNewAgentDialog(page)
  const recoveredAgentId = await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  await expect.poll(() => visibleTerminalText(page, recoveredAgentId), { timeout: 15_000 }).toContain('$')
  await expectAgentVariable(page, recoveredAgentId, 'RECOVERED_AGENT', 'recovered-without-saving')
})
