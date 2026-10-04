import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'
import type { Agent } from '../../src/types/agent'

test('Ctrl+C retains an unmaterialized Provider Terminal and Project across reopen, refresh and CRT', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'terminal-exit-demo')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Terminal exit demo\n')
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'terminal' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  const readAgent = async () => {
    const response = await page.request.get('/farming/api/control/agents')
    expect(response.ok()).toBeTruthy()
    return (await response.json() as { agents: Agent[] }).agents.find(agent => agent.id === agentId)
  }
  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await row.click()
  const pane = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
  await expect(pane).toBeVisible()
  await page.waitForFunction(id => window.__farmingTerminalTest?.isReady(id), agentId)
  expect((await readAgent())?.providerSessionTemporary).toBe(true)
  await pane.click()
  await page.keyboard.press('Control+c')
  await expect.poll(async () => (await readAgent())?.status).toBe('stopped')
  await expect(row).toBeVisible()
  await expect(pane).toBeVisible()
  await expect(page.getByTestId('code-terminal-stopped')).toBeVisible()
  await expect(page.getByTestId('code-composer-input')).toBeDisabled()
  await expect(page.getByTestId('code-composer-send')).toBeDisabled()
  await expect(page.getByTestId('code-project-title').filter({ hasText: 'terminal-exit-demo' })).toBeVisible()
  const sentBefore = await page.evaluate(id => window.__farmingTerminalTest?.getInputCount(id), agentId)
  await page.keyboard.type('do not replay')
  expect(await page.evaluate(id => window.__farmingTerminalTest?.getInputCount(id), agentId)).toBe(sentBefore)
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await page.screenshot({ path: testInfo.outputPath(`terminal-exit-${appearance}.png`), animations: 'disabled' })
  }
  await page.getByTestId('code-new-agent').click()
  await page.keyboard.press('Escape')
  await row.click()
  await expect(pane).toBeVisible()
  await page.reload()
  await expect(row).toBeVisible()
  await expect(pane).toBeVisible()
  expect((await readAgent())?.status).toBe('stopped')
  await page.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`)
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  expect((await readAgent())?.status).toBe('stopped')
})


test('CRT stops accepting input when an open Provider Terminal exits', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'crt-terminal-exit-demo')
  fs.mkdirSync(workspace, { recursive: true })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'terminal' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  const inputs: string[] = []
  page.on('websocket', socket => socket.on('framesent', frame => {
    const message = JSON.parse(String(frame.payload)) as { type: string }
    if (message.type === 'input') inputs.push(String(frame.payload))
  }))
  await page.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`)
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  const textarea = page.locator('#terminal-output .xterm-helper-textarea')
  await expect(textarea).toBeAttached()
  await textarea.focus()
  await page.keyboard.press('Control+c')
  await expect(page.locator('#session-title')).toContainText('[READ ONLY]')
  const inputCount = inputs.length
  expect(inputCount).toBeGreaterThan(0)
  await page.keyboard.type('do not replay')
  expect(inputs.length).toBe(inputCount)
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
})
