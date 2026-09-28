import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpRevisionInterestStore, acpRevisionWatchAgentIds } from '../src/lib/acp-revision-interest'
import { MAX_ACP_TRANSCRIPT_INTEREST } from '../shared/browser-protocol'

test('visible transcript and composer share interest until both detach', () => {
  const store = new AcpRevisionInterestStore()
  let changes = 0
  const unsubscribe = store.subscribe(() => { changes++ })
  const releaseTranscript = store.acquire('child')
  const snapshot = store.getSnapshot()
  const releaseComposer = store.acquire('child')
  assert.equal(store.getSnapshot(), snapshot)
  assert.equal(changes, 1)
  releaseTranscript()
  releaseTranscript()
  assert.deepEqual(store.getSnapshot(), ['child'])
  releaseComposer()
  assert.deepEqual(store.getSnapshot(), [])
  assert.equal(changes, 2)
  unsubscribe()
})

test('switching one panel keeps its visible peers subscribed', () => {
  const store = new AcpRevisionInterestStore()
  const releaseParent = store.acquire('parent')
  const releaseChild = store.acquire('child')
  releaseChild()
  const releaseResource = store.acquire('resource-agent')
  assert.deepEqual(store.getSnapshot(), ['parent', 'resource-agent'])
  releaseParent()
  assert.deepEqual(store.getSnapshot(), ['resource-agent'])
  releaseResource()
  assert.deepEqual(store.getSnapshot(), [])
})

test('visible panels take priority over a full retained cache and share exact identities', () => {
  const retained = Array.from({ length: MAX_ACP_TRANSCRIPT_INTEREST }, (_, i) => `cached-${i}`)
  const watched = acpRevisionWatchAgentIds(['child', 'parent', 'child'], [...retained, 'parent'])
  assert.equal(watched.length, MAX_ACP_TRANSCRIPT_INTEREST)
  assert.deepEqual(watched.slice(0, 2), ['child', 'parent'])
  assert.equal(new Set(watched).size, watched.length)
  assert.deepEqual(acpRevisionWatchAgentIds([], []), [])
})
