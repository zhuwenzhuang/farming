import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('sends negotiated Codex ACP steer with mixed input and restores it once', async ({ page, workspaceRoot }) => {
  const sessionRevisionMessages: Array<{ agentId?: string; revision?: number }> = []
  page.on('websocket', socket => {
    if (!/\/farming\/ws(?:\?|$)/.test(socket.url())) return
    socket.on('framereceived', event => {
      if (typeof event.payload !== 'string') return
      try {
        const message = JSON.parse(event.payload) as {
          type?: string
          session?: { agentId?: string; revision?: number }
        }
        if (message.type === 'acp-session-revision' && message.session) {
          sessionRevisionMessages.push(message.session)
        }
      } catch {
        // Ignore non-JSON frames owned by other websocket protocols.
      }
    })
  })
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
  await input.fill('hold for steer without user echo')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'interrupt')

  await page.getByTestId('code-acp-composer-file-input').setInputFiles(imagePath)
  await expect(page.getByTestId('code-composer-attachment')).toHaveClass(/ready/)
  await input.fill('focus on the attached image')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-pending-followup')).toHaveCount(0)

  const steer = page.getByTestId('code-agent-transcript-steer')
  await expect(steer).toContainText('focus on the attached image')
  await expect(steer.getByTestId('code-agent-transcript-user-images').locator('img')).toHaveCount(1)
  const steerTime = steer.getByTestId('code-agent-transcript-steer-time')
  await expect(steerTime).toHaveCount(1)
  await expect(steerTime).toHaveCSS('opacity', '0')
  await steer.locator('.code-agent-transcript-steer-bubble').hover()
  await expect(steerTime).toHaveCSS('opacity', '1')
  await expect(page.getByText('Steer accepted: focus on the attached image', { exact: true })).toBeVisible()
  const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'hold for steer without user echo' })
  await expect(turn).toHaveCount(1)
  expect(await turn.evaluate(element => {
    const children = Array.from(element.children)
    const steerIndex = children.findIndex(child => child.matches('[data-testid="code-agent-transcript-steer"]'))
    const processIndex = children.findIndex(child => child.matches('.code-agent-transcript-process'))
    const answerIndex = children.findIndex(child => child.matches('.code-agent-transcript-answer'))
    return {
      steerIndex,
      processIndex,
      answerIndex,
      steerInsideProcess: Boolean(element.querySelector('.code-agent-transcript-process [data-testid="code-agent-transcript-steer"]')),
    }
  })).toEqual({
    steerIndex: 1,
    processIndex: 2,
    answerIndex: 3,
    steerInsideProcess: false,
  })
  await expect(page.locator('.code-agent-transcript-turn')).toHaveCount(1)

  await page.reload()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(1)
  await expect(page.getByTestId('code-agent-transcript-steer')).toContainText('focus on the attached image')
  await expect(page.getByTestId('code-agent-transcript-steer-time')).toHaveCount(1)
  await expect(page.locator('.code-agent-transcript-turn')).toHaveCount(1)
  expect(sessionRevisionMessages.some(message => (
    message.agentId === agentId && Number.isFinite(message.revision)
  ))).toBe(true)
})

test('keeps consecutive Codex steers separate while acceptance is delayed', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'codex-acp-consecutive-steers')
  fs.mkdirSync(workspace, { recursive: true })

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
  await input.fill('hold for two steers delayed')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'interrupt')

  await input.fill('?')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('code-acp-submission')).toContainText('?')

  await input.fill('inspect the separate issue')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('code-acp-submission')).toHaveCount(2)
  await expect(page.getByTestId('code-acp-submission').nth(0)).toContainText('?')
  await expect(page.getByTestId('code-acp-submission').nth(1)).toContainText('inspect the separate issue')

  await expect(page.getByTestId('code-acp-submission')).toHaveCount(0)
  await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(2)
  await expect(page.locator('.code-agent-transcript-steer-bubble')).toHaveText([
    '?',
    'inspect the separate issue',
  ])
})
