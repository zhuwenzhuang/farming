import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  session,
  type IpcMainInvokeEvent,
} from 'electron'
import type { DesktopBackendInput, DesktopNotificationInput, DesktopState } from '../shared/desktop-contract.js'
import { DesktopConnectionManager } from './connection-manager.js'
import { DesktopGateway } from './gateway.js'
import { DesktopLifecycle, type DesktopNavigationToken } from './lifecycle.js'
import { DesktopLocalBackend, LOCAL_BACKEND_ID } from './local-backend.js'
import { allowsDesktopAudioPermission } from './permissions.js'
import { DesktopProfileStore } from './profile-store.js'

let mainWindow: BrowserWindow | null = null
let profiles: DesktopProfileStore | null = null
let connections: DesktopConnectionManager | null = null
let gateway: DesktopGateway | null = null
let localBackend: DesktopLocalBackend | null = null
let pendingRendererUrl: string | null | undefined
let focusRendererWhenReady = false
let rendererDrainScheduled = false
let stopPromise: Promise<void> | null = null
let startupFailureShown = false
const lifecycle = new DesktopLifecycle()
const desktopIconPath = path.join(__dirname, 'assets', 'farming-desktop.png')

const userDataOverride = process.env.FARMING_DESKTOP_USER_DATA_DIR
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride))

function state(): DesktopState {
  if (!profiles || !connections) throw new Error('Desktop runtime is not ready.')
  return {
    activeBackendId: profiles.getActiveBackendId(),
    profiles: profiles.list(),
    connections: connections.list(),
  }
}

function broadcastState() {
  if (!lifecycle.isRunning()) return
  const snapshot = state()
  BrowserWindow.getAllWindows().forEach(window => window.webContents.send('desktop:state-changed', snapshot))
}

function validateSender(event: IpcMainInvokeEvent) {
  if (!gateway || !lifecycle.isRunning()) throw new Error('Desktop runtime is not accepting requests.')
  if (!event.senderFrame) throw new Error('Desktop IPC sender has no frame.')
  const senderUrl = new URL(event.senderFrame.url)
  if (senderUrl.origin !== gateway.origin()) throw new Error('Untrusted desktop IPC sender.')
}

function registerIpc() {
  if (!profiles || !connections || !gateway) throw new Error('Desktop runtime is not ready.')
  const profileStore = profiles
  const connectionManager = connections
  const desktopGateway = gateway
  ipcMain.handle('desktop:get-state', event => {
    validateSender(event)
    return state()
  })
  ipcMain.handle('desktop:save-backend', (event, input: DesktopBackendInput) => {
    validateSender(event)
    const saved = profileStore.save(input)
    if (input.id) connectionManager.disconnect(saved.id)
    broadcastState()
    return state()
  })
  ipcMain.handle('desktop:remove-backend', (event, backendId: string) => {
    validateSender(event)
    const wasActive = profileStore.getActiveBackendId() === backendId
    connectionManager.disconnect(backendId)
    profileStore.remove(backendId)
    if (wasActive) requestRendererNavigation(null)
    broadcastState()
    return state()
  })
  ipcMain.handle('desktop:connect-backend', async (event, backendId: string) => {
    validateSender(event)
    await connectionManager.connect(backendId)
    if (!lifecycle.isRunning()) throw new Error('Desktop is stopping.')
    return state()
  })
  ipcMain.handle('desktop:disconnect-backend', (event, backendId: string) => {
    validateSender(event)
    connectionManager.disconnect(backendId)
    if (profileStore.getActiveBackendId() === backendId) desktopGateway.closeClientConnections()
    return state()
  })
  ipcMain.handle('desktop:activate-backend', async (event, backendId: string) => {
    validateSender(event)
    await connectionManager.connect(backendId)
    if (!lifecycle.isRunning()) throw new Error('Desktop is stopping.')
    profileStore.setActiveBackendId(backendId)
    broadcastState()
    requestRendererNavigation(null)
    return state()
  })
  ipcMain.handle('desktop:show-notification', (event, input: DesktopNotificationInput) => {
    validateSender(event)
    if (!Notification.isSupported()) return
    const backendId = profileStore.getActiveBackendId()
    const notification = new Notification({
      title: String(input.title || 'Farming').slice(0, 120),
      body: String(input.body || '').slice(0, 240),
    })
    notification.on('click', () => {
      void (async () => {
        if (backendId) {
          await connectionManager.connect(backendId)
          if (!lifecycle.isRunning()) return
          profileStore.setActiveBackendId(backendId)
          broadcastState()
        }
        if (!lifecycle.isRunning()) return
        if (!mainWindow) createWindow()
        focusRendererWhenReady = true
        const agent = encodeURIComponent(input.agentId)
        requestRendererNavigation(`${desktopGateway.origin()}/code/?agent=${agent}`)
      })().catch(() => {
        if (!lifecycle.isRunning()) return
        if (!mainWindow) createWindow()
        focusRendererWhenReady = true
      })
    })
    notification.show()
  })
}

