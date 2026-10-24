import { expect, test } from './fixtures'

test('read-only language requests receive correlated permission failures after reconnect', async ({ page, browser }) => {
  test.skip(process.env.FARMING_PLAYWRIGHT_AUTH !== '1', 'Requires isolated token authentication')
  await page.goto('/farming/?token=mobile-auth-owner-fixture-token')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const share = await page.request.post('/farming/api/share/qr-ticket', { data: {} })
  expect(share.ok()).toBe(true)
  const { readOnlyUrl } = await share.json() as { readOnlyUrl: string }
  const recipient = await browser.newContext()
  try {
    const guest = await recipient.newPage()
    await guest.goto(readOnlyUrl)
    await expect(guest.getByTestId('code-read-only-share-banner')).toBeVisible()
    for (let round = 0; round < 2; round++) {
      const responses = await guest.evaluate(async iteration => {
        const url = new URL('/farming/ws', location.href)
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(url)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await new Promise<Array<{ requestId: string; ok: boolean; error: { code: string; status: number } }>>((resolve, reject) => {
            const received: Array<{ requestId: string; ok: boolean; error: { code: string; status: number } }> = []
            timer = setTimeout(() => reject(new Error('Read-only language denial did not settle')), 5000)
            socket.onerror = () => reject(new Error('Read-only WebSocket failed'))
            socket.onmessage = event => {
              const message = JSON.parse(String(event.data))
              if (message.type === 'protocol-hello') {
                if (message.accessMode !== 'read-only') { reject(new Error('Expected read-only admission')); return }
                for (let index = 0; index < 3; index++) socket.send(JSON.stringify({
                  type: 'language-server-request', requestId: `denied-${iteration}-${index}`,
                  request: { operation: 'capability', rootId: 'unresolved-root' },
                }))
              } else if (message.type === 'language-server-result') {
                received.push(message)
                if (received.length === 3) resolve(received)
              } else if (message.type === 'error' || message.type === 'protocol-error') {
                reject(new Error(`Uncorrelated rejection: ${message.message}`))
              }
            }
          })
        } finally { clearTimeout(timer); socket.close() }
      }, round)
      expect(responses).toMatchObject(Array.from({ length: 3 }, (_, index) => ({
        requestId: `denied-${round}-${index}`, ok: false, error: { code: 'FORBIDDEN', status: 403 },
      })))
    }
  } finally { await recipient.close() }
})

test('read-only Chat rejection settles delivery and preserves the draft across reload', async ({ page, browser, workspaceRoot }) => {
  test.skip(process.env.FARMING_PLAYWRIGHT_AUTH !== '1', 'Requires isolated token authentication')
  await page.goto('/farming/?token=mobile-auth-owner-fixture-token')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  expect((await page.request.post('/farming/api/settings', { data: { language: 'en' } })).ok()).toBe(true)
  const created = await page.request.post('/farming/api/control/agents', { data: {
    command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'acp',
  } })
  expect(created.ok()).toBe(true)
  const { agentId } = await created.json() as { agentId: string }
  const recipient = await browser.newContext()
  let primaryFailure: unknown
  try {
    const share = await page.request.post('/farming/api/share/qr-ticket', { data: { target: { kind: 'agent', agentId } } })
    expect(share.ok()).toBe(true)
    const { readOnlyUrl } = await share.json() as { readOnlyUrl: string }
    const guest = await recipient.newPage()
    const responses: Array<Record<string, unknown>> = []
    guest.on('websocket', socket => socket.on('framereceived', event => {
      try { responses.push(JSON.parse(String(event.payload))) } catch { /* Ignore non-JSON transport frames. */ }
    }))
    const selectAgent = async () => {
      const mobileMenu = guest.getByTestId('code-mobile-menu')
      if (await mobileMenu.isVisible()) await mobileMenu.click()
      await guest.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click({ timeout: 10_000 })
    }
    await guest.goto(readOnlyUrl)
    await expect(guest.getByTestId('code-read-only-share-banner')).toBeVisible()
    // The shared Agent target opens asynchronously and closes the mobile sidebar.
    // Wait for that navigation instead of racing it with a second selection.
    const workPane = guest.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    await expect(workPane).toBeVisible()
    const input = guest.getByTestId('code-acp-composer-input')
    const marker = 'READ_ONLY_CHAT_MUST_NOT_RUN'
    await expect(input).toBeEnabled()
    await input.fill(marker)
    await guest.getByTestId('code-acp-composer-send').click()
    await expect(guest.getByTestId('app-toast')).toContainText('This Farming share is read-only.')
    await expect.poll(() => responses.find(frame => frame.type === 'composer-input-result')).toMatchObject({
      agentId, accepted: false, message: 'This Farming share is read-only.',
    })
    await expect(input).toHaveText(marker)
    await expect(guest.getByText('Delivery outcome unknown', { exact: true })).toHaveCount(0)
    await expect(guest.getByText('Waiting for Agent', { exact: true })).toHaveCount(0)
    await guest.reload()
    await expect(guest.getByTestId('code-read-only-share-banner')).toBeVisible()
    await selectAgent()
    await expect(input).toHaveText(marker)
    await expect(guest.getByText('Delivery outcome unknown', { exact: true })).toHaveCount(0)
    const transcript = await page.request.get(`/farming/api/agents/${encodeURIComponent(agentId)}/acp-transcript?maxTurns=5&media=external-v1`)
    expect(transcript.ok()).toBe(true)
    expect(await transcript.text()).not.toContain(marker)
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    // Attempt both exact-owner cleanups even if the browser has already closed.
    // Teardown errors must not replace the action or assertion that failed first.
    const cleanup = await Promise.allSettled([
      recipient.close(),
      page.request.delete(`/farming/api/control/agents/${encodeURIComponent(agentId)}?recordHistory=0`, { timeout: 10_000 })
        .then(response => expect(response.ok()).toBe(true)),
    ])
    if (!primaryFailure) {
      const failed = cleanup.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  }
})
