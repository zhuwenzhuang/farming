import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMobileViewportGeometry } from '../src/lib/mobile-viewport'

const base = {
  visualWidth: 390,
  visualHeight: 760,
  visualOffsetTop: 84,
  visualOffsetLeft: 0,
  layoutWidth: 390,
  layoutHeight: 844,
  compact: true,
  touch: true,
}

test('browser chrome uses the visible viewport instead of extending below it', () => {
  assert.deepEqual(resolveMobileViewportGeometry(base), {
    width: 390,
    height: 760,
    offsetTop: 84,
    offsetLeft: 0,
    keyboardOffset: 0,
    keyboardActive: false,
  })
})

test('a tall keyboard and candidate panel may shrink the app below the old 240px floor', () => {
  assert.deepEqual(resolveMobileViewportGeometry({
    ...base,
    visualHeight: 190,
    visualOffsetTop: 0,
  }), {
    width: 390,
    height: 190,
    offsetTop: 0,
    offsetLeft: 0,
    keyboardOffset: 654,
    keyboardActive: true,
  })
})

test('a resting standalone app keeps the native visual viewport paint boundary', () => {
  assert.deepEqual(resolveMobileViewportGeometry({
    ...base,
    visualHeight: 812,
    visualOffsetTop: 62,
    visualOffsetLeft: 8,
    visualWidth: 382,
    layoutHeight: 812,
  }), {
    width: 382,
    height: 812,
    offsetTop: 62,
    offsetLeft: 8,
    keyboardOffset: 0,
    keyboardActive: false,
  })
})

test('a standalone app returns to visual viewport coordinates while its keyboard is open', () => {
  assert.deepEqual(resolveMobileViewportGeometry({
    ...base,
    visualHeight: 477,
    visualOffsetTop: 62,
    layoutHeight: 812,
  }), {
    width: 390,
    height: 477,
    offsetTop: 62,
    offsetLeft: 0,
    keyboardOffset: 273,
    keyboardActive: true,
  })
})

test('a stale rotated VisualViewport falls back to current layout dimensions', () => {
  assert.deepEqual(resolveMobileViewportGeometry({
    ...base,
    visualWidth: 844,
    visualHeight: 390,
    visualOffsetTop: 12,
    visualOffsetLeft: 8,
  }), {
    width: 390,
    height: 844,
    offsetTop: 0,
    offsetLeft: 0,
    keyboardOffset: 0,
    keyboardActive: false,
  })
})
