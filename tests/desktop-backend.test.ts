import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DesktopBackendActivationState,
} from '../desktop/backend-activation-state'
import { resolveDesktopServerVersion } from '../desktop/app-version'
import { buildSshTunnelArgs } from '../desktop/connection-manager'
import { validateDesktopRendererAssets } from '../desktop/gateway'
import { DesktopLifecycle } from '../desktop/lifecycle'
import { DesktopLocalBackend, LOCAL_BACKEND_ID } from '../desktop/local-backend'
import { allowsDesktopAudioPermission } from '../desktop/permissions'
import { DesktopProfileStore } from '../desktop/profile-store'
import { saveAndActivateDesktopBackend } from '../desktop/save-and-activate'
import {
  DESKTOP_STARTUP_CANCEL_URL,
  DesktopStartupVisibility,
  desktopStartupDocument,
} from '../desktop/startup-view'
import {
  DesktopStartupCancelledError,
  DesktopStartupResourceOwner,
} from '../desktop/startup-resource-owner'
import {
  normalizeDesktopBackendInput,
  publicDesktopBackendProfile,
  type StoredDesktopBackendProfile,
} from '../desktop/profile-model'
import { bearerCredential, joinUpstreamUrl } from '../desktop/upstream'
import {
  buildRemoteBootstrapScript,
  buildRemoteUploadCommand,
  DesktopRemoteOperationCancelledError,
  downloadDesktopReleaseUrl,
  normalizeDesktopReleaseRoot,
  normalizeDesktopServerVersion,
  parseRemoteServerHandshake,
  runCommand,
  shellQuote,
} from '../desktop/remote-bootstrap'

test('desktop lifecycle coalesces route invalidations while a window is loading', () => {
  const lifecycle = new DesktopLifecycle()
  lifecycle.start()
  const initial = lifecycle.openWindow()
  assert.equal(lifecycle.invalidateRendererRoute(), true)
  assert.equal(lifecycle.invalidateRendererRoute(), true)

  const retry = lifecycle.navigationReady(initial)
  assert.equal(retry.kind, 'reload')
  if (retry.kind !== 'reload') return
  assert.equal(retry.token.routeRevision, 2)
  assert.deepEqual(lifecycle.navigationReady(retry.token), { kind: 'ready' })
  assert.deepEqual(lifecycle.snapshot(), {
    appPhase: 'running',
    loadedRouteRevision: 2,
    routeRevision: 2,
    windowGeneration: 1,
    windowPhase: 'ready',
  })
})

test('desktop lifecycle ignores stale window completion after close and reopen', () => {
  const lifecycle = new DesktopLifecycle()
  lifecycle.start()
  const stale = lifecycle.openWindow()
  lifecycle.closeWindow(stale.windowGeneration)
  const current = lifecycle.openWindow()

  assert.deepEqual(lifecycle.navigationReady(stale), { kind: 'ignore' })
  assert.deepEqual(lifecycle.navigationReady(current), { kind: 'ready' })
  assert.equal(lifecycle.snapshot().windowGeneration, 2)
})

test('desktop lifecycle makes shutdown terminal and suppresses late UI effects', () => {
  const lifecycle = new DesktopLifecycle()
  lifecycle.start()
  const navigation = lifecycle.openWindow()

  assert.equal(lifecycle.beginStop(), true)
  assert.equal(lifecycle.beginStop(), false)
  assert.equal(lifecycle.invalidateRendererRoute(), false)
  assert.deepEqual(lifecycle.navigationReady(navigation), { kind: 'ignore' })
  lifecycle.finishStop()
  assert.deepEqual(lifecycle.snapshot(), {
    appPhase: 'stopped',
    loadedRouteRevision: -1,
    routeRevision: 0,
    windowGeneration: 2,
    windowPhase: 'absent',
  })
  assert.throws(() => lifecycle.openWindow(), /Desktop is stopped/)
})

test('desktop lifecycle retries the newest route when an obsolete navigation fails', () => {
  const lifecycle = new DesktopLifecycle()
  lifecycle.start()
  const initial = lifecycle.openWindow()
  assert.deepEqual(lifecycle.navigationReady(initial), { kind: 'ready' })
  assert.equal(lifecycle.invalidateRendererRoute(), true)
  const obsolete = lifecycle.beginPendingNavigation()
  assert.ok(obsolete)
  assert.equal(lifecycle.invalidateRendererRoute(), true)

  const retry = lifecycle.navigationFailed(obsolete)
  assert.equal(retry.kind, 'reload')
  if (retry.kind !== 'reload') return
  assert.equal(retry.token.routeRevision, 2)
  assert.deepEqual(lifecycle.navigationReady(retry.token), { kind: 'ready' })
})

test('desktop lifecycle batches ready-window invalidations before navigation begins', () => {
  const lifecycle = new DesktopLifecycle()
  lifecycle.start()
  const initial = lifecycle.openWindow()
  assert.deepEqual(lifecycle.navigationReady(initial), { kind: 'ready' })

  lifecycle.invalidateRendererRoute()
  lifecycle.invalidateRendererRoute()
  const navigation = lifecycle.beginPendingNavigation()
  assert.equal(navigation?.routeRevision, 2)
  assert.equal(lifecycle.beginPendingNavigation(), null)
  assert.ok(navigation)
  assert.deepEqual(lifecycle.navigationReady(navigation), { kind: 'ready' })
})

test('editing the active backend invalidates its route before a replacement connection can fail', async () => {
  const activations = new DesktopBackendActivationState()
  const effects: string[] = []
  let rejectConnection: (error: Error) => void = () => {}
  const connection = new Promise<void>((_resolve, reject) => {
    rejectConnection = reject
  })
  const operation = saveAndActivateDesktopBackend({
    activations,
    activeBackendId: 'backend-a',
    editingBackendId: 'backend-a',
    save: () => {
      effects.push('save-profile')
      return { id: 'backend-a' }
    },
    disconnect: () => effects.push('disconnect-old-target'),
    closeActiveClientConnections: () => effects.push('close-old-clients'),
    broadcastState: () => effects.push('broadcast-state'),
    connect: () => {
      effects.push('activate-dispatched')
      return connection
    },
    assertRunning: () => effects.push('assert-running'),
    setActiveBackendId: () => effects.push('commit-active'),
    requestRendererNavigation: () => {
      effects.push('request-navigation')
      setImmediate(() => effects.push('scheduled-drain'))
    },
  }).catch(error => {
    effects.push('save-response-rejected')
    throw error
  })

  assert.deepEqual(effects, [
    'save-profile',
    'disconnect-old-target',
    'close-old-clients',
    'broadcast-state',
    'activate-dispatched',
  ])
  rejectConnection(new Error('replacement backend is unreachable'))
  await assert.rejects(operation, /replacement backend is unreachable/)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(effects, [
    'save-profile',
    'disconnect-old-target',
    'close-old-clients',
    'broadcast-state',
    'activate-dispatched',
    'save-response-rejected',
  ])
})

