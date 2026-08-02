import assert from 'node:assert/strict'
import test from 'node:test'
import {
  codexRealtimePresentationForAgent,
  initialCodexRealtimePresentation,
  reduceCodexRealtimePresentation,
  type CodexRealtimePresentationState,
} from '../src/components/code/codex-realtime-presentation'
import type { CodexRealtimeSnapshot } from '../src/components/code/codex-realtime-controller'
import type { AcpRealtimeEvent } from '../src/types/messages'

function snapshot(
  agentId: string | null,
  phase: CodexRealtimeSnapshot['phase'],
  error = '',
): CodexRealtimeSnapshot {
  return {
    phase,
    generation: 1,
    agentId,
    operationId: agentId ? 'voice-op-a' : null,
    startDisposition: agentId ? 'accepted' : 'not-sent',
    error,
  }
}

function transcript(agentId: string, text: string): AcpRealtimeEvent {
  return {
    agentId,
    sessionId: 'session-1',
    operationId: 'voice-op-a',
    method: 'thread/realtime/transcript/done',
    params: { role: 'user', text },
  }
}

function startAgent(state: CodexRealtimePresentationState, agentId: string) {
  return reduceCodexRealtimePresentation(state, { type: 'start', agentId })
}

test('A transcript and failure cannot leak into B or return after switching back to A', () => {
  let state = startAgent(initialCodexRealtimePresentation(), 'agent-a')
  state = reduceCodexRealtimePresentation(state, {
    type: 'transcript',
    displayedAgentId: 'agent-a',
    event: transcript('agent-a', 'agent A transcript'),
  })
  state = reduceCodexRealtimePresentation(state, {
    type: 'snapshot',
    displayedAgentId: 'agent-a',
    snapshot: snapshot('agent-a', 'failed', 'agent A failure'),
  })
  assert.deepEqual(codexRealtimePresentationForAgent(state, 'agent-a'), {
    owned: true,
    listening: false,
    connecting: false,
    transcript: 'agent A transcript',
    error: 'agent A failure',
  })

  state = reduceCodexRealtimePresentation(state, { type: 'agentChanged', agentId: 'agent-b' })
  state = reduceCodexRealtimePresentation(state, {
    type: 'snapshot',
    displayedAgentId: 'agent-b',
    snapshot: snapshot('agent-a', 'failed', 'delayed A failure'),
  })
  state = reduceCodexRealtimePresentation(state, {
    type: 'transcript',
    displayedAgentId: 'agent-b',
    event: transcript('agent-a', 'delayed A transcript'),
  })
  assert.deepEqual(codexRealtimePresentationForAgent(state, 'agent-b'), {
    owned: false,
    listening: false,
    connecting: false,
    transcript: '',
    error: '',
  })

  state = reduceCodexRealtimePresentation(state, { type: 'agentChanged', agentId: 'agent-a' })
  assert.deepEqual(state, initialCodexRealtimePresentation())
  assert.equal(codexRealtimePresentationForAgent(state, 'agent-a').owned, false)
})

test('same-owner idle clears activity but preserves the final transcript and error', () => {
  let state = startAgent(initialCodexRealtimePresentation(), 'agent-a')
  state = reduceCodexRealtimePresentation(state, {
    type: 'snapshot',
    displayedAgentId: 'agent-a',
    snapshot: snapshot('agent-a', 'connecting'),
  })
  state = reduceCodexRealtimePresentation(state, {
    type: 'transcript',
    displayedAgentId: 'agent-a',
    event: transcript('agent-a', 'final transcript'),
  })
  state = reduceCodexRealtimePresentation(state, {
    type: 'snapshot',
    displayedAgentId: 'agent-a',
    snapshot: snapshot('agent-a', 'failed', 'final failure'),
  })
  state = reduceCodexRealtimePresentation(state, {
    type: 'snapshot',
    displayedAgentId: 'agent-a',
    snapshot: snapshot(null, 'idle'),
  })

  assert.deepEqual(codexRealtimePresentationForAgent(state, 'agent-a'), {
    owned: true,
    listening: false,
    connecting: false,
    transcript: 'final transcript',
    error: 'final failure',
  })
})

test('ownerless idle cannot clear another displayed Agent or populate content', () => {
  let state = startAgent(initialCodexRealtimePresentation(), 'agent-a')
  state = reduceCodexRealtimePresentation(state, {
    type: 'snapshot',
    displayedAgentId: 'agent-a',
    snapshot: snapshot('agent-a', 'live'),
  })
  const before = state
  state = reduceCodexRealtimePresentation(state, {
    type: 'snapshot',
    displayedAgentId: 'agent-b',
    snapshot: snapshot(null, 'idle'),
  })
  assert.equal(state, before)
  assert.equal(codexRealtimePresentationForAgent(state, 'agent-b').owned, false)
})

test('same-Agent capability churn keeps audit content while a new start clears it', () => {
  let state = startAgent(initialCodexRealtimePresentation(), 'agent-a')
  state = reduceCodexRealtimePresentation(state, {
    type: 'transcript',
    displayedAgentId: 'agent-a',
    event: transcript('agent-a', 'keep for review'),
  })
  const before = state
  state = reduceCodexRealtimePresentation(state, { type: 'agentChanged', agentId: 'agent-a' })
  assert.equal(state, before)
  assert.equal(state.transcript, 'keep for review')

  state = reduceCodexRealtimePresentation(state, { type: 'start', agentId: 'agent-a' })
  assert.equal(state.ownerAgentId, 'agent-a')
  assert.equal(state.transcript, '')
  assert.equal(state.error, '')
})
