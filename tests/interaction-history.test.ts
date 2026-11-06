import assert from 'node:assert/strict'
import test from 'node:test'
import { InteractionHistory, type InteractionHistoryPort } from '../src/lib/interaction-history'

function fixture(original: unknown = { navigation: 'kept' }) {
  const entries = [{ state: null as unknown, url: '/previous' }, { state: original, url: '/farming/' }]
  let index = 1
  let layers = 0
  let busy = false
  let backCalls = 0
  let dismissals = 0
  let timer: (() => void) | null = null
  const deferred: Array<() => void> = []
  const reports: unknown[] = []
  const port: InteractionHistoryPort = {
    read: () => entries[index],
    push: (state, url) => { entries.splice(++index, entries.length, { state, url }) },
    replace: (state, url) => { entries[index] = { state, url } },
    back: () => { backCalls++ },
    defer: action => { deferred.push(action) },
    timeout: action => { timer = action; return () => { timer = null } },
    report: error => reports.push(error),
  }
  const history = new InteractionHistory(port, 'this-document', () => layers > 0, () => {
    if (!busy) { layers--; dismissals++ }
  })
  const flush = () => { while (deferred.length) deferred.shift()!() }
  const back = () => { index--; history.pop(); flush() }
  return {
    entries, port, reports, history, back, flush,
    setLayers: (count: number) => { layers = count; history.sync() },
    setBusy: (value: boolean) => { busy = value },
    forward: () => { index++; history.pop(); flush() },
    timeout: () => timer?.(),
    get current() { return entries[index] },
    get layers() { return layers },
    get backCalls() { return backCalls },
    get dismissals() { return dismissals },
  }
}

test('one guard serves nested layers; Back dismisses only one at a time', () => {
  const f = fixture()
  f.setLayers(1)
  f.setLayers(2)
  f.history.sync()
  assert.equal(f.entries.length, 3)
  f.back()
  assert.equal(f.layers, 1)
  assert.equal(f.dismissals, 1)
  assert.equal(f.entries.length, 3)
  f.back()
  assert.equal(f.layers, 0)
  assert.deepEqual(f.current, { state: { navigation: 'kept' }, url: '/farming/' })
  f.back()
  assert.equal(f.current.url, '/previous')
})

test('a busy layer consumes Back without dismissal or mutation replay', () => {
  const f = fixture()
  f.setLayers(1)
  f.setBusy(true)
  f.back()
  assert.equal(f.layers, 1)
  assert.equal(f.dismissals, 0)
  f.setBusy(false)
  f.back()
  assert.equal(f.dismissals, 1)
})

test('close and immediate reopen await the same cleanup; its pop cannot close the new layer', () => {
  const f = fixture()
  f.setLayers(1)
  f.setLayers(0)
  assert.equal(f.backCalls, 1)
  f.setLayers(1)
  f.history.sync()
  assert.equal(f.backCalls, 1)
  f.back()
  assert.equal(f.layers, 1)
  assert.equal(f.dismissals, 0)
  f.back()
  assert.equal(f.layers, 0)
})

test('closing and forward do not resurrect UI or leave a guard in the Back path', () => {
  const f = fixture()
  f.setLayers(1)
  f.setLayers(0)
  f.back()
  f.forward()
  assert.equal(f.layers, 0)
  assert.equal(f.backCalls, 2)
  f.back()
  assert.equal(f.current.url, '/farming/')
  f.back()
  assert.equal(f.current.url, '/previous')
  assert.equal(f.dismissals, 0)
})

test('reload recognizes and removes another document guard, not its former UI', () => {
  const f = fixture()
  f.setLayers(1)
  let newLayers = 0
  const reloaded = new InteractionHistory(f.port, 'new-document', () => newLayers > 0, () => newLayers--)
  reloaded.sync()
  assert.equal(f.backCalls, 1)
  // New UI may mount while the old guard is being removed.
  newLayers = 1
  reloaded.sync()
  assert.equal(f.backCalls, 1)
})

test('cleanup preserves primitive state and navigation updates to URL/object state', () => {
  for (const original of [null, 42, 'state', [1, 2]]) {
    const f = fixture(original)
    f.setLayers(1)
    f.setLayers(0)
    f.back()
    assert.deepEqual(f.current.state, original)
  }
  const f = fixture()
  f.setLayers(1)
  f.port.replace({ ...f.current.state as object, navigation: 'new' }, '/farming/?agent=new')
  f.setLayers(0)
  f.back()
  assert.deepEqual(f.current, { state: { navigation: 'new' }, url: '/farming/?agent=new' })
})

test('timeout reports uncertainty without replay; a late pop still cannot dismiss a new layer', () => {
  const f = fixture()
  f.setLayers(1)
  f.setLayers(0)
  f.timeout()
  f.setLayers(1)
  f.history.sync()
  assert.equal(f.reports.length, 1)
  assert.equal(f.backCalls, 1)
  f.back()
  assert.equal(f.layers, 1)
  assert.equal(f.dismissals, 0)
  f.back()
  assert.equal(f.layers, 0)
})

test('a navigation replacement during cleanup cannot be undone by its delayed pop', () => {
  const f = fixture()
  f.setLayers(1)
  f.setLayers(0)
  f.history.replace({ ...f.current.state as object, navigation: 'latest' }, '/farming/?file=new')
  f.setLayers(1)
  f.back()
  assert.equal(f.current.url, '/farming/?file=new')
  assert.equal(f.layers, 1)
  f.back()
  assert.deepEqual(f.current, { state: { navigation: 'latest' }, url: '/farming/?file=new' })
})

test('navigation replacing state with null preserves the one active guard', () => {
  const f = fixture()
  f.setLayers(1)
  f.history.replace(null, '/farming/review?head=resolved')
  f.history.sync()
  assert.equal(f.entries.length, 3)
  f.back()
  assert.equal(f.layers, 0)
  assert.deepEqual(f.current, { state: null, url: '/farming/review?head=resolved' })
  f.back()
  assert.equal(f.current.url, '/previous')
})

test('history API failures are reported once and never retried automatically', () => {
  const f = fixture()
  let writes = 0
  f.port.push = () => { writes++; throw new Error('History unavailable') }
  f.setLayers(1)
  f.history.sync()
  assert.equal(f.reports.length, 1)
  assert.equal(writes, 1)
  assert.equal(f.backCalls, 0)
  f.history.replace(null, '/farming/?file=latest')
  f.back()
  assert.equal(f.current.url, '/previous')
  assert.equal(f.current.state, null)
  assert.equal(f.dismissals, 0)
  assert.equal(writes, 1)
})
