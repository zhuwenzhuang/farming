import { appPath } from './base-path'

export type TurnCheckpointKind = 'turn' | 'manual' | 'pre-restore'

export interface TurnCheckpointFileStat {
  additions: number | null
  deletions: number | null
  path: string
  status: string
}

export interface TurnCheckpointItem {
  id: string
  agentId: string
  turnHandle: string
  kind: TurnCheckpointKind
  summary: string
  repoRoot: string
  workspace: string
  beforeRef: string
  afterRef: string
  beforeTree: string
  afterTree: string
  files: TurnCheckpointFileStat[]
  createdAt: string
}

export interface TurnCheckpointDiffResponse {
  checkpoint: TurnCheckpointItem
  files: TurnCheckpointFileStat[]
  patch: string
  truncated: boolean
}

export interface TurnCheckpointRestoreResponse {
  restored: boolean
  checkpointId: string
  target: 'before' | 'after'
  restoredCount: number
  removedCount: number
  safetyCheckpoint: TurnCheckpointItem | null
}

export async function fetchAgentTurnCheckpoints(
  agentId: string,
  signal?: AbortSignal,
): Promise<TurnCheckpointItem[]> {
  if (!agentId) return []
  const response = await fetch(
    appPath(`/api/agents/${encodeURIComponent(agentId)}/turn-checkpoints`),
    { signal, cache: 'no-store' },
  )
  if (!response.ok) return []
  const data = (await response.json()) as { checkpoints?: TurnCheckpointItem[] }
  return Array.isArray(data.checkpoints) ? data.checkpoints : []
}

export async function fetchAgentTurnCheckpointDiff(
  agentId: string,
  checkpointId: string,
  filePath?: string,
  signal?: AbortSignal,
): Promise<TurnCheckpointDiffResponse> {
  const params = new URLSearchParams()
  if (filePath) params.set('path', filePath)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(
    appPath(`/api/agents/${encodeURIComponent(agentId)}/turn-checkpoints/${encodeURIComponent(checkpointId)}/diff${suffix}`),
    { signal, cache: 'no-store' },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `Failed to load checkpoint diff (${response.status})`)
  }
  return (await response.json()) as TurnCheckpointDiffResponse
}

export async function restoreAgentTurnCheckpoint(
  agentId: string,
  checkpointId: string,
  target: 'before' | 'after' = 'before',
): Promise<TurnCheckpointRestoreResponse> {
  const response = await fetch(
    appPath(`/api/agents/${encodeURIComponent(agentId)}/turn-checkpoints/${encodeURIComponent(checkpointId)}/restore`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    },
  )
  const body = (await response.json().catch(() => ({}))) as TurnCheckpointRestoreResponse & { error?: string }
  if (!response.ok) {
    throw new Error(body.error || `Failed to restore checkpoint (${response.status})`)
  }
  return body
}