function currentRendererUrl(window: BrowserWindow) {
  if (!gateway) throw new Error('Desktop gateway is not ready.')
  try {
    const current = new URL(window.webContents.getURL())
    if (current.origin === gateway.origin() && current.pathname !== '/__desktop_bootstrap') return current.toString()
  } catch {
    // The initial about:blank and a destroyed navigation have no reusable renderer URL.
  }
  return `${gateway.origin()}/code/`
}

function takePendingRendererUrl(window: BrowserWindow) {
  const requested = pendingRendererUrl
  pendingRendererUrl = undefined
  return requested || currentRendererUrl(window)
}

function showStartupFailure(error: unknown) {
  const phase = lifecycle.snapshot().appPhase
  if (phase === 'stopping' || phase === 'stopped') return
  if (!startupFailureShown) {
    startupFailureShown = true
    dialog.showErrorBox('Farming Desktop failed to start', error instanceof Error ? error.message : String(error))
  }
  void stopDesktop(1)
}

async function navigateWindow(window: BrowserWindow, token: DesktopNavigationToken, url: string): Promise<void> {
  try {
    await window.loadURL(url)
    const rendered = await window.webContents.executeJavaScript(`new Promise(resolve => {
      const selector = '[data-testid="app-shell"], [data-testid="app-error-fallback"]'
      if (document.querySelector(selector)) return resolve(true)
      const observer = new MutationObserver(() => {
        if (!document.querySelector(selector)) return
        observer.disconnect()
        resolve(true)
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
      setTimeout(() => {
        observer.disconnect()
        resolve(false)
      }, 15000)
    })`) as boolean
    if (!rendered) throw new Error('Desktop renderer did not produce visible application content within 15 seconds.')
    const decision = lifecycle.navigationReady(token)
    if (decision.kind === 'reload' && !window.isDestroyed()) {
      await navigateWindow(window, decision.token, takePendingRendererUrl(window))
      return
    }
    if (decision.kind !== 'ready' || window.isDestroyed()) return
    window.show()
    if (focusRendererWhenReady) {
      focusRendererWhenReady = false
      window.focus()
    }
  } catch (error) {
    const decision = lifecycle.navigationFailed(token)
    if (decision.kind === 'reload' && !window.isDestroyed()) {
      await navigateWindow(window, decision.token, takePendingRendererUrl(window))
      return
    }
    if (decision.kind === 'fail') showStartupFailure(error)
  }
}

function requestRendererNavigation(url: string | null) {
  if (!lifecycle.isRunning() || !gateway) return
  if (!lifecycle.invalidateRendererRoute()) return
  pendingRendererUrl = url
  gateway.closeClientConnections()
  if (rendererDrainScheduled) return
  rendererDrainScheduled = true
  setImmediate(() => {
    rendererDrainScheduled = false
    if (!lifecycle.isRunning()) return
    const token = lifecycle.beginPendingNavigation()
    const window = mainWindow
    if (!token || !window || window.isDestroyed()) return
    void navigateWindow(window, token, takePendingRendererUrl(window))
  })
}

