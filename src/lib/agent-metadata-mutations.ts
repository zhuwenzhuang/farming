import { useEffect, useRef } from 'react'
import { appPath } from './base-path'
import { projectWorkspaceFromAgentState } from '../../shared/agent-state-semantics.js'
import {
  agentWithAuthoritativeLiveState,
  setAgentMetadataProjections,
  subscribeAgentReadEvents,
  type AgentMetadataProjection,
} from './agent-live-state'
import type { Agent } from '@/types/agent'

type MetadataAction =
  | { kind: 'patch'; agentId: string; patch: AgentMetadataProjection }
  | { kind: 'reorder'; agentId: string; beforeAgentId: string; afterAgentId: string }
type Operation = { action: MetadataAction; resolve: (value: Record<string, unknown> | false) => void }
type Ports = {
  agents: () => Agent[]
  notice: (uncertain: boolean) => void
  request?: typeof fetch
  timeoutMs?: number
  project?: typeof setAgentMetadataProjections
}
const fields = ['customTitle', 'pinned', 'pinnedOrder', 'projectOrder', 'followUp', 'unread',
  'archived', 'archivedAt', 'readAttentionSeq', 'readOutputEpoch', 'readOutputSeq'] as const

function metadata(value: Record<string, unknown>): AgentMetadataProjection {
  return Object.fromEntries(fields.filter(field => field in value).map(field => [field, value[field]])) as AgentMetadataProjection
}

function isReadReceipt(action: MetadataAction) {
  return action.kind === 'patch' && action.patch.unread === false
    && Object.keys(action.patch).every(key => ['unread', 'readAttentionSeq', 'readOutputEpoch', 'readOutputSeq'].includes(key))
}

function orderedGroup(agents: Agent[], source: Agent) {
  const field = source.pinned ? 'pinnedOrder' : 'projectOrder'
  const direction = source.pinned ? 1 : -1
  const workspace = projectWorkspaceFromAgentState(source)
  return agents.filter(agent => !agent.archived && !agent.isMain && (source.pinned
    ? agent.pinned === true
    : !agent.pinned && projectWorkspaceFromAgentState(agent) === workspace))
    .sort((a, b) => direction * (Number(a[field] ?? 0) - Number(b[field] ?? 0)
      || Number(a.startedAt ?? 0) - Number(b.startedAt ?? 0)))
}

export function projectAgentMetadataAction(agents: Agent[], action: MetadataAction): Agent[] {
  const source = agents.find(agent => agent.id === action.agentId)
  if (!source) return agents
  if (action.kind === 'patch') {
    const patch = { ...action.patch }
    if (patch.pinned === true && !source.pinned) {
      patch.pinnedOrder = Math.max(0, ...agents.map(agent => Number(agent.pinnedOrder ?? 0))) + 1024
    }
    return agents.map(agent => agent.id === source.id ? { ...agent, ...patch } : agent)
  }
  const group = orderedGroup(agents, source).filter(agent => agent.id !== source.id)
  const before = group.findIndex(agent => agent.id === action.beforeAgentId)
  const after = group.findIndex(agent => agent.id === action.afterAgentId)
  if ((action.beforeAgentId || action.afterAgentId) && before < 0 && after < 0) return agents
  group.splice(before >= 0 ? before + 1 : after >= 0 ? after : group.length, 0, source)
  const field = source.pinned ? 'pinnedOrder' : 'projectOrder'
  const ranks = new Map(group.map((agent, index) => [agent.id, (source.pinned ? index + 1 : group.length - index) * 1024]))
  return agents.map(agent => ranks.has(agent.id) ? { ...agent, [field]: ranks.get(agent.id) } : agent)
}

/** Browser intent is independent from saved state; one lane preserves pin/drop order. */
export class AgentMetadataMutationController {
  private readonly queue: Operation[] = []
  private readonly confirmed = new Map<string, AgentMetadataProjection>()
  private abort: AbortController | null = null
  private disposed = false

  constructor(private readonly ports: Ports) {}

  observe() {
    const agents = this.ports.agents()
    const ids = new Set(agents.map(agent => agent.id))
    this.confirmed.forEach((_patch, id) => { if (!ids.has(id)) this.confirmed.delete(id) })
    agents.forEach(agent => {
      const patch = this.confirmed.get(agent.id)
      if (!patch) return
      if (patch.unread === false && typeof patch.readAttentionSeq === 'number'
        && Number(agent.readAttentionSeq ?? 0) >= patch.readAttentionSeq) {
        delete patch.unread
        delete patch.readAttentionSeq
      }
      fields.forEach(field => {
        if (field in patch && Object.is(agent[field], patch[field])) delete patch[field]
      })
      if (Object.keys(patch).length === 0) this.confirmed.delete(agent.id)
    })
    this.refresh()
  }

