import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('native retry compaction and terminal output remain visible across appearances', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'opencode', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  try {
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await page.getByTestId('code-acp-composer-input').fill('native status integration')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(page.getByText('Native status integration complete.', { exact: true })).toBeVisible()
    const summary = page.getByTestId('code-agent-transcript-process-summary')
    await summary.click()
    await expect(page.getByTestId('code-acp-progress-update')).toContainText('Retrying request (attempt 1)')
    await page.getByTestId('code-agent-transcript-process-group-toggle').click()
    await page.getByText('Native command output', { exact: true }).click()
    await expect(page.getByText(/first line\s+second line\s+Exit code: 0/)).toBeVisible()
    await page.getByText('Context compacted', { exact: true }).click()
    await expect(page.getByText('Preserved context', { exact: true })).toBeVisible()
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        document.documentElement.dataset.appearance = value
      }, appearance)
      const capture = await page.screenshot({ path: testInfo.outputPath(`native-status-${appearance}.png`), animations: 'disabled' })
      expect([capture.readUInt32BE(16), capture.readUInt32BE(20)]).toEqual([1440, 900])
    }
  } finally {
    await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
  }
})

for (const provider of ['agy', 'qwen']) {
  test(`${provider} native steering keeps the active Turn across appearances and reload`, async ({ page, workspaceRoot }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const workspace = path.join(workspaceRoot, `acp-native-steer-${provider}`)
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: provider, workspace, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    try {
      await openFarming(page)
      const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
      await row.click()
      const input = page.getByTestId('code-acp-composer-input')
      const send = page.getByTestId('code-acp-composer-send')
      await input.fill('native steering hold')
      await send.click()
      await expect(page.getByText('Native turn running.', { exact: true })).toBeVisible()
      for (const change of ['first change', 'second change']) {
        await input.fill(change)
        await send.click()
        const steer = page.getByTestId('code-acp-pending-followup-steer')
        await expect(steer).toBeVisible()
        await steer.click()
        await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(0)
        await expect(page.getByTestId('code-agent-transcript-steer').filter({ hasText: change })).toHaveCount(1)
        await expect(send).toHaveAttribute('data-action', 'interrupt')
      }
      await expect(page.locator('.code-agent-transcript-turn > .code-agent-transcript-user')).toHaveCount(1)
      for (const appearance of ['light', 'dark', 'paper']) {
        await page.evaluate(value => {
          document.body.dataset.appearance = value
          document.documentElement.dataset.appearance = value
        }, appearance)
        await page.evaluate(() => document.fonts.ready)
        await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(2)
        const capture = await page.screenshot({ path: testInfo.outputPath(`native-steer-${appearance}.png`), animations: 'disabled' })
        expect([capture.readUInt32BE(16), capture.readUInt32BE(20)]).toEqual([1440, 900])
      }
      await page.reload()
      await row.click()
      await expect(send).toHaveAttribute('data-action', 'interrupt')
      await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(2)
      await send.click()
      await expect(send).not.toHaveAttribute('data-action', 'interrupt')
      await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(2)
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    }
  })
}
