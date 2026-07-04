import type { Agent } from '@/types/agent'
import { agentKindForCommand, type ComposerAgentKind } from './agent-kind'

type AgentKindSource = 'terminal-status' | 'terminal-title' | 'terminal-output' | 'terminal-busy' | 'launch-command' | 'none'

export interface AgentTerminalInference {
  kind: ComposerAgentKind
  kindSource: AgentKindSource
  turnActive: boolean
  terminalBusy: boolean
}

interface KindEvidence {
  kind: ComposerAgentKind
  source: AgentKindSource
}

interface IndexedKindEvidence extends KindEvidence {
  kind: Exclude<ComposerAgentKind, null>
  index: number
}

export function currentTerminalText(agent: Agent | null | undefined) {
  if (!agent) return ''
  const previewText = typeof agent.previewText === 'string' ? agent.previewText : ''
  if (previewText.trim()) return previewText.toLowerCase()
  return (agent.output || '').slice(-1800).toLowerCase()
}

function lastIndexOfAny(text: string, needles: string[]) {
  return needles.reduce((last, needle) => Math.max(last, text.lastIndexOf(needle)), -1)
}

function lastMatchIndex(text: string, pattern: RegExp) {
  const matches = Array.from(text.matchAll(pattern))
  const lastMatch = matches.length > 0 ? matches[matches.length - 1] : undefined
  return lastMatch?.index ?? -1
}

function lastCodexIdleFooterIndex(text: string) {
  return lastMatchIndex(text, /(?:^|\n)\s*(?:gpt|codex)[^\n]*(?:·|•)\s*(?:~|\/)[^\n]*$/gim)
}

function codexActiveIndex(text: string) {
  const activeTextIndex = lastIndexOfAny(text, [
    'pursuing goal',
    'esc to interrupt',
    'press esc to interrupt',
    'reconnecting',
    '/stop to close',
    'background terminal running',
  ])
  const workingIndex = /\bworking\b/.test(text) ? text.lastIndexOf('working') : -1
  const stepIndex = lastMatchIndex(text, /step\s+\d+\s*\/\s*\d+/g)
  return Math.max(activeTextIndex, workingIndex, stepIndex)
}

function codexKindIndex(text: string) {
  const codexSpecificIndex = lastIndexOfAny(text, [
    'pursuing goal',
    'reconnecting',
    '/stop to close',
    'background terminal running',
    'messages to be submitted after next tool call',
    'stream disconnected before completion',
  ])
  const workingIndex = /\bworking\b/.test(text) ? text.lastIndexOf('working') : -1
  const stepIndex = lastMatchIndex(text, /step\s+\d+\s*\/\s*\d+/g)
  return Math.max(codexSpecificIndex, workingIndex, stepIndex)
}

function codexBlockedIndex(text: string) {
  return lastIndexOfAny(text, [
    'goal blocked',
    'input exceeds the context window',
    'please adjust your input and try again',
  ])
}

