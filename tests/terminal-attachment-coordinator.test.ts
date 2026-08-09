/// <reference path="../src/types/terminal-replay.d.ts" />

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TerminalAttachmentCoordinator,
} from '../src/lib/terminal-attachment-coordinator'

const replay = require('../frontend/terminal-replay.js') as FarmingTerminalReplayApi
const epoch = 'farming-runtime-v1:00000000000000000001:test'

function checkpoint(revision: number): TerminalReplayCheckpoint {
  return { runtimeEpoch: epoch, outputSeq: revision, stateRevision: revision, cols: 80, rows: 24 }
}

function output(revision: number): TerminalReplayTransition {
  return { kind: 'output', data: String(revision), runtimeEpoch: epoch, outputSeq: revision, stateRevision: revision }
}

test('a newer attachment fences an older checkpoint completion', () => {
  const coordinator = new TerminalAttachmentCoordinator(replay)
  const first = coordinator.beginAttachment()
  assert.equal(coordinator.commitCheckpoint(first, checkpoint(1)), true)

  const staleInstall = coordinator.beginCheckpointOperation(first.generation)
  if (!staleInstall) throw new Error('expected an install token')
  coordinator.beginAttachment()

  assert.equal(coordinator.commitCheckpoint(staleInstall, checkpoint(2)), false)
  assert.equal(coordinator.snapshot().stateRevision, 1)
})

test('a newer checkpoint admission fences the previous completion', () => {
  const coordinator = new TerminalAttachmentCoordinator(replay)
  const attachment = coordinator.beginAttachment()
  const first = coordinator.beginCheckpointOperation(attachment.generation)
  const second = coordinator.beginCheckpointOperation(attachment.generation)
  if (!first || !second) throw new Error('expected checkpoint operation tokens')

  assert.equal(coordinator.commitCheckpoint(first, checkpoint(1)), false)
  assert.equal(coordinator.commitCheckpoint(second, checkpoint(1)), true)
})

test('a live commit invalidates an older checkpoint before its renderer effect and completion', () => {
  const coordinator = new TerminalAttachmentCoordinator(replay)
  const attachment = coordinator.beginAttachment()
  assert.equal(coordinator.commitCheckpoint(attachment, checkpoint(1)), true)

  const install = coordinator.beginCheckpointOperation(attachment.generation)
  if (!install) throw new Error('expected a checkpoint operation token')
  assert.equal(coordinator.admitCheckpointInstall(install, checkpoint(1)), true)

  coordinator.commitTransition(output(2))

  assert.equal(coordinator.admitCheckpointInstall(install, checkpoint(1)), false)
  assert.equal(coordinator.commitCheckpoint(install, checkpoint(1)), false)
  assert.equal(coordinator.outputSeq, 2)
  assert.equal(coordinator.stateRevision, 2)
})

test('ordered transitions advance one cursor while a gap enters recovery', () => {
  const coordinator = new TerminalAttachmentCoordinator(replay)
  const attachment = coordinator.beginAttachment()
  coordinator.commitCheckpoint(attachment, checkpoint(1))

  assert.equal(coordinator.classifyTransition(output(2)).action, 'apply')
  coordinator.commitTransition(output(2))
  assert.equal(coordinator.classifyTransition(output(4)).action, 'recover')
  assert.equal(coordinator.queueTransition(output(4)).queued, true)

  assert.deepEqual(coordinator.snapshot(), {
    generation: 1,
    revision: 0,
    runtimeEpoch: epoch,
    outputSeq: 2,
    stateRevision: 2,
    replayTargetEpoch: epoch,
    replayTargetRevision: 4,
    queuedTransitions: 1,
    queuedBytes: 1,
    recovering: true,
    halted: false,
    failureCount: 0,
  })
})

test('batch admission proves a contiguous suffix without mutating the live cursor', () => {
  const coordinator = new TerminalAttachmentCoordinator(replay)
  const attachment = coordinator.beginAttachment()
  coordinator.commitCheckpoint(attachment, checkpoint(1))
  coordinator.queueTransition(output(2))
  coordinator.queueTransition(output(3))

  assert.deepEqual(coordinator.queuedOutputBatch(), [output(2), output(3)])
  assert.equal(coordinator.snapshot().stateRevision, 1)
  assert.equal(coordinator.snapshot().queuedTransitions, 2)
})
