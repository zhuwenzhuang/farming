import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import type {
  TerminalReplicationRecord,
} from '../src/lib/terminal-session-replication'

Object.assign(globalThis, { self: globalThis })
const runtimeRequire = createRequire(import.meta.url)
runtimeRequire.extensions['.css'] = () => {}
let replication!: typeof import('../src/lib/terminal-session-replication')

test.before(async () => {
  replication = await import('../src/lib/terminal-session-replication')
})

function replicationRecord() {
  let attached = false
  let recoveryBegins = 0
  let recoveryResets = 0
  const record = {
    disposed: false,
    replication: replication.createTerminalReplicationState(),
    replicationPorts: {
      isAttached: () => attached,
      publishStatus: () => {},
      reportError: () => {},
      notifyReady: () => false,
      captureViewportState: () => ({}),
      restoreViewportState: () => {},
    },
    resizeEffects: {
      beginRecovery: () => { recoveryBegins += 1 },
    },
    attachment: {
      generation: 1,
      queuedTransitionCount: 0,
      runtimeEpoch: '',
      outputSeq: null,
      stateRevision: null,
      resetRecovery: () => { recoveryResets += 1 },
      beginRecovery: () => { recoveryBegins += 1 },
      invalidateOperation: () => {},
    },
  } as unknown as TerminalReplicationRecord

  return {
    record,
    attach: () => { attached = true },
    recoveryBegins: () => recoveryBegins,
    recoveryResets: () => recoveryResets,
  }
}

test('replication owner initializes and updates fixture/input state as one cluster', () => {
  const { record } = replicationRecord()

  assert.equal(record.replication.bootstrappingSnapshot, true)
  assert.equal(replication.terminalReplicationBootstrapSettled(record), false)
  assert.equal(replication.terminalReplicationCanFocus(record), false)

  record.replication.fixtureOverrideActive = true
  replication.markTerminalReplicationInput(record)
  assert.equal(record.replication.fixtureOverrideActive, false)

  record.replication.bootstrappingSnapshot = false
  assert.equal(replication.terminalReplicationBootstrapSettled(record), true)
  assert.equal(replication.terminalReplicationCanFocus(record), true)
})

test('attachment and page lifecycle transitions are owned by replication', () => {
  const state = replicationRecord()

  replication.beginTerminalAttachmentReplication(state.record)
  assert.equal(state.record.replication.needsReconnectOutputSync, true)
  assert.equal(state.record.replication.bootstrappingSnapshot, true)
  assert.equal(state.recoveryResets(), 1)

  replication.setTerminalReplicationPageSuspended(state.record, true)
  assert.equal(state.record.replication.pageOutputSuspended, true)
  assert.equal(state.record.replication.needsReconnectOutputSync, true)

  replication.setTerminalReplicationPageSuspended(state.record, false)
  assert.equal(state.record.replication.pageOutputSuspended, false)
  assert.equal(state.recoveryResets(), 2)
  assert.ok(state.recoveryBegins() >= 4)
})

test('ready and pending-snapshot queries expose protocol meaning instead of fields', () => {
  const { record, attach } = replicationRecord()
  attach()
  record.replication.bootstrappingSnapshot = false
  record.replication.needsReconnectOutputSync = false
  const attachment = record.attachment as unknown as {
    runtimeEpoch: string
    outputSeq: number | null
    stateRevision: number | null
  }
  attachment.runtimeEpoch = 'runtime-1'
  attachment.outputSeq = 4
  attachment.stateRevision = 7

  assert.equal(replication.terminalReplicationReady(record), true)
  record.replication.pendingSnapshotReplay = true
  assert.equal(replication.hasPendingTerminalSnapshot(record), true)
  assert.equal(replication.terminalReplicationReady(record), false)
})

test('releasing a held checkpoint completion consumes it exactly once', () => {
  const { record } = replicationRecord()
  let completions = 0
  record.replication.heldCheckpointInstallCompletionForTest = () => { completions += 1 }

  replication.setTerminalCheckpointInstallHeld(record, true)
  assert.equal(completions, 0)
  replication.setTerminalCheckpointInstallHeld(record, false)
  replication.setTerminalCheckpointInstallHeld(record, false)

  assert.equal(completions, 1)
  assert.equal(record.replication.heldCheckpointInstallCompletionForTest, null)
})

test('a detached replacement snapshot explicitly requires checkpoint recovery', () => {
  const state = replicationRecord()
  state.record.replication.bootstrappingSnapshot = false
  state.record.replication.needsReconnectOutputSync = false

  replication.applyTerminalOutputEvent(
    state.record,
    'replacement screen',
    true,
    9,
    'farming-runtime-v1:00000000000000000002:test',
    12,
    100,
    30,
  )

  assert.equal(state.record.replication.needsReconnectOutputSync, true)
  assert.equal(state.record.replication.bootstrappingSnapshot, true)
  assert.ok(state.recoveryBegins() >= 2)
})
