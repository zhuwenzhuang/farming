import { expect, test } from './fixtures'

test('failed reconnects eventually leave the initial loading state', {
  tag: ['@critical-behavior', '@behavior-CODE-BACKEND-CONNECTION-RECOVERY'],
}, async ({ page }) => {
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    socket.onMessage(() => undefined)
    socket.close({ code: 1012, reason: 'backend unavailable' })
  })

  await page.goto('/farming/')

  const status = page.getByTestId('connection-status')
  await expect(status).toContainText('Loading')
  await expect(status).toHaveClass(/lost/, { timeout: 12_000 })
  await expect(status).toContainText('still unavailable')
})

test('terminal authentication and protocol failures do not resume on recovery events', async ({ page }) => {
  const protocolPage = await page.context().newPage()
  let authenticationSocketCount = 0
  let protocolSocketCount = 0
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    authenticationSocketCount += 1
    socket.onMessage(() => undefined)
    socket.close({ code: 4001, reason: 'invalid token' })
  })
  await protocolPage.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    protocolSocketCount += 1
    socket.onMessage(() => undefined)
    socket.close({ code: 4002, reason: 'unsupported protocol' })
  })

  await Promise.all([
    page.goto('/farming/'),
    protocolPage.goto('/farming/'),
  ])

  const status = page.getByTestId('connection-status')
  const protocolStatus = protocolPage.getByTestId('connection-status')
  await expect(status).toHaveClass(/lost/, { timeout: 12_000 })
  await expect(protocolStatus).toHaveClass(/lost/, { timeout: 12_000 })
  await expect(status).toContainText('connection is unavailable')
  await expect(protocolStatus).toContainText('connection is unavailable')
  await expect(status).not.toContainText('Retrying')
  await expect(protocolStatus).not.toContainText('Retrying')
  await Promise.all([page, protocolPage].map(currentPage => currentPage.evaluate(() => {
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('pageshow'))
  })))
  await page.waitForTimeout(1_200)
  expect(authenticationSocketCount).toBe(1)
  expect(protocolSocketCount).toBe(1)
  await protocolPage.close()
})

test('a stuck initial mobile WebSocket is replaced after its bounded connect deadline', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeEvent = window.Event
    const NativeCloseEvent = window.CloseEvent
    const NativeMessageEvent = window.MessageEvent
    let socketCount = 0
    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      binaryType: BinaryType = 'blob'
      bufferedAmount = 0
      extensions = ''
      protocol = ''
      readyState = MockWebSocket.CONNECTING
      url: string
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onopen: ((event: Event) => void) | null = null

      constructor(url: string | URL) {
        super()
        this.url = String(url)
        socketCount += 1
        ;(window as typeof window & { __stuckSocketCount?: number }).__stuckSocketCount = socketCount
        if (socketCount === 1) return
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN
          this.onopen?.(new NativeEvent('open'))
        }, 0)
      }

      close(code = 1000, reason = '') {
        if (this.readyState === MockWebSocket.CLOSED) return
        this.readyState = MockWebSocket.CLOSING
        if (socketCount === 1) return
        this.readyState = MockWebSocket.CLOSED
        window.setTimeout(() => {
          this.onclose?.(new NativeCloseEvent('close', { code, reason, wasClean: true }))
        }, 0)
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (this.readyState !== MockWebSocket.OPEN || typeof data !== 'string') return
        const message = JSON.parse(data) as { type?: string; requestId?: string }
        const emit = (body: unknown) => {
          this.onmessage?.(new NativeMessageEvent('message', { data: JSON.stringify(body) }))
        }
        if (message.type === 'protocol-hello') {
          emit({
            type: 'protocol-hello',
            protocolVersion: 15,
            minProtocolVersion: 15,
            accessMode: 'owner',
          })
        } else if (message.type === 'business-health-probe') {
          emit({
            type: 'business-health-result',
            requestId: message.requestId,
            status: 'ready',
            serverEpoch: 'stuck-connect-recovered',
            protocolVersion: 15,
            agentCount: 0,
            mainAgentId: null,
          })
        }
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket })
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/farming/')
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __stuckSocketCount?: number }).__stuckSocketCount || 0
  )), { timeout: 12_000 }).toBeGreaterThan(1)
  await expect(page.getByTestId('connection-status')).toHaveCount(0, { timeout: 5_000 })
})

