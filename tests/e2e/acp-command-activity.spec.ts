import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createChatAgent(page: Page, command: 'claude' | 'codex', workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

function agentRow(page: Page, agentId: string) {
  return page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
}

async function sendMessage(page: Page, text: string) {
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill(text)
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
}

test('shows truthful command activity through output, silence, reload, completion, failure, and cancel', async ({
  page,
  workspaceRoot,
}) => {
  test.setTimeout(90_000)
  const claudeWorkspace = path.join(workspaceRoot, 'acp-command-activity-claude')
  const codexWorkspace = path.join(workspaceRoot, 'acp-command-activity-codex')
  fs.mkdirSync(claudeWorkspace, { recursive: true })
  fs.mkdirSync(codexWorkspace, { recursive: true })
  const claudeAgentId = await createChatAgent(page, 'claude', claudeWorkspace)
  const codexAgentId = await createChatAgent(page, 'codex', codexWorkspace)

  await openFarming(page)
  await agentRow(page, claudeAgentId).click()
  await sendMessage(page, 'streaming command activity')
  const streamingActivity = page.getByTestId('code-agent-transcript-live-activity')
  await expect(streamingActivity).toContainText('Running: Run streaming command · Activity just now', {
    timeout: 15_000,
  })
  await expect(page.getByText('Streaming command completed.', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(streamingActivity).toHaveCount(0)

  await agentRow(page, codexAgentId).click()
  await sendMessage(page, 'long terminal')
  const silentTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'long terminal' }).last()
  const silentActivity = silentTurn.getByTestId('code-agent-transcript-live-activity')
  await expect(silentActivity).toContainText('Running: Run long command · Activity just now', { timeout: 15_000 })
  await expect(silentActivity).toContainText(/Activity 1\d+s ago/, { timeout: 25_000 })
  await expect(silentTurn.getByTestId('code-agent-transcript-process-summary')).toContainText(/Working for 1\d+s/)
  await expect(silentActivity.locator('button')).toHaveCount(0)
  expect((await silentActivity.boundingBox())?.height || 0).toBeLessThanOrEqual(24)

  const screenshotPath = path.resolve(
    process.env.FARMING_ACP_COMMAND_SCREENSHOT_PATH
      || '.tmp/acp-command-activity/long-command-activity.png',
  )
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
  await silentTurn.scrollIntoViewIfNeeded()
  await page.screenshot({ path: screenshotPath })

  await page.reload()
  await agentRow(page, codexAgentId).click()
  const recoveredTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'long terminal' }).last()
  const recoveredActivity = recoveredTurn.getByTestId('code-agent-transcript-live-activity')
  await expect(recoveredActivity).toContainText(/Running: Run long command · Activity (1\d|[2-9]\d)s ago/, {
    timeout: 20_000,
  })

  const processSummary = recoveredTurn.getByTestId('code-agent-transcript-process-summary')
  await processSummary.click()
  await recoveredTurn.getByTestId('code-agent-transcript-process-group-toggle').click()
  const longItem = recoveredTurn.getByTestId('code-agent-transcript-process-item')
    .filter({ hasText: 'Run long command' })
  await longItem.getByTestId('code-agent-transcript-process-item-toggle').click()
  await longItem.getByTestId('code-acp-terminal-stop').click()
  await expect(page.getByText('Long command stopped.', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(recoveredActivity).toHaveCount(0)

  await sendMessage(page, 'failing terminal')
  const failingTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'failing terminal' }).last()
  await expect(failingTurn.getByTestId('code-agent-transcript-live-activity')).toContainText(
    'Running: Run failing command · Activity just now',
    { timeout: 15_000 },
  )
  await expect(page.getByText('Failing terminal finished.', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(failingTurn.getByTestId('code-agent-transcript-live-activity')).toHaveCount(0)
})
