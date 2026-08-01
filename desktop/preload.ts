import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopBackendInput,
  DesktopNotificationClick,
  DesktopNotificationInput,
  DesktopState,
  FarmingDesktopBridge,
} from '../shared/desktop-contract.js'

const bridge: FarmingDesktopBridge = {
  getState: () => ipcRenderer.invoke('desktop:get-state') as Promise<DesktopState>,
  saveBackend: (input: DesktopBackendInput) => ipcRenderer.invoke('desktop:save-backend', input) as Promise<DesktopState>,
  removeBackend: (backendId: string) => ipcRenderer.invoke('desktop:remove-backend', backendId) as Promise<DesktopState>,
  connectBackend: (backendId: string) => ipcRenderer.invoke('desktop:connect-backend', backendId) as Promise<DesktopState>,
  disconnectBackend: (backendId: string) => ipcRenderer.invoke('desktop:disconnect-backend', backendId) as Promise<DesktopState>,
  activateBackend: (backendId: string) => ipcRenderer.invoke('desktop:activate-backend', backendId) as Promise<DesktopState>,
  showNotification: (input: DesktopNotificationInput) => ipcRenderer.invoke('desktop:show-notification', input) as Promise<void>,
  onStateChanged(listener: (state: DesktopState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopState) => listener(state)
    ipcRenderer.on('desktop:state-changed', handler)
    return () => ipcRenderer.off('desktop:state-changed', handler)
  },
  onNotificationClicked(listener: (event: DesktopNotificationClick) => void) {
    const handler = (_ipcEvent: Electron.IpcRendererEvent, event: DesktopNotificationClick) => listener(event)
    ipcRenderer.on('desktop:notification-clicked', handler)
    return () => ipcRenderer.off('desktop:notification-clicked', handler)
  },
}

contextBridge.exposeInMainWorld('farmingDesktop', bridge)
