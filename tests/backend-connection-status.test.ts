import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BACKEND_INITIAL_CONNECT_GRACE_MS,
  classifyBackendConnection,
  reducePageVisibilitySnapshot,
} from '../shared/backend-connection-status'
import {
  getBackendConnectionSnapshot,
  markBackendDisconnected,
  resetBackendConnectionStatus,
  subscribeBackendConnectionStatus,
  updateBackendConnectionStatus,
} from '../src/lib/backend-live-status'

test('classifies transport loss from close time and business health from explicit probes', () => {
  const backgroundMessageAt = 1_000
  const foregroundAt = backgroundMessageAt + 30_000

  assert.equal(classifyBackendConnection({
    connected: true,
    lastMessageAt: backgroundMessageAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
    businessStatus: 'ready',
  }), null)
  assert.equal(classifyBackendConnection({
    connected: true,
    lastMessageAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
    businessStatus: 'unresponsive',
  }), 'business-unavailable')
  assert.equal(classifyBackendConnection({
    connected: true,
    lastMessageAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
    businessStatus: 'recovering',
  }), 'business-recovering')
  assert.equal(classifyBackendConnection({
    connected: false,
    lastMessageAt: foregroundAt,
    disconnectedAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt + BACKEND_INITIAL_CONNECT_GRACE_MS - 1,
  }), 'connecting')
  assert.equal(classifyBackendConnection({
    connected: false,
    lastMessageAt: foregroundAt,
    disconnectedAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt + BACKEND_INITIAL_CONNECT_GRACE_MS,
  }), 'lost')
  assert.equal(classifyBackendConnection({
    connected: false,
    lastMessageAt: backgroundMessageAt,
    disconnectedAt: backgroundMessageAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
  }), 'connecting')
})

test('one continuous outage retains its first close time and notifies subscribers once per change', () => {
  resetBackendConnectionStatus()
  updateBackendConnectionStatus({ connected: true, disconnectedAt: null })

  let notifications = 0
  const unsubscribe = subscribeBackendConnectionStatus(() => {
    notifications += 1
  })
  try {
    markBackendDisconnected(31_000)
    assert.equal(getBackendConnectionSnapshot().disconnectedAt, 31_000)

    markBackendDisconnected(32_000)
    assert.equal(getBackendConnectionSnapshot().disconnectedAt, 31_000)
    assert.equal(notifications, 1)

    updateBackendConnectionStatus({ connected: true, disconnectedAt: null })
    markBackendDisconnected(33_000)
    assert.equal(getBackendConnectionSnapshot().disconnectedAt, 33_000)
    assert.equal(notifications, 3)
  } finally {
    unsubscribe()
    resetBackendConnectionStatus()
  }
})

test('page visibility transitions preserve the last real foreground boundary', () => {
  const hiddenSnapshot = { visible: false, visibleSince: 1_000 }
  const hiddenPageShow = reducePageVisibilitySnapshot(hiddenSnapshot, {
    eventType: 'pageshow',
    documentVisible: false,
    changedAt: 30_000,
  })
  assert.equal(hiddenPageShow, hiddenSnapshot)

  const foregroundSnapshot = reducePageVisibilitySnapshot(hiddenPageShow, {
    eventType: 'visibilitychange',
    documentVisible: true,
    changedAt: 31_000,
  })
  assert.deepEqual(foregroundSnapshot, {
    visible: true,
    visibleSince: 31_000,
  })

  assert.deepEqual(reducePageVisibilitySnapshot(foregroundSnapshot, {
    eventType: 'pagehide',
    documentVisible: true,
    changedAt: 32_000,
  }), {
    visible: false,
    visibleSince: 31_000,
  })
})
