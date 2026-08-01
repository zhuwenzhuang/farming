import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import {
  SHARED_NOW_TICK_MS,
  getSharedNowSnapshot,
  subscribeSharedNow,
} from '../src/lib/shared-now'

test('shared now clock starts on first subscriber and ticks every 30 seconds', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 })
  try {
    let notified = 0
    const unsubscribe = subscribeSharedNow(() => { notified += 1 })
    try {
      assert.equal(getSharedNowSnapshot(), 1_000_000)
      mock.timers.tick(SHARED_NOW_TICK_MS - 1)
      assert.equal(notified, 0)
      assert.equal(getSharedNowSnapshot(), 1_000_000)
      mock.timers.tick(1)
      assert.equal(notified, 1)
      assert.equal(getSharedNowSnapshot(), 1_000_000 + SHARED_NOW_TICK_MS)
    } finally {
      unsubscribe()
    }
  } finally {
    mock.timers.reset()
  }
})

test('multiple subscribers share one timer and each gets one notification per tick', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 5_000_000 })
  try {
    let first = 0
    let second = 0
    const unsubscribeFirst = subscribeSharedNow(() => { first += 1 })
    const unsubscribeSecond = subscribeSharedNow(() => { second += 1 })
    try {
      mock.timers.tick(SHARED_NOW_TICK_MS)
      assert.equal(first, 1)
      assert.equal(second, 1)
      mock.timers.tick(SHARED_NOW_TICK_MS)
      assert.equal(first, 2)
      assert.equal(second, 2)
    } finally {
      unsubscribeFirst()
      unsubscribeSecond()
    }
  } finally {
    mock.timers.reset()
  }
})

test('timer stops after the last unsubscribe and restarts with a fresh snapshot', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 9_000_000 })
  try {
    let firstNotified = 0
    const unsubscribeFirst = subscribeSharedNow(() => { firstNotified += 1 })
    unsubscribeFirst()
    const stoppedSnapshot = getSharedNowSnapshot()
    mock.timers.tick(SHARED_NOW_TICK_MS * 3)
    assert.equal(firstNotified, 0)
    assert.equal(getSharedNowSnapshot(), stoppedSnapshot)

    let secondNotified = 0
    const unsubscribeSecond = subscribeSharedNow(() => { secondNotified += 1 })
    try {
      assert.equal(getSharedNowSnapshot(), 9_000_000 + SHARED_NOW_TICK_MS * 3)
      mock.timers.tick(SHARED_NOW_TICK_MS)
      assert.equal(secondNotified, 1)
    } finally {
      unsubscribeSecond()
    }
  } finally {
    mock.timers.reset()
  }
})

test('a stale unsubscribe cannot stop the timer owned by a newer subscriber', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 2_000_000 })
  try {
    const staleListener = () => {}
    const unsubscribeStale = subscribeSharedNow(staleListener)
    unsubscribeStale()

    let notified = 0
    const unsubscribe = subscribeSharedNow(() => { notified += 1 })
    try {
      unsubscribeStale()
      unsubscribeStale()
      mock.timers.tick(SHARED_NOW_TICK_MS)
      assert.equal(notified, 1)
    } finally {
      unsubscribe()
    }
  } finally {
    mock.timers.reset()
  }
})

test('strict-mode style subscribe, unsubscribe, resubscribe keeps exactly one live timer', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 3_000_000 })
  try {
    let notified = 0
    const listener = () => { notified += 1 }
    const firstLease = subscribeSharedNow(listener)
    firstLease()
    const secondLease = subscribeSharedNow(listener)
    try {
      mock.timers.tick(SHARED_NOW_TICK_MS)
      assert.equal(notified, 1)
    } finally {
      secondLease()
    }
    mock.timers.tick(SHARED_NOW_TICK_MS * 2)
    assert.equal(notified, 1)
  } finally {
    mock.timers.reset()
  }
})

test('a stale unsubscribe of the same listener function cannot remove the resubscribed lease', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 4_000_000 })
  try {
    let notified = 0
    const listener = () => { notified += 1 }
    const staleLease = subscribeSharedNow(listener)
    staleLease()
    const currentLease = subscribeSharedNow(listener)
    try {
      staleLease()
      staleLease()
      mock.timers.tick(SHARED_NOW_TICK_MS)
      assert.equal(notified, 1)
    } finally {
      currentLease()
    }
    mock.timers.tick(SHARED_NOW_TICK_MS * 2)
    assert.equal(notified, 1)
  } finally {
    mock.timers.reset()
  }
})

test('concurrent leases of the same listener function are independent and notify per lease', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 6_000_000 })
  try {
    let notified = 0
    const listener = () => { notified += 1 }
    const firstLease = subscribeSharedNow(listener)
    const secondLease = subscribeSharedNow(listener)
    try {
      mock.timers.tick(SHARED_NOW_TICK_MS)
      assert.equal(notified, 2)
      firstLease()
      firstLease()
      mock.timers.tick(SHARED_NOW_TICK_MS)
      assert.equal(notified, 3)
    } finally {
      secondLease()
    }
    mock.timers.tick(SHARED_NOW_TICK_MS * 2)
    assert.equal(notified, 3)
  } finally {
    mock.timers.reset()
  }
})
