import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import type { TerminalOutputRecord } from '../src/lib/terminal-output'

Object.assign(globalThis, { self: globalThis })
const runtimeRequire = createRequire(import.meta.url)
runtimeRequire.extensions['.css'] = () => {}
let output!: typeof import('../src/lib/terminal-output')

test.before(async () => {
  output = await import('../src/lib/terminal-output')
})

function outputRecord() {
  const writes: Array<{ data: string; complete: () => void }> = []
  let resets = 0
  let renderSuspensionReleases = 0
  const record = {
    terminal: {
      __farmingTerminalEngine: 'xterm',
      buffer: { active: { viewportY: 0, baseY: 0, length: 24 } },
      cols: 80,
      rows: 24,
      viewportY: 0,
      reset: () => { resets += 1 },
      scrollToBottom: () => {},
      write: (data: string, complete: () => void) => { writes.push({ data, complete }) },
    },
    hostEl: { querySelector: () => null },
    disposed: false,
    rendererEffects: {
      acquireRenderSuspension: () => ({
        release: () => { renderSuspensionReleases += 1 },
      }),
    },
    replication: {
      terminalWriteQueue: Promise.resolve(),
      terminalWriteResolvers: new Set<(cancelled?: boolean) => boolean>(),
      terminalWriteBatchCount: 0,
    },
    followOutput: true,
    hasUnreadOutput: false,
    preserveUnreadOutputUntilJump: false,
    followOutputHandler: null,
  } as unknown as TerminalOutputRecord
  return {
    record,
    writes,
    resets: () => resets,
    renderSuspensionReleases: () => renderSuspensionReleases,
  }
}

async function startQueuedWrite() {
  await Promise.resolve()
  await Promise.resolve()
}

test('destroy cleanup cancels one pending write and completes its callback exactly once', async () => {
  const state = outputRecord()
  let callbacks = 0
  output.writeTerminalOutput(state.record, 'pending', () => { callbacks += 1 }, { quiet: true })
  await startQueuedWrite()

  assert.equal(state.record.replication.terminalWriteResolvers.size, 1)
  output.flushPendingTerminalWrites(state.record)
  await state.record.replication.terminalWriteQueue
  assert.equal(callbacks, 1)
  assert.equal(state.renderSuspensionReleases(), 1)
  assert.equal(state.record.replication.terminalWriteResolvers.size, 0)

  state.writes[0]?.complete()
  assert.equal(callbacks, 1)
  assert.equal(state.renderSuspensionReleases(), 1)
})

test('terminal writes remain serialized behind renderer callbacks', async () => {
  const state = outputRecord()
  output.writeTerminalOutput(state.record, 'first')
  output.writeTerminalOutput(state.record, 'second')
  await startQueuedWrite()
  assert.deepEqual(state.writes.map(write => write.data), ['first'])

  state.writes[0]?.complete()
  await startQueuedWrite()
  assert.deepEqual(state.writes.map(write => write.data), ['first', 'second'])
  state.writes[1]?.complete()
  await state.record.replication.terminalWriteQueue
})

test('checkpoint admission is revalidated before reset mutates the terminal', async () => {
  const state = outputRecord()
  let admitted = false
  let callbacks = 0
  output.replaceTerminalOutput(state.record, 'checkpoint', () => { callbacks += 1 }, {
    beforeReplace: () => admitted,
  })
  await state.record.replication.terminalWriteQueue

  assert.equal(state.resets(), 0)
  assert.equal(state.writes.length, 0)
  assert.equal(callbacks, 1)
})
