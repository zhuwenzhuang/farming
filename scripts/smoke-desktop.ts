import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
  if (request.url === '/desktop-smoke-external-redirect') {
    response.writeHead(302, {
      Location: 'https://docs.example.test/farming-desktop-redirect',
    })
    response.end()
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
  socket.send(JSON.stringify({
    type: 'state',
    generation: 'desktop-smoke',
    sequence: 0,
    state: { agents: [] },
  }))
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

async function waitFor(condition: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

async function waitForOwnedProcessExit(child: ReturnType<typeof spawn>, label: string) {
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4_000) })
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${label} did not exit within 10 seconds. ${stderr}`))
    }, 10_000)
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })
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
    const secondInstance = spawn(
      path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron'),
      [path.join(repoRoot, 'dist-desktop', 'main.js')],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FARMING_DESKTOP_USER_DATA_DIR: userDataDir,
          FARMING_DESKTOP_LOCAL_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    const secondInstanceExit = await waitForOwnedProcessExit(secondInstance, 'Secondary Farming Desktop instance')
    assert.equal(secondInstanceExit.code, 0, 'Secondary Desktop instance must hand off to the primary instance and exit.')
    assert.equal(
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      1,
      'Secondary Desktop launch must not create another primary window.',
    )
    await page.getByTestId('app-shell').waitFor({ state: 'visible' })
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
    const primaryRendererOrigin = new URL(restartedPage.url()).origin
    await application.evaluate(({ BrowserWindow, shell }) => {
      type NavigationEvent = {
        defaultPrevented: boolean
        isMainFrame: boolean | null
        name: string
        url: string | null
      }
      const main = globalThis as typeof globalThis & {
        desktopSmokeExternalUrls?: string[]
        desktopSmokeNavigationEvents?: NavigationEvent[]
      }
      main.desktopSmokeExternalUrls = []
      main.desktopSmokeNavigationEvents = []
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents
      if (!webContents) throw new Error('Desktop primary window is missing.')
      webContents.on('will-frame-navigate', event => {
        main.desktopSmokeNavigationEvents?.push({
          defaultPrevented: Boolean(event.defaultPrevented),
          isMainFrame: typeof event.isMainFrame === 'boolean' ? event.isMainFrame : null,
          name: 'will-frame-navigate',
          url: event.url || null,
        })
      })
      webContents.on('will-navigate', event => {
        main.desktopSmokeNavigationEvents?.push({
          defaultPrevented: Boolean(event.defaultPrevented),
          isMainFrame: typeof event.isMainFrame === 'boolean' ? event.isMainFrame : null,
          name: 'will-navigate',
          url: event.url || null,
        })
      })
      webContents.on('will-redirect', event => {
        main.desktopSmokeNavigationEvents?.push({
          defaultPrevented: Boolean(event.defaultPrevented),
          isMainFrame: typeof event.isMainFrame === 'boolean' ? event.isMainFrame : null,
          name: 'will-redirect',
          url: event.url || null,
        })
      })
      shell.openExternal = async url => {
        main.desktopSmokeExternalUrls?.push(url)
      }
    })
    await restartedPage.evaluate(() => {
      window.open('https://docs.example.test/farming-desktop-smoke', '_blank', 'noopener,noreferrer')
      window.open('file:///tmp/farming-desktop-smoke', '_blank', 'noopener,noreferrer')
    })
    const externalDeadline = Date.now() + 10_000
    let externalUrls: string[] = []
    while (Date.now() < externalDeadline) {
      externalUrls = await application.evaluate(() => {
        const main = globalThis as typeof globalThis & { desktopSmokeExternalUrls?: string[] }
        return main.desktopSmokeExternalUrls ?? []
      })
      if (externalUrls.length > 0) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.deepEqual(
      externalUrls,
      ['https://docs.example.test/farming-desktop-smoke'],
      'Desktop must send only safe external HTTP(S) targets to the operating system.',
    )
    await restartedPage.evaluate(() => {
      const credentialedGatewayUrl = new URL('/code/?desktop-smoke-credentialed=1', window.location.origin)
      credentialedGatewayUrl.username = 'desktop'
      credentialedGatewayUrl.password = 'secret'
      window.open(credentialedGatewayUrl.toString(), '_blank')
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(
      await application.evaluate(() => {
        const main = globalThis as typeof globalThis & { desktopSmokeExternalUrls?: string[] }
        return main.desktopSmokeExternalUrls ?? []
      }),
      ['https://docs.example.test/farming-desktop-smoke'],
      'Desktop must deny a credential-bearing destination even when its origin matches the gateway.',
    )
    assert.equal(
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      1,
      'Desktop must not create another window for a denied credential-bearing gateway URL.',
    )
    await restartedPage.evaluate(() => {
      window.location.assign('https://docs.example.test/farming-desktop-direct')
    })
    await waitFor(async () => {
      externalUrls = await application!.evaluate(() => {
        const main = globalThis as typeof globalThis & { desktopSmokeExternalUrls?: string[] }
        return main.desktopSmokeExternalUrls ?? []
      })
      return externalUrls.length === 2
    }, 'Desktop did not send a direct external navigation to the operating system.')
    assert.deepEqual(
      externalUrls,
      [
        'https://docs.example.test/farming-desktop-smoke',
        'https://docs.example.test/farming-desktop-direct',
      ],
      'Desktop must apply its safe external navigation policy to the primary renderer.',
    )
    const directNavigationEvidence = await application.evaluate(() => {
      const main = globalThis as typeof globalThis & {
        desktopSmokeNavigationEvents?: Array<{
          defaultPrevented: boolean
          isMainFrame: boolean | null
          name: string
          url: string | null
        }>
      }
      return main.desktopSmokeNavigationEvents ?? []
    })
    assert.deepEqual(
      directNavigationEvidence.find(event => (
        event.name === 'will-navigate'
        && event.url === 'https://docs.example.test/farming-desktop-direct'
      )),
      {
        defaultPrevented: true,
        isMainFrame: true,
        name: 'will-navigate',
        url: 'https://docs.example.test/farming-desktop-direct',
      },
      'Desktop must prevent the primary renderer from leaving the gateway for a safe external URL.',
    )
    const directRendererState = await restartedPage.evaluate(() => ({
      appShell: Boolean(document.querySelector('[data-testid="app-shell"]')),
      url: window.location.href,
    }))
    assert.equal(new URL(directRendererState.url).origin, primaryRendererOrigin)
    assert.equal(directRendererState.appShell, true, 'Desktop must retain its app shell after external navigation.')
    await restartedPage.evaluate(() => {
      window.location.assign(`${window.location.origin}/desktop-smoke-external-redirect`)
    })
    await waitFor(async () => {
      externalUrls = await application!.evaluate(() => {
        const main = globalThis as typeof globalThis & { desktopSmokeExternalUrls?: string[] }
        return main.desktopSmokeExternalUrls ?? []
      })
      return externalUrls.length === 3
    }, 'Desktop did not send a safe external redirect to the operating system.')
    assert.deepEqual(
      externalUrls,
      [
        'https://docs.example.test/farming-desktop-smoke',
        'https://docs.example.test/farming-desktop-direct',
        'https://docs.example.test/farming-desktop-redirect',
      ],
      'Desktop must apply its safe external navigation policy to redirects.',
    )
    const redirectNavigationEvidence = await application.evaluate(() => {
      const main = globalThis as typeof globalThis & {
        desktopSmokeNavigationEvents?: Array<{
          defaultPrevented: boolean
          isMainFrame: boolean | null
          name: string
          url: string | null
        }>
      }
      return main.desktopSmokeNavigationEvents ?? []
    })
    assert.deepEqual(
      redirectNavigationEvidence.find(event => (
        event.name === 'will-redirect'
        && event.url === 'https://docs.example.test/farming-desktop-redirect'
      )),
      {
        defaultPrevented: true,
        isMainFrame: true,
        name: 'will-redirect',
        url: 'https://docs.example.test/farming-desktop-redirect',
      },
      'Desktop must prevent the primary renderer from following an external redirect.',
    )
    const redirectRendererState = await restartedPage.evaluate(() => ({
      appShell: Boolean(document.querySelector('[data-testid="app-shell"]')),
      url: window.location.href,
    }))
    assert.equal(new URL(redirectRendererState.url).origin, primaryRendererOrigin)
    assert.equal(redirectRendererState.appShell, true, 'Desktop must retain its app shell after an external redirect.')
    const internalNavigation = restartedPage.waitForEvent('framenavigated', {
      predicate: frame => frame === restartedPage.mainFrame()
        && frame.url().includes('/code/?desktop-smoke=1'),
    })
    await restartedPage.evaluate(() => {
      window.open(`${window.location.origin}/code/?desktop-smoke=1`, '_blank', 'noopener,noreferrer')
    })
    await internalNavigation
    await restartedPage.getByTestId('app-shell').waitFor({ state: 'visible' })
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
