import type { Agent } from '@/types/agent'
import type { ComposerAgentKind } from './agent-kind'

type AgentKindSource = 'terminal-status' | 'none'

export interface AgentTerminalInference {
  kind: ComposerAgentKind
  kindSource: AgentKindSource
  turnActive: boolean
  terminalBusy: boolean
}

export function currentTerminalText(agent: Agent | null | undefined) {
  if (!agent) return ''
  const previewText = typeof agent.previewText === 'string' ? agent.previewText : ''
  return previewText.trim() ? previewText.toLowerCase() : (agent.output || '').slice(-1800).toLowerCase()
}

function composerKind(agent: Agent): ComposerAgentKind {
  const kind = agent.runtimeObservation.kind
  if (kind === 'codex' || kind === 'claude' || kind === 'shell') return kind
  return kind === 'process' ? 'agent' : null
}

export function inferAgentTerminalState(agent: Agent | null | undefined): AgentTerminalInference {
  if (!agent) return { kind: null, kindSource: 'none', turnActive: false, terminalBusy: false }
  const phase = agent.runtimeObservation.phase
  const turnActive = phase === 'starting' || phase === 'working' || phase === 'waiting'
  return {
    kind: composerKind(agent),
    kindSource: 'terminal-status',
    turnActive,
    terminalBusy: agent.runtimeBinding.kind === 'terminal'
      ? (agent.terminalStatus
        ? agent.terminalStatus.busy === true
        : agent.terminalBusy === true)
      : false,
  }
}

export function isCodexAgentWorking(agent: Agent | null | undefined) {
  const state = inferAgentTerminalState(agent)
  return state.kind === 'codex' && state.turnActive
}

export function isAgentTurnActive(agent: Agent | null | undefined) {
  return inferAgentTerminalState(agent).turnActive
}
