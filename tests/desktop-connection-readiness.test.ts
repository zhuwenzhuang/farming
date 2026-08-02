import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { PassThrough } from 'node:stream'
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

async function fakeBackend(mode: BackendMode, options: { hangCapabilities?: boolean } = {}) {
  let capabilityRequestCount = 0
  let capabilityAbortCount = 0
  const server = http.createServer((request, response) => {
    if (request.url?.endsWith('/api/auth/status')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ authRequired: false }))
      return
    }
    if (options.hangCapabilities && request.url?.endsWith('/capability')) {
      capabilityRequestCount += 1
      response.once('close', () => {
        if (!response.writableEnded) capabilityAbortCount += 1
      })
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
    port: address.port,
    observed,
    sockets,
    upgradePaths,
    get upgradeAttempts() {
      return upgradeAttempts
    },
    get capabilityRequestCount() {
      return capabilityRequestCount
    },
    get capabilityAbortCount() {
      return capabilityAbortCount
    },
    async close() {
      sockets.forEach(socket => socket.terminate())
      await new Promise<void>(resolve => webSockets.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function fakeSshChild() {
  let killCount = 0
  const child = new EventEmitter() as EventEmitter & {
    stderr: PassThrough
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: () => boolean
  }
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    killCount += 1
    return true
  }
  return {
    child: child as unknown as ChildProcess,
    get killCount() {
      return killCount
    },
    exit(message: string) {
      child.stderr.write(message)
      child.exitCode = 255
      child.emit('exit', 255, null)
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

function sshConnectionManager(backendPort: number, child: ChildProcess) {
  const profile: StoredDesktopBackendProfile = {
    id: 'ssh-readiness-backend',
    kind: 'remote',
    name: 'SSH readiness backend',
    transport: 'ssh',
    sshHost: 'example.test',
    remoteHost: '127.0.0.1',
    remotePort: 6694,
    basePath: '',
    directUrl: '',
    farmingHome: '',
    encryptedToken: '',
  }
  const profiles = {
    getStored: (backendId: string) => backendId === profile.id ? profile : null,
    list: () => [{ ...profile, hasToken: false }],
    readToken: () => '',
  } as unknown as DesktopProfileStore
  return new DesktopConnectionManager(profiles, {
    appVersion: '2.2.37-test',
    cacheDir: '',
    bootstrapRemoteServer: async () => ({
      protocolVersion: 1 as const,
      version: '2.2.37-test',
      platform: 'linux',
      arch: 'x64',
      farmingHome: '/tmp/farming-desktop-test',
      host: '127.0.0.1' as const,
      port: 6694,
      basePath: '',
      token: '',
      runtime: 'system',
    }),
    allocateLoopbackPort: async () => backendPort,
    spawnSshTunnel: () => child,
  })
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

test('desktop SSH exit during capability discovery never becomes ready', async () => {
  const backend = await fakeBackend('healthy-old-v4', { hangCapabilities: true })
  const tunnel = fakeSshChild()
  const manager = sshConnectionManager(backend.port, tunnel.child)
  const statuses: string[] = []
  manager.on('change', () => {
    const status = manager.list()[0]?.status
    if (status) statuses.push(status)
  })
  try {
    const connecting = manager.connect('ssh-readiness-backend')
    for (let attempt = 0; attempt < 1_000 && backend.capabilityRequestCount < 2; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(backend.capabilityRequestCount, 2, 'both capability requests must start before the SSH exit')
    tunnel.exit('ssh tunnel lost during capability discovery')
    await assert.rejects(connecting, /ssh tunnel lost during capability discovery/)
    for (let attempt = 0; attempt < 1_000 && backend.capabilityAbortCount < 2; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(statuses.includes('ready'), false)
    assert.equal(manager.target('ssh-readiness-backend'), null)
    assert.equal(backend.capabilityAbortCount, 2)
    assert.equal(tunnel.killCount, 1)
    assert.equal(manager.list()[0]?.status, 'error')
    assert.equal(manager.list()[0]?.server, null)
    assert.match(manager.list()[0]?.error || '', /ssh tunnel lost during capability discovery/)
  } finally {
    manager.close()
    await backend.close()
  }
})

test('desktop SSH lifetime listener marks a ready tunnel error', async () => {
  const backend = await fakeBackend('healthy-old-v4')
  const tunnel = fakeSshChild()
  const manager = sshConnectionManager(backend.port, tunnel.child)
  try {
    await manager.connect('ssh-readiness-backend')
    assert.equal(manager.list()[0]?.status, 'ready')
    assert.notEqual(manager.target('ssh-readiness-backend'), null)
    tunnel.exit('ssh tunnel closed after readiness')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(manager.list()[0]?.status, 'error')
    assert.equal(manager.list()[0]?.server, null)
    assert.equal(manager.target('ssh-readiness-backend'), null)
    assert.match(manager.list()[0]?.error || '', /ssh tunnel closed after readiness/)
  } finally {
    manager.close()
    await backend.close()
  }
})

test('desktop SSH late exit cannot mutate a disconnected generation', async () => {
  const backend = await fakeBackend('healthy-old-v4', { hangCapabilities: true })
  const tunnel = fakeSshChild()
  const manager = sshConnectionManager(backend.port, tunnel.child)
  try {
    const connecting = manager.connect('ssh-readiness-backend')
    for (let attempt = 0; attempt < 1_000 && backend.capabilityRequestCount < 2; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(backend.capabilityRequestCount, 2, 'both capability requests must start before disconnect')
    manager.disconnect('ssh-readiness-backend')
    await assert.rejects(connecting, /cancel/i)
    tunnel.exit('late exit from obsolete SSH child')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(manager.list()[0]?.status, 'disconnected')
    assert.equal(manager.list()[0]?.error, '')
    assert.equal(manager.target('ssh-readiness-backend'), null)
  } finally {
    manager.close()
    await backend.close()
  }
})
