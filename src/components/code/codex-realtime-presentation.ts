import type { AcpRealtimeEvent } from '@/types/messages'
import type { CodexRealtimePhase, CodexRealtimeSnapshot } from './codex-realtime-controller'

export interface CodexRealtimePresentationState {
  ownerAgentId: string | null
  phase: CodexRealtimePhase
  listening: boolean
  connecting: boolean
  transcript: string
  error: string
}

export type CodexRealtimePresentationAction =
  | { type: 'start', agentId: string }
  | { type: 'agentChanged', agentId: string | null }
  | { type: 'snapshot', displayedAgentId: string | null, snapshot: CodexRealtimeSnapshot }
  | { type: 'transcript', displayedAgentId: string | null, event: AcpRealtimeEvent }
  | { type: 'reset' }

export interface CodexRealtimePresentationView {
  owned: boolean
  listening: boolean
  connecting: boolean
  transcript: string
  error: string
}

export function initialCodexRealtimePresentation(): CodexRealtimePresentationState {
  return {
    ownerAgentId: null,
    phase: 'idle',
    listening: false,
    connecting: false,
    transcript: '',
    error: '',
  }
}

function activityForPhase(phase: CodexRealtimePhase) {
  return {
    listening: phase === 'requesting-permission'
      || phase === 'connecting'
      || phase === 'live'
      || phase === 'stopping',
    connecting: phase === 'requesting-permission'
      || phase === 'connecting'
      || phase === 'stopping',
  }
}

export function reduceCodexRealtimePresentation(
  state: CodexRealtimePresentationState,
  action: CodexRealtimePresentationAction,
): CodexRealtimePresentationState {
  if (action.type === 'reset') return initialCodexRealtimePresentation()
  if (action.type === 'start') {
    return {
      ...initialCodexRealtimePresentation(),
      ownerAgentId: action.agentId,
    }
  }
  if (action.type === 'agentChanged') {
    return state.ownerAgentId === null || state.ownerAgentId === action.agentId
      ? state
      : initialCodexRealtimePresentation()
  }
  if (action.type === 'snapshot') {
    const { snapshot, displayedAgentId } = action
    if (snapshot.agentId === null) {
      if (
        snapshot.phase !== 'idle'
        || state.ownerAgentId === null
        || state.ownerAgentId !== displayedAgentId
      ) return state
      return {
        ...state,
        phase: 'idle',
        listening: false,
        connecting: false,
      }
    }
    if (snapshot.agentId !== displayedAgentId || snapshot.agentId !== state.ownerAgentId) return state
    return {
      ...state,
      ...activityForPhase(snapshot.phase),
      phase: snapshot.phase,
      error: snapshot.error,
    }
  }

  const { event, displayedAgentId } = action
  if (event.agentId !== displayedAgentId || event.agentId !== state.ownerAgentId) return state
  if (event.params.role !== 'user') return state
  if (event.method === 'thread/realtime/transcript/delta' && typeof event.params.delta === 'string') {
    return { ...state, transcript: `${state.transcript}${event.params.delta}` }
  }
  if (event.method === 'thread/realtime/transcript/done' && typeof event.params.text === 'string') {
    return { ...state, transcript: event.params.text }
  }
  return state
}

export function codexRealtimePresentationForAgent(
  state: CodexRealtimePresentationState,
  displayedAgentId: string | null,
): CodexRealtimePresentationView {
  if (state.ownerAgentId === null || state.ownerAgentId !== displayedAgentId) {
    return { owned: false, listening: false, connecting: false, transcript: '', error: '' }
  }
  return {
    owned: true,
    listening: state.listening,
    connecting: state.connecting,
    transcript: state.transcript,
    error: state.error,
  }
}