function createWindow() {
  if (!gateway || !lifecycle.isRunning()) return
  const desktopGateway = gateway
  const token = lifecycle.openWindow()
  const preload = path.join(__dirname, 'preload.js')
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Farming',
    icon: desktopIconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload,
    },
  })
  mainWindow = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== desktopGateway.origin()) event.preventDefault()
  })
  window.on('closed', () => {
    lifecycle.closeWindow(token.windowGeneration)
    if (mainWindow === window) {
      mainWindow = null
      pendingRendererUrl = undefined
      focusRendererWhenReady = false
    }
  })
  void navigateWindow(window, token, desktopGateway.bootstrapUrl())
}

function stopDesktop(exitCode: number) {
  if (stopPromise) return stopPromise
  if (!lifecycle.beginStop()) return Promise.resolve()
  pendingRendererUrl = undefined
  focusRendererWhenReady = false
  rendererDrainScheduled = false
  const managedConnections = connections
  const managedGateway = gateway
  stopPromise = (async () => {
    try {
      managedConnections?.close()
      await managedGateway?.close()
      await localBackend?.stop()
    } catch (error) {
      console.error('Farming Desktop cleanup failed:', error)
    } finally {
      lifecycle.finishStop()
      app.exit(exitCode)
    }
  })()
  return stopPromise
}

app.setName('Farming')

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(desktopIconPath)
  const desktopLocalBackend = new DesktopLocalBackend({
    configDir: path.join(app.getPath('userData'), 'local-backend'),
    electronExecutable: process.execPath,
    resourcesPath: process.resourcesPath,
    repositoryRoot: path.resolve(__dirname, '..'),
    injectedUrl: process.env.FARMING_DESKTOP_LOCAL_BACKEND_URL,
    injectedToken: process.env.FARMING_DESKTOP_LOCAL_BACKEND_TOKEN,
    cliPath: process.env.FARMING_DESKTOP_LOCAL_CLI,
  })
  localBackend = desktopLocalBackend
  const localTarget = await desktopLocalBackend.start()
  const profileStore = new DesktopProfileStore(path.join(app.getPath('userData'), 'backends.json'), [localTarget])
  const connectionManager = new DesktopConnectionManager(profileStore, {
    appVersion: process.env.FARMING_DESKTOP_SERVER_VERSION || app.getVersion(),
    cacheDir: path.join(app.getPath('userData'), 'server-cache'),
  })
  const desktopGateway = new DesktopGateway(path.resolve(__dirname, '..', 'dist'), profileStore, connectionManager)
  profiles = profileStore
  connections = connectionManager
  gateway = desktopGateway
  await desktopGateway.listen()
  lifecycle.start()
  connectionManager.on('change', broadcastState)
  registerIpc()
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    webContents === mainWindow?.webContents
    && allowsDesktopAudioPermission({
      gatewayOrigin: desktopGateway.origin(),
      isMainFrame: details.isMainFrame,
      mediaType: details.mediaType,
      permission,
      requestingOrigin: details.securityOrigin || requestingOrigin,
    })
  ))
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaDetails = details as Electron.MediaAccessPermissionRequest
    callback(
      webContents === mainWindow?.webContents
      && allowsDesktopAudioPermission({
        gatewayOrigin: desktopGateway.origin(),
        isMainFrame: mediaDetails.isMainFrame,
        mediaTypes: mediaDetails.mediaTypes,
        permission,
        requestingOrigin: mediaDetails.securityOrigin || mediaDetails.requestingUrl,
      }),
    )
  })
  profileStore.setActiveBackendId(LOCAL_BACKEND_ID)
  await connectionManager.connect(LOCAL_BACKEND_ID)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch(error => {
  console.error('Farming Desktop failed to start:', error)
  showStartupFailure(error)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', event => {
  event.preventDefault()
  void stopDesktop(0)
})