test('mobile resume probes before replacing a zombie and never replays uncertain input', {
  tag: ['@iphone-human'],
}, async ({ page, workspaceRoot }) => {
  const agentResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(agentResponse.ok()).toBeTruthy()

  let socketCount = 0
  let staleHealthSocket = 0
  let healthProbeCount = 0
  let composerInputCount = 0
  let interruptNextComposerInput = false
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    socketCount += 1
    const socketGeneration = socketCount
    const server = socket.connectToServer()
    socket.onMessage(message => {
      try {
        const parsed = JSON.parse(String(message)) as { type?: string }
        if (parsed.type === 'business-health-probe') healthProbeCount += 1
        if (parsed.type === 'composer-input') {
          composerInputCount += 1
          if (interruptNextComposerInput) {
            interruptNextComposerInput = false
            void socket.close({ code: 1012, reason: 'mobile route changed during submission' })
            return
          }
        }
      } catch {
        // Non-JSON frames remain part of the proxied connection.
      }
      server.send(message)
    })
    server.onMessage(message => {
      try {
        const parsed = JSON.parse(String(message)) as { type?: string }
        if (parsed.type === 'business-health-result' && socketGeneration === staleHealthSocket) return
      } catch {
        // Non-JSON frames remain part of the proxied connection.
      }
      socket.send(message)
    })
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/farming/')
  const composer = page.getByTestId('code-acp-composer-input')
  await expect(composer).toBeEditable()
  await composer.fill('MOBILE_RECOVERY_SEND_ONCE')
  await expect.poll(() => socketCount).toBe(1)

  const healthyProbeBaseline = healthProbeCount
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => healthProbeCount).toBeGreaterThan(healthyProbeBaseline)
  await page.waitForTimeout(2_800)
  expect(socketCount).toBe(1)
  await expect(composer).toHaveValue('MOBILE_RECOVERY_SEND_ONCE')

  staleHealthSocket = 1
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => socketCount, { timeout: 6_000 }).toBe(2)
  await expect(page.getByTestId('connection-status')).toHaveCount(0, { timeout: 8_000 })
  await expect(composer).toHaveValue('MOBILE_RECOVERY_SEND_ONCE')

  staleHealthSocket = 2
  await page.evaluate(() => {
    const event = new Event('pageshow')
    Object.defineProperty(event, 'persisted', { value: true })
    window.dispatchEvent(event)
  })
  await expect.poll(() => socketCount, { timeout: 6_000 }).toBe(3)
  await expect(page.getByTestId('connection-status')).toHaveCount(0, { timeout: 8_000 })
  await expect(composer).toHaveValue('MOBILE_RECOVERY_SEND_ONCE')
  expect(composerInputCount).toBe(0)

  interruptNextComposerInput = true
  await page.getByTestId('code-acp-composer-send').click()
  await expect.poll(() => composerInputCount).toBe(1)
  await expect.poll(() => socketCount, { timeout: 6_000 }).toBe(4)
  await expect(page.getByTestId('connection-status')).toHaveCount(0, { timeout: 8_000 })
  await expect(composer).toHaveValue('MOBILE_RECOVERY_SEND_ONCE')
  await page.waitForTimeout(1_200)
  expect(composerInputCount).toBe(1)

  await page.getByTestId('code-acp-composer-send').click()
  await expect.poll(() => composerInputCount).toBe(2)
  await expect(composer).toHaveValue('')
})
