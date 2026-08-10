import { useCallback, useEffect, useRef } from 'react'
import { appPath } from '@/lib/base-path'
import { normalizeProjectNames, type ProjectMembership } from './useProjectMembershipController'

const PROJECT_MUTATION_TIMEOUT_MS = 30_000

export type ProjectMutation =
  | { kind: 'rename'; workspace: string; name: string; previousName?: string; errorMessage: string }
  | { kind: 'pin'; workspace: string; pinned: boolean; errorMessage: string }
  | { kind: 'remove'; workspace: string; errorMessage: string }
  | { kind: 'reorder'; workspace: string; beforeWorkspace: string; afterWorkspace: string; errorMessage: string }

type ProjectRequest = (
  url: string,
  init: {
    body?: string
    headers?: { 'Content-Type': 'application/json' }
    method: 'GET' | 'POST' | 'PATCH'
    signal: AbortSignal
  },
) => Promise<{ json(): Promise<unknown>; ok: boolean; status: number }>

export type ProjectMutationOutcome =
  | { status: 'succeeded' }
  | { status: 'failed'; uncertain: boolean }
  | { status: 'stale' }

export interface ProjectMutationPorts {
  applyProjectMembership: (membership: ProjectMembership) => void
  clearTimer?: (timer: unknown) => void
  createAbortController?: () => AbortController
  replaceProjectName: (workspace: string, name: string | null, expectedCurrent?: string) => void
  request?: ProjectRequest
  setTimer?: (callback: () => void, delay: number) => unknown
  showError: (message: string) => void
  timeoutMs?: number
}

type ProjectOperation = {
  abortController: AbortController
  input: ProjectMutation
  promise: Promise<ProjectMutationOutcome>
  resolve: (outcome: ProjectMutationOutcome) => void
  signature: string
  settlingUncertain: boolean
  timer: unknown
}

