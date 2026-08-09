import { useCallback, useEffect, useRef, useState } from 'react'
import type { Agent } from '@/types/agent'
import {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  GLOBAL_WORKSPACE_FILES_ROOT,
  isGlobalWorkspaceFilesAgentId,
} from '@/lib/global-workspace-files'
import {
  projectFilesWorkspaceId,
  projectWorkspaceFromFilesId,
} from '@/lib/project-workspaces'
import type {
  OpenWorkspaceFile,
  WorkspaceOpenFileRequest,
  WorkspaceOpenFileTarget,
  WorkspaceOpenFileUpdater,
} from '@/lib/workspace-open-files'
import { workspaceOpenFileRequestForTarget } from '@/lib/workspace-open-files'
import { fetchWorkspaceFile, type WorkspaceFile } from '@/lib/workspace-files'
import { projectWorkspaceForAgent } from './model'
import type { WorkspaceFileOpenTarget, WorkspaceView } from './types'
import {
  loadCodeWorkspaceViewState,
  saveCodeWorkspaceViewState,
  type CodeWorkspaceSurface,
} from './workspace-view-state'

export interface WorkspaceFileIdentity {
  filesId: string
  workspaceRoot?: string
  sourceAgentId?: string
  sourceAgent?: Agent
}

export function resolveWorkspaceFileIdentityForAgents(
  candidateId: string,
  requestedSourceAgentId: string | undefined,
  activeAgents: readonly Agent[],
  hiddenMainAgent: Agent | null,
): WorkspaceFileIdentity {
  const sourceCandidates = hiddenMainAgent ? [...activeAgents, hiddenMainAgent] : activeAgents
  if (isGlobalWorkspaceFilesAgentId(candidateId)) {
    const sourceAgent = sourceCandidates.find(agent => agent.id === requestedSourceAgentId)
    return {
      filesId: GLOBAL_WORKSPACE_FILES_AGENT_ID,
      workspaceRoot: GLOBAL_WORKSPACE_FILES_ROOT,
      sourceAgentId: sourceAgent?.id,
      sourceAgent,
    }
  }

  const projectWorkspace = projectWorkspaceFromFilesId(candidateId)
  if (projectWorkspace) {
    const sourceAgent = activeAgents.find(agent => (
      agent.id === requestedSourceAgentId
      && projectFilesWorkspaceId(projectWorkspaceForAgent(agent)) === projectFilesWorkspaceId(projectWorkspace)
    ))
    return {
      filesId: projectFilesWorkspaceId(projectWorkspace),
      workspaceRoot: projectWorkspace,
      sourceAgentId: sourceAgent?.id,
      sourceAgent,
    }
  }

  const candidateAgent = sourceCandidates.find(agent => agent.id === candidateId)
  if (candidateAgent && !candidateAgent.isMain) {
    const workspaceRoot = projectWorkspaceForAgent(candidateAgent)
    const requestedSourceAgent = activeAgents.find(agent => (
      agent.id === requestedSourceAgentId
      && projectFilesWorkspaceId(projectWorkspaceForAgent(agent)) === projectFilesWorkspaceId(workspaceRoot)
    ))
    const sourceAgent = requestedSourceAgent ?? candidateAgent
    return {
      filesId: projectFilesWorkspaceId(workspaceRoot),
      workspaceRoot,
      sourceAgentId: sourceAgent.id,
      sourceAgent,
    }
  }

  return {
    filesId: candidateId,
    workspaceRoot: candidateAgent ? projectWorkspaceForAgent(candidateAgent) : undefined,
    sourceAgentId: candidateAgent?.id,
    sourceAgent: candidateAgent,
  }
}

interface UseWorkspaceFileIdentityControllerOptions {
  activeAgents: readonly Agent[]
  hiddenMainAgent: Agent | null
  openWorkspaceFile: OpenWorkspaceFile | null
  updateOpenFile: (
    target: WorkspaceOpenFileTarget,
    updater: WorkspaceOpenFileUpdater,
  ) => OpenWorkspaceFile | null
}

