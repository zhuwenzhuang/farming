import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const provider of ['codex', 'claude'] as const) {
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    test(`withdraws only the cancelled ACP requests (${provider}, ${appearance})`, async ({ page, workspaceRoot }, testInfo) => {
      const workspace = path.join(workspaceRoot, 'service-demo')
      fs.mkdirSync(workspace, { recursive: true })
      const response = await page.request.post('/farming/api/control/agents', {
        data: { command: provider, workspace, agentRuntimeMode: 'chat' },
      })
      expect(response.ok()).toBeTruthy()
      const { agentId } = await response.json() as { agentId: string }
      await openFarming(page)
      const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
      await row.click()
      await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
      await page.getByTestId('code-acp-composer-input').fill('request cancellation fixture')
      await page.getByTestId('code-acp-composer-send').click()
      const cards = page.getByTestId('code-acp-elicitation')
      await expect(cards).toHaveCount(3)
      const withdrawn = cards.filter({ hasText: 'Withdrawn question' })
      const retained = cards.filter({ hasText: 'Retained question' })
      await expect(withdrawn).toBeVisible()
      await expect(page.getByText('Withdrawn permission', { exact: true }).first()).toBeVisible()
      await cards.filter({ hasText: 'Ready to withdraw' }).getByRole('button', { name: 'Submit', exact: true }).click()
      await expect(withdrawn).toHaveCount(0)
      await expect(page.getByText('Withdrawn permission', { exact: true })).toHaveCount(0)
      await expect(cards).toHaveCount(1)
      await expect(retained).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'interrupt')
      await page.reload()
      await row.click()
      await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
      await expect(cards).toHaveCount(1)
      await expect(retained).toBeVisible()
      const plan = page.getByTestId('code-agent-transcript-plan-driver')
      await expect(plan).toContainText('Verify request isolation')
      const screenshot = testInfo.outputPath(`request-cancellation-${provider}-${appearance}.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`${provider} ${appearance}`, { path: screenshot, contentType: 'image/png' })
      await retained.getByRole('button', { name: 'Submit', exact: true }).click()
      await expect(cards).toHaveCount(0)
      await expect(page.locator('.code-agent-transcript-assistant').last()).toContainText('Request cancellation verified.')
      await expect(plan).toHaveCount(0)
    })
  }
}
