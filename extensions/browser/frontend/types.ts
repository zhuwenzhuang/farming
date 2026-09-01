export type BrowserResourceStatus = 'failed' | 'reconnecting' | 'running' | 'starting' | 'stopped' | 'stopping'

export interface BrowserResource {
  id: string
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
  browserSource?: 'desktop' | 'extension' | 'isolated' | 'system'
  desktopAdapterId?: string
  sessionId?: string
  tabId?: string
  sessionName?: string
  controlEpoch?: number
  controlOwner?: 'agent' | 'user'
  loading?: boolean
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
    source: 'desktop' | 'extension' | 'isolated' | 'system'
    executablePath: string
  }
  options?: Array<{ kind: string; path: string }>
  sources?: Array<{
    source: 'desktop' | 'extension' | 'isolated' | 'system'
    available: boolean
    kind: string
    path: string
    message: string
  }>
  extension?: {
    installed?: boolean
    extensionPath?: string
    sizeBytes?: number
    integrity?: 'invalid' | 'missing' | 'valid'
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
