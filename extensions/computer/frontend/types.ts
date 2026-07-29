export type ComputerResourceStatus = 'failed' | 'running' | 'starting' | 'stopped' | 'stopping'
export type ComputerControlOwner = 'agent' | 'human'

export interface ComputerResource {
  id: string
  ownerAgentId: string
  projectRootId: string
  workspace: string
  name: string
  status: ComputerResourceStatus
  generation: number
  revision: number
  collectionRevision: number
  controlOwner: ComputerControlOwner
  controlEpoch: number
  needsObserve: boolean
  containerId: string
  containerName: string
  viewerPort: number
  sessionId: string
  error: string
  createdAt: number
  updatedAt: number
}

export interface ComputerCapability {
  available: boolean
  enabled: boolean
  dockerAvailable: boolean
  imageReady: boolean
  image: string
  imageDigest: string
  driverVersion: string
  compatibilityMode: boolean
  error: string
}