function titleWithoutActivityPrefix(title: string) {
  return title
    .trim()
    .replace(/^[\s*＊✳✱✲✶·•:.\u2800-\u28FF]+/u, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function activeTerminalTitleEvidence(agent: Agent | null | undefined): KindEvidence | null {
  const title = typeof agent?.sessionTitle === 'string' ? agent.sessionTitle.trim() : ''
  if (/^[\u2800-\u28ff]/u.test(title)) return { kind: 'codex', source: 'terminal-title' }
  return null
}

function genericTerminalTitleEvidence(agent: Agent | null | undefined): KindEvidence | null {
  const normalized = titleWithoutActivityPrefix(agent?.sessionTitle || '')
  if (!normalized) return null
  if (/\bclaude(?:\s+code)?\b/.test(normalized)) return { kind: 'claude', source: 'terminal-title' }
  if (/\bcodex\b/.test(normalized)) return { kind: 'codex', source: 'terminal-title' }
  if (/^(?:bash|zsh|sh|fish)(?:\s|$)/.test(normalized)) return { kind: 'shell', source: 'terminal-title' }
  return null
}

function latestTerminalOutputEvidence(text: string): KindEvidence | null {
  const candidates: IndexedKindEvidence[] = []
  const codexIndex = Math.max(
    lastCodexIdleFooterIndex(text),
    codexKindIndex(text),
    lastMatchIndex(text, /(?:^|\n)\s*›\s/g),
  )
  if (codexIndex >= 0) candidates.push({ kind: 'codex', source: 'terminal-output', index: codexIndex })

  const claudeIndex = Math.max(
    lastIndexOfAny(text, ['claude code']),
    lastMatchIndex(text, /(?:thinking|claude)[\s\S]*(?:esc|escape|ctrl\+c|ctrl-c) to interrupt/g)
  )
  if (claudeIndex >= 0) candidates.push({ kind: 'claude', source: 'terminal-output', index: claudeIndex })

  const shellIndex = lastMatchIndex(text, /(?:^|\n)\s*(?:[\w./~:@-]+\s*)?[$%#]\s*$/gm)
  if (shellIndex >= 0) candidates.push({ kind: 'shell', source: 'terminal-output', index: shellIndex })

  const latest = candidates.sort((a, b) => b.index - a.index)[0]
  return latest ? { kind: latest.kind, source: latest.source } : null
}

function inferAgentKind(agent: Agent | null | undefined): KindEvidence {
  if (!agent) return { kind: null, source: 'none' }

  const statusKind = agent.terminalStatus?.kind
  if (statusKind === 'codex' || statusKind === 'claude' || statusKind === 'shell') {
    return { kind: statusKind, source: 'terminal-status' }
  }
  if (statusKind === 'process') return { kind: 'agent', source: 'terminal-status' }

  const activeTitleEvidence = activeTerminalTitleEvidence(agent)
  if (activeTitleEvidence) return activeTitleEvidence

  const outputEvidence = latestTerminalOutputEvidence(currentTerminalText(agent))
  if (outputEvidence) return outputEvidence

  if (agent.terminalBusy === true) return { kind: 'shell', source: 'terminal-busy' }

  const titleEvidence = genericTerminalTitleEvidence(agent)
  if (titleEvidence) return titleEvidence

  return {
    kind: agentKindForCommand(agent.command),
    source: agent.command ? 'launch-command' : 'none',
  }
}

function codexTitleShowsActiveTurn(agent: Agent | null | undefined) {
  return activeTerminalTitleEvidence(agent)?.kind === 'codex'
}

function isCodexTerminalActive(agent: Agent | null | undefined) {
  if (!agent) return false
  if (agent.status === 'pending') return true
  if (agent.status !== 'running') return false

  const output = currentTerminalText(agent)
  if (!output) {
    const startedAt = typeof agent.startedAt === 'number' ? agent.startedAt : 0
    return startedAt > 0 && Date.now() - startedAt < 5000
  }

  const blockedIndex = codexBlockedIndex(output)
  const streamDisconnectedIndex = output.lastIndexOf('stream disconnected before completion')
  if (blockedIndex >= 0 && blockedIndex >= streamDisconnectedIndex) return false

  if (output.includes('messages to be submitted after next tool call')) return true
  if (codexTitleShowsActiveTurn(agent)) return true
  if (streamDisconnectedIndex >= 0) return true

  const activeIndex = codexActiveIndex(output)
  if (activeIndex < 0) return false

  return lastCodexIdleFooterIndex(output) <= activeIndex
}

function isClaudeTerminalActive(agent: Agent | null | undefined) {
  if (!agent) return false
  if (agent.status === 'pending') return true
  if (agent.status !== 'running') return false

  const output = currentTerminalText(agent)
  return (
    output.includes('esc to interrupt') ||
    output.includes('escape to interrupt') ||
    output.includes('ctrl+c to interrupt') ||
    output.includes('ctrl-c to interrupt') ||
    output.includes('press esc to interrupt')
  )
}

function isShellTerminalActive(agent: Agent | null | undefined) {
  if (!agent || agent.status !== 'running') return false
  if (agent.terminalStatus?.activity === 'busy') return true
  if (agent.terminalStatus?.activity === 'idle' || agent.terminalStatus?.activity === 'exited') return false
  return agent.terminalBusy === true
}

export function inferAgentTerminalState(agent: Agent | null | undefined): AgentTerminalInference {
  const kindEvidence = inferAgentKind(agent)
  const terminalBusy = agent?.terminalStatus
    ? agent.terminalStatus.busy === true
    : agent?.terminalBusy === true
  let turnActive = false

  if (agent?.terminalStatus?.activity === 'busy' && agent.status === 'running') {
    turnActive = true
  } else if (agent?.terminalStatus?.activity === 'idle' || agent?.terminalStatus?.activity === 'exited') {
    turnActive = false
  } else if (kindEvidence.kind === 'codex') turnActive = isCodexTerminalActive(agent)
  else if (kindEvidence.kind === 'claude') turnActive = isClaudeTerminalActive(agent)
  else if (kindEvidence.kind === 'shell' || kindEvidence.kind === 'agent') turnActive = isShellTerminalActive(agent)

  return {
    kind: kindEvidence.kind,
    kindSource: kindEvidence.source,
    turnActive,
    terminalBusy,
  }
}

export function isCodexAgentWorking(agent: Agent | null | undefined) {
  const state = inferAgentTerminalState(agent)
  return state.kind === 'codex' && state.turnActive
}

export function isAgentTurnActive(agent: Agent | null | undefined) {
  return inferAgentTerminalState(agent).turnActive
}
