import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { WebSocketServer } from 'ws'
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  validateClientMessage,
} from '../shared/browser-protocol'
import type { FarmingDesktopBridge } from '../shared/desktop-contract'

declare global {
  interface Window {
    farmingDesktop?: FarmingDesktopBridge
  }
}

const repoRoot = path.join(__dirname, '..')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-smoke-'))
let settingsRequestCount = 0
let protocolHelloCount = 0
let businessHealthProbeCount = 0
let stateFrameCount = 0
const backend = http.createServer((request, response) => {
  if (request.url === '/api/auth/status') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ authRequired: false }))
    return
  }
  if (request.url === '/api/settings') {
    settingsRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ settings: { language: 'en' } }))
    return
  }
  response.writeHead(404, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: 'Not implemented by desktop smoke backend.' }))
})
const backendWebSockets = new WebSocketServer({ noServer: true })
backend.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname
  if (pathname !== '/ws') {
    socket.destroy()
    return
  }
  backendWebSockets.handleUpgrade(request, socket, head, client => {
    backendWebSockets.emit('connection', client, request)
  })
})
backendWebSockets.on('connection', socket => {
  socket.send(JSON.stringify({
    type: 'protocol-hello',
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: MIN_PROTOCOL_VERSION,
    availableExtensions: [],
  }))
  socket.send(JSON.stringify({ type: 'state', state: { agents: [] } }))
  stateFrameCount += 1
  socket.on('message', data => {
    const validation = validateClientMessage(JSON.parse(data.toString()))
    if (!validation.ok) return
    const message = validation.value
    if (message.type === 'protocol-hello') {
      protocolHelloCount += 1
      socket.send(JSON.stringify({
        type: 'protocol-hello',
        protocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: MIN_PROTOCOL_VERSION,
        availableExtensions: [],
        negotiatedExtensions: [],
      }))
      return
    }
    if (message.type === 'business-health-probe') {
      businessHealthProbeCount += 1
      socket.send(JSON.stringify({
        type: 'business-health-result',
        requestId: message.requestId,
        serverEpoch: 'desktop-smoke',
        protocolVersion: PROTOCOL_VERSION,
        status: 'ready',
        agentCount: 0,
        mainAgentId: null,
      }))
    }
  })
})

async function listenBackend() {
  await new Promise<void>((resolve, reject) => {
    backend.once('error', reject)
    backend.listen(0, '127.0.0.1', () => resolve())
  })
  const address = backend.address()
  if (!address || typeof address === 'string') throw new Error('Smoke backend did not receive a port.')
  return address.port
}

async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

