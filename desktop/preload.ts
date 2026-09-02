import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopBackendInput,
  DesktopNativeBrowserCommand,
  DesktopNativeBrowserEvent,
  DesktopNativeBrowserMount,
  DesktopNotificationInput,
  DesktopState,
  FarmingDesktopBridge,
} from '../shared/desktop-contract.js'

function nativeBrowserAdapterIdFromArg(argv: readonly string[]): string {
  const prefix = '--farming-native-browser-adapter='
  const value = argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length).trim() || ''
  if (value) return value
  // Main always provides the argument. Keep this explicit value only so an
  // incompatible hand-built Desktop runtime fails through the backend adapter
  // boundary rather than silently sharing a renderer-generated identity.
  return 'desktop-browser-unavailable'
}

const nativeBrowserAdapterId = nativeBrowserAdapterIdFromArg(process.argv)

const bridge: FarmingDesktopBridge = {
  getState: () => ipcRenderer.invoke('desktop:get-state') as Promise<DesktopState>,
  saveAndActivateBackend: (input: DesktopBackendInput) => ipcRenderer.invoke('desktop:save-and-activate-backend', input) as Promise<DesktopState>,
  removeBackend: (backendId: string) => ipcRenderer.invoke('desktop:remove-backend', backendId) as Promise<DesktopState>,
  connectBackend: (backendId: string) => ipcRenderer.invoke('desktop:connect-backend', backendId) as Promise<DesktopState>,
  disconnectBackend: (backendId: string) => ipcRenderer.invoke('desktop:disconnect-backend', backendId) as Promise<DesktopState>,
  activateBackend: (backendId: string) => ipcRenderer.invoke('desktop:activate-backend', backendId) as Promise<DesktopState>,
  showNotification: (input: DesktopNotificationInput) => ipcRenderer.invoke('desktop:show-notification', input) as Promise<void>,
  nativeBrowser: {
    adapterId: nativeBrowserAdapterId,
    command: async (command: DesktopNativeBrowserCommand) => ({
      result: await ipcRenderer.invoke('desktop:native-browser-command', command),
    }),
    mount: (input: DesktopNativeBrowserMount) => (
      ipcRenderer.invoke('desktop:native-browser-mount', input) as Promise<void>
    ),
    unmount: (input: { generation: number; resourceId: string }) => (
      ipcRenderer.invoke('desktop:native-browser-unmount', input) as Promise<void>
    ),
    focus: (input: { generation: number; resourceId: string }) => (
      ipcRenderer.invoke('desktop:native-browser-focus', input) as Promise<void>
    ),
    invalidateLease: () => (
      ipcRenderer.invoke('desktop:native-browser-invalidate-lease') as Promise<void>
    ),
    reconcileBackendEpoch: (serverEpoch: string) => (
      ipcRenderer.invoke(
        'desktop:native-browser-reconcile-backend-epoch',
        serverEpoch,
      ) as Promise<void>
    ),
    onEvent(listener: (event: DesktopNativeBrowserEvent) => void) {
      const handler = (_event: Electron.IpcRendererEvent, event: DesktopNativeBrowserEvent) => listener(event)
      ipcRenderer.on('desktop:native-browser-event', handler)
      return () => ipcRenderer.off('desktop:native-browser-event', handler)
    },
  },
  onStateChanged(listener: (state: DesktopState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopState) => listener(state)
    ipcRenderer.on('desktop:state-changed', handler)
    return () => ipcRenderer.off('desktop:state-changed', handler)
  },
}

contextBridge.exposeInMainWorld('farmingDesktop', bridge)