test('successful atomic save responds before its scheduled renderer drain', async () => {
  const activations = new DesktopBackendActivationState()
  const effects: string[] = []
  const operation = saveAndActivateDesktopBackend({
    activations,
    activeBackendId: 'backend-a',
    editingBackendId: 'backend-a',
    save: () => ({ id: 'backend-a' }),
    disconnect: () => effects.push('disconnect-old-target'),
    closeActiveClientConnections: () => effects.push('close-old-clients'),
    broadcastState: () => effects.push('broadcast-state'),
    connect: async () => {
      effects.push('activate-dispatched')
    },
    assertRunning: () => effects.push('assert-running'),
    setActiveBackendId: () => effects.push('commit-active'),
    requestRendererNavigation: () => {
      effects.push('request-navigation')
      setImmediate(() => effects.push('scheduled-drain'))
    },
  }).then(() => effects.push('save-response'))

  await operation
  assert.equal(effects.at(-1), 'save-response')
  assert.equal(effects.includes('scheduled-drain'), false)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(effects.slice(-3), ['request-navigation', 'save-response', 'scheduled-drain'])
})

test('backend activation ownership ignores unrelated mutations and rejects stale A/B completion', async () => {
  const activations = new DesktopBackendActivationState()
  const activationA = activations.begin('backend-a')
  let resolveA: () => void = () => {}
  let resolveB: () => void = () => {}
  const connectionA = new Promise<void>(resolve => { resolveA = resolve })
  const connectionB = new Promise<void>(resolve => { resolveB = resolve })
  const committed: string[] = []
  const completionA = connectionA.then(() => {
    if (activations.claim(activationA)) committed.push('backend-a')
  })

  assert.deepEqual(
    activations.backendChanged('backend-b', 'backend-b'),
    { activationCancelled: false, invalidateActiveRoute: true },
  )
  assert.equal(activations.isCurrent(activationA), true)

  const activationB = activations.begin('backend-b')
  const completionB = connectionB.then(() => {
    if (activations.claim(activationB)) committed.push('backend-b')
  })
  assert.equal(activations.isCurrent(activationA), false)
  resolveB()
  await completionB
  resolveA()
  await completionA
  assert.deepEqual(committed, ['backend-b'])

  const retryA = activations.begin('backend-a')
  assert.deepEqual(
    activations.backendChanged('backend-a', 'backend-b'),
    { activationCancelled: true, invalidateActiveRoute: false },
  )
  assert.equal(activations.isCurrent(retryA), false)
})

