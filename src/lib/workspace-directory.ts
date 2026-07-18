import { appPath } from '@/lib/base-path'

export type WorkspaceDirectoryResult = {
  status: 'ready' | 'missing' | 'created' | 'rejected'
  workspace: string
  code?: string
  message?: string
}

export async function prepareWorkspaceDirectory(workspace: string, create = false): Promise<WorkspaceDirectoryResult> {
  const response = await fetch(appPath('/api/workspaces/prepare'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, create }),
  })
  const result = await response.json().catch(() => null) as WorkspaceDirectoryResult | null
  if (result?.status && typeof result.workspace === 'string') return result
  throw new Error(result?.message || `Failed to prepare workspace (${response.status})`)
}
