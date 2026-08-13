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

export interface BrowserResourceCollection {
  collectionRevision: number
  resources: BrowserResource[]
}

export interface BrowserResourceDeletion {
  id: string
  collectionRevision: number
}

export interface BrowserCapability {
  enabled: boolean
  available: boolean
  browser: { kind: string; path: string } | null
  selection?: {
    source: 'extension' | 'external-cdp' | 'isolated' | 'system'
    executablePath: string
    externalCdpUrl: string
  }
  options?: Array<{ kind: string; path: string }>
  extension?: {
    installed?: boolean
    extensionPath?: string
    connected?: boolean
    browser?: {
      browserVersion?: string
      extensionVersion?: string
      userAgent?: string
    } | null
    accessibleTabs?: number
    protocol?: string
  } | null
  isolated?: {
    available?: boolean
    dockerAvailable?: boolean
    imageReady?: boolean
    image?: string
    imageDigest?: string
    compatibilityMode?: boolean
    error?: string
  } | null
  message: string
}
