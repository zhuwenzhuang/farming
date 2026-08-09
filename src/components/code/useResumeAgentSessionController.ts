import { useCallback, useEffect, useRef } from 'react'
import { appPath } from '@/lib/base-path'
import { agentSessionId } from './model'
import { resumedAgentSource } from './session-display'
import {
  canonicalProviderSessionKey,
  canonicalResumedProviderSessionSource,
} from '../../../shared/provider-session-identity.js'
import type { ProjectMembership } from './useProjectMembershipController'

const CHAT_RESUME_PROVIDERS = new Set(['codex', 'claude', 'opencode', 'qoder', 'qwen'])
const RESUME_AGENT_SESSION_TIMEOUT_MS = 60_000

export type ResumeAgentCandidate = {
  archived?: boolean
  id: string
  providerSessionKey?: string
  source?: string
  status: string
  workspace: string
}

export type ResumeAgentSessionIdentity = {
  customTitle?: string
  provider: string
  providerHomeId?: string
  sessionId: string
}

type ResumeResponse = ProjectMembership & { agentId: string }
type ResumeRequest = (
  url: string,
  init: {
    body: string
    headers: { 'Content-Type': 'application/json' }
    method: 'POST'
    signal: AbortSignal
  },
) => Promise<{ json(): Promise<unknown>; ok: boolean; status: number }>

export interface ResumeAgentSessionPorts {
  applyProjectMembership: (membership: ProjectMembership) => void
  clearTimer?: (timer: unknown) => void
  closeMobileNavigation: () => void
  commitSessionMembership: (identity: Omit<ResumeAgentSessionIdentity, 'customTitle'>) => void
  createAbortController?: () => AbortController
  getActiveAgents: () => readonly ResumeAgentCandidate[]
  mountProject: (workspace: string, signal?: AbortSignal) => Promise<string>
  openAgent: (agentId: string, whenReady: boolean) => void
  request?: ResumeRequest
  setTimer?: (callback: () => void, delay: number) => unknown
  showError: (message: string) => void
  timeoutMs?: number
}

export type ResumeAgentSessionOutcome =
  | { status: 'succeeded'; agentId: string; reused: boolean }
  | { status: 'failed'; uncertain: boolean }
  | { status: 'stale' }

type ResumeOperation = {
  abortController: AbortController
  customTitle: string
  finalize: (outcome: ResumeAgentSessionOutcome) => void
  promise: Promise<ResumeAgentSessionOutcome>
  timer: unknown
}

function identityParts(identity: ResumeAgentSessionIdentity) {
  return { provider: identity.provider, sessionId: identity.sessionId, providerHomeId: identity.providerHomeId || '' }
}

