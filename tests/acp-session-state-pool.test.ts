import assert from 'node:assert/strict'
import test from 'node:test'
import {
  discardAcpSessionState,
  getAcpSessionStateSnapshot,
  resetAcpSessionStatePoolForTests,
  retainAcpSessionStates,
  subscribeAcpSessionState,
  updateAcpSessionState,
} from '../src/components/code/acp/acp-session-state-pool'

function session(sessionId: string) {
  return {
    provider: 'codex',
    sessionId,
    state: 'ready',
    error: '',
    stopReason: '',
    availableCommands: [],
    currentModeId: '',
    modes: null,
    configOptions: [],
    usage: null,
  }
}

test('retains each Agent ACP Session snapshot across subscriber switches', () => {
  try {
    retainAcpSessionStates(['agent-a', 'agent-b'])
    updateAcpSessionState('agent-a', current => ({ ...current, session: session('session-a') }))
    const releaseA = subscribeAcpSessionState('agent-a', () => {})
    releaseA()
    const releaseB = subscribeAcpSessionState('agent-b', () => {})
    releaseB()

    assert.equal(getAcpSessionStateSnapshot('agent-a').session?.sessionId, 'session-a')
  } finally {
    resetAcpSessionStatePoolForTests()
  }
})

test('failed revalidation preserves the confirmed ACP Session snapshot', () => {
  try {
    retainAcpSessionStates(['agent-a'])
    updateAcpSessionState('agent-a', current => ({ ...current, session: session('confirmed') }))
    updateAcpSessionState('agent-a', current => ({ ...current, error: 'refresh failed' }))

    const snapshot = getAcpSessionStateSnapshot('agent-a')
    assert.equal(snapshot.session?.sessionId, 'confirmed')
    assert.equal(snapshot.error, 'refresh failed')
  } finally {
    resetAcpSessionStatePoolForTests()
  }
})

test('discard removes only the selected Agent ACP Session snapshot', () => {
  try {
    retainAcpSessionStates(['agent-a', 'agent-b'])
    updateAcpSessionState('agent-a', current => ({ ...current, session: session('session-a') }))
    updateAcpSessionState('agent-b', current => ({ ...current, session: session('session-b') }))
    discardAcpSessionState('agent-a')

    assert.equal(getAcpSessionStateSnapshot('agent-a').session, null)
    assert.equal(getAcpSessionStateSnapshot('agent-b').session?.sessionId, 'session-b')
  } finally {
    resetAcpSessionStatePoolForTests()
  }
})