export function useWorkspaceFileIdentityController({
  activeAgents,
  hiddenMainAgent,
  openWorkspaceFile,
  updateOpenFile,
}: UseWorkspaceFileIdentityControllerOptions) {
  const cursorRequestIdRef = useRef(0)
  const diffRequestIdRef = useRef(0)
  const resolveWorkspaceFileIdentity = useCallback((
    candidateId: string,
    requestedSourceAgentId?: string,
  ) => resolveWorkspaceFileIdentityForAgents(
    candidateId,
    requestedSourceAgentId,
    activeAgents,
    hiddenMainAgent,
  ), [activeAgents, hiddenMainAgent])

  useEffect(() => {
    if (!openWorkspaceFile?.sourceAgentId) return
    const identity = resolveWorkspaceFileIdentity(
      openWorkspaceFile.agentId,
      openWorkspaceFile.sourceAgentId,
    )
    if (identity.sourceAgentId) return
    updateOpenFile({
      agentId: openWorkspaceFile.agentId,
      filePath: openWorkspaceFile.file.path,
      workspaceRoot: openWorkspaceFile.workspaceRoot,
    }, current => ({ ...current, sourceAgentId: undefined }))
  }, [
    openWorkspaceFile?.agentId,
    openWorkspaceFile?.file.path,
    openWorkspaceFile?.sourceAgentId,
    openWorkspaceFile?.workspaceRoot,
    resolveWorkspaceFileIdentity,
    updateOpenFile,
  ])

  const createWorkspaceOpenFileRequest = useCallback((
    target?: WorkspaceFileOpenTarget,
  ): WorkspaceOpenFileRequest => workspaceOpenFileRequestForTarget(target, {
    cursorRequestId: target?.lineNumber
      ? (cursorRequestIdRef.current += 1)
      : cursorRequestIdRef.current,
    diffRequestId: target?.view === 'diff'
      ? (diffRequestIdRef.current += 1)
      : diffRequestIdRef.current,
  }), [])

  return { resolveWorkspaceFileIdentity, createWorkspaceOpenFileRequest }
}

export type WorkspaceSurfaceRestorePlan =
  | { kind: 'wait' }
  | { kind: 'clear' }
  | { kind: 'agent'; agentId: string }
  | {
      kind: 'file'
      filesId: string
      filePath: string
      target: WorkspaceFileOpenTarget
    }

interface PlanWorkspaceSurfaceRestoreOptions {
  surface: CodeWorkspaceSurface
  activeAgents: readonly Agent[]
  agentInventoryComplete: boolean
  projectWorkspaces: readonly string[]
  projectWorkspacesLoaded: boolean
  resolveWorkspaceFileIdentity: (
    candidateId: string,
    requestedSourceAgentId?: string,
  ) => WorkspaceFileIdentity
}

