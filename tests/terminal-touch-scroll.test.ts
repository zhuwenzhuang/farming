import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendTerminalTouchVelocitySample,
  blendTerminalTouchVelocity,
  clampTerminalTouchVelocity,
  consumeTerminalTouchScrollDelta,
  nextTerminalTouchEdgeOffset,
  readTerminalTouchGestureVelocity,
  shouldStartTerminalTouchMomentum,
  stepTerminalTouchMomentum,
} from '../src/lib/terminal-touch-scroll'

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} should equal ${expected}`)
}

test('clamps touch velocity equally in both directions', () => {
  assert.equal(clampTerminalTouchVelocity(1.5), 1.5)
  assert.equal(clampTerminalTouchVelocity(8), 3.2)
  assert.equal(clampTerminalTouchVelocity(-8), -3.2)
})

test('keeps the recent velocity window while retaining two samples', () => {
  const original = [{ y: 0, at: 0 }]
  const recent = appendTerminalTouchVelocitySample(original, { y: 10, at: 40 })
  const pruned = appendTerminalTouchVelocitySample(recent, { y: 40, at: 120 })
  const sparse = appendTerminalTouchVelocitySample(pruned, { y: 80, at: 400 })

  assert.deepEqual(original, [{ y: 0, at: 0 }])
  assert.deepEqual(pruned, [{ y: 10, at: 40 }, { y: 40, at: 120 }])
  assert.deepEqual(sparse, [{ y: 40, at: 120 }, { y: 80, at: 400 }])
})

test('derives signed gesture velocity and falls back for invalid samples', () => {
  assert.equal(readTerminalTouchGestureVelocity([
    { y: 100, at: 10 },
    { y: 140, at: 30 },
  ], 0), 2)
  assert.equal(readTerminalTouchGestureVelocity([
    { y: 140, at: 10 },
    { y: 100, at: 20 },
  ], 0), -3.2)
  assert.equal(readTerminalTouchGestureVelocity([
    { y: 100, at: 10 },
    { y: 120, at: 10 },
  ], 0.75), 0.75)
})

test('blends gesture and instant velocity before applying the speed limit', () => {
  assertClose(blendTerminalTouchVelocity(2, 10, 10), 1.72)
  assert.equal(blendTerminalTouchVelocity(10, 100, 1), 3.2)
  assert.equal(blendTerminalTouchVelocity(-10, -100, 1), -3.2)
})

test('converts signed pixel deltas to lines without losing the remainder', () => {
  assert.deepEqual(consumeTerminalTouchScrollDelta(7, 10, 16), {
    lineDelta: 1,
    remainderPx: 1,
  })
  assert.deepEqual(consumeTerminalTouchScrollDelta(-7, -10, 16), {
    lineDelta: -1,
    remainderPx: -1,
  })
  assert.deepEqual(consumeTerminalTouchScrollDelta(2, 5, 16), {
    lineDelta: 0,
    remainderPx: 7,
  })
})

test('resists and bounds edge pull in both directions', () => {
  assertClose(nextTerminalTouchEdgeOffset(0, 10), 2.8)
  assert.equal(nextTerminalTouchEdgeOffset(25, 100), 30)
  assert.equal(nextTerminalTouchEdgeOffset(-25, -100), -30)
})

test('uses bounded frame time and decays momentum symmetrically', () => {
  const first = stepTerminalTouchMomentum(2, 0, 1_000)
  assert.equal(first.elapsedMs, 16)
  assert.equal(first.scrollDeltaPx, 32)
  assertClose(first.nextVelocity, 2 * 0.972)
  assert.equal(first.shouldContinue, true)

  const delayed = stepTerminalTouchMomentum(-2, 100, 200)
  assert.equal(delayed.elapsedMs, 48)
  assert.equal(delayed.scrollDeltaPx, -96)
  assertClose(delayed.nextVelocity, -2 * Math.pow(0.972, 3))

  assert.equal(stepTerminalTouchMomentum(0.025, 0, 16).shouldContinue, false)
})

test('starts momentum only at the minimum signed velocity', () => {
  assert.equal(shouldStartTerminalTouchMomentum(0.024), false)
  assert.equal(shouldStartTerminalTouchMomentum(-0.024), false)
  assert.equal(shouldStartTerminalTouchMomentum(0.025), true)
  assert.equal(shouldStartTerminalTouchMomentum(-0.025), true)
})