test('desktop startup document exposes visible progress and a cancellation action', () => {
  const document = desktopStartupDocument('Preparing local Farming environment…')
  assert.match(document, /aria-live="polite"/)
  assert.match(document, /Preparing local Farming environment/)
  assert.match(document, /Cancel startup/)
  assert.match(document, new RegExp(DESKTOP_STARTUP_CANCEL_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('desktop startup visibility suppresses the transient page on a fast launch', () => {
  const fastLaunch = new DesktopStartupVisibility()
  assert.equal(fastLaunch.complete(), true)
  assert.equal(fastLaunch.reveal(), false)

  const slowLaunch = new DesktopStartupVisibility()
  assert.equal(slowLaunch.reveal(), true)
  assert.equal(slowLaunch.reveal(), false)
  assert.equal(slowLaunch.complete(), true)
})

test('startup resource owner cancels exactly as local start resolves', async () => {
  const owner = new DesktopStartupResourceOwner()
  const cleanup: string[] = []
  owner.own('local-backend', async () => { cleanup.push('local-backend') })
  let resolveLocalStart: () => void = () => {}
  const localStart = new Promise<void>(resolve => { resolveLocalStart = resolve })
  let managerCreated = false
  const pipeline = (async () => {
    await localStart
    owner.guard()
    managerCreated = true
    owner.own('connection-manager', () => { cleanup.push('connection-manager') })
  })()

  resolveLocalStart()
  const stopping = owner.stop()
  await assert.rejects(pipeline, DesktopStartupCancelledError)
  await stopping
  assert.equal(managerCreated, false)
  assert.deepEqual(cleanup, ['local-backend'])
})

test('startup resource owner cleans a gateway cancelled while listen is pending', async () => {
  const owner = new DesktopStartupResourceOwner()
  const cleanup: string[] = []
  let resolveListen: () => void = () => {}
  const listen = new Promise<void>(resolve => { resolveListen = resolve })
  let committed = false
  owner.own('local-backend', () => { cleanup.push('local-backend') })
  const pipeline = (async () => {
    owner.guard()
    owner.own('gateway', async () => { cleanup.push('gateway') })
    owner.own('connection-manager', () => { cleanup.push('connection-manager') })
    await listen
    owner.guard()
    committed = true
  })()
  await Promise.resolve()

  const stopping = owner.stop()
  resolveListen()
  await assert.rejects(pipeline, DesktopStartupCancelledError)
  await stopping
  assert.equal(committed, false)
  assert.deepEqual(cleanup, ['connection-manager', 'gateway', 'local-backend'])
})

test('ships branded PNG and macOS icon assets for the desktop application', () => {
  const assetsDir = path.join(__dirname, '..', 'desktop', 'assets')
  const png = fs.readFileSync(path.join(assetsDir, 'farming-desktop.png'))
  const icns = fs.readFileSync(path.join(assetsDir, 'Farming.icns'))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 1024)
  assert.equal(png.readUInt32BE(20), 1024)
  assert.equal(png[25], 6, 'Desktop PNG must retain RGBA transparency for rounded macOS corners.')
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns')
})

test('desktop development resolves its Server version from the repository manifest', () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-version-'))
  const manifest = path.join(temporaryDir, 'package.json')
  try {
    fs.writeFileSync(manifest, JSON.stringify({ version: '2.2.37' }))
    assert.equal(resolveDesktopServerVersion({
      electronVersion: '42.3.3',
      packageJsonPath: manifest,
      isPackaged: false,
    }), '2.2.37')
    assert.equal(resolveDesktopServerVersion({
      electronVersion: '2.3.0',
      packageJsonPath: manifest,
      isPackaged: true,
    }), '2.3.0')
    assert.equal(resolveDesktopServerVersion({
      electronVersion: '2.3.0',
      packageJsonPath: manifest,
      isPackaged: true,
      overrideVersion: '2.4.0',
    }), '2.4.0')
    fs.writeFileSync(manifest, JSON.stringify({ name: 'farming-code' }))
    assert.throws(() => resolveDesktopServerVersion({
      electronVersion: '42.3.3',
      packageJsonPath: manifest,
      isPackaged: false,
    }), /Farming Server version is missing or invalid/)
    fs.writeFileSync(manifest, JSON.stringify({ version: 'Electron' }))
    assert.throws(() => resolveDesktopServerVersion({
      electronVersion: '42.3.3',
      packageJsonPath: manifest,
      isPackaged: false,
    }), /Farming Server version is missing or invalid/)
    fs.writeFileSync(manifest, '{invalid json')
    assert.throws(() => resolveDesktopServerVersion({
      electronVersion: '42.3.3',
      packageJsonPath: manifest,
      isPackaged: false,
    }), /Could not resolve the Farming Server version/)
    fs.rmSync(manifest)
    assert.throws(() => resolveDesktopServerVersion({
      electronVersion: '42.3.3',
      packageJsonPath: manifest,
      isPackaged: false,
    }), /Could not resolve the Farming Server version/)
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('removing the active remote backend falls back to the built-in local backend', () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-profiles-'))
  const stateFile = path.join(temporaryDir, 'backends.json')
  const localProfile: StoredDesktopBackendProfile = {
    id: LOCAL_BACKEND_ID,
    kind: 'local',
    name: 'This Mac',
    transport: 'direct',
    sshHost: '',
    remoteHost: '127.0.0.1',
    remotePort: 0,
    basePath: '/farming',
    directUrl: 'http://127.0.0.1:43121',
    farmingHome: path.join(temporaryDir, 'local'),
    encryptedToken: '',
  }
  try {
    const store = new DesktopProfileStore(stateFile, [{ profile: localProfile, token: 'local-token' }])
    const remote = store.save({
      name: 'Build host',
      transport: 'direct',
      directUrl: 'http://127.0.0.1:43122',
    })
    store.setActiveBackendId(remote.id)

    store.remove(remote.id)

    assert.equal(store.getActiveBackendId(), LOCAL_BACKEND_ID)
    assert.deepEqual(store.list().map(profile => profile.id), [LOCAL_BACKEND_ID])
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('desktop profile tokens use the injected system credential storage', () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-credentials-'))
  const stateFile = path.join(temporaryDir, 'backends.json')
  const credentialStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  }
  try {
    const store = new DesktopProfileStore(stateFile, [], credentialStorage)
    const remote = store.save({
      name: 'Build host',
      transport: 'direct',
      directUrl: 'http://127.0.0.1:43122',
      token: 'desktop-secret',
    })

    assert.equal(store.readToken(remote.id), 'desktop-secret')
    assert.equal(fs.readFileSync(stateFile, 'utf8').includes('desktop-secret'), false)
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('local backend lifecycle coalesces start and makes stop idempotent', async () => {
  const runtime = new DesktopLocalBackend({
    configDir: '/tmp/farming-desktop-local-test',
    electronExecutable: '/unused/electron',
    resourcesPath: '/unused/resources',
    repositoryRoot: '/unused/repository',
    injectedUrl: 'http://127.0.0.1:43121/farming/',
    injectedToken: 'local-token',
  })
  const firstStart = runtime.start()
  const secondStart = runtime.start()
  assert.equal(firstStart, secondStart)
  const target = await firstStart
  assert.equal(runtime.state(), 'ready')
  assert.equal(target.profile.id, LOCAL_BACKEND_ID)
  assert.equal(target.profile.kind, 'local')
  assert.equal(target.profile.directUrl, 'http://127.0.0.1:43121')
  assert.equal(target.profile.basePath, '/farming')
  assert.equal(target.token, 'local-token')
  await Promise.all([runtime.stop(), runtime.stop()])
  assert.equal(runtime.state(), 'stopped')
})

test('desktop local startup is pinned to the npm-prepared runtime seed and forbids downloads', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-local-seed-'))
  const cli = path.join(temporaryDir, 'seed-cli.cjs')
  const observedEnv = path.join(temporaryDir, 'runtime-env.json')
  fs.writeFileSync(cli, `
const fs = require('node:fs')
const path = require('node:path')
if (process.argv[2] === 'stop') process.exit(0)
fs.writeFileSync(${JSON.stringify(observedEnv)}, JSON.stringify({
  policy: process.env.FARMING_RUNTIME_DOWNLOAD_POLICY,
  seed: process.env.FARMING_RUNTIME_SEED_DIR,
}))
const configDir = process.argv[process.argv.indexOf('--config-dir') + 1]
fs.mkdirSync(configDir, { recursive: true })
fs.writeFileSync(path.join(configDir, 'farming-server.json'), JSON.stringify({ port: 43123, basePath: '/farming' }))
fs.writeFileSync(path.join(configDir, '.session-token'), 'seed-token')
process.exit(0)
`)
  const runtime = new DesktopLocalBackend({
    configDir: path.join(temporaryDir, 'config'),
    electronExecutable: process.execPath,
    resourcesPath: temporaryDir,
    repositoryRoot: temporaryDir,
    cliPath: cli,
  })
  try {
    await runtime.start()
    assert.deepEqual(JSON.parse(fs.readFileSync(observedEnv, 'utf8')), {
      policy: 'forbid',
      seed: path.join(temporaryDir, '.farming-runtime-seed'),
    })
    await runtime.stop()
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('local backend startup watchdog accepts active dependency progress but bounds a stall', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-local-watchdog-'))
  const progressingCli = path.join(temporaryDir, 'progressing-cli.cjs')
  const stalledCli = path.join(temporaryDir, 'stalled-cli.cjs')
  fs.writeFileSync(progressingCli, `
const fs = require('node:fs')
const path = require('node:path')
const command = process.argv[2]
if (command === 'stop') process.exit(0)
const configIndex = process.argv.indexOf('--config-dir')
const configDir = process.argv[configIndex + 1]
const progress = setInterval(() => process.stdout.write('Downloading dependency...\\n'), 20)
setTimeout(() => {
  clearInterval(progress)
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'farming-server.json'), JSON.stringify({ port: 43122, basePath: '/farming' }))
  fs.writeFileSync(path.join(configDir, '.session-token'), 'watchdog-token')
  process.exit(0)
}, 140)
`)
  fs.writeFileSync(stalledCli, `
if (process.argv[2] === 'stop') process.exit(0)
setInterval(() => {}, 1000)
`)
  const policy = {
    daemon: { absoluteTimeoutMs: 5_000, idleTimeoutMs: 2_000, killGraceMs: 50 },
    stop: { absoluteTimeoutMs: 2_000, idleTimeoutMs: 1_000, killGraceMs: 50 },
  }
  try {
    const visibleProgress: string[] = []
    const progressing = new DesktopLocalBackend({
      configDir: path.join(temporaryDir, 'progressing-config'),
      electronExecutable: process.execPath,
      resourcesPath: temporaryDir,
      repositoryRoot: temporaryDir,
      cliPath: progressingCli,
      commandPolicies: policy,
      handshakeTimeoutMs: 100,
      onProgress: message => visibleProgress.push(message),
    })
    const target = await progressing.start()
    assert.equal(target.token, 'watchdog-token')
    assert.equal(progressing.state(), 'ready')
    assert.match(visibleProgress.join('\n'), /Downloading dependency/)
    await progressing.stop()

    const stalled = new DesktopLocalBackend({
      configDir: path.join(temporaryDir, 'stalled-config'),
      electronExecutable: process.execPath,
      resourcesPath: temporaryDir,
      repositoryRoot: temporaryDir,
      cliPath: stalledCli,
      commandPolicies: policy,
      handshakeTimeoutMs: 100,
    })
    await assert.rejects(stalled.start(), /produced no command progress/)
    assert.equal(stalled.state(), 'failed')

    const cancellable = new DesktopLocalBackend({
      configDir: path.join(temporaryDir, 'cancelled-config'),
      electronExecutable: process.execPath,
      resourcesPath: temporaryDir,
      repositoryRoot: temporaryDir,
      cliPath: stalledCli,
      handshakeTimeoutMs: 100,
      commandPolicies: {
        daemon: { absoluteTimeoutMs: 5_000, idleTimeoutMs: 5_000, killGraceMs: 20 },
        stop: policy.stop,
      },
    })
    const starting = cancellable.start()
    await new Promise(resolve => setTimeout(resolve, 30))
    const stopping = cancellable.stop()
    await assert.rejects(starting, /was cancelled/)
    await stopping
    assert.equal(cancellable.state(), 'stopped')
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('local backend best-effort stop cleans a partially started failed daemon', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-local-failed-'))
  const cli = path.join(temporaryDir, 'partial-cli.cjs')
  const cleanupMarker = path.join(temporaryDir, 'cleanup-complete')
  fs.writeFileSync(cli, `
const fs = require('node:fs')
const command = process.argv[2]
if (command === 'daemon') {
  process.stderr.write('daemon failed after partial startup\\n')
  process.exit(2)
}
if (command === 'stop') {
  fs.writeFileSync(${JSON.stringify(cleanupMarker)}, 'stopped')
  process.exit(0)
}
`)
  const runtime = new DesktopLocalBackend({
    configDir: path.join(temporaryDir, 'config'),
    electronExecutable: process.execPath,
    resourcesPath: temporaryDir,
    repositoryRoot: temporaryDir,
    cliPath: cli,
    commandPolicies: {
      daemon: { absoluteTimeoutMs: 5_000, idleTimeoutMs: 2_000, killGraceMs: 50 },
      stop: { absoluteTimeoutMs: 2_000, idleTimeoutMs: 1_000, killGraceMs: 50 },
    },
    handshakeTimeoutMs: 100,
  })
  try {
    await assert.rejects(runtime.start(), /partial startup/)
    assert.equal(runtime.state(), 'failed')
    await runtime.stop()
    assert.equal(runtime.state(), 'stopped')
    assert.equal(fs.readFileSync(cleanupMarker, 'utf8'), 'stopped')
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('local backend cancellation interrupts a pending handshake before cleanup', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-local-handshake-'))
  const cli = path.join(temporaryDir, 'handshake-cli.cjs')
  const cleanupMarker = path.join(temporaryDir, 'cleanup-complete')
  let resolveHandshakePending: () => void = () => {}
  const handshakePending = new Promise<void>(resolve => { resolveHandshakePending = resolve })
  fs.writeFileSync(cli, `
const fs = require('node:fs')
if (process.argv[2] === 'stop') {
  fs.writeFileSync(${JSON.stringify(cleanupMarker)}, 'stopped')
  process.exit(0)
}
process.exit(0)
`)
  const runtime = new DesktopLocalBackend({
    configDir: path.join(temporaryDir, 'config'),
    electronExecutable: process.execPath,
    resourcesPath: temporaryDir,
    repositoryRoot: temporaryDir,
    cliPath: cli,
    handshakeTimeoutMs: 5_000,
    commandPolicies: {
      daemon: { absoluteTimeoutMs: 5_000, idleTimeoutMs: 2_000, killGraceMs: 50 },
      stop: { absoluteTimeoutMs: 2_000, idleTimeoutMs: 1_000, killGraceMs: 50 },
    },
    onProgress: message => {
      if (message === 'Waiting for the local Farming Server…') resolveHandshakePending()
    },
  })
  try {
    const starting = runtime.start()
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('local backend never entered handshake polling')),
        2_000,
      )
      void handshakePending.then(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
    const stoppedAt = Date.now()
    await runtime.stop()
    assert.ok(Date.now() - stoppedAt < 500, 'handshake cancellation must not wait for its five second deadline')
    await assert.rejects(starting, /cancelled/)
    assert.equal(fs.readFileSync(cleanupMarker, 'utf8'), 'stopped')
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('normalizes an SSH backend without weakening OpenSSH host verification', () => {
  const profile = normalizeDesktopBackendInput({
    name: 'Development',
    transport: 'ssh',
    sshHost: 'dev-box',
    remotePort: 6694,
    basePath: 'farming/',
  })

  assert.equal(profile.farmingHome, '~/.farming-desktop')
  assert.equal(profile.basePath, '/farming')
  const args = buildSshTunnelArgs(profile.sshHost, '127.0.0.1', 6694, 54321)
  assert.deepEqual(args.slice(0, 8), [
    '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
  ])
  assert.ok(args.includes('127.0.0.1:54321:127.0.0.1:6694'))
  assert.equal(args.at(-1), 'dev-box')
  assert.equal(args.some(argument => argument.includes('StrictHostKeyChecking=no')), false)
})

test('rejects option-shaped SSH hosts and ambiguous direct URLs', () => {
  assert.throws(() => normalizeDesktopBackendInput({
    name: 'Unsafe',
    transport: 'ssh',
    sshHost: '-oProxyCommand=bad',
  }), /cannot start with a dash/)

  assert.throws(() => normalizeDesktopBackendInput({
    name: 'Direct',
    transport: 'direct',
    directUrl: 'http://127.0.0.1:3000/farming',
  }), /Base path field/)
})

test('never exposes the encrypted backend token to the renderer contract', () => {
  const stored: StoredDesktopBackendProfile = {
    id: 'backend-1',
    kind: 'remote',
    name: 'Backend',
    transport: 'direct',
    sshHost: '',
    remoteHost: '127.0.0.1',
    remotePort: 3000,
    basePath: '',
    directUrl: 'http://127.0.0.1:3000',
    farmingHome: '~/.farming-desktop',
    encryptedToken: 'ciphertext',
  }
  const profile = publicDesktopBackendProfile(stored)
  assert.equal(profile.hasToken, true)
  assert.equal('encryptedToken' in profile, false)
})

test('parses the versioned remote bootstrap handshake without exposing shell output', () => {
  const handshake = parseRemoteServerHandshake(`noise\nFARMING_DESKTOP_HANDSHAKE_BEGIN
protocolVersion=1
version=2.2.35
platform=linux
arch=amd64
farmingHomeHex=2f686f6d652f6465762f2e6661726d696e672d6465736b746f70
port=6694
basePathHex=2f6661726d696e67
tokenHex=7465737420746f6b656e
runtimeHex=7673636f64652d637573746f6d2d676c696263
FARMING_DESKTOP_HANDSHAKE_END\n`)
  assert.deepEqual(handshake, {
    protocolVersion: 1,
    version: '2.2.35',
    platform: 'linux',
    arch: 'amd64',
    farmingHome: '/home/dev/.farming-desktop',
    host: '127.0.0.1',
    port: 6694,
    basePath: '/farming',
    token: 'test token',
    runtime: 'vscode-custom-glibc',
  })
})

test('remote bootstrap reuses a validated custom glibc runtime on legacy Linux', () => {
  const script = buildRemoteBootstrapScript()
  assert.match(script, /FARMING_SERVER_CUSTOM_GLIBC_LINKER/)
  assert.match(script, /VSCODE_SERVER_CUSTOM_GLIBC_LINKER/)
  assert.match(script, /--set-interpreter/)
  assert.match(script, /LD_LIBRARY_PATH=/)
  assert.match(script, /FARMING_NODE_LD=/)
  assert.match(script, /FARMING_NODE_LIBRARY_PATH=/)
  assert.match(script, /FARMING_DESKTOP_COMPAT_GLIBC_PATH=/)
  assert.match(script, /FARMING_DESKTOP_INHERITED_LD_LIBRARY_PATH=/)
  assert.doesNotMatch(script, /--set-rpath/)
  assert.match(script, /--max-time 45/)
  assert.match(script, /mv "\$patched" "\$binary"/)
  assert.match(script, /Remote Server output \(last 30 lines\)/)
  assert.match(script, /tail -c 4096/)
})

test('desktop release mirrors keep the same bounded HTTP checksum contract', () => {
  assert.equal(normalizeDesktopReleaseRoot('https://releases.example.test/farming/'), 'https://releases.example.test/farming')
  assert.throws(() => normalizeDesktopReleaseRoot('file:///tmp/releases'), /HTTP\(S\)/)
  assert.throws(() => normalizeDesktopReleaseRoot('https://user:secret@example.test/releases'), /without credentials/)
  const script = buildRemoteBootstrapScript()
  assert.match(script, /checksum_limit=262144/)
  assert.match(script, /asset_limit=536870912/)
  assert.doesNotMatch(script, /ulimit/)
  assert.match(script, /--max-filesize "\$limit"/)
  assert.match(script, /head -c "\$\(\(limit \+ 1\)\)"/)
  assert.match(script, /trap cleanup_download EXIT/)
  assert.match(script, /trap abort_download HUP INT TERM/)
  assert.match(script, /kill "\$wget_pid"/)
  assert.match(script, /mkfifo "\$download_fifo"/)
  assert.match(script, /wait "\$wget_pid"/)
  assert.match(script, /actual_size=\$\(wc -c < "\$target"/)
  assert.match(script, /rm -f "\$target"/)
  assert.match(script, /download "\$sums_url" "\$sums" "\$checksum_limit"/)
  assert.match(script, /download "\$asset_url" "\$tmp" "\$asset_limit"/)
})

test('remote bootstrap TERM cleans its exact wget process and temporary files', async t => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-wget-term-'))
  const binaryDir = path.join(temporaryDir, 'bin')
  const farmingHome = path.join(temporaryDir, 'home')
  fs.mkdirSync(binaryDir)
  const commandNames = ['awk', 'head', 'mkdir', 'mkfifo', 'rm', 'tr', 'uname', 'wc']
  const commands = Object.fromEntries(commandNames.map(name => [
    name,
    spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim(),
  ]))
  if (Object.values(commands).some(target => !target)) {
    fs.rmSync(temporaryDir, { recursive: true, force: true })
    t.skip('The wget cancellation smoke requires standard shell tools.')
    return
  }
  Object.entries(commands).forEach(([name, target]) => fs.symlinkSync(target, path.join(binaryDir, name)))
  const fakeWget = path.join(binaryDir, 'wget')
  fs.writeFileSync(fakeWget, `#!/bin/sh
trap 'exit 0' HUP INT TERM
while :; do
  printf 'download-in-progress'
  /bin/sleep 0.02
done
`)
  fs.chmodSync(fakeWget, 0o700)
  const child = spawn('/bin/sh', ['-s'], {
    detached: true,
    env: {
      HOME: farmingHome,
      PATH: binaryDir,
      FARMING_HOME: farmingHome,
      FARMING_RELEASE_ROOT: 'http://release.invalid',
      FARMING_VERSION: 'term-version',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.stdin.end(buildRemoteBootstrapScript())
  const installDir = path.join(farmingHome, 'server', 'term-version')
  try {
    const deadline = Date.now() + 2_000
    while (
      (!fs.existsSync(installDir) || fs.readdirSync(installDir).length === 0)
      && Date.now() < deadline
    ) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(fs.existsSync(installDir) && fs.readdirSync(installDir).length > 0, stderr)
    process.kill(-child.pid!, 'SIGTERM')
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    assert.notEqual(exitCode, 0)
    assert.deepEqual(fs.readdirSync(installDir), [])
  } finally {
    if (child.exitCode === null) {
      try { process.kill(-child.pid!, 'SIGKILL') } catch {}
    }
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('remote wget path deletes an oversized stream without relying on ulimit', async t => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-wget-cap-'))
  const binaryDir = path.join(temporaryDir, 'bin')
  const farmingHome = path.join(temporaryDir, 'home')
  fs.mkdirSync(binaryDir)
  const commandNames = ['awk', 'head', 'mkdir', 'mkfifo', 'rm', 'tr', 'uname', 'wc', 'wget']
  const commands = Object.fromEntries(commandNames.map(name => [
    name,
    spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim(),
  ]))
  if (Object.values(commands).some(target => !target)) {
    fs.rmSync(temporaryDir, { recursive: true, force: true })
    t.skip('The wget cap smoke requires standard shell tools and wget.')
    return
  }
  Object.entries(commands).forEach(([name, target]) => fs.symlinkSync(target, path.join(binaryDir, name)))
  const server = http.createServer((_request, response) => {
    response.writeHead(200)
    response.end(Buffer.alloc(262_145, 0x61))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const child = spawn('/bin/sh', ['-s'], {
      env: {
        HOME: farmingHome,
        PATH: binaryDir,
        FARMING_HOME: farmingHome,
        FARMING_RELEASE_ROOT: `http://127.0.0.1:${address.port}`,
        FARMING_VERSION: 'test-version',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.stdin.end(buildRemoteBootstrapScript())
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    assert.equal(exitCode, 42, `${stdout}\n${stderr}`)
    assert.match(stderr, /Release checksum exceeds its 262144 byte limit/)
    const installDir = path.join(farmingHome, 'server', 'test-version')
    assert.deepEqual(fs.readdirSync(installDir), [])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('desktop release download reports progress and has bounded cancellation and stalls', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-download-'))
  const sockets = new Set<import('node:net').Socket>()
  let writeFailureStreamsClosed = 0
  let activeWriteFailureStreams = 0
  const server = http.createServer((request, response) => {
    if (request.url === '/progress') {
      response.writeHead(200, { 'content-length': '12' })
      response.write('hello ')
      setTimeout(() => response.end('world!'), 15)
      return
    }
    if (request.url === '/oversized-header') {
      response.writeHead(200, { 'content-length': '1000' })
      response.end('too large')
      return
    }
    if (request.url === '/unbounded') {
      response.writeHead(200)
      response.write('12345678')
      response.end('overflow')
      return
    }
    if (request.url === '/write-failure') {
      response.writeHead(200)
      activeWriteFailureStreams += 1
      const interval = setInterval(() => response.write('streaming-body'), 5)
      response.once('close', () => {
        clearInterval(interval)
        activeWriteFailureStreams -= 1
        writeFailureStreamsClosed += 1
      })
      return
    }
    response.writeHead(200, { 'content-length': '12' })
    response.write('stalled')
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const root = `http://127.0.0.1:${address.port}`
  try {
    const progress: string[] = []
    const completed = path.join(temporaryDir, 'completed')
    await downloadDesktopReleaseUrl(`${root}/progress`, completed, 'Test download', {
      timeoutMs: 500,
      idleTimeoutMs: 100,
      onProgress: message => progress.push(message),
    })
    assert.equal(fs.readFileSync(completed, 'utf8'), 'hello world!')
    assert.match(progress.join('\n'), /100%/)
    assert.match(progress.at(-1) || '', /downloaded, verifying/)

    const stalled = path.join(temporaryDir, 'stalled')
    await assert.rejects(
      downloadDesktopReleaseUrl(`${root}/stall`, stalled, 'Stalled download', {
        timeoutMs: 160,
        idleTimeoutMs: 25,
      }),
      /produced no download progress|deadline/,
    )
    assert.equal(fs.existsSync(stalled), false)

    const controller = new AbortController()
    const cancelled = path.join(temporaryDir, 'cancelled')
    const cancellation = downloadDesktopReleaseUrl(`${root}/stall`, cancelled, 'Cancelled download', {
      signal: controller.signal,
      timeoutMs: 500,
      idleTimeoutMs: 250,
    })
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(cancellation, DesktopRemoteOperationCancelledError)
    assert.equal(fs.existsSync(cancelled), false)

    const oversizedHeader = path.join(temporaryDir, 'oversized-header')
    await assert.rejects(
      downloadDesktopReleaseUrl(`${root}/oversized-header`, oversizedHeader, 'Oversized header', {
        maxBytes: 16,
      }),
      /exceeds the 16 byte limit/,
    )
    assert.equal(fs.existsSync(oversizedHeader), false)

    const unbounded = path.join(temporaryDir, 'unbounded')
    await assert.rejects(
      downloadDesktopReleaseUrl(`${root}/unbounded`, unbounded, 'Unbounded download', {
        maxBytes: 12,
      }),
      /exceeds the 12 byte limit/,
    )
    assert.equal(fs.existsSync(unbounded), false)

    const unwritableTarget = path.join(temporaryDir, 'missing-parent', 'target')
    await assert.rejects(
      downloadDesktopReleaseUrl(`${root}/write-failure`, unwritableTarget, 'Write failure', {
        timeoutMs: 3_000,
        idleTimeoutMs: 500,
      }),
      /failed after 3 attempts/,
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(writeFailureStreamsClosed, 3)
    assert.equal(activeWriteFailureStreams, 0)
  } finally {
    sockets.forEach(socket => socket.destroy())
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('remote Server upload publishes only a complete checksum-verified temporary file', () => {
  const checksum = 'a'.repeat(64)
  const command = buildRemoteUploadCommand({
    farmingHome: '~/.farming-desktop',
    version: '2.2.37',
    expectedSize: 123_456,
    expectedSha256: checksum,
  })
  assert.match(command, /farming\.upload\.\$\$/)
  assert.match(command, /trap cleanup EXIT HUP INT TERM/)
  assert.match(command, /actual_size=.*wc -c/)
  assert.match(command, /actual_sha=.*sha256sum/)
  assert.ok(command.indexOf('actual_sha=') < command.indexOf('mv "$tmp" "$install_dir/farming"'))
  assert.equal(normalizeDesktopServerVersion('2.2.37'), '2.2.37')
  assert.throws(() => normalizeDesktopServerVersion('2.2.37$(touch bad)'), /invalid/)

  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-upload-'))
  try {
    const interrupted = spawnSync('sh', ['-c', buildRemoteUploadCommand({
      farmingHome: temporaryHome,
      version: '2.2.37',
      expectedSize: 4,
      expectedSha256: checksum,
    })], { input: Buffer.from('abc') })
    assert.equal(interrupted.status, 3)
    assert.match(interrupted.stderr.toString(), /size mismatch/)
    const installDir = path.join(temporaryHome, 'server', '2.2.37')
    assert.equal(fs.existsSync(path.join(installDir, 'farming')), false)
    assert.deepEqual(fs.existsSync(installDir) ? fs.readdirSync(installDir) : [], [])
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true })
  }
})

function capturedStreamCommand(
  inputFile: string,
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  let source: fs.ReadStream | null = null
  const operation = runCommand(command, args, { ...options, inputFile }, {
    createReadStream: file => {
      source = fs.createReadStream(file)
      return source
    },
  })
  if (!source) throw new Error('Remote command did not create its streamed input source.')
  return { operation, source }
}

function assertStreamReleased(source: fs.ReadStream, message: string) {
  assert.equal(source.destroyed, true, `${message}: source was not destroyed`)
  assert.equal(source.closed, true, `${message}: source file descriptor was not closed`)
  assert.equal(Reflect.get(source, 'fd'), null, `${message}: source retained an open file descriptor`)
}

test('remote command releases its exact streamed input when the child exits early', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-command-input-'))
  const inputFile = path.join(temporaryDir, 'sparse-input')
  const cleanupSources: fs.ReadStream[] = []
  try {
    const descriptor = fs.openSync(inputFile, 'w')
    try {
      fs.ftruncateSync(descriptor, 64 * 1024 * 1024)
    } finally {
      fs.closeSync(descriptor)
    }
    const captured = capturedStreamCommand(inputFile, process.execPath, [
      '-e',
      'setTimeout(() => process.exit(7), 100)',
    ], {
      timeoutMs: 2_000,
    })
    cleanupSources.push(captured.source)
    const result = await captured.operation
    assert.equal(result.code, 7)
    assertStreamReleased(captured.source, 'child early exit')
  } finally {
    cleanupSources.forEach(source => source.destroy())
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('remote command releases streamed input on spawn error, cancellation, timeout, and input error', async t => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-command-stop-input-'))
  const inputFile = path.join(temporaryDir, 'sparse-input')
  const cleanupSources: fs.ReadStream[] = []
  const cleanupPids: number[] = []
  const descriptor = fs.openSync(inputFile, 'w')
  try {
    fs.ftruncateSync(descriptor, 64 * 1024 * 1024)
  } finally {
    fs.closeSync(descriptor)
  }
  try {
    await t.test('spawn error', async () => {
      const captured = capturedStreamCommand(inputFile, path.join(temporaryDir, 'missing-command'), [])
      cleanupSources.push(captured.source)
      await assert.rejects(captured.operation, /ENOENT/)
      assertStreamReleased(captured.source, 'spawn error')
    })
    await t.test('cancellation', async () => {
      const controller = new AbortController()
      const captured = capturedStreamCommand(inputFile, process.execPath, [
        '-e',
        'setInterval(() => {}, 1000)',
      ], { signal: controller.signal, timeoutMs: 2_000 })
      cleanupSources.push(captured.source)
      controller.abort()
      await assert.rejects(captured.operation, DesktopRemoteOperationCancelledError)
      assertStreamReleased(captured.source, 'cancellation')
    })
    await t.test('timeout', async () => {
      const captured = capturedStreamCommand(inputFile, process.execPath, [
        '-e',
        'setInterval(() => {}, 1000)',
      ], { timeoutMs: 20 })
      cleanupSources.push(captured.source)
      await assert.rejects(captured.operation, /exceeded its 1 second deadline/)
      assertStreamReleased(captured.source, 'timeout')
    })
    await t.test('input error', async () => {
      const captured = capturedStreamCommand(
        path.join(temporaryDir, 'missing-input'),
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
      )
      cleanupSources.push(captured.source)
      await assert.rejects(captured.operation, /ENOENT/)
      assertStreamReleased(captured.source, 'input error')
    })
    await t.test('synchronous input setup error', async () => {
      let spawnedPid: number | undefined
      const operation = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        inputFile,
        timeoutMs: 2_000,
      }, {
        createReadStream: () => { throw new Error('fixture setup failure') },
        onSpawn: child => {
          spawnedPid = child.pid
          if (child.pid !== undefined) cleanupPids.push(child.pid)
        },
      })
      await assert.rejects(operation, /fixture setup failure/)
      if (spawnedPid === undefined) throw new Error('Fixture did not capture its child process.')
      const exactPid = spawnedPid
      assert.throws(
        () => process.kill(exactPid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ESRCH',
        'synchronous input setup failure rejected while its child process was still alive',
      )
    })
  } finally {
    cleanupSources.forEach(source => source.destroy())
    cleanupPids.forEach(pid => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    })
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('remote command rejects an input failure only after a SIGTERM-resistant child is dead', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-command-input-failure-'))
  const inputFile = path.join(temporaryDir, 'sparse-input')
  const descriptor = fs.openSync(inputFile, 'w')
  try {
    fs.ftruncateSync(descriptor, 64 * 1024 * 1024)
  } finally {
    fs.closeSync(descriptor)
  }
  const cleanupSources: fs.ReadStream[] = []
  let spawnedPid: number | undefined
  let exitSignal: NodeJS.Signals | null | undefined
  let resolveReady: (() => void) | undefined
  const ready = new Promise<void>(resolve => { resolveReady = resolve })
  try {
    let source: fs.ReadStream | null = null
    const operation = runCommand(process.execPath, ['-e', [
      `process.on('SIGTERM', () => {})`,
      `process.stdout.write('ready\\n')`,
      `setInterval(() => {}, 1000)`,
    ].join(';')], { inputFile, timeoutMs: 5_000 }, {
      createReadStream: file => {
        source = fs.createReadStream(file)
        cleanupSources.push(source)
        return source
      },
      onSpawn: child => {
        spawnedPid = child.pid
        child.stdout?.once('data', () => resolveReady?.())
        child.once('exit', (_code, signal) => { exitSignal = signal })
      },
    })
    let settled = false
    void operation.then(
      () => { settled = true },
      () => { settled = true },
    )
    await Promise.race([
      ready,
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error('SIGTERM-resistant child did not report ready within 1 second.')), 1_000)
      }),
    ])
    if (!source || spawnedPid === undefined) throw new Error('Fixture did not capture its input source and child process.')
    const exactSource: fs.ReadStream = source
    const exactPid = spawnedPid
    const sourceClosed = exactSource.closed
      ? Promise.resolve()
      : new Promise<void>(resolve => exactSource.once('close', resolve))
    exactSource.destroy(new Error('fixture input failure'))
    await sourceClosed

    assert.equal(settled, false, 'input failure settled before terminating the child')
    assert.doesNotThrow(() => process.kill(exactPid, 0), 'SIGTERM-resistant child exited before forced termination')
    await assert.rejects(operation, /fixture input failure/)
    assert.equal(exitSignal, 'SIGKILL')
    assert.throws(
      () => process.kill(exactPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ESRCH',
      'input failure rejected while its child process was still alive',
    )
    assertStreamReleased(exactSource, 'SIGTERM-resistant input failure')
  } finally {
    cleanupSources.forEach(source => source.destroy())
    if (spawnedPid !== undefined) {
      try {
        process.kill(spawnedPid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('remote command streams the complete payload before successful child completion', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-command-complete-input-'))
  const inputFile = path.join(temporaryDir, 'payload')
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x5a)
  fs.writeFileSync(inputFile, payload)
  const expectedHash = createHash('sha256').update(payload).digest('hex')
  const cleanupSources: fs.ReadStream[] = []
  try {
    const captured = capturedStreamCommand(inputFile, process.execPath, ['-e', [
      `const { createHash } = require('node:crypto')`,
      `const hash = createHash('sha256')`,
      `let bytes = 0`,
      `process.stdin.on('data', chunk => { bytes += chunk.length; hash.update(chunk) })`,
      `process.stdin.on('end', () => console.log(JSON.stringify({ bytes, sha256: hash.digest('hex') })))`,
    ].join(';')], { timeoutMs: 2_000 })
    cleanupSources.push(captured.source)
    const result = await captured.operation
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.stdout), { bytes: payload.length, sha256: expectedHash })
    assertStreamReleased(captured.source, 'successful full input')
  } finally {
    cleanupSources.forEach(source => source.destroy())
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
})

test('desktop renderer validation rejects a backend-base-path build before opening a window', () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-renderer-'))
  try {
    assert.throws(
      () => validateDesktopRendererAssets(distDir),
      /Desktop renderer is missing .*index\.html.*desktop:build/,
    )
    fs.mkdirSync(path.join(distDir, 'assets'))
    fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'export {}\n')
    fs.writeFileSync(path.join(distDir, 'assets', 'app.css'), 'body {}\n')
    fs.writeFileSync(path.join(distDir, 'index.html'), [
      '<link rel="stylesheet" href="/assets/app.css">',
      '<script type="module" src="/assets/app.js"></script>',
    ].join('\n'))
    assert.doesNotThrow(() => validateDesktopRendererAssets(distDir))

    fs.writeFileSync(path.join(distDir, 'index.html'), '<script type="module" src="/farming/assets/app.js"></script>')
    assert.throws(
      () => validateDesktopRendererAssets(distDir),
      /wrong base path: \/farming\/assets\/app\.js/,
    )
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true })
  }
})

test('maps gateway paths under a backend base path and encodes bearer credentials', () => {
  assert.equal(
    joinUpstreamUrl('http://127.0.0.1:43121/farming', '/api/settings?fresh=1').toString(),
    'http://127.0.0.1:43121/farming/api/settings?fresh=1',
  )
  assert.equal(bearerCredential('three word token'), 'dGhyZWUgd29yZCB0b2tlbg')
})

test('grants only main-frame microphone access to the exact desktop gateway origin', () => {
  const baseRequest = {
    gatewayOrigin: 'http://127.0.0.1:43121',
    isMainFrame: true,
    permission: 'media',
    requestingOrigin: 'http://127.0.0.1:43121/code/',
  }

  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, mediaTypes: ['audio'] }), true)
  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, mediaType: 'audio' }), true)
  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, mediaTypes: ['video'] }), false)
  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, mediaTypes: ['audio', 'video'] }), false)
  assert.equal(allowsDesktopAudioPermission({
    ...baseRequest,
    requestingOrigin: 'http://127.0.0.1:43122/code/',
    mediaTypes: ['audio'],
  }), false)
  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, isMainFrame: false, mediaTypes: ['audio'] }), false)
  assert.equal(allowsDesktopAudioPermission({ ...baseRequest, permission: 'notifications', mediaTypes: ['audio'] }), false)
})

test('shellQuote neutralizes shell metacharacters in remote bootstrap arguments', () => {
  assert.equal(shellQuote('2.2.37'), "'2.2.37'")
  const adversarial = '2.2.37"; rm -rf /; echo "'
  assert.equal(shellQuote(adversarial), `'2.2.37"; rm -rf /; echo "'`)
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  const script = buildRemoteBootstrapScript()
  assert.match(script, /\$FARMING_VERSION/)
})