export function planWorkspaceSurfaceRestore({
  surface,
  activeAgents,
  agentInventoryComplete,
  projectWorkspaces,
  projectWorkspacesLoaded,
  resolveWorkspaceFileIdentity,
}: PlanWorkspaceSurfaceRestoreOptions): WorkspaceSurfaceRestorePlan {
  if (surface.kind === 'agent') {
    if (!agentInventoryComplete) return { kind: 'wait' }
    const targetAgent = activeAgents.find(agent => agent.id === surface.agentId)
      ?? activeAgents.find(agent => (
        Boolean(surface.providerSessionKey)
        && agent.providerSessionKey === surface.providerSessionKey
      ))
      ?? activeAgents.find(agent => (
        Boolean(surface.workspace)
        && projectWorkspaceForAgent(agent) === surface.workspace
      ))
    return targetAgent ? { kind: 'agent', agentId: targetAgent.id } : { kind: 'clear' }
  }

  if (!projectWorkspacesLoaded) return { kind: 'wait' }
  const sourceAgent = activeAgents.find(agent => (
    agent.id === surface.sourceAgentId
    && (
      surface.workspace === GLOBAL_WORKSPACE_FILES_ROOT
      || projectFilesWorkspaceId(projectWorkspaceForAgent(agent)) === projectFilesWorkspaceId(surface.workspace)
    )
  ))
    ?? activeAgents.find(agent => (
      projectFilesWorkspaceId(projectWorkspaceForAgent(agent)) === projectFilesWorkspaceId(surface.workspace)
    ))
  const filesId = surface.workspace === GLOBAL_WORKSPACE_FILES_ROOT
    ? GLOBAL_WORKSPACE_FILES_AGENT_ID
    : projectFilesWorkspaceId(surface.workspace)
  const projectAvailable = surface.workspace === GLOBAL_WORKSPACE_FILES_ROOT
    || projectWorkspaces.some(workspace => projectFilesWorkspaceId(workspace) === filesId)
    || Boolean(sourceAgent)
  if (!projectAvailable) return { kind: 'clear' }
  const identity = resolveWorkspaceFileIdentity(filesId, sourceAgent?.id)
  return {
    kind: 'file',
    filesId: identity.filesId,
    filePath: surface.filePath,
    target: {
      view: surface.view ?? 'editor',
      lineNumber: surface.lineNumber,
      column: surface.column,
      endColumn: surface.endColumn,
      revealInTree: true,
      sourceAgentId: identity.sourceAgentId,
    },
  }
}

export class WorkspaceSurfaceRestoreAdmission {
  private phase: 'waiting' | 'fetching' | 'opening' | 'settled'
  private generation = 0

  constructor(hasRestoreIntent: boolean) {
    this.phase = hasRestoreIntent ? 'waiting' : 'settled'
  }

  begin() {
    if (this.phase !== 'waiting') return null
    this.phase = 'fetching'
    this.generation += 1
    return this.generation
  }

  beginOpening(generation: number) {
    if (this.phase !== 'fetching' || this.generation !== generation) return false
    this.phase = 'opening'
    return true
  }

  cancelFetch(generation: number) {
    if (this.phase !== 'fetching' || this.generation !== generation) return false
    this.phase = 'waiting'
    return true
  }

  settle(generation: number) {
    if (
      (this.phase !== 'fetching' && this.phase !== 'opening')
      || this.generation !== generation
    ) return false
    this.phase = 'settled'
    return true
  }

  isActive(generation: number) {
    return (
      (this.phase === 'fetching' || this.phase === 'opening')
      && this.generation === generation
    )
  }
}

interface CurrentWorkspaceSurfaceOptions {
  activeView: WorkspaceView
  mainPaneMode: 'terminal' | 'editor' | 'browser' | 'computer'
  activeTerminalId: string | null
  activeAgents: readonly Agent[]
  openWorkspaceFile: OpenWorkspaceFile | null
}

export function currentWorkspaceSurface({
  activeView,
  mainPaneMode,
  activeTerminalId,
  activeAgents,
  openWorkspaceFile,
}: CurrentWorkspaceSurfaceOptions): CodeWorkspaceSurface | undefined {
  if (activeView !== 'projects') return undefined
  if (mainPaneMode === 'terminal') {
    const agent = activeAgents.find(candidate => candidate.id === activeTerminalId)
    if (!agent) return undefined
    return {
      kind: 'agent',
      agentId: agent.id,
      providerSessionKey: agent.providerSessionKey || undefined,
      workspace: projectWorkspaceForAgent(agent),
    }
  }
  if (!openWorkspaceFile) return undefined
  const workspace = openWorkspaceFile.workspaceRoot
    ?? activeAgents.find(agent => agent.id === openWorkspaceFile.agentId)?.projectWorkspace
    ?? activeAgents.find(agent => agent.id === openWorkspaceFile.agentId)?.cwd
    ?? ''
  if (!workspace) return undefined
  return {
    kind: 'file',
    workspace,
    filePath: openWorkspaceFile.file.path,
    view: openWorkspaceFile.diffRequestId ? 'diff' : 'editor',
    lineNumber: openWorkspaceFile.cursor?.lineNumber,
    column: openWorkspaceFile.cursor?.column,
    endColumn: openWorkspaceFile.cursor?.endColumn,
    sourceAgentId: openWorkspaceFile.sourceAgentId,
  }
}

