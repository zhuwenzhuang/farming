import { useEffect, useRef } from 'react'
import { appPath } from '@/lib/base-path'
import { agentSessionId } from './model'
import { resumedAgentSource } from './session-display'
import {
  canonicalProviderSessionKey,
  canonicalResumedProviderSessionSource,
} from '../../../shared/provider-session-identity.js'
import type { ProjectMembership } from './useProjectMembershipController'

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

type ResumeResponse = ProjectMembership & { agentId: string; reused: boolean }
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
  commitSessionMembership: (identity: Omit<ResumeAgentSessionIdentity, 'customTitle'>) => void
  createAbortController?: () => AbortController
  getActiveAgents: () => readonly ResumeAgentCandidate[]
  mountProject: (workspace: string, signal?: AbortSignal) => Promise<string>
  readStatus?: (url: string, init: { signal: AbortSignal }) => ReturnType<ResumeRequest>
  request?: ResumeRequest
  setTimer?: (callback: () => void, delay: number) => unknown
  timeoutMs?: number
}

export type ResumeAgentSessionOutcome =
  | { status: 'succeeded'; agentId: string; reused: boolean }
  | { status: 'failed'; uncertain: boolean; message: string }
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
    reused: data.reused === true,
    ...(data.projectWorkspaces !== undefined ? { projectWorkspaces: data.projectWorkspaces } : {}),
    ...(data.pinnedProjectWorkspaces !== undefined ? { pinnedProjectWorkspaces: data.pinnedProjectWorkspaces } : {}),
  }
}

/** Owns Resume admission, mutation reconciliation, and stale-completion fencing. */
export class ResumeAgentSessionController {
  private disposed = false
  private readonly inFlight = new Map<string, ResumeOperation>()
  private readonly uncertain = new Set<string>()
  private readonly checks = new Set<() => void>()

  constructor(private readonly ports: ResumeAgentSessionPorts) {}

  resume(identity: ResumeAgentSessionIdentity): Promise<ResumeAgentSessionOutcome> {
    if (this.disposed) return Promise.resolve({ status: 'stale' })
    const key = identityKey(identity)
    if (this.uncertain.has(key)) return Promise.resolve({ status: 'failed', uncertain: true, message: 'The resume outcome is uncertain. Check its status before continuing.' })
    const customTitle = identity.customTitle || ''
    const existing = this.inFlight.get(key)
    if (existing) {
      if (existing.customTitle === customTitle) return existing.promise
      return Promise.resolve({ status: 'failed', uncertain: false, message: 'This Agent session is already resuming with a different title' })
    }

    const abortController = (this.ports.createAbortController || (() => new AbortController()))()
    let resolveOperation!: (outcome: ResumeAgentSessionOutcome) => void
    const promise = new Promise<ResumeAgentSessionOutcome>(resolve => { resolveOperation = resolve })
    const operation = {} as ResumeOperation
    let finalized = false
    const finalize = (outcome: ResumeAgentSessionOutcome) => {
      if (finalized) return
      finalized = true
      if (outcome.status === 'failed' && outcome.uncertain) this.uncertain.add(key)
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
        finalize({ status: 'failed', uncertain: true, message: 'Agent session resume timed out; the outcome is uncertain' })
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
    return { status: 'failed', uncertain, message: error instanceof Error ? error.message : fallback }
  }

  private finish(
    identity: Omit<ResumeAgentSessionIdentity, 'customTitle'>,
    agentId: string,
    reused: boolean,
  ): ResumeAgentSessionOutcome {
    this.ports.commitSessionMembership(identity)
    return { status: 'succeeded', agentId, reused }
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
        return this.finish(identity, activeAgent.id, true)
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
            agentRuntimeMode: 'chat',
            acpHistoryMode: 'load',
            ...(customTitle ? { customTitle } : {}),
          }),
        },
      )
      const raw = await response.json().catch(() => null)
      if (!active()) return { status: 'stale' } as const
      const data = parseResumeResponse(raw)
      if (!response.ok || !data) {
        const error = record(raw)?.error
        return {
          status: 'failed',
          uncertain: response.ok || response.status >= 500 || response.status === 409,
          message: typeof error === 'string' && error ? error : `Failed to resume agent session (${response.status})`,
        } as const
      }
      this.ports.applyProjectMembership(data)
      return this.finish(identity, data.agentId, data.reused)
    } catch (error) {
      // The mutation may have completed before a transport failure. This
      // admission terminates without replay; a later user action is explicit.
      return this.fail(error, active, true)
    }
  }

  /** A read cannot establish that a lost mutation is safe to replay. */
  reconcile(identity: ResumeAgentSessionIdentity): Promise<ResumeAgentSessionOutcome> {
    if (this.disposed) return Promise.resolve({ status: 'stale' })
    const key = identityKey(identity)
    const abort = new AbortController()
    return new Promise(resolve => {
      let settled = false
      const finish = (outcome: ResumeAgentSessionOutcome) => {
        if (settled) return
        settled = true
        ;(this.ports.clearTimer || clearTimeout)(timer as number)
        this.checks.delete(cancel)
        if (outcome.status === 'succeeded') this.uncertain.delete(key)
        else if (outcome.status === 'failed') this.uncertain.add(key)
        resolve(outcome)
      }
      const cancel = () => { finish({ status: 'stale' }); abort.abort() }
      const timer = (this.ports.setTimer || setTimeout)(() => {
        finish({ status: 'failed', uncertain: true, message: 'Status check timed out. The resume outcome is still uncertain.' })
        abort.abort()
      }, this.ports.timeoutMs ?? RESUME_AGENT_SESSION_TIMEOUT_MS)
      this.checks.add(cancel)
      const url = appPath(`/api/agent-sessions/${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.sessionId)}/resume-status?providerHomeId=${encodeURIComponent(identity.providerHomeId || 'default')}`)
      void Promise.resolve().then(() => (this.ports.readStatus || fetch)(url, { signal: abort.signal })).then(async response => {
        const raw = record(await response.json())
        if (settled) return
        const data = parseResumeResponse(raw)
        if (response.ok && raw?.state === 'ready' && data) {
          this.ports.applyProjectMembership(data)
          finish(this.finish(identityParts(identity), data.agentId, true))
        } else {
          finish({ status: 'failed', uncertain: true, message: raw?.state === 'pending'
            ? 'The backend is still resuming this session. Check again later.'
            : 'No completed resume could be confirmed. The outcome is still uncertain.' })
        }
      }).catch(error => finish({ status: 'failed', uncertain: true, message: error instanceof Error ? error.message : 'Status check failed' }))
    })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const cancel of [...this.checks]) cancel()
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
      commitSessionMembership: identity => portsRef.current.commitSessionMembership(identity),
      getActiveAgents: () => portsRef.current.getActiveAgents(),
      mountProject: (workspace, signal) => portsRef.current.mountProject(workspace, signal),
      readStatus: (url, init) => (portsRef.current.readStatus || fetch)(url, init),
      request: (url, init) => (portsRef.current.request || fetch)(url, init),
    })
  }
  const controller = controllerRef.current
  useEffect(() => () => controller.dispose(), [controller])
  return controller
}
