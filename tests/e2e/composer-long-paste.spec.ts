import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, openFarming, terminalCheckpointOutput, test } from './fixtures'

const documentText = '# Migration review\n' + '检查迁移计划、权限与回滚路径。 Keep the entire source.\n'.repeat(180) + 'END_OF_PASTED_DOCUMENT'

async function paste(input: Locator, text = documentText) {
  return input.evaluate((element, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    return !element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}

for (const mode of ['chat', 'terminal'] as const) {
  test(`${mode} long paste supports preview, restore, recovery and complete submission`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, `long-paste-${mode}`)
    fs.mkdirSync(workspace, { recursive: true })
    await page.request.post('/farming/api/settings', { data: { language: 'en' } })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace, agentRuntimeMode: mode },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    const sent: string[] = []
    await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
      const server = socket.connectToServer()
      socket.onMessage(message => {
        const payload = JSON.parse(String(message)) as { type: string; text?: string }
        if (payload.type === 'composer-input' || payload.type === 'input') sent.push(JSON.stringify(payload))
        server.send(message)
      })
      server.onMessage(message => socket.send(message))
    })
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const input = page.getByTestId(mode === 'chat' ? 'code-acp-composer-input' : 'code-composer-input')
    const send = page.getByTestId(mode === 'chat' ? 'code-acp-composer-send' : 'code-composer-send')
    await expect(input).toBeEditable()
    await input.fill('Review this')
    expect(await paste(input, 'short text')).toBe(false)
    expect(await paste(input, 'x'.repeat(250_001))).toBe(true)
    await expect(page.getByText('Pasted text exceeds 250,000 characters. Split it into smaller documents before pasting.', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('Review this')
    await expect(page.getByTestId('code-composer-pasted-text')).toHaveCount(0)
    await expect(page.getByText('Pasted text exceeds 250,000 characters. Split it into smaller documents before pasting.', { exact: true })).toBeHidden()
    expect(await paste(input)).toBe(true)
    await expect(input).toHaveValue('Review this')
    const cards = page.getByTestId('code-composer-pasted-text')
    await expect(cards).toHaveCount(1)
    expect(sent).toHaveLength(0)
    await cards.locator('summary').click()
    expect(await cards.locator('pre').textContent()).toBe(documentText)
    await cards.locator('summary').click()

    for (const [layout, viewport] of [
      ['desktop', { width: 1440, height: 900 }], ['compact', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport)
      for (const appearance of ['light', 'dark', 'paper']) {
        await page.evaluate(value => {
          document.body.dataset.appearance = value
          document.documentElement.dataset.appearance = value
        }, appearance)
        const restore = cards.getByRole('button', { name: 'Show in text field' })
        await expect(restore).toBeInViewport()
        await expect(send).toBeInViewport()
        const box = (await cards.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
        await page.screenshot({ path: testInfo.outputPath(`${mode}-${layout}-${appearance}.png`), animations: 'disabled' })
        await cards.locator('summary').click()
        await expect(cards.locator('pre')).toBeVisible()
        await page.screenshot({ path: testInfo.outputPath(`${mode}-${layout}-${appearance}-expanded.png`), animations: 'disabled' })
        await cards.locator('summary').click()
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await cards.getByRole('button', { name: 'Show in text field' }).click()
    await expect(cards).toHaveCount(0)
    await expect(input).toHaveValue('Review this\n\n' + documentText)
    await input.fill('Review this')
    await paste(input)
    await paste(input)
    await expect(cards).toHaveCount(2)
    await cards.first().getByRole('button', { name: 'Remove # Migration review' }).click()
    await expect(cards).toHaveCount(1)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('farming.code.agentComposerCheckpoint.v1'))).toContain('END_OF_PASTED_DOCUMENT')
    await page.reload()
    await expect(cards).toHaveCount(1)
    await expect(input).toHaveValue('Review this')
    await cards.locator('summary').click()
    expect(await cards.locator('pre').textContent()).toBe(documentText)
    await send.click()
    await expect(input).toHaveValue('')
    await expect(cards).toHaveCount(0)
    if (mode === 'terminal' && await page.getByTestId('code-pending-followup-send-next').count()) {
      await page.getByTestId('code-pending-followup-send-next').click()
    }
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0]).toContain('END_OF_PASTED_DOCUMENT')
    expect(sent[0]).toContain('reference material')
    expect(sent[0]).toContain(JSON.stringify(documentText).slice(1, -1))
    if (mode === 'terminal') await expect.poll(() => terminalCheckpointOutput(page, agentId)).toContain('END_OF_PASTED_DOCUMENT')
  })
}

test('side chat owns its pasted document separately from the parent draft', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'side-long-paste')
  fs.mkdirSync(workspace, { recursive: true })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const parent = page.locator('.code-composer-shell').getByTestId('code-acp-composer-input')
  await parent.fill('image attachment parent context')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Received 0 image.')
  await parent.fill('/side')
  await page.getByTestId('code-acp-composer-send').click()
  const pane = page.getByTestId('code-subagent-panel')
  await expect(pane).toBeVisible()
  await parent.fill('Keep parent draft')
  const child = pane.getByTestId('code-acp-composer-input')
  await child.fill('Review child document')
  await paste(child)
  const card = pane.getByTestId('code-composer-pasted-text')
  await expect(card).toHaveCount(1)
  await expect(page.locator('.code-composer-shell').getByTestId('code-composer-pasted-text')).toHaveCount(0)
  await card.getByRole('button', { name: 'Show in text field' }).click()
  await expect(child).toHaveValue('Review child document\n\n' + documentText)
  await expect(parent).toHaveValue('Keep parent draft')
  await child.fill('Review child document')
  await paste(child)
  await pane.getByTestId('code-acp-composer-send').click()
  await expect(card).toHaveCount(0)
  await expect(pane.locator('.code-agent-transcript-user').last()).toContainText('END_OF_PASTED_DOCUMENT')
  await expect(parent).toHaveValue('Keep parent draft')
})
