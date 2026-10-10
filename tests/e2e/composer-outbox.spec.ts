import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

interface Input { type: string; requestId: string; agentId: string; message: string }

for (const appearance of ['light', 'dark', 'paper']) {
  test(`stages messages immediately and admits only the FIFO head in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, `composer-outbox-${appearance}`)
    fs.mkdirSync(workspace, { recursive: true })
    await page.request.post('/farming/api/settings', { data: { appearance, language: 'en' } })
    const created = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    const sends: Input[] = []
    const forwards: Array<() => void> = []
    await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
      const server = socket.connectToServer()
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw)) as Input
        if (message.type === 'composer-input' && message.agentId === agentId) {
          sends.push(message)
          forwards.push(() => server.send(raw))
        } else server.send(raw)
      })
      server.onMessage(raw => socket.send(raw))
    })
    try {
      await openFarming(page)
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      const input = page.getByTestId('code-acp-composer-input')
      const rows = page.getByTestId('code-acp-submission')
      for (let i = 1; i <= 3; i++) {
        await input.fill(`image attachment outbox message ${i}`)
        await page.getByTestId('code-acp-composer-send').click()
        await expect(input).toHaveValue('', { timeout: 1000 })
        await expect(rows).toHaveCount(i)
      }
      await expect(rows.nth(0)).toHaveAttribute('data-status', 'submitting')
      await expect(rows.nth(1)).toHaveAttribute('data-status', 'queued')
      expect(sends.map(item => item.message)).toEqual(['image attachment outbox message 1'])
      await input.fill('newer draft must survive all acknowledgements')
      await page.screenshot({ path: testInfo.outputPath(`outbox-${appearance}.png`), animations: 'disabled' })
      for (let i = 0; i < 3; i++) {
        await expect.poll(() => sends.length).toBe(i + 1)
        expect(sends[i].message).toBe(`image attachment outbox message ${i + 1}`)
        forwards[i]()
        await expect(rows).toHaveCount(2 - i)
        await expect(input).toHaveValue('newer draft must survive all acknowledgements')
      }
      expect(new Set(sends.map(item => item.requestId)).size).toBe(3)
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    }
  })
}

for (const reload of [false, true]) {
test(`uncertain delivery pauses later messages and recovers through ${reload ? 'reload with same id' : 'late acknowledgement'}`,  async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'composer-uncertain')
  fs.mkdirSync(workspace, { recursive: true })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const created = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  const { agentId } = await created.json() as { agentId: string }
  const sends: Input[] = []
  const statusRequests: Input[] = []
  let sendUnknown: (() => void) | undefined
  let release = false
  let deliverLateAcknowledgement: (() => void) | undefined
  let firstRequestId = ''
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw)) as Input
      if (message.agentId === agentId && message.type === 'composer-input') {
        sends.push(message)
        firstRequestId ||= message.requestId
        sendUnknown = () => socket.send(JSON.stringify({ type: 'composer-input-result', agentId, requestId: firstRequestId, accepted: false, uncertain: true, message: 'Uncertain test delivery' }))
      }
      if (message.agentId === agentId && message.type === 'composer-input-status-request') statusRequests.push(message)
      server.send(raw)
    })
    server.onMessage(raw => {
      const message = JSON.parse(String(raw)) as { type: string; requestId?: string; accepted?: boolean; phase?: string }
      if (!release && message.requestId === firstRequestId && ((message.type === 'composer-input-result' && message.accepted) || (message.type === 'composer-input-status' && message.phase === 'submitted'))) {
        deliverLateAcknowledgement = () => socket.send(raw)
        return
      }
      socket.send(raw)
    })
  })
  try {
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const input = page.getByTestId('code-acp-composer-input')
    await input.fill('image attachment uncertain original message')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(input).toHaveValue('')
    await expect.poll(async () => (await (await page.request.get(`/farming/api/agents/${agentId}/acp-session`)).json()).session?.chatTurn?.status).toBe('completed')
    sendUnknown!()
    await expect(page.getByTestId('code-acp-submission').first()).toHaveAttribute('data-status', 'unknown')
    await input.fill('image attachment later queued message')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(page.getByTestId('code-acp-submission')).toHaveCount(2)
    expect(sends).toHaveLength(1)
    if (!reload) {
      await input.fill('new draft after uncertain delivery')
      await expect.poll(() => Boolean(deliverLateAcknowledgement)).toBe(true)
      release = true
      deliverLateAcknowledgement!()
      await expect(page.getByTestId('code-acp-submission')).toHaveCount(0)
      expect(sends).toHaveLength(2)
      await expect(input).toHaveValue('new draft after uncertain delivery')
      await expect(page.locator('.code-agent-transcript-turn').filter({ hasText: 'image attachment uncertain original message' })).toHaveCount(1)
      return
    }
    await expect.poll(() => page.evaluate(() => localStorage.getItem('farming.code.agentComposerCheckpoint.v1'))).toContain('image attachment later queued message')
    await page.reload()
    await expect(page.getByTestId('code-acp-submission')).toHaveCount(2)
    expect(sends).toHaveLength(1)
    release = true
    await page.getByTestId('code-acp-submission-retry').first().click()
    await expect(page.getByTestId('code-acp-submission')).toHaveCount(1)
    expect(statusRequests[statusRequests.length - 1].requestId).toBe(firstRequestId)
    expect(sends).toHaveLength(1)
    // Missing records are not proof of zero effect: even a formerly queued item
    // is only queried after reload, never blindly admitted under an old ID.
    await page.getByTestId('code-acp-submission-retry').first().click()
    await expect(page.getByTestId('code-acp-submission')).toHaveAttribute('data-status', 'unknown')
    expect(statusRequests).toHaveLength(2)
    expect(sends).toHaveLength(1)
    await expect(page.locator('.code-agent-transcript-turn').filter({ hasText: 'image attachment uncertain original message' })).toHaveCount(1)
  } finally {
    await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
  }
})

}

test('only definite failure returns the submitted snapshot to an empty editor', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'composer-bounce')
  fs.mkdirSync(workspace, { recursive: true })
  const created = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  const { agentId } = await created.json() as { agentId: string }
  let reject: (() => void) | undefined
  const requestIds: string[] = []
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw)) as Input
      if (message.type === 'composer-input' && message.agentId === agentId) {
        requestIds.push(message.requestId)
        reject = () => socket.send(JSON.stringify({ type: 'composer-input-result', agentId, requestId: message.requestId, accepted: false, uncertain: false, message: 'Definite test rejection before dispatch' }))
      } else server.send(raw)
    })
    server.onMessage(raw => socket.send(raw))
  })
  try {
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const input = page.getByTestId('code-acp-composer-input')
    await input.fill('return this message')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(input).toHaveValue('')
    await expect.poll(() => Boolean(reject)).toBe(true)
    reject!()
    await expect(input).toHaveValue('return this message')
    await expect(page.getByTestId('code-acp-submission')).toHaveCount(0)
    reject = undefined
    await page.getByTestId('code-acp-composer-send').click()
    await expect(input).toHaveValue('')
    await input.fill('keep the new draft')
    await expect.poll(() => Boolean(reject)).toBe(true)
    reject!()
    await expect(page.getByTestId('code-acp-submission')).toHaveAttribute('data-status', 'failed')
    await expect(input).toHaveValue('keep the new draft')
    const staleRejection = reject!
    await page.getByTestId('code-acp-submission-retry').click()
    await expect.poll(() => requestIds.length).toBe(3)
    expect(requestIds[2]).not.toBe(requestIds[1])
    staleRejection()
    await expect(page.getByTestId('code-acp-submission')).toHaveAttribute('data-status', 'submitting')
    await expect(input).toHaveValue('keep the new draft')
  } finally {
    await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
  }
})


test('bounds a burst of unconfirmed messages without dispatching or losing the overflow draft', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'composer-burst')
  fs.mkdirSync(workspace, { recursive: true })
  const created = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  const { agentId } = await created.json() as { agentId: string }
  const sends: Input[] = []
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw)) as Input
      if (message.type === 'composer-input' && message.agentId === agentId) sends.push(message)
      else if (message.type === 'composer-input-status-request' && message.agentId === agentId) {
        socket.send(JSON.stringify({ type: 'composer-input-status', agentId, requestId: message.requestId, phase: 'received', updatedAt: Date.now() }))
      } else server.send(raw)
    })
    server.onMessage(raw => socket.send(raw))
  })
  try {
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const input = page.getByTestId('code-acp-composer-input')
    for (let i = 0; i < 32; i++) {
      await input.fill(`burst ${i}`)
      await input.press('Enter')
      await expect(input).toHaveValue('', { timeout: 1000 })
    }
    await expect(page.getByTestId('code-acp-submission')).toHaveCount(32)
    await input.fill('overflow stays editable')
    await expect(page.getByTestId('code-acp-composer-send')).toBeDisabled()
    await input.press('Enter')
    await expect(input).toHaveValue('overflow stays editable')
    expect(sends).toHaveLength(1)
    await page.screenshot({ path: testInfo.outputPath('bounded-outbox.png'), animations: 'disabled' })
  } finally {
    await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
  }
})
