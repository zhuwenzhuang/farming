/// <reference path="../src/types/terminal-replay.d.ts" />

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { TerminalAttachmentCoordinator } from '../src/lib/terminal-attachment-coordinator'
import type { TerminalOutputRecord } from '../src/lib/terminal-output'

const replay = require('../frontend/terminal-replay.js') as FarmingTerminalReplayApi
const epoch = 'farming-runtime-v1:00000000000000000001:write-ordering'

test('a queued stale checkpoint is rejected before it resets live output', async () => {
  Object.assign(globalThis, { self: globalThis })
  const runtimeRequire = createRequire(import.meta.url)
  runtimeRequire.extensions['.css'] = () => {}
  const { replaceTerminalOutput, writeTerminalOutput } = await import('../src/lib/terminal-output')
  let reportLiveWriteStarted!: (complete: () => void) => void
  const liveWriteStarted = new Promise<() => void>(resolve => {
    reportLiveWriteStarted = resolve
  })
  let resetCount = 0
  const terminal = {
    buffer: { active: { baseY: 0, length: 24 } },
    cols: 80,
    rows: 24,
    reset: () => { resetCount += 1 },
    refresh: () => {},
    write: (data: string, callback?: () => void) => {
      if (data === 'live-seq-2' && callback) reportLiveWriteStarted(callback)
      else callback?.()
    },
  }
  const record = {
    terminal,
    hostEl: { querySelector: () => null },
    disposed: false,
    suspendRendering: false,
    terminalWriteQueue: Promise.resolve(),
    terminalWriteResolvers: new Set(),
    terminalWriteBatchCount: 0,
    followOutput: true,
    hasUnreadOutput: false,
    preserveUnreadOutputUntilJump: false,
    followOutputHandler: null,
  } as unknown as TerminalOutputRecord
  const coordinator = new TerminalAttachmentCoordinator(replay)
  const attachment = coordinator.beginAttachment()
  const checkpoint = {
    runtimeEpoch: epoch,
    outputSeq: 1,
    stateRevision: 1,
    cols: 81,
    rows: 24,
  }
  assert.equal(coordinator.commitCheckpoint(attachment, checkpoint), true)
  const install = coordinator.beginCheckpointOperation(attachment.generation)
  if (!install) throw new Error('expected a checkpoint operation token')

  writeTerminalOutput(record, 'live-seq-2', () => {
    coordinator.commitTransition({
      kind: 'output',
      data: 'live-seq-2',
      runtimeEpoch: epoch,
      outputSeq: 2,
      stateRevision: 2,
    })
  })
  let checkpointCommitted = true
  replaceTerminalOutput(record, 'checkpoint-seq-1', () => {
    checkpointCommitted = coordinator.commitCheckpoint(install, checkpoint)
  }, {
    beforeReplace: () => coordinator.admitCheckpointInstall(install, checkpoint),
  })

  const completeLiveWrite = await liveWriteStarted
  completeLiveWrite()
  await record.terminalWriteQueue

  assert.equal(resetCount, 0)
  assert.equal(checkpointCommitted, false)
  assert.equal(coordinator.outputSeq, 2)
  assert.equal(coordinator.stateRevision, 2)
})
