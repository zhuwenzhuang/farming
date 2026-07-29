export interface AgentProviderSessionPlan {
  provider: string
  id: string
  precreate: boolean
  temporary: boolean
  source: string
  forkedFromProviderSessionId: string
  providerHomeId?: string
  identityWorkspace?: string
  resumeInsertIndex?: number | null
  error?: string
  args: string[]
}

export type AgentOrderField = 'projectOrder' | 'pinnedOrder'

export interface AgentOrderTransactionOwner {
  agents: Map<string, Record<string, any>>
  lifecycleOperations: Map<string, { label?: string }>
  persistAgent(agent: Record<string, any>): void
  updateRuntimeMetadata(agent: Record<string, any>): void
  emitUpdate(): void
  setAgentRecordId(agent: Record<string, any>, recordId: string): void
  finiteOrder(value: unknown): number
}

export interface AgentOrderTransactionSuccess {
  agentId: string
  projectOrder?: number
  pinnedOrder?: number
  updates: Array<Record<string, number | string>>
  error?: never
}

export interface AgentOrderTransactionFailure {
  error: string
}

export type AgentOrderTransactionResult =
  | AgentOrderTransactionSuccess
  | AgentOrderTransactionFailure
