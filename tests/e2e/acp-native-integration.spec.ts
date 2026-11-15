import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('repeated native replies use lossless disclosures across appearances and reload', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'agy', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  try {
    await openFarming(page)
    const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await row.click()
    for (let turn = 1; turn <= 2; turn += 1) {
      await page.getByTestId('code-acp-composer-input').fill('Inspect repeated native replies')
      await page.getByTestId('code-acp-composer-send').click()
      await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'disabled')
      await expect(page.getByText('Native verification complete.', { exact: true })).toHaveCount(turn)
    }
    const turns = page.locator('.code-agent-transcript-turn')
    await expect(turns).toHaveCount(2)
    const last = turns.last()
    await last.getByTestId('code-agent-transcript-process-summary').click()
    const repeated = last.locator('[data-repeats-final-response="true"]')
    await expect(repeated).toHaveCount(2)
    await expect(repeated.filter({ hasText: /Thought|思考/ })).toHaveCount(1)
    await expect(repeated.filter({ hasText: /Earlier reply|较早回复/ })).toHaveCount(1)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        document.documentElement.dataset.appearance = value
      }, appearance)
      await expect(page.getByText('Native verification complete.', { exact: true })).toHaveCount(2)
      const capture = await page.screenshot({ path: testInfo.outputPath(`repeated-reply-${appearance}.png`), animations: 'disabled' })
      expect([capture.readUInt32BE(16), capture.readUInt32BE(20)]).toEqual([1440, 900])
    }
    for (const item of await repeated.all()) {
      const toggle = item.getByTestId('code-agent-transcript-process-item-toggle')
      await toggle.focus()
      await page.keyboard.press('Enter')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(item.getByText('Native verification complete.', { exact: true })).toBeVisible()
      await expect(item.getByRole('button', { name: /Copy details|复制详情/ })).toBeVisible()
      await page.keyboard.press('Enter')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    }
    // The authoritative stream still contains two replies per input.
    const snapshot = await page.request.get(`/farming/api/agents/${agentId}/acp-session?includeEntries=1`)
    const { session } = await snapshot.json() as { session: { entries: Array<{ role?: string; type?: string }> } }
    expect(session.entries.filter(entry => entry.type === 'message' && entry.role === 'assistant')).toHaveLength(4)
    await page.reload()
    await row.click()
    await expect(page.getByText('Native verification complete.', { exact: true })).toHaveCount(2)
    await turns.last().getByTestId('code-agent-transcript-process-summary').click()
    await expect(turns.last().locator('[data-repeats-final-response="true"]')).toHaveCount(2)
  } finally {
    const removed = await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    expect(removed.ok()).toBeTruthy()
  }
})

test('related session previews preserve repeated reply disclosures', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'agy', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  try {
    await page.route(`**/api/agents/${agentId}/acp-subagents/*/transcript?*`, async route => {
      const original = await route.fetch()
      const payload = await original.json()
      const content = [{ type: 'text', text: 'Child verification complete.' }]
      await route.fulfill({ response: original, json: { ...payload, state: 'idle', entries: [
        { id: 'input', type: 'message', role: 'user', content: [{ type: 'text', text: 'Verify the child command' }] },
        { id: 'earlier', type: 'message', role: 'assistant', content },
        { id: 'thought', type: 'thought', role: 'assistant', content },
        { id: 'final', type: 'message', role: 'assistant', content },
      ] } })
    })
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await page.getByTestId('code-acp-composer-input').fill('agy registry children')
    await page.getByTestId('code-acp-composer-send').click()
    await page.getByRole('button', { name: 'DeepCoder', exact: true }).click()
    const panel = page.getByTestId('code-related-session-panel')
    await expect(panel.getByText('Child verification complete.', { exact: true })).toHaveCount(1)
    await panel.getByTestId('code-agent-transcript-process-summary').click()
    const repeated = panel.locator('[data-repeats-final-response="true"]')
    await expect(repeated).toHaveCount(2)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        document.documentElement.dataset.appearance = value
      }, appearance)
      const capture = await page.screenshot({ path: testInfo.outputPath(`repeated-child-${appearance}.png`), animations: 'disabled' })
      expect([capture.readUInt32BE(16), capture.readUInt32BE(20)]).toEqual([1440, 900])
    }
    await repeated.first().getByTestId('code-agent-transcript-process-item-toggle').click()
    await expect(repeated.first().getByText('Child verification complete.', { exact: true })).toBeVisible()
  } finally {
    const removed = await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    expect(removed.ok()).toBeTruthy()
  }
})

