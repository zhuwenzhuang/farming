import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('sends negotiated Codex ACP steer with mixed input and restores it once', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'codex-acp-steer')
  fs.mkdirSync(workspace, { recursive: true })
  const imagePath = path.join(workspace, 'steer.png')
  fs.writeFileSync(
    imagePath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
  )

  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect.poll(async () => {
    const state = await page.request.get('/farming/api/control/agents')
    const body = await state.json() as {
      agents?: Array<{ id?: string; providerCapabilities?: { supportsSteer?: boolean } }>
    }
    return body.agents?.find(agent => agent.id === agentId)?.providerCapabilities?.supportsSteer
  }).toBe(true)

  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('hold for steer')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Waiting for steering.', { exact: true })).toBeVisible()

  await page.getByTestId('code-acp-composer-file-input').setInputFiles(imagePath)
  await expect(page.getByTestId('code-composer-attachment')).toHaveClass(/ready/)
  await input.fill('focus on the attached image')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-pending-followup')).toHaveCount(0)

  const steer = page.getByTestId('code-agent-transcript-steer')
  await expect(steer).toContainText('focus on the attached image')
  await expect(steer.getByTestId('code-agent-transcript-user-images').locator('img')).toHaveCount(1)
  await expect(page.getByText('Steer accepted: focus on the attached image', { exact: true })).toBeVisible()
  await expect(page.locator('.code-agent-transcript-turn').filter({ hasText: 'hold for steer' })).toHaveCount(1)

  await page.reload()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(1)
  await expect(page.getByTestId('code-agent-transcript-steer')).toContainText('focus on the attached image')
})