  mutate(action: MetadataAction): Promise<Record<string, unknown> | false> {
    if (this.disposed) return Promise.resolve(false)
    if (action.kind === 'patch' && action.patch.unread === false) {
      const agent = this.ports.agents().find(agent => agent.id === action.agentId)
      // The first manual unread creates cursor 1. A subsequent read includes
      // that earlier local intent, without consuming later runtime activity.
      const pendingManualUnread = this.queue.some(({ action: previous }) => previous.kind === 'patch'
        && previous.agentId === action.agentId && previous.patch.unread === true)
      action = { ...action, patch: { ...action.patch, readAttentionSeq: Math.max(Number(agent?.attentionSeq ?? 0), pendingManualUnread ? 1 : 0) } }
    }
    const promise = new Promise<Record<string, unknown> | false>(resolve => this.queue.push({ action, resolve }))
    this.refresh()
    if (this.queue.length === 1) void this.run(this.queue[0]!)
    return promise
  }

  private refresh() {
    const authority = this.ports.agents()
    let projected = authority.map(agent => ({ ...agent, ...this.confirmed.get(agent.id) }))
    this.queue.forEach(operation => { projected = projectAgentMetadataAction(projected, operation.action) })
    const patches = new Map<string, AgentMetadataProjection>()
    projected.forEach((agent, index) => {
      const original = authority[index]!
      const changed = fields.filter(field => !Object.is(agent[field], original[field]))
      if (changed.length) {
        const patch = metadata(Object.fromEntries(changed.map(field => [field, agent[field]])))
        if (patch.unread === false) patch.readAttentionSeq = agent.readAttentionSeq
        patches.set(agent.id, patch)
      }
    })
    ;(this.ports.project ?? setAgentMetadataProjections)(patches)
  }

  private remember(agentId: string, value: Record<string, unknown>) {
    this.confirmed.set(agentId, { ...this.confirmed.get(agentId), ...metadata(value) })
  }

  private rememberReconciled(action: MetadataAction, agents: Agent[]) {
    const source = agents.find(agent => agent.id === action.agentId)
    if (!source) return
    if (action.kind === 'patch') {
      const keys = new Set(Object.keys(action.patch))
      if ('pinned' in action.patch) keys.add('pinnedOrder')
      if ('archived' in action.patch) keys.add('archivedAt')
      if ('unread' in action.patch) keys.add('readAttentionSeq')
      this.remember(source.id, Object.fromEntries(Object.entries(source).filter(([key]) => keys.has(key))))
    } else {
      const field = source.pinned ? 'pinnedOrder' : 'projectOrder'
      agents.filter(agent => source.pinned ? agent.pinned : projectWorkspaceFromAgentState(agent) === projectWorkspaceFromAgentState(source))
        .forEach(agent => this.remember(agent.id, { [field]: agent[field] }))
    }
  }

  private matches(action: MetadataAction, agents: Agent[]) {
    const agent = agents.find(agent => agent.id === action.agentId)
    if (!agent) return false
    if (action.kind === 'patch') return Object.entries(action.patch).every(([key, value]) => {
      if (action.patch.unread === false && key === 'unread') return Number(agent.readAttentionSeq ?? 0) >= Number(action.patch.readAttentionSeq ?? 0)
      if (key === 'readAttentionSeq') return Number(agent.readAttentionSeq ?? 0) >= Number(value)
      return Object.is(agent[key as keyof Agent], value)
    })
    const group = orderedGroup(agents, agent)
    const index = group.findIndex(item => item.id === agent.id)
    return (!action.beforeAgentId || group[index - 1]?.id === action.beforeAgentId)
      && (!action.afterAgentId || group[index + 1]?.id === action.afterAgentId)
  }

