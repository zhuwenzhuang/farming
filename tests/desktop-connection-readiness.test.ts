import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import {
  DesktopBackendReadinessCancelledError,
  probeDesktopBackendWebSocket,
} from '../desktop/backend-readiness'
import { DesktopConnectionManager } from '../desktop/connection-manager'
import type { StoredDesktopBackendProfile } from '../desktop/profile-model'
import type { DesktopProfileStore } from '../desktop/profile-store'
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  validateClientMessage,
} from '../shared/browser-protocol'

type BackendMode =
  | 'healthy-old-v4'
  | 'healthy-ack-v4'
  | 'destroy-upgrade'
  | 'incompatible'
  | 'missing-state'
  | 'ignored-health'
  | 'recovering-health'
  | 'transient-then-ready'
  | 'failed-health'
  | 'stopping-health'
  | 'close-4001'

async function fakeBackend(mode: BackendMode) {
  const server = http.createServer((request, response) => {
    if (request.url?.endsWith('/api/auth/status')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ authRequired: false }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  const sockets = new Set<WebSocket>()
  const webSockets = new WebSocketServer({ noServer: true })
  const observed: string[] = []
  const upgradePaths: string[] = []
  let upgradeAttempts = 0
  let acceptedConnections = 0

  server.on('upgrade', (request, socket, head) => {
    upgradeAttempts += 1
    upgradePaths.push(new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname)
    if (mode === 'destroy-upgrade' || (mode === 'transient-then-ready' && upgradeAttempts === 1)) {
      socket.destroy()
      return
    }
    webSockets.handleUpgrade(request, socket, head, client => {
      webSockets.emit('connection', client, request)
    })
  })
  webSockets.on('connection', socket => {
    acceptedConnections += 1
    const connectionNumber = acceptedConnections
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    if (mode === 'close-4001') {
      socket.close(4001, 'Authentication required')
      return
    }
    socket.send(JSON.stringify({
      type: 'protocol-hello',
      protocolVersion: mode === 'incompatible' ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION,
      minProtocolVersion: mode === 'incompatible' ? PROTOCOL_VERSION + 1 : MIN_PROTOCOL_VERSION,
      ...(mode === 'healthy-ack-v4' ? { availableExtensions: [] } : {}),
    }))
    if (mode !== 'missing-state') {
      socket.send(JSON.stringify({ type: 'state', state: { agents: [] } }))
    }
    socket.on('message', data => {
      const validation = validateClientMessage(JSON.parse(data.toString()))
      assert.equal(validation.ok, true)
      if (!validation.ok) return
      observed.push(validation.value.type)
      if (validation.value.type === 'protocol-hello' && mode === 'healthy-ack-v4') {
        socket.send(JSON.stringify({
          type: 'protocol-hello',
          protocolVersion: PROTOCOL_VERSION,
          minProtocolVersion: MIN_PROTOCOL_VERSION,
          availableExtensions: [],
          negotiatedExtensions: [],
        }))
      }
      if (validation.value.type === 'business-health-probe' && mode !== 'ignored-health') {
        let status: 'ready' | 'recovering' | 'failed' | 'stopping' = 'ready'
        if (mode === 'recovering-health' || (mode === 'transient-then-ready' && connectionNumber === 1)) {
          status = 'recovering'
        } else if (mode === 'failed-health') {
          status = 'failed'
        } else if (mode === 'stopping-health') {
          status = 'stopping'
        }
        socket.send(JSON.stringify({
          type: 'business-health-result',
          requestId: validation.value.requestId,
          serverEpoch: 'desktop-readiness-test',
          protocolVersion: PROTOCOL_VERSION,
          status,
          agentCount: 0,
          mainAgentId: null,
        }))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    observed,
    sockets,
    upgradePaths,
    get upgradeAttempts() {
      return upgradeAttempts
    },
    async close() {
      sockets.forEach(socket => socket.terminate())
      await new Promise<void>(resolve => webSockets.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function connectionManager(baseUrl: string, basePath = '') {
  const profile: StoredDesktopBackendProfile = {
    id: 'readiness-backend',
    kind: 'remote',
    name: 'Readiness backend',
    transport: 'direct',
    sshHost: '',
    remoteHost: '127.0.0.1',
    remotePort: 0,
    basePath,
    directUrl: baseUrl,
    farmingHome: '',
    encryptedToken: '',
  }
  const profiles = {
    getStored: (backendId: string) => backendId === profile.id ? profile : null,
    list: () => [{ ...profile, hasToken: false }],
    readToken: () => '',
  } as unknown as DesktopProfileStore
  return new DesktopConnectionManager(profiles)
}

async function waitForSocketCleanup(sockets: Set<WebSocket>) {
  const deadline = Date.now() + 500
  while (sockets.size > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(sockets.size, 0)
}

for (const mode of ['healthy-old-v4', 'healthy-ack-v4'] as const) {
  test(`desktop readiness accepts ${mode} hello and proves both protocol directions`, async () => {
    const backend = await fakeBackend(mode)
    try {
      await probeDesktopBackendWebSocket({ baseUrl: backend.baseUrl, token: '', timeoutMs: 1_000 })
      assert.deepEqual(backend.observed, ['protocol-hello', 'business-health-probe'])
      await waitForSocketCleanup(backend.sockets)
    } finally {
      await backend.close()
    }
  })
}

test('desktop readiness rejects a backend that destroys WebSocket upgrades', async () => {
  const backend = await fakeBackend('destroy-upgrade')
  try {
    await assert.rejects(
      probeDesktopBackendWebSocket({ baseUrl: backend.baseUrl, token: '', timeoutMs: 300 }),
      /WebSocket readiness probe failed|closed before readiness completed/,
    )
  } finally {
    await backend.close()
  }
})

test('desktop connection retries transient WebSocket startup within one deadline', async () => {
  const backend = await fakeBackend('transient-then-ready')
  const manager = connectionManager(backend.baseUrl, '/farming')
  try {
    await manager.connect('readiness-backend')
    assert.equal(manager.list()[0]?.status, 'ready')
    assert.equal(backend.upgradeAttempts, 3)
    assert.deepEqual(backend.upgradePaths, ['/farming/ws', '/farming/ws', '/farming/ws'])
    await waitForSocketCleanup(backend.sockets)
  } finally {
    manager.close()
    await backend.close()
  }
})

test('desktop connection fails fast for a permanently incompatible protocol', async () => {
  const backend = await fakeBackend('incompatible')
  const manager = connectionManager(backend.baseUrl)
  try {
    await assert.rejects(manager.connect('readiness-backend'), /protocol version/)
    assert.equal(manager.list()[0]?.status, 'error')
    assert.equal(backend.upgradeAttempts, 1)
    await waitForSocketCleanup(backend.sockets)
  } finally {
    manager.close()
    await backend.close()
  }
})

test('desktop connection does not retry terminal health or authentication failures', async t => {
  for (const [mode, message] of [
    ['failed-health', /terminal business status failed/],
    ['stopping-health', /terminal business status stopping/],
    ['close-4001', /authentication/i],
  ] as const) {
    await t.test(mode, async () => {
      const backend = await fakeBackend(mode)
      const manager = connectionManager(backend.baseUrl)
      try {
        await assert.rejects(manager.connect('readiness-backend'), message)
        assert.equal(manager.list()[0]?.status, 'error')
        assert.equal(backend.upgradeAttempts, 1)
        await waitForSocketCleanup(backend.sockets)
      } finally {
        manager.close()
        await backend.close()
      }
    })
  }
})

test('desktop readiness rejects incompatible, incomplete, and non-ready backends', async t => {
  for (const [mode, message] of [
    ['incompatible', /protocol version/],
    ['missing-state', /missing state/],
    ['ignored-health', /missing business health/],
    ['recovering-health', /backend is recovering.*reconnect/i],
    ['failed-health', /terminal business status failed/],
    ['stopping-health', /terminal business status stopping/],
    ['close-4001', /authentication/i],
  ] as const) {
    await t.test(mode, async () => {
      const backend = await fakeBackend(mode)
      try {
        await assert.rejects(
          probeDesktopBackendWebSocket({ baseUrl: backend.baseUrl, token: '', timeoutMs: 150 }),
          message,
        )
        await waitForSocketCleanup(backend.sockets)
      } finally {
        await backend.close()
      }
    })
  }
})

test('desktop readiness cancellation closes its exact socket', async () => {
  const backend = await fakeBackend('ignored-health')
  const controller = new AbortController()
  try {
    const probing = probeDesktopBackendWebSocket({
      baseUrl: backend.baseUrl,
      token: '',
      signal: controller.signal,
      timeoutMs: 2_000,
    })
    while (backend.sockets.size === 0) await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await assert.rejects(probing, DesktopBackendReadinessCancelledError)
    await waitForSocketCleanup(backend.sockets)
  } finally {
    await backend.close()
  }
})

test('desktop connection generation cannot become ready after cancellation', async () => {
  const backend = await fakeBackend('ignored-health')
  const manager = connectionManager(backend.baseUrl)
  try {
    const connecting = manager.connect('readiness-backend')
    while (backend.sockets.size === 0) await new Promise(resolve => setTimeout(resolve, 5))
    manager.disconnect('readiness-backend')
    await assert.rejects(connecting, /cancel/i)
    assert.equal(manager.list()[0]?.status, 'disconnected')
    await waitForSocketCleanup(backend.sockets)
  } finally {
    manager.close()
    await backend.close()
  }
})
