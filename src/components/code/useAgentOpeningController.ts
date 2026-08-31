import { useEffect, useRef, useState } from 'react'
import type { ResumeAgentCandidate, ResumeAgentSessionIdentity, ResumeAgentSessionOutcome } from './useResumeAgentSessionController'

export type AgentOpeningTarget = {
  agentId?: string
  focusTerminal?: boolean
  identity?: ResumeAgentSessionIdentity
  title: string
  workspace: string
  source: 'search' | 'history' | 'projects'
}

export type AgentOpeningState = {
  intent: number
  target: AgentOpeningTarget
  phase: 'resuming' | 'checking' | 'waiting' | 'ready' | 'failed'
  agentId?: string
  uncertain?: boolean
  message?: string
}

export interface AgentOpeningPorts {
  resume: (identity: ResumeAgentSessionIdentity) => Promise<ResumeAgentSessionOutcome>
  reconcile: (identity: ResumeAgentSessionIdentity) => Promise<ResumeAgentSessionOutcome>
  getAgents: () => readonly ResumeAgentCandidate[]
  activate: (agentId: string, options?: { focusTerminal?: boolean }) => void
  changed: (state: AgentOpeningState | null) => void
  timeoutMs?: number
  setTimer?: (callback: () => void, delay: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** Viewing intent is independent of backend resume admission and membership. */
export class AgentOpeningController {
  private state: AgentOpeningState | null = null
  private intent = 0
  private timer: unknown

  constructor(private readonly ports: AgentOpeningPorts) {}

  private publish(state: AgentOpeningState | null) {
    this.state = state
    this.ports.changed(state)
  }

  private clearWait() {
    if (this.timer !== undefined) (this.ports.clearTimer || clearTimeout)(this.timer as number)
    this.timer = undefined
  }

  leave() {
    this.intent += 1
    this.clearWait()
    this.publish(null)
  }

  open(target: AgentOpeningTarget) {
    this.begin(target, false)
  }

  retry() {
    if (this.state?.phase !== 'failed' || this.state.uncertain) return
    this.begin(this.state.target.identity ? { ...this.state.target, agentId: undefined } : this.state.target, false)
  }

  check() {
    if (this.state?.phase !== 'failed' || !this.state.uncertain || !this.state.target.identity) return
    this.begin(this.state.target, true)
  }

  private begin(target: AgentOpeningTarget, check: boolean) {
    this.clearWait()
    const intent = ++this.intent
    const state: AgentOpeningState = { intent, target, phase: check ? 'checking' : 'resuming' }
    this.publish(state)
    if (target.agentId && !check) {
      this.waitForAgent(state, target.agentId)
      return
    }
    if (!target.identity) {
      this.publish({ ...state, phase: 'failed', uncertain: false, message: 'This target has no Agent or session identity.' })
      return
    }
    void (check ? this.ports.reconcile(target.identity) : this.ports.resume(target.identity)).then(outcome => {
      if (this.intent !== intent) return
      if (outcome.status === 'succeeded') this.waitForAgent(state, outcome.agentId)
      else if (outcome.status === 'failed') this.publish({ ...state, phase: 'failed', uncertain: outcome.uncertain, message: outcome.message })
      else this.leave()
    }).catch(error => {
      if (this.intent !== intent) return
      this.publish({ ...state, phase: 'failed', uncertain: true, message: error instanceof Error ? error.message : 'Resume unavailable' })
    })
  }

  private waitForAgent(state: AgentOpeningState, agentId: string) {
    this.publish({ ...state, phase: 'waiting', agentId })
    this.observeAgents()
    if (this.state?.phase !== 'waiting') return
    this.timer = (this.ports.setTimer || setTimeout)(() => {
      if (this.state?.intent !== state.intent || this.state.phase !== 'waiting') return
      this.clearWait()
      this.publish({ ...this.state, phase: 'failed', uncertain: Boolean(state.target.identity), message: 'The Agent has not appeared in current state. Check the connection and try checking its status.' })
    }, this.ports.timeoutMs ?? 30_000)
  }

  observeAgents() {
    const state = this.state
    if (!state || state.phase !== 'waiting') return
    const agent = this.ports.getAgents().find(candidate => candidate.id === state.agentId)
    if (!agent) return
    this.clearWait()
    if (agent.archived || agent.status === 'dead' || agent.status === 'stopped') {
      this.publish({ ...state, phase: 'failed', uncertain: false, message: 'This Agent stopped before it could be opened.' })
      return
    }
    // Commit synchronously from observed backend state: no second, unfenced
    // pending-open queue may outlive this intent in the parent application.
    this.publish({ ...state, phase: 'ready' })
    this.ports.activate(agent.id, { focusTerminal: state.target.focusTerminal })
  }
}

export function useAgentOpeningController(ports: Omit<AgentOpeningPorts, 'changed'>) {
  const latest = useRef(ports)
  latest.current = ports
  const [state, setState] = useState<AgentOpeningState | null>(null)
  const [controller] = useState(() => new AgentOpeningController({
    resume: identity => latest.current.resume(identity),
    reconcile: identity => latest.current.reconcile(identity),
    getAgents: () => latest.current.getAgents(),
    activate: (id, options) => latest.current.activate(id, options),
    changed: setState,
  }))
  useEffect(() => () => controller.leave(), [controller])
  return { state, controller }
}
