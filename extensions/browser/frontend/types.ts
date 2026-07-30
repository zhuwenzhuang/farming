export type BrowserResourceStatus = 'failed' | 'running' | 'starting' | 'stopped' | 'stopping'

export interface BrowserResource {
  id: string
  ownerType: 'agent' | 'project'
  ownerAgentId: string
  projectRootId: string
  workspace: string
  name: string
  status: BrowserResourceStatus
  generation: number
  revision: number
  collectionRevision: number
  url: string
  title: string
  browserKind: string
  error: string
  createdAt: number
  updatedAt: number
}

export interface BrowserCapability {
  enabled: boolean
  available: boolean
  browser: { kind: string; path: string } | null
  selection?: {
    source: 'external-cdp' | 'isolated' | 'managed' | 'system'
    executablePath: string
    externalCdpUrl: string
  }
  options?: Array<{ kind: string; path: string }>
  isolated?: {
    available?: boolean
    dockerAvailable?: boolean
    imageReady?: boolean
    image?: string
    imageDigest?: string
    compatibilityMode?: boolean
    error?: string
  } | null
  installation: {
    state: 'absent' | 'failed' | 'installing' | 'ready'
    agentBrowserVersion: string
    installedVersion: string
    updateAvailable: boolean
    error: string
  }
  message: string
}