test('delayed native prompt echo stays in one Turn across appearances, reload and repeated sends', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'agy', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  try {
    await openFarming(page)
    const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await row.click()
    const users = page.locator('.code-agent-transcript-turn > .code-agent-transcript-user')
    const results = page.getByText('Delayed prompt echo verified.', { exact: true })
    for (let turn = 1; turn <= 2; turn += 1) {
      await page.getByTestId('code-acp-composer-input').fill('Inspect delayed prompt echo')
      await page.getByTestId('code-acp-composer-send').click()
      await expect(results).toHaveCount(turn)
      await expect(users).toHaveCount(turn)
      await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'disabled')
      await expect(page.getByText(/本轮执行未产生最终回复|This turn did not produce a final reply/)).toHaveCount(0)
    }
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        document.documentElement.dataset.appearance = value
      }, appearance)
      const capture = await page.screenshot({ path: testInfo.outputPath(`delayed-echo-${appearance}.png`), animations: 'disabled' })
      expect([capture.readUInt32BE(16), capture.readUInt32BE(20)]).toEqual([1440, 900])
    }
    await page.reload()
    await row.click()
    await expect(results).toHaveCount(2)
    await expect(users).toHaveCount(2)
    await expect(page.getByText(/本轮执行未产生最终回复|This turn did not produce a final reply/)).toHaveCount(0)
  } finally {
    const removed = await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    expect(removed.ok()).toBeTruthy()
  }
})

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

test('late native Steer acceptance never restores a sent input or loses a newer draft', async ({ page, workspaceRoot }, testInfo) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const workspace = path.join(workspaceRoot, 'acp-native-steer-agy-delayed')
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'agy', workspace, agentRuntimeMode: 'chat' },
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
    await input.fill('delay native steer echo')
    await send.click()
    await page.getByTestId('code-acp-pending-followup-steer').click()
    const submission = page.getByTestId('code-acp-submission')
    await expect(submission).toHaveAttribute('data-status', 'submitting')
    await expect.poll(() => fs.existsSync(path.join(workspace, 'delayed-steer-received'))).toBeTruthy()
    // Cross the real admission deadline while the native provider has the input.
    await expect(submission).toHaveAttribute('data-status', 'unknown', { timeout: 40_000 })
    await expect(input).toHaveText('')
    await expect(page.getByTestId('code-acp-submission-discard')).toHaveCount(0)
    await input.fill('Preserve this newer draft')
    fs.writeFileSync(path.join(workspace, 'release-steer-echo'), 'ready')
    await expect(page.getByTestId('code-agent-transcript-steer').filter({ hasText: 'delay native steer echo' })).toHaveCount(1)
    await expect(submission).toHaveCount(0)
    await expect(input).toHaveText('Preserve this newer draft')
    expect(fs.readFileSync(path.join(workspace, 'delayed-steer-received'), 'utf8')).toBe('received\n')
    await expect(page.getByTestId('app-toast')).toHaveCount(0)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        document.documentElement.dataset.appearance = value
      }, appearance)
      const capture = await page.screenshot({ path: testInfo.outputPath(`late-steer-${appearance}.png`), animations: 'disabled' })
      expect([capture.readUInt32BE(16), capture.readUInt32BE(20)]).toEqual([1440, 900])
    }
    await page.reload()
    await row.click()
    await expect(submission).toHaveCount(0)
    await expect(input).toHaveText('Preserve this newer draft')
    await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(1)
  } finally {
    const removed = await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    expect(removed.ok()).toBeTruthy()
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