type QueuedMembershipMutation = {
  input: Exclude<ProjectMutation, { kind: 'rename' }>
  promise: Promise<ProjectMutationOutcome>
  resolve: (outcome: ProjectMutationOutcome) => void
  signature: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function membership(value: unknown): ProjectMembership | null {
  const data = record(value)
  if (!data || !stringArray(data.projectWorkspaces) || !stringArray(data.pinnedProjectWorkspaces)) return null
  return {
    projectWorkspaces: data.projectWorkspaces,
    pinnedProjectWorkspaces: data.pinnedProjectWorkspaces,
  }
}

function operationKey(input: ProjectMutation) {
  return input.kind === 'rename' ? `rename:${input.workspace}` : 'membership'
}

function operationSignature(input: ProjectMutation) {
  if (input.kind === 'rename') return JSON.stringify({ kind: input.kind, workspace: input.workspace, name: input.name })
  if (input.kind === 'pin') return JSON.stringify({ kind: input.kind, workspace: input.workspace, pinned: input.pinned })
  if (input.kind === 'remove') return JSON.stringify({ kind: input.kind, workspace: input.workspace })
  return JSON.stringify({
    kind: input.kind,
    workspace: input.workspace,
    beforeWorkspace: input.beforeWorkspace,
    afterWorkspace: input.afterWorkspace,
  })
}

function requestSpec(input: ProjectMutation) {
  if (input.kind === 'rename') {
    return { path: '/api/projects/name', method: 'PATCH' as const, body: { workspace: input.workspace, name: input.name } }
  }
  if (input.kind === 'pin') {
    return { path: '/api/projects/pin', method: 'POST' as const, body: { workspace: input.workspace, pinned: input.pinned } }
  }
  if (input.kind === 'remove') {
    return { path: '/api/projects/remove', method: 'POST' as const, body: { workspace: input.workspace } }
  }
  return {
    path: '/api/projects/reorder',
    method: 'POST' as const,
    body: {
      workspace: input.workspace,
      beforeWorkspace: input.beforeWorkspace,
      afterWorkspace: input.afterWorkspace,
    },
  }
}

/** Owns admission, cancellation, postconditions, and uncertain Project mutation reconciliation. */
export class ProjectMutationController {
  private disposed = false
  private readonly operations = new Map<string, ProjectOperation>()
  private readonly epochs = new Map<string, number>()
  private readonly membershipQueue: QueuedMembershipMutation[] = []
  private readonly reconcileAborts = new Map<string, AbortController>()

  constructor(private readonly ports: ProjectMutationPorts) {}

  mutate(input: ProjectMutation): Promise<ProjectMutationOutcome> {
    if (this.disposed) return Promise.resolve({ status: 'stale' })
    const key = operationKey(input)
    const signature = operationSignature(input)
    const existing = this.operations.get(key)
    if (existing) {
      if (key === 'membership' && input.kind !== 'rename') {
        const queuedTail = this.membershipQueue[this.membershipQueue.length - 1]
        if (queuedTail?.signature === signature) return queuedTail.promise
        if (!queuedTail && existing.signature === signature) return existing.promise
        let resolve!: (outcome: ProjectMutationOutcome) => void
        const promise = new Promise<ProjectMutationOutcome>(accept => { resolve = accept })
        this.membershipQueue.push({ input, promise, resolve, signature })
        return promise
      }
      if (existing.signature === signature) return existing.promise
      this.ports.showError(`${input.errorMessage}: another Project change is still pending`)
      return Promise.resolve({ status: 'failed', uncertain: false })
    }

    return this.start(input, signature)
  }

  private start(
    input: ProjectMutation,
    signature: string,
    deferred?: Pick<QueuedMembershipMutation, 'promise' | 'resolve'>,
  ) {
    const key = operationKey(input)
    const epoch = (this.epochs.get(key) ?? 0) + 1
    this.epochs.set(key, epoch)
    this.reconcileAborts.get(key)?.abort()
    this.reconcileAborts.delete(key)
    if (input.kind === 'rename') this.ports.replaceProjectName(input.workspace, input.name)
    const abortController = (this.ports.createAbortController || (() => new AbortController()))()
    let resolve!: (outcome: ProjectMutationOutcome) => void
    const promise = deferred?.promise ?? new Promise<ProjectMutationOutcome>(accept => { resolve = accept })
    if (deferred) resolve = deferred.resolve
    const operation = {} as ProjectOperation
    const setTimer = this.ports.setTimer || ((callback: () => void, delay: number) => setTimeout(callback, delay))
    Object.assign(operation, {
      abortController,
      input,
      promise,
      resolve,
      signature,
      settlingUncertain: false,
      timer: setTimer(() => {
        if (this.operations.get(key) !== operation) return
        abortController.abort()
        void this.finishUncertain(key, operation, epoch, 'Project request timed out')
      }, this.ports.timeoutMs ?? PROJECT_MUTATION_TIMEOUT_MS),
    })
    this.operations.set(key, operation)
    void this.run(key, operation, epoch)
    return promise
  }

  private active(key: string, operation: ProjectOperation) {
    return !this.disposed && this.operations.get(key) === operation
  }

  private settle(
    key: string,
    operation: ProjectOperation,
    outcome: ProjectMutationOutcome,
    advanceMembership = true,
  ) {
    if (!this.active(key, operation)) return
    this.operations.delete(key)
    ;(this.ports.clearTimer || clearTimeout)(operation.timer as number)
    operation.resolve(outcome)
    if (key === 'membership') this.advanceMembership(advanceMembership)
  }

  private advanceMembership(allowed: boolean) {
    if (this.disposed) return
    if (!allowed) {
      for (const queued of this.membershipQueue.splice(0)) {
        queued.resolve({ status: 'failed', uncertain: true })
      }
      return
    }
    const queued = this.membershipQueue.shift()
    if (queued) this.start(queued.input, queued.signature, queued)
  }

  private rollbackRename(input: ProjectMutation) {
    if (input.kind !== 'rename') return
    this.ports.replaceProjectName(input.workspace, input.previousName ?? null, input.name)
  }

  private async finishUncertain(key: string, operation: ProjectOperation, epoch: number, reason: string) {
    if (!this.active(key, operation) || operation.settlingUncertain) return
    operation.settlingUncertain = true
    ;(this.ports.clearTimer || clearTimeout)(operation.timer as number)
    operation.abortController.abort()
    this.ports.showError(`${reason}; the Project outcome is uncertain`)
    const reconciled = await this.reconcile(key, epoch, operation.input)
    if (!this.active(key, operation)) return
    this.settle(key, operation, { status: 'failed', uncertain: true }, reconciled)
  }

  private async run(key: string, operation: ProjectOperation, epoch: number) {
    const input = operation.input
    const spec = requestSpec(input)
    try {
      const request = this.ports.request || fetch
      const response = await request(appPath(spec.path), {
        method: spec.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec.body),
        signal: operation.abortController.signal,
      })
      const raw = await response.json().catch(() => null)
      if (!this.active(key, operation)) return
      if (!response.ok) {
        this.rollbackRename(input)
        const message = record(raw)?.error
        this.ports.showError(typeof message === 'string' && message ? message : input.errorMessage)
        this.settle(key, operation, { status: 'failed', uncertain: false })
        return
      }
      if (input.kind === 'rename') {
        const data = record(raw)
        if (
          !data
          || data.workspace !== input.workspace
          || typeof data.name !== 'string'
          || !data.name.trim()
        ) {
          void this.finishUncertain(key, operation, epoch, 'Project rename returned an invalid response')
          return
        }
        this.ports.replaceProjectName(data.workspace, data.name, input.name)
      } else {
        const authoritativeMembership = membership(raw)
        if (!authoritativeMembership) {
          void this.finishUncertain(key, operation, epoch, 'Project mutation returned an invalid response')
          return
        }
        this.ports.applyProjectMembership(authoritativeMembership)
      }
      this.settle(key, operation, { status: 'succeeded' })
    } catch (error) {
      if (!this.active(key, operation)) return
      const message = error instanceof Error ? error.message : input.errorMessage
      void this.finishUncertain(key, operation, epoch, message)
    }
  }

  private async reconcile(key: string, epoch: number, input: ProjectMutation) {
    this.reconcileAborts.get(key)?.abort()
    const abortController = (this.ports.createAbortController || (() => new AbortController()))()
    this.reconcileAborts.set(key, abortController)
    const setTimer = this.ports.setTimer || ((callback: () => void, delay: number) => setTimeout(callback, delay))
    let timer: unknown
    let timedOut = false
    try {
      const request = this.ports.request || fetch
      const result = await Promise.race([
        (async () => {
          const response = await request(appPath('/api/settings'), {
            method: 'GET',
            signal: abortController.signal,
          })
          const raw = await response.json().catch(() => null)
          return { response, raw }
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimer(() => {
            timedOut = true
            abortController.abort()
            reject(new Error('Project state reconciliation timed out'))
          }, this.ports.timeoutMs ?? PROJECT_MUTATION_TIMEOUT_MS)
        }),
      ])
      const { response, raw } = result
      if (this.disposed || this.epochs.get(key) !== epoch || this.reconcileAborts.get(key) !== abortController) return false
      const settings = record(record(raw)?.settings)
      if (!response.ok || !settings) throw new Error('Project state reconciliation failed')
      if (input.kind === 'rename') {
        const names = normalizeProjectNames(settings.projectNames)
        this.ports.replaceProjectName(input.workspace, names[input.workspace] ?? null, input.name)
      } else {
        const authoritativeMembership = membership(settings)
        if (!authoritativeMembership) throw new Error('Project state reconciliation failed')
        this.ports.applyProjectMembership(authoritativeMembership)
      }
      return true
    } catch (error) {
      if (this.disposed || this.epochs.get(key) !== epoch || this.reconcileAborts.get(key) !== abortController) return false
      if (!abortController.signal.aborted || timedOut) {
        this.ports.showError(error instanceof Error ? error.message : 'Project state reconciliation failed')
      }
      return false
    } finally {
      if (timer !== undefined) (this.ports.clearTimer || clearTimeout)(timer as number)
      if (this.reconcileAborts.get(key) === abortController) this.reconcileAborts.delete(key)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const abortController of this.reconcileAborts.values()) abortController.abort()
    this.reconcileAborts.clear()
    for (const [key, operation] of [...this.operations]) {
      this.operations.delete(key)
      ;(this.ports.clearTimer || clearTimeout)(operation.timer as number)
      operation.abortController.abort()
      operation.resolve({ status: 'stale' })
    }
    for (const queued of this.membershipQueue.splice(0)) queued.resolve({ status: 'stale' })
  }
}

export function useProjectMutationController(ports: ProjectMutationPorts) {
  const portsRef = useRef(ports)
  portsRef.current = ports
  const controllerRef = useRef<ProjectMutationController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = new ProjectMutationController({
      applyProjectMembership: membership => portsRef.current.applyProjectMembership(membership),
      replaceProjectName: (workspace, name, expected) => portsRef.current.replaceProjectName(workspace, name, expected),
      request: (url, init) => (portsRef.current.request || fetch)(url, init),
      showError: message => portsRef.current.showError(message),
    })
  }
  const controller = controllerRef.current
  useEffect(() => () => controller.dispose(), [controller])
  return useCallback((input: ProjectMutation) => controller.mutate(input), [controller])
}
