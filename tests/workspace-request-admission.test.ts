import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  requestWorkspace, requestLanguageServerTransport, setWorkspaceRequestTransport,
  setWorkspaceRequestTransportReady, settleWorkspaceRequest, WorkspaceTransportError,
} from '../src/lib/workspace-request-client'
import type { WorkspaceRequestMessage } from '../shared/browser-protocol'

test('restored directory bursts stay bounded and background work cannot block navigation', { timeout: 5_000 }, async t => {
  const sent: WorkspaceRequestMessage[] = []
  const controller = new AbortController()
  t.after(() => controller.abort())
  const pending: Promise<unknown>[] = []
  setWorkspaceRequestTransport(message => {
    if (message.type === 'workspace-request') sent.push(message)
    return true
  })
  setWorkspaceRequestTransportReady(true)
  try {
    for (let i = 0; i < 100; i++) {
      pending.push(requestWorkspace({ operation: 'tree-decorations', rootId: 'root', path: `dir-${i}`, entryPaths: [] },
        { signal: controller.signal }).catch(error => error))
    }
    assert.equal(sent.length, 2, 'background restoration must have bounded delivery')
    for (let i = 0; i < 100; i++) {
      pending.push(requestWorkspace({ operation: 'tree', rootId: 'root', path: `dir-${i}` },
        { signal: controller.signal }).catch(error => error))
    }
    assert.equal(sent.length, 6, 'navigation retains its own four delivery slots')
    setWorkspaceRequestTransportReady(true)
    assert.equal(sent.length, 6, 'repeated readiness must neither replay sent work nor bypass admission')
    for (let i = 0; i < 200; i++) {
      const message = sent[i]
      assert(message, 'settlement must admit the next queued request')
      settleWorkspaceRequest({ type: 'workspace-result', requestId: message.requestId, ok: true, result: { path: message.request.operation } })
      assert(sent.length - i - 1 <= 6, 'the entire burst must respect delivery capacity')
    }
    assert.equal(sent.length, 200)
    assert((await Promise.all(pending)).every(value => !(value instanceof Error)))
  } finally {
    controller.abort()
    await Promise.all(pending)
    setWorkspaceRequestTransport(null)
  }
})

test('queued cancellation and deadline never send mutations or claim an uncertain outcome', { timeout: 5_000 }, async t => {
  const sent: WorkspaceRequestMessage[] = []
  const controller = new AbortController()
  t.after(() => controller.abort())
  const pending: Promise<unknown>[] = []
  setWorkspaceRequestTransport(message => {
    if (message.type === 'workspace-request') sent.push(message)
    return true
  })
  setWorkspaceRequestTransportReady(true)
  try {
    for (let i = 0; i < 4; i++) pending.push(requestWorkspace({ operation: 'tree', rootId: 'root', path: `${i}` },
      { signal: controller.signal }).catch(error => error))
    const queuedController = new AbortController()
    const cancelled = requestWorkspace({ operation: 'save-file', rootId: 'root', path: 'cancelled', content: '', baseSha1: 'v1' },
      { mutation: true, signal: queuedController.signal })
    queuedController.abort()
    await assert.rejects(cancelled, { name: 'AbortError' })
    await assert.rejects(requestWorkspace({ operation: 'save-file', rootId: 'root', path: 'expired', content: '', baseSha1: 'v1' },
      { mutation: true, timeoutMs: 10 }), error => error instanceof WorkspaceTransportError && error.code === 'TIMEOUT' && !error.uncertain)
    assert.equal(sent.length, 4)
    const last = requestWorkspace({ operation: 'tree', rootId: 'root', path: 'last' }, { signal: controller.signal })
    pending.push(last.catch(error => error))
    settleWorkspaceRequest({ type: 'workspace-result', requestId: sent[0].requestId, ok: true, result: {} })
    assert.equal(sent.at(-1)?.request.operation, 'tree')
    assert.equal(sent.length, 5, 'cancelled and timed-out work cannot hold or consume later admission')
  } finally {
    controller.abort()
    await Promise.all(pending)
    setWorkspaceRequestTransport(null)
  }
})

test('one bounded queue covers both domains while disconnected', { timeout: 5_000 }, async t => {
  setWorkspaceRequestTransport(null)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const pending: Promise<unknown>[] = []
  try {
    for (let i = 0; i < 512; i++) pending.push(requestWorkspace({ operation: 'tree', rootId: 'root', path: `${i}` },
      { signal: controller.signal }).catch(error => error))
    await assert.rejects(requestLanguageServerTransport({ operation: 'capability', rootId: 'root' }, { signal: controller.signal }),
      error => error instanceof WorkspaceTransportError && error.code === 'BUSY' && !error.uncertain)
  } finally {
    controller.abort()
    await Promise.all(pending)
  }
})