interface UseWorkspaceSurfaceControllerOptions extends CurrentWorkspaceSurfaceOptions {
  agentInventoryComplete: boolean
  projectWorkspaces: readonly string[]
  projectWorkspacesLoaded: boolean
  resolveWorkspaceFileIdentity: (
    candidateId: string,
    requestedSourceAgentId?: string,
  ) => WorkspaceFileIdentity
  openAgent: (agentId: string) => void
  openFile: (
    filesId: string,
    file: WorkspaceFile,
    target: WorkspaceFileOpenTarget,
  ) => void | Promise<void>
  fetchFile?: (filesId: string, filePath: string, signal: AbortSignal) => Promise<WorkspaceFile>
}

function fetchWorkspaceSurfaceFile(filesId: string, filePath: string, signal: AbortSignal) {
  return fetchWorkspaceFile(filesId, filePath, { signal })
}

export function useWorkspaceSurfaceController({
  activeView,
  mainPaneMode,
  activeTerminalId,
  activeAgents,
  agentInventoryComplete,
  openWorkspaceFile,
  projectWorkspaces,
  projectWorkspacesLoaded,
  resolveWorkspaceFileIdentity,
  openAgent,
  openFile,
  fetchFile = fetchWorkspaceSurfaceFile,
}: UseWorkspaceSurfaceControllerOptions) {
  const [initialSurface] = useState<CodeWorkspaceSurface | undefined>(() => (
    loadCodeWorkspaceViewState().surface
  ))
  const admissionRef = useRef<WorkspaceSurfaceRestoreAdmission | null>(null)
  if (admissionRef.current === null) {
    admissionRef.current = new WorkspaceSurfaceRestoreAdmission(Boolean(initialSurface))
  }
  const [restored, setRestored] = useState(!initialSurface)

  useEffect(() => {
    if (!initialSurface) return
    const plan = planWorkspaceSurfaceRestore({
      surface: initialSurface,
      activeAgents,
      agentInventoryComplete,
      projectWorkspaces,
      projectWorkspacesLoaded,
      resolveWorkspaceFileIdentity,
    })
    if (plan.kind === 'wait') return
    const generation = admissionRef.current!.begin()
    if (generation === null) return
    const settle = () => {
      if (!admissionRef.current!.settle(generation)) return
      setRestored(true)
    }
    const clear = () => saveCodeWorkspaceViewState({ surface: undefined })

    if (plan.kind === 'clear') {
      clear()
      settle()
      return
    }
    if (plan.kind === 'agent') {
      try {
        openAgent(plan.agentId)
      } catch {
        clear()
      }
      settle()
      return
    }

    const abortController = new AbortController()
    void fetchFile(plan.filesId, plan.filePath, abortController.signal)
      .then(file => {
        if (!admissionRef.current!.beginOpening(generation)) return
        return openFile(plan.filesId, file, plan.target)
      })
      .then(() => settle())
      .catch(() => {
        if (!admissionRef.current!.isActive(generation)) return
        clear()
        settle()
      })
    return () => {
      abortController.abort()
      // Fetch is a read and can restart after dependency churn. Once the
      // host open/mount effect starts, its outcome is not replay-safe: retain
      // the opening admission until that exact effect settles.
      admissionRef.current!.cancelFetch(generation)
    }
  }, [
    activeAgents,
    agentInventoryComplete,
    fetchFile,
    initialSurface,
    openAgent,
    openFile,
    projectWorkspaces,
    projectWorkspacesLoaded,
    resolveWorkspaceFileIdentity,
  ])

  useEffect(() => {
    if (!restored) return
    const surface = currentWorkspaceSurface({
      activeView,
      mainPaneMode,
      activeTerminalId,
      activeAgents,
      openWorkspaceFile,
    })
    if (surface) saveCodeWorkspaceViewState({ surface })
  }, [activeAgents, activeTerminalId, activeView, mainPaneMode, openWorkspaceFile, restored])
}
