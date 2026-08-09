import assert from 'node:assert/strict'
import test from 'node:test'
import {
  transitionTerminalRecoveryStatus,
  type TerminalRecoveryStatus,
} from '../src/lib/terminal-recovery-status'

const requesting: TerminalRecoveryStatus = {
  phase: 'requesting',
  attempt: 1,
  startedAt: 100,
  retryDelayMs: null,
}

test('keeps one recovery start time while checkpoint phases advance', () => {
  const installing = transitionTerminalRecoveryStatus(requesting, {
    phase: 'installing',
    attempt: 2,
  }, 200)
  const retrying = transitionTerminalRecoveryStatus(installing, {
    phase: 'retrying',
    attempt: 3,
    retryDelayMs: 1000,
  }, 300)

  assert.deepEqual(installing, {
    phase: 'installing', attempt: 2, startedAt: 100, retryDelayMs: null,
  })
  assert.deepEqual(retrying, {
    phase: 'retrying', attempt: 3, startedAt: 100, retryDelayMs: 1000,
  })
})

test('terminal states clear active recovery metadata', () => {
  for (const phase of ['ready', 'failed'] as const) {
    assert.deepEqual(transitionTerminalRecoveryStatus({
      phase: 'retrying', attempt: 4, startedAt: 100, retryDelayMs: 1000,
    }, { phase }, 200), {
      phase, attempt: 0, startedAt: null, retryDelayMs: null,
    })
  }
})

test('a new attachment recovery restarts elapsed time while stale retry data cannot leak', () => {
  const restarted = transitionTerminalRecoveryStatus({
    phase: 'retrying', attempt: 4, startedAt: 100, retryDelayMs: 1000,
  }, {
    phase: 'requesting', attempt: 1, restart: true,
  }, 200)

  assert.deepEqual(restarted, {
    phase: 'requesting', attempt: 1, startedAt: 200, retryDelayMs: null,
  })
})

test('active transitions clamp invalid attempts to the first attempt', () => {
  assert.equal(transitionTerminalRecoveryStatus(requesting, {
    phase: 'requesting', attempt: 0,
  }, 200).attempt, 1)
})