async function main() {
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    const backendPort = await listenBackend()
    application = await electron.launch({
      args: [path.join(repoRoot, 'dist-desktop', 'main.js')],
      cwd: repoRoot,
      env: {
        ...process.env,
        FARMING_DESKTOP_USER_DATA_DIR: userDataDir,
        FARMING_DESKTOP_LOCAL_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      },
    })
    application.on('console', message => console.log(`[electron:${message.type()}] ${message.text()}`))
    const page = await application.firstWindow()
    page.setDefaultTimeout(10_000)
    const rendererErrors: string[] = []
    const rendererPageErrors: string[] = []
    page.on('console', message => {
      console.log(`[renderer:${message.type()}] ${message.text()}`)
      if (message.type() === 'error') rendererErrors.push(message.text())
    })
    page.on('pageerror', error => {
      rendererPageErrors.push(error.message)
      console.error(`[renderer:error] ${error.message}`)
    })
    console.log(`Desktop window opened at ${page.url()}`)
    await page.getByTestId('app-shell').waitFor({ state: 'visible' })
    const initialState = await page.evaluate(() => ({
      desktopBridge: typeof (window as Window & { farmingDesktop?: unknown }).farmingDesktop,
      text: document.body.innerText.slice(0, 500),
    }))
    console.log(`Desktop renderer state: ${JSON.stringify(initialState)}`)
    assert.equal(initialState.desktopBridge, 'object', 'Electron preload bridge was not installed.')
    assert.equal(await page.getByRole('dialog').count(), 0, 'Desktop first launch must not force a backend decision.')
    assert.equal(await page.getByTestId('desktop-backend-bar').count(), 0, 'Desktop must not add a backend bar above the web UI.')
    const initialBackendState = await page.evaluate(async () => {
      const desktop = (window as Window & { farmingDesktop?: import('../shared/desktop-contract').FarmingDesktopBridge }).farmingDesktop
      if (!desktop) throw new Error('Desktop bridge is missing.')
      const state = await desktop.getState()
      return {
        active: state.profiles.find(profile => profile.id === state.activeBackendId),
        connection: state.connections.find(connection => connection.backendId === state.activeBackendId),
      }
    })
    assert.equal(initialBackendState.active?.kind, 'local')
    assert.equal(initialBackendState.connection?.status, 'ready')
    await waitFor(
      () => protocolHelloCount >= 2 && businessHealthProbeCount >= 2 && stateFrameCount >= 2,
      'Desktop renderer did not complete a real bidirectional WebSocket handshake through the gateway.',
    )
    const rendererAssets = await page.evaluate(async () => {
      const references = [
        ...Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'), element => element.src),
        ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"], link[rel="stylesheet"]'), element => element.href),
      ]
      return Promise.all(references.map(async url => {
        const response = await fetch(url)
        return { ok: response.ok, status: response.status, url: new URL(url).pathname }
      }))
    })
    assert.ok(rendererAssets.length > 0, 'Desktop renderer did not reference executable assets.')
    assert.deepEqual(rendererAssets.filter(asset => !asset.ok), [], 'Desktop renderer assets did not all return success.')
    await page.getByTestId('code-nav-plugins').click()
    await page.getByTestId('code-plugins-panel').waitFor()
    await page.getByTestId('desktop-connections-panel').waitFor()
    assert.equal(await page.getByTestId('code-plugin-tab-farming').count(), 1)
    assert.equal(await page.getByRole('button', { name: 'Back to Plugins' }).count(), 0)
    assert.equal(await page.getByTestId('desktop-connection-local').count(), 1)
    await page.locator('.desktop-connections-add').click()
    const formText = await page.locator('.desktop-connections-form').innerText()
    assert.match(formText, /SSH host|SSH 主机/)
    assert.match(formText, /Farming Home/)
    assert.doesNotMatch(formText, /Remote listener|远端监听地址|Farming token|Base path/)
    const protocolHelloBeforeActivation = protocolHelloCount
    const businessHealthBeforeActivation = businessHealthProbeCount
    const activationReload = page.waitForEvent('framenavigated', {
      predicate: frame => frame === page.mainFrame(),
    })
    await page.evaluate(async backendUrl => {
      const desktop = (window as Window & { farmingDesktop?: import('../shared/desktop-contract').FarmingDesktopBridge }).farmingDesktop
      if (!desktop) throw new Error('Desktop bridge is missing.')
      const activated = await desktop.saveAndActivateBackend({
        name: 'Smoke backend',
        transport: 'direct',
        directUrl: backendUrl,
      })
      const id = activated.profiles.find(profile => profile.name === 'Smoke backend')?.id
      if (!id || activated.activeBackendId !== id) throw new Error('Smoke backend was not saved and activated atomically.')
    }, `http://127.0.0.1:${backendPort}`)
    await activationReload

    const appShell = page.getByTestId('app-shell')
    await appShell.waitFor({ state: 'visible' })
    await waitFor(
      () => (
        protocolHelloCount >= protocolHelloBeforeActivation + 2
        && businessHealthProbeCount >= businessHealthBeforeActivation + 2
      ),
      'Activated backend did not pass readiness and renderer WebSocket handshakes.',
    )
    assert.match(await appShell.innerText(), /Farming/, 'Desktop application shell rendered no recognizable content.')
    const burstNavigation = page.waitForEvent('framenavigated', {
      predicate: frame => frame === page.mainFrame(),
    })
    const burstActivation = await page.evaluate(async () => {
      const desktop = (window as Window & { farmingDesktop?: import('../shared/desktop-contract').FarmingDesktopBridge }).farmingDesktop
      if (!desktop) throw new Error('Desktop bridge is missing.')
      const current = await desktop.getState()
      const backendId = current.activeBackendId
      if (!backendId) throw new Error('Desktop has no active backend for burst activation.')
      const results = await Promise.all([
        desktop.activateBackend(backendId),
        desktop.activateBackend(backendId),
        desktop.activateBackend(backendId),
      ])
      return results.every(result => result.activeBackendId === backendId)
    })
    assert.equal(burstActivation, true, 'Burst activation did not return all IPC results before navigation.')
    await burstNavigation
    await page.getByTestId('app-shell').waitFor({ state: 'visible' })
    await page.waitForFunction(async () => {
      const state = await window.farmingDesktop?.getState()
      return state?.connections.find(connection => connection.backendId === state.activeBackendId)?.status === 'ready'
    })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.reload()
      await page.getByTestId('app-shell').waitFor({ state: 'visible' })
      await page.waitForFunction(async () => {
        const state = await window.farmingDesktop?.getState()
        return state?.connections.find(connection => connection.backendId === state.activeBackendId)?.status === 'ready'
      })
      assert.match(
        await page.getByTestId('app-shell').innerText(),
        /Farming/,
        `Desktop application shell was blank after reload ${attempt}.`,
      )
    }
    const failedConnection = await page.evaluate(async () => {
      const desktop = (window as Window & { farmingDesktop?: import('../shared/desktop-contract').FarmingDesktopBridge }).farmingDesktop
      if (!desktop) throw new Error('Desktop bridge is missing.')
      let message = ''
      try {
        await desktop.saveAndActivateBackend({
          name: 'Unavailable backend',
          transport: 'direct',
          directUrl: 'http://127.0.0.1:1',
        })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      const state = await desktop.getState()
      const id = state.profiles.find(profile => profile.name === 'Unavailable backend')?.id
      if (!id) throw new Error('Unavailable smoke backend was not persisted before activation failed.')
      return {
        activeName: state.profiles.find(profile => profile.id === state.activeBackendId)?.name,
        failedStatus: state.connections.find(connection => connection.backendId === id)?.status,
        message,
      }
    })
    assert.ok(failedConnection.message, 'Unavailable backend activation unexpectedly succeeded.')
    assert.equal(failedConnection.activeName, 'Smoke backend')
    assert.equal(failedConnection.failedStatus, 'error')
    await page.getByTestId('app-shell').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('app-error-fallback').count(), 0)
    const profileState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'backends.json'), 'utf8')) as {
      activeBackendId?: unknown
      profiles?: Array<{ name?: unknown; encryptedToken?: unknown }>
    }
    assert.equal(typeof profileState.activeBackendId, 'string')
    assert.equal(profileState.profiles?.[0]?.name, 'Smoke backend')
    assert.equal(profileState.profiles?.[0]?.encryptedToken, '')
    assert.equal(
      rendererErrors.some(message => /Content Security Policy/i.test(message)),
      false,
      'Desktop renderer emitted a Content Security Policy violation.',
    )
    assert.deepEqual(rendererPageErrors, [], 'Desktop renderer emitted an uncaught page error.')

    const removalReload = page.waitForEvent('framenavigated', {
      predicate: frame => frame === page.mainFrame(),
    })
    const removalState = await page.evaluate(async () => {
      const desktop = (window as Window & { farmingDesktop?: import('../shared/desktop-contract').FarmingDesktopBridge }).farmingDesktop
      if (!desktop) throw new Error('Desktop bridge is missing.')
      const current = await desktop.getState()
      const active = current.profiles.find(profile => profile.id === current.activeBackendId)
      if (!active || active.kind !== 'remote') throw new Error('Smoke remote backend is not active before removal.')
      const next = await desktop.removeBackend(active.id)
      return {
        active: next.profiles.find(profile => profile.id === next.activeBackendId),
        removedStillPresent: next.profiles.some(profile => profile.id === active.id),
      }
    })
    assert.equal(removalState.active?.kind, 'local')
    assert.equal(removalState.removedStillPresent, false)
    await removalReload
    await page.getByTestId('app-shell').waitFor({ state: 'visible' })
    await page.waitForFunction(async () => {
      const state = await window.farmingDesktop?.getState()
      const active = state?.profiles.find(profile => profile.id === state.activeBackendId)
      const connection = state?.connections.find(candidate => candidate.backendId === state.activeBackendId)
      return active?.kind === 'local' && connection?.status === 'ready'
    })

    const settingsBeforeRestart = settingsRequestCount
    await application.close()
    application = await electron.launch({
      args: [path.join(repoRoot, 'dist-desktop', 'main.js')],
      cwd: repoRoot,
      env: {
        ...process.env,
        FARMING_DESKTOP_USER_DATA_DIR: userDataDir,
        FARMING_DESKTOP_LOCAL_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      },
    })
    const restartedPage = await application.firstWindow()
    restartedPage.setDefaultTimeout(10_000)
    const restartPageErrors: string[] = []
    restartedPage.on('pageerror', error => restartPageErrors.push(error.message))
    await restartedPage.getByTestId('app-shell').waitFor({ state: 'visible' })
    await restartedPage.waitForFunction(async () => {
      const state = await window.farmingDesktop?.getState()
      const active = state?.profiles.find(profile => profile.id === state.activeBackendId)
      const connection = state?.connections.find(candidate => candidate.backendId === state.activeBackendId)
      return active?.kind === 'local' && connection?.status === 'ready'
    })
    await waitFor(
      () => settingsRequestCount > settingsBeforeRestart,
      'Restarted desktop did not reload application data after reconnecting its saved backend.',
    )
    assert.equal(await restartedPage.getByTestId('app-error-fallback').count(), 0)
    assert.deepEqual(restartPageErrors, [], 'Restarted desktop renderer emitted an uncaught page error.')
    const screenshotPath = process.env.FARMING_DESKTOP_SMOKE_SCREENSHOT
    if (screenshotPath) {
      await restartedPage.getByTestId('code-nav-plugins').click()
      await restartedPage.getByTestId('code-plugins-panel').waitFor()
      await restartedPage.getByTestId('desktop-connections-panel').waitFor()
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
      await restartedPage.screenshot({ path: screenshotPath, fullPage: true })
    }
    console.log('Desktop MVP smoke passed: local-first startup, built-in remote management, backend switching, and restart recovery.')
  } finally {
    await application?.close().catch(() => {})
    backendWebSockets.clients.forEach(socket => socket.terminate())
    await new Promise<void>(resolve => backendWebSockets.close(() => resolve()))
    await new Promise<void>(resolve => backend.close(() => resolve()))
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