function identityKey(identity: ResumeAgentSessionIdentity) {
  const normalized = identityParts(identity)
  return agentSessionId({
    provider: normalized.provider,
    id: normalized.sessionId,
    providerHomeId: normalized.providerHomeId,
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseResumeResponse(value: unknown): ResumeResponse | null {
  const data = record(value)
  if (!data || typeof data.agentId !== 'string' || !data.agentId.trim()) return null
  if (data.projectWorkspaces !== undefined && !stringArray(data.projectWorkspaces)) return null
  if (data.pinnedProjectWorkspaces !== undefined && !stringArray(data.pinnedProjectWorkspaces)) return null
  return {
    agentId: data.agentId,
    ...(data.projectWorkspaces !== undefined ? { projectWorkspaces: data.projectWorkspaces } : {}),
    ...(data.pinnedProjectWorkspaces !== undefined ? { pinnedProjectWorkspaces: data.pinnedProjectWorkspaces } : {}),
  }
}

/** Owns Resume admission, mutation reconciliation, and stale-completion fencing. */
export class ResumeAgentSessionController {
  private disposed = false
  private readonly inFlight = new Map<string, ResumeOperation>()

  constructor(private readonly ports: ResumeAgentSessionPorts) {}

  resume(identity: ResumeAgentSessionIdentity): Promise<ResumeAgentSessionOutcome> {
    if (this.disposed) return Promise.resolve({ status: 'stale' })
    const key = identityKey(identity)
    const customTitle = identity.customTitle || ''
    const existing = this.inFlight.get(key)
    if (existing) {
      if (existing.customTitle === customTitle) return existing.promise
      this.ports.showError('This Agent session is already resuming with a different title')
      return Promise.resolve({ status: 'failed', uncertain: false })
    }

    const abortController = (this.ports.createAbortController || (() => new AbortController()))()
    let resolveOperation!: (outcome: ResumeAgentSessionOutcome) => void
    const promise = new Promise<ResumeAgentSessionOutcome>(resolve => { resolveOperation = resolve })
    const operation = {} as ResumeOperation
    let finalized = false
    const finalize = (outcome: ResumeAgentSessionOutcome) => {
      if (finalized) return
      finalized = true
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key)
      if (operation.timer !== undefined) (this.ports.clearTimer || clearTimeout)(operation.timer as number)
      resolveOperation(outcome)
    }
    const setTimer = this.ports.setTimer || ((callback: () => void, delay: number) => setTimeout(callback, delay))
    Object.assign(operation, {
      abortController,
      customTitle,
      finalize,
      promise,
      timer: setTimer(() => {
        if (this.inFlight.get(key) !== operation) return
        this.ports.showError('Agent session resume timed out; the outcome is uncertain')
        finalize({ status: 'failed', uncertain: true })
        abortController.abort()
      }, this.ports.timeoutMs ?? RESUME_AGENT_SESSION_TIMEOUT_MS),
    })
    this.inFlight.set(key, operation)
    const active = () => !this.disposed && this.inFlight.get(key) === operation
    void this.run(identityParts(identity), customTitle, abortController.signal, active)
      .then(finalize, error => finalize(this.fail(error, active, true)))
    return promise
  }

  private fail(
    error: unknown,
    active: () => boolean,
    uncertain: boolean,
    fallback = 'Failed to resume agent session',
  ): ResumeAgentSessionOutcome {
    if (!active()) return { status: 'stale' }
    this.ports.showError(error instanceof Error ? error.message : fallback)
    return { status: 'failed', uncertain }
  }

  private finish(
    identity: Omit<ResumeAgentSessionIdentity, 'customTitle'>,
    agentId: string,
    whenReady: boolean,
  ): ResumeAgentSessionOutcome {
    this.ports.commitSessionMembership(identity)
    this.ports.openAgent(agentId, whenReady)
    this.ports.closeMobileNavigation()
    return { status: 'succeeded', agentId, reused: !whenReady }
  }

  private async run(
    identity: Omit<ResumeAgentSessionIdentity, 'customTitle'>,
    customTitle: string,
    signal: AbortSignal,
    active: () => boolean,
  ) {
    const sessionHandle = agentSessionId({
      provider: identity.provider,
      id: identity.sessionId,
      providerHomeId: identity.providerHomeId,
    })
    const source = resumedAgentSource(identity.provider, identity.sessionId, identity.providerHomeId)
    const activeAgent = this.ports.getActiveAgents().find(agent => (
      (canonicalProviderSessionKey(agent.providerSessionKey) === sessionHandle
        || canonicalResumedProviderSessionSource(agent.source) === source)
      && agent.archived !== true
      && agent.status !== 'dead'
      && agent.status !== 'stopped'
    ))
    if (activeAgent) {
      try {
        await this.ports.mountProject(activeAgent.workspace, signal)
        if (!active()) return { status: 'stale' } as const
        return this.finish(identity, activeAgent.id, false)
      } catch (error) {
        return this.fail(error, active, true)
      }
    }

    try {
      const request = this.ports.request || fetch
      const response = await request(
        appPath(`/api/agent-sessions/${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.sessionId)}/resume`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            unarchiveArchived: true,
            providerHomeId: identity.providerHomeId,
            ...(CHAT_RESUME_PROVIDERS.has(identity.provider) ? { agentRuntimeMode: 'chat', acpHistoryMode: 'load' } : {}),
            ...(customTitle ? { customTitle } : {}),
          }),
        },
      )
      const raw = await response.json().catch(() => null)
      if (!active()) return { status: 'stale' } as const
      const data = parseResumeResponse(raw)
      if (!response.ok || !data) {
        const error = record(raw)?.error
        this.ports.showError(
          typeof error === 'string' && error
            ? error
            : `Failed to resume agent session (${response.status})`,
        )
        return { status: 'failed', uncertain: response.ok } as const
      }
      this.ports.applyProjectMembership(data)
      return this.finish(identity, data.agentId, true)
    } catch (error) {
      // The mutation may have completed before a transport failure. This
      // admission terminates without replay; a later user action is explicit.
      return this.fail(error, active, true)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const operation of [...this.inFlight.values()]) {
      operation.finalize({ status: 'stale' })
      operation.abortController.abort()
    }
  }
}

export function useResumeAgentSessionController(ports: ResumeAgentSessionPorts) {
  const portsRef = useRef(ports)
  portsRef.current = ports
  const controllerRef = useRef<ResumeAgentSessionController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = new ResumeAgentSessionController({
      applyProjectMembership: membership => portsRef.current.applyProjectMembership(membership),
      closeMobileNavigation: () => portsRef.current.closeMobileNavigation(),
      commitSessionMembership: identity => portsRef.current.commitSessionMembership(identity),
      getActiveAgents: () => portsRef.current.getActiveAgents(),
      mountProject: (workspace, signal) => portsRef.current.mountProject(workspace, signal),
      openAgent: (agentId, whenReady) => portsRef.current.openAgent(agentId, whenReady),
      request: (url, init) => (portsRef.current.request || fetch)(url, init),
      showError: message => portsRef.current.showError(message),
    })
  }
  const controller = controllerRef.current
  useEffect(() => () => controller.dispose(), [controller])
  return useCallback((provider: string, sessionId: string, providerHomeId = '', customTitle = '') => (
    controller.resume({ provider, sessionId, providerHomeId, customTitle })
  ), [controller])
}
