export type DesktopBackendTransport = 'ssh' | 'direct'

export type DesktopBackendStatus =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'error'

export interface DesktopBackendProfile {
  id: string
  kind: 'local' | 'remote'
  name: string
  transport: DesktopBackendTransport
  sshHost: string
  remoteHost: string
  remotePort: number
  basePath: string
  directUrl: string
  farmingHome: string
  hasToken: boolean
}

export interface DesktopBackendInput {
  id?: string
  name: string
  transport: DesktopBackendTransport
  sshHost?: string
  remoteHost?: string
  remotePort?: number
  basePath?: string
  directUrl?: string
  farmingHome?: string
  token?: string
  clearToken?: boolean
}

export interface DesktopBackendConnection {
  backendId: string
  generation: number
  status: DesktopBackendStatus
  error: string
  message: string
  server: DesktopServerInfo | null
}

export interface DesktopCapabilitySummary {
  id: string
  state: string
}

export interface DesktopServerInfo {
  version: string
  platform: string
  arch: string
  farmingHome: string
  runtime: string
  capabilities: DesktopCapabilitySummary[]
}

export interface DesktopState {
  activeBackendId: string | null
  profiles: DesktopBackendProfile[]
  connections: DesktopBackendConnection[]
}

export interface DesktopNotificationInput {
  agentId: string
  body: string
  title: string
}

export interface FarmingDesktopBridge {
  getState(): Promise<DesktopState>
  saveBackend(input: DesktopBackendInput): Promise<DesktopState>
  removeBackend(backendId: string): Promise<DesktopState>
  connectBackend(backendId: string): Promise<DesktopState>
  disconnectBackend(backendId: string): Promise<DesktopState>
  activateBackend(backendId: string): Promise<DesktopState>
  showNotification(input: DesktopNotificationInput): Promise<void>
  onStateChanged(listener: (state: DesktopState) => void): () => void
}
