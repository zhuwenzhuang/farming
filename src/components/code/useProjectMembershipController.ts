import { useCallback, useEffect, useReducer } from 'react'
import { appPath } from '@/lib/base-path'
import { normalizeProjectWorkspaces } from '@/lib/project-workspaces'

export type ProjectMembership = {
  projectWorkspaces?: unknown
  pinnedProjectWorkspaces?: unknown
}

export type ProjectMembershipState = {
  projectWorkspaces: string[]
  projectWorkspacesLoaded: boolean
  pinnedProjectWorkspaces: string[]
}

export type ProjectMountResponse = ProjectMembership & {
  error?: string
  workspace?: string
}

type ProjectMountRequest = (
  url: string,
  init: {
    method: 'POST'
    headers: { 'Content-Type': 'application/json' }
    body: string
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export const initialProjectMembershipState: ProjectMembershipState = {
  projectWorkspaces: [],
  projectWorkspacesLoaded: false,
  pinnedProjectWorkspaces: [],
}

function normalizedMembershipUpdate(membership: ProjectMembership) {
  return {
    projectWorkspaces: Array.isArray(membership.projectWorkspaces)
      ? normalizeProjectWorkspaces(membership.projectWorkspaces)
      : undefined,
    pinnedProjectWorkspaces: Array.isArray(membership.pinnedProjectWorkspaces)
      ? normalizeProjectWorkspaces(membership.pinnedProjectWorkspaces)
      : undefined,
  }
}

export function projectMembershipReducer(
  state: ProjectMembershipState,
  membership: ProjectMembership,
): ProjectMembershipState {
  const update = normalizedMembershipUpdate(membership)
  if (!update.projectWorkspaces && !update.pinnedProjectWorkspaces) return state
  return {
    projectWorkspaces: update.projectWorkspaces ?? state.projectWorkspaces,
    projectWorkspacesLoaded: update.projectWorkspaces ? true : state.projectWorkspacesLoaded,
    pinnedProjectWorkspaces: update.pinnedProjectWorkspaces ?? state.pinnedProjectWorkspaces,
  }
}

export function projectMountResult(
  requestedWorkspace: string,
  response: ProjectMountResponse | null,
) {
  return {
    membership: response ?? {},
    workspace: response?.workspace || requestedWorkspace,
  }
}

function normalizeMountWorkspace(workspace: string) {
  const trimmedWorkspace = workspace.trim()
  return trimmedWorkspace === '/'
    ? '/'
    : trimmedWorkspace.replace(/[\\/]+$/, '')
}

export function throwIfProjectMountAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw new DOMException('Project mount was aborted', 'AbortError')
}

export async function requestProjectMount(
  workspace: string,
  signal?: AbortSignal,
  request: ProjectMountRequest = fetch,
) {
  throwIfProjectMountAborted(signal)
  const normalizedWorkspace = normalizeMountWorkspace(workspace)
  if (!normalizedWorkspace) return { membership: null, workspace: '' }
  const response = await request(appPath('/api/projects/mount'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: normalizedWorkspace }),
    signal,
  })
  const membership = await response.json().catch(() => null) as ProjectMountResponse | null
  throwIfProjectMountAborted(signal)
  if (!response.ok) throw new Error(membership?.error || `Project request failed (${response.status})`)
  return projectMountResult(normalizedWorkspace, membership)
}

export function useProjectMembershipController(
  remoteProjectWorkspaces: string[] | null,
  remotePinnedProjectWorkspaces: string[] | null,
) {
  const [state, applyMembership] = useReducer(
    projectMembershipReducer,
    initialProjectMembershipState,
  )

  useEffect(() => {
    if (remoteProjectWorkspaces === null) return
    applyMembership({ projectWorkspaces: remoteProjectWorkspaces })
  }, [remoteProjectWorkspaces])

  useEffect(() => {
    if (remotePinnedProjectWorkspaces === null) return
    applyMembership({ pinnedProjectWorkspaces: remotePinnedProjectWorkspaces })
  }, [remotePinnedProjectWorkspaces])

  const mountProject = useCallback(async (workspace: string, signal?: AbortSignal) => {
    const result = await requestProjectMount(workspace, signal)
    throwIfProjectMountAborted(signal)
    if (result.membership) applyMembership(result.membership)
    return result.workspace
  }, [])

  return {
    ...state,
    applyMembership,
    mountProject,
  }
}
