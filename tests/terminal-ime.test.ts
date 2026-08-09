import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalImeOverlayStyle } from '../src/lib/terminal-ime'

test('leaves the DOM owner to ignore missing cursor or renderer metrics', () => {
  assert.equal(terminalImeOverlayStyle(null, { width: 9, height: 19 }, 15, 'Farming Mono'), null)
  assert.equal(terminalImeOverlayStyle({ x: 4, y: 3 }, undefined, 15, 'Farming Mono'), null)
})

test('positions the IME overlay at the renderer cursor and preserves its style policy', () => {
  assert.deepEqual(terminalImeOverlayStyle(
    { x: 4, y: 3 },
    { width: 9, height: 19 },
    15,
    'Farming Mono',
  ), {
    position: 'absolute',
    left: '36px',
    top: '57px',
    width: '120px',
    height: '19px',
    lineHeight: '19px',
    fontSize: '15px',
    fontFamily: 'Farming Mono',
    padding: '0',
    margin: '0',
    border: '0',
    outline: '0',
    background: 'transparent',
    clipPath: 'none',
    overflow: 'hidden',
    whiteSpace: 'pre',
    resize: 'none',
  })
})

test('clamps cursor geometry at the visible origin and keeps the minimum composition width', () => {
  const style = terminalImeOverlayStyle(
    { x: -2, y: -1 },
    { width: 11, height: 12 },
    16,
    'Farming Mono',
  )

  if (!style) throw new Error('expected an overlay style')
  assert.equal(style.left, '0px')
  assert.equal(style.top, '0px')
  assert.equal(style.width, '120px')
  assert.equal(style.height, '18px')
  assert.equal(style.lineHeight, '18px')
})

test('uses renderer row height when it exceeds the font fallback', () => {
  const style = terminalImeOverlayStyle(
    { x: 1, y: 1 },
    { width: 20, height: 28 },
    16,
    'Farming Mono',
  )

  if (!style) throw new Error('expected an overlay style')
  assert.equal(style.width, '160px')
  assert.equal(style.height, '28px')
  assert.equal(style.lineHeight, '28px')
  assert.equal(style.fontSize, '16px')
})

test('retains the existing numeric fallback behavior for malformed renderer measurements', () => {
  const style = terminalImeOverlayStyle(
    { x: 1, y: 1 },
    { width: Number.NaN, height: Number.NaN },
    14,
    'Farming Mono',
  )

  if (!style) throw new Error('expected an overlay style')
  assert.equal(style.left, 'NaNpx')
  assert.equal(style.top, 'NaNpx')
  assert.equal(style.width, 'NaNpx')
  assert.equal(style.height, 'NaNpx')
  assert.equal(style.lineHeight, 'NaNpx')
})