  private async run(operation: Operation) {
    let { action } = operation
    if (action.kind === 'reorder') {
      const { beforeAgentId, afterAgentId } = action
      // Queued drops have not been sent yet. Resolve their anchors against the
      // latest list, including confirmed earlier writes, at first dispatch.
      const base = this.ports.agents().map(agent => ({ ...agent, ...this.confirmed.get(agent.id) }))
      const projected = projectAgentMetadataAction(base, action)
      const source = projected.find(agent => agent.id === action.agentId)
      if (source) {
        const group = orderedGroup(projected, source)
        const index = group.findIndex(agent => agent.id === source.id)
        const hasAnchor = (!beforeAgentId && !afterAgentId)
          || group.some(agent => agent.id === beforeAgentId || agent.id === afterAgentId)
        if (index >= 0 && hasAnchor) action = { ...action, beforeAgentId: group[index - 1]?.id ?? '', afterAgentId: group[index + 1]?.id ?? '' }
      }
      operation.action = action
    }
    const controller = new AbortController()
    this.abort = controller
    const timer = setTimeout(() => controller.abort(), this.ports.timeoutMs ?? 10_000)
    let result: Record<string, unknown> | false = false
    let uncertain = false
    let rejected = false
    try {
      const response = await (this.ports.request ?? fetch)(appPath(`/api/agents/${encodeURIComponent(action.agentId)}${action.kind === 'reorder' ? '/reorder' : ''}`), {
        method: action.kind === 'reorder' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // A read acknowledges the observed cut, so later activity stays unread.
        body: JSON.stringify(action.kind === 'reorder'
          ? { beforeAgentId: action.beforeAgentId, afterAgentId: action.afterAgentId }
          : Object.fromEntries(Object.entries(action.patch).filter(([key]) => !(action.patch.unread === false && key === 'unread')))),
        signal: controller.signal,
      })
      const body = await response.json() as Record<string, unknown>
      if (!response.ok) {
        rejected = response.status < 500
        throw new Error('Metadata save was not confirmed')
      }
      if (!body || body.agentId !== action.agentId
        || (action.kind === 'patch' && !Object.keys(action.patch).every(key => key in body))
        || (action.kind === 'reorder' && !Array.isArray(body.updates))) throw new Error('Metadata response was not confirmed')
      if (this.disposed) return
      this.remember(action.agentId, body)
      if (Array.isArray(body.updates)) body.updates.forEach((update: Record<string, unknown>) => {
        if (typeof update.agentId === 'string') this.remember(update.agentId, update)
      })
      result = body
    } catch {
      if (this.disposed) return
      if (!rejected) {
        uncertain = true
        try {
          const response = await (this.ports.request ?? fetch)(appPath('/api/control/agents'), { signal: AbortSignal.timeout(5_000) })
          const body = await response.json() as { agents?: Agent[] }
          if (!response.ok || !Array.isArray(body.agents)) throw new Error('Metadata read unavailable')
          if (this.disposed) return
          this.rememberReconciled(action, body.agents)
          if (this.matches(action, body.agents)) { result = { agentId: action.agentId }; uncertain = false }
        } catch { /* Keep one neutral outcome notice, without replaying the write. */ }
      }
    } finally {
      clearTimeout(timer)
      if (!this.disposed) {
        const superseded = this.queue.slice(1).some(next => {
          const later = next.action
          return later.agentId === action.agentId && (action.kind === 'reorder'
            || later.kind === 'patch' && action.kind === 'patch' && Object.keys(action.patch).every(key => key in later.patch))
        })
        this.queue.shift()
        operation.resolve(result)
        const canceled = uncertain ? this.queue.splice(0) : []
        canceled.forEach(next => next.resolve(false))
        // WebSocket may have acknowledged these fields before HTTP arrived.
        this.observe()
        if (!result && (uncertain || !superseded)
          && (!isReadReceipt(action) || canceled.some(next => !isReadReceipt(next.action)))) this.ports.notice(uncertain)
        if (this.queue.length) void this.run(this.queue[0]!)
      }
    }
  }

  dispose() {
    this.disposed = true
    this.abort?.abort()
    this.queue.splice(0).forEach(operation => operation.resolve(false))
    ;(this.ports.project ?? setAgentMetadataProjections)(new Map())
  }
}

export function useAgentMetadataMutations(agents: Agent[], notice: Ports['notice']) {
  const ports = useRef({ agents, notice })
  ports.current = { agents, notice }
  const controller = useRef<AgentMetadataMutationController | null>(null)
  if (!controller.current) controller.current = new AgentMetadataMutationController({
    agents: () => ports.current.agents.map(agentWithAuthoritativeLiveState),
    notice: uncertain => ports.current.notice(uncertain),
  })
  const owner = controller.current
  useEffect(() => { owner.observe() }, [agents, owner])
  useEffect(() => {
    const unsubscribe = subscribeAgentReadEvents(() => owner.observe())
    return () => { unsubscribe(); owner.dispose() }
  }, [owner])
  return owner
}
