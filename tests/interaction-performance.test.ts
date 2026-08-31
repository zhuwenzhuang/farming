import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { InteractionPerformanceRecorder, parsePerformanceRecord, PERFORMANCE_LIMITS } from '../shared/interaction-performance'

function harness() {
  let time = 0
  const recorder = new InteractionPerformanceRecorder({ source: 'browser', prefix: 'test', now: () => time, wallNow: () => 10000 + time })
  return { recorder, advance: (ms: number) => { time += ms } }
}

test('monotonic stages, deadline and replacement fencing', () => {
  const { recorder, advance } = harness()
  const old = recorder.begin('terminal.input', { id: 'one', timeout: 3000, expiry: 'unobserved' })
  advance(20); old.mark('sent'); old.mark('sent')
  const next = recorder.begin('terminal.input', { id: 'one', timeout: 3000, expiry: 'unobserved' })
  old.end('completed')
  assert.equal(next.active(), true)
  advance(3001); recorder.sweep()
  const records = recorder.snapshot().records
  assert.equal(records[0].outcome, 'superseded')
  assert.equal(records[0].stages.sent, 20)
  assert.equal(records[1].outcome, 'unobserved')
  assert.equal(records[1].slow, false, 'no echo is not evidence of slow delivery')
  assert.equal(recorder.snapshot().pending, 0)
})

test('bounded pending and recent observations; hiding and late completion', () => {
  const { recorder } = harness()
  const late = recorder.begin('editor.input')
  for (let i = 0; i < 1000; i++) recorder.begin('editor.input')
  assert.equal(recorder.snapshot().pending, PERFORMANCE_LIMITS.pending)
  assert.ok(recorder.dropped > 0)
  recorder.cancelAll('hidden'); late.end('observed')
  assert.equal(recorder.snapshot().pending, 0)
  assert.equal(recorder.snapshot().records.length, PERFORMANCE_LIMITS.recent)
  const snapshot = recorder.snapshot()
  snapshot.records[0].metrics.inputUnits = 999
  assert.equal(recorder.snapshot().records[0].metrics.inputUnits, undefined)
})

test('allowlist excludes text, paths, arbitrary error messages and invalid numbers', () => {
  const { recorder } = harness()
  recorder.begin('file.save').end('completed')
  const record = recorder.snapshot().records[0]
  const parsed = parsePerformanceRecord({ ...record, path: '/private/secret', input: 'password', error: 'private message',
    target: '/private/secret', requestId: '/private/path', requestKind: 'private query',
    metrics: { inputUnits: 12, content: 'password', heapBytes: Infinity, queueMs: -1 }, stages: { handler: NaN, sent: 5 } })
  assert.ok(parsed)
  assert.deepEqual(parsed.metrics, { inputUnits: 12 })
  assert.deepEqual(parsed.stages, { sent: 5 })
  assert.equal(parsed.requestKind, 'other')
  assert.doesNotMatch(JSON.stringify(parsed), /password|private|Infinity/)
  assert.equal(parsePerformanceRecord({ ...record, durationMs: NaN }), null)
})

test('sink failure never escapes; buffered long tasks use actual duration', () => {
  const recorder = new InteractionPerformanceRecorder({ source: 'browser', prefix: 'test', now: () => 500,
    wallNow: () => 10000, emit: () => { throw new Error('disk offline') } })
  const trace = recorder.begin('browser.long-task', { started: 100, threshold: 50 })
  assert.doesNotThrow(() => trace.end('observed', 180))
  assert.equal(recorder.snapshot().records[0].durationMs, 80)
  assert.equal(recorder.dropped, 1)
})

test('recent percentiles exclude hidden and unobserved outcomes', () => {
  const { recorder, advance } = harness()
  for (const duration of [10, 20, 30]) { const trace = recorder.begin('terminal.input'); advance(duration); trace.end('observed') }
  const hidden = recorder.begin('terminal.input'); advance(10000); hidden.end('hidden')
  const group = recorder.snapshot().summary[0]
  assert.equal(group.observed, 4); assert.equal(group.completed, 3)
  assert.equal(group.p50Ms, 20); assert.equal(group.p95Ms, 30)
})

test('same-file replacement cannot be cancelled by the prior open request', async () => {
  const { beginNavigationPerformance } = await import('../src/lib/interaction-performance')
  const old = beginNavigationPerformance('file.open', 'opaque-same-file')
  const next = beginNavigationPerformance('file.open', 'opaque-same-file')
  old.end('cancelled')
  assert.equal(old.active(), false)
  assert.equal(next.active(), true)
  next.end('cancelled')
})

test('high-cardinality recording keeps constant retention', () => {
  const recorder = new InteractionPerformanceRecorder({ source: 'browser', prefix: 'load', now: () => performance.now(), wallNow: Date.now })
  const started = performance.now()
  for (let i = 0; i < 20000; i++) {
    const trace = recorder.begin('terminal.input')
    trace.mark('sent'); trace.mark('output'); trace.metric({ inputUnits: 1 }); trace.end('observed')
  }
  console.log(`interaction recorder: ${((performance.now() - started) / 20000 * 1000).toFixed(2)} us/observation (20,000 observations)`)
  assert.equal(recorder.snapshot().records.length, 512)
  assert.equal(recorder.snapshot().pending, 0)
})
