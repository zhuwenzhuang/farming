import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from 'react'
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

export async function requestProjectMountForFile(
  filePath: string,
  signal?: AbortSignal,
  request: ProjectMountRequest = fetch,
) {
  throwIfProjectMountAborted(signal)
  const normalizedPath = filePath.trim()
  if (!normalizedPath) return { membership: null, workspace: '' }
  const response = await request(appPath('/api/projects/mount-file'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: normalizedPath }),
    signal,
  })
  const membership = await response.json().catch(() => null) as ProjectMountResponse | null
  throwIfProjectMountAborted(signal)
  if (response.status === 404) return { membership: null, workspace: '' }
  if (!response.ok) throw new Error(membership?.error || `Project request failed (${response.status})`)
  return projectMountResult('', membership)
}

export type ProjectNamesState = {
  latestRequestVersion: number
  names: Record<string, string>
  revision: number
}

export type ProjectNamesInitialGuard = {
  requestVersion: number
  revision: number
}

export const initialProjectNamesState: ProjectNamesState = {
  latestRequestVersion: 0,
  names: {},
  revision: 0,
}

export function normalizeProjectNames(projectNames: unknown): Record<string, string> {
  const source = projectNames && typeof projectNames === 'object' && !Array.isArray(projectNames)
    ? projectNames as Record<string, unknown>
    : null
  if (!source) return {}
  const normalized: Record<string, string> = {}
  for (const [workspace, name] of Object.entries(source)) {
    if (typeof name !== 'string') continue
    const key = workspace.trim()
    const value = name.trim()
    if (key && value) normalized[key] = value.slice(0, 80)
  }
  return normalized
}

export function beginProjectNamesSettingsRequest(
  state: ProjectNamesState,
): { guard: ProjectNamesInitialGuard; state: ProjectNamesState } {
  const requestVersion = state.latestRequestVersion + 1
  return {
    guard: { requestVersion, revision: state.revision },
    state: { ...state, latestRequestVersion: requestVersion },
  }
}

export function receiveInitialProjectNames(
  state: ProjectNamesState,
  projectNames: unknown,
  guard: ProjectNamesInitialGuard,
): ProjectNamesState {
  if (guard.requestVersion !== state.latestRequestVersion) return state
  if (guard.revision !== state.revision) return state
  return { ...state, names: normalizeProjectNames(projectNames) }
}

export function replaceProjectName(
  state: ProjectNamesState,
  workspace: string,
  name: string | null,
  expectedCurrent?: string,
): ProjectNamesState {
  const current = state.names
  if (expectedCurrent !== undefined && current[workspace] !== expectedCurrent) return state
  if (name === null) {
    if (!(workspace in current)) return state
    const next = { ...current }
    delete next[workspace]
    return { ...state, names: next, revision: state.revision + 1 }
  }
  if (current[workspace] === name) return state
  return { ...state, names: { ...current, [workspace]: name }, revision: state.revision + 1 }
}

/**
 * Owns the authoritative Project display names: optimistic rename projection
 * with compare-and-swap rollback, plus stale-response fencing so an initial
 * settings read can never overwrite a rename that landed after it started.
 */
export class ProjectNamesController {
  private state = initialProjectNamesState
  private readonly listeners = new Set<() => void>()

  getSnapshot = () => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  captureInitialSettingsGuard = () => {
    const request = beginProjectNamesSettingsRequest(this.state)
    this.publish(request.state)
    return request.guard
  }

  receiveInitialSettings = (projectNames: unknown, guard: ProjectNamesInitialGuard) => {
    this.publish(receiveInitialProjectNames(this.state, projectNames, guard))
  }

  replaceProjectName = (workspace: string, name: string | null, expectedCurrent?: string) => {
    this.publish(replaceProjectName(this.state, workspace, name, expectedCurrent))
  }

  private publish(next: ProjectNamesState) {
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

export function useProjectMembershipController(
  remoteProjectWorkspaces: string[] | null,
  remotePinnedProjectWorkspaces: string[] | null,
) {
  const [state, applyMembership] = useReducer(
    projectMembershipReducer,
    initialProjectMembershipState,
  )
  const [namesController] = useState(() => new ProjectNamesController())
  const namesState = useSyncExternalStore(
    namesController.subscribe,
    namesController.getSnapshot,
    namesController.getSnapshot,
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

  const mountProjectForFile = useCallback(async (filePath: string, signal?: AbortSignal) => {
    const result = await requestProjectMountForFile(filePath, signal)
    throwIfProjectMountAborted(signal)
    if (result.membership) applyMembership(result.membership)
    return result.workspace
  }, [])

  return {
    ...state,
    projectNames: namesState.names,
    applyMembership,
    mountProject,
    mountProjectForFile,
    replaceProjectName: namesController.replaceProjectName,
    captureProjectNamesInitialGuard: namesController.captureInitialSettingsGuard,
    receiveInitialProjectNames: namesController.receiveInitialSettings,
  }
}
