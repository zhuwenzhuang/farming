import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserViewerKeyboard, BrowserViewerClicks } from '../extensions/browser/frontend/browser-viewer-keyboard'
import { isBrowserViewerInputMessage } from '../shared/browser-viewer-input'

const event = (key: string, code: string, patch = {}) => ({
  key, code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
  repeat: false, location: 0, ...patch,
})

test('preserves physical release identity after modifiers change and clears on focus loss', () => {
  const keyboard = new BrowserViewerKeyboard()
  assert.deepEqual(keyboard.key(event('>', 'Period', { shiftKey: true }), 'down'), {
    type: 'key', action: 'down', key: '>', code: 'Period', modifiers: 8, repeat: false, location: 0, text: '>',
  })
  assert.equal(keyboard.key(event('.', 'Period'), 'up')?.type, 'key')
  keyboard.key(event('Shift', 'ShiftLeft'), 'down')
  keyboard.reset()
  assert.equal(keyboard.key(event('Shift', 'ShiftLeft'), 'up'), null)
})

test('forwards selection chords and repeat without duplicate committed text', () => {
  const keyboard = new BrowserViewerKeyboard()
  const key = keyboard.key(event('ArrowLeft', 'ArrowLeft', { shiftKey: true, repeat: true }), 'down')
  assert.equal(key?.type, 'key')
  if (key?.type === 'key') {
    assert.equal(key.modifiers, 8)
    assert.equal(key.repeat, true)
    assert.equal(key.text, '')
  }
  assert.equal(keyboard.key(event('Process', '', { isComposing: true }), 'down'), null)
  assert.equal(keyboard.key(event('Dead', 'Quote'), 'down'), null)
  for (const key of ['c', 'x', 'v']) assert.equal(keyboard.key(event(key, `Key${key.toUpperCase()}`, { metaKey: true }), 'down'), null)
})

test('recognizes repeated clicks and resets for a different point or button', () => {
  const clicks = new BrowserViewerClicks()
  assert.equal(clicks.down(0, 10, 10, 10), 1)
  assert.equal(clicks.down(0, 11, 10, 200), 2)
  assert.equal(clicks.down(0, 11, 10, 300), 3)
  assert.equal(clicks.down(0, 30, 10, 400), 1)
  assert.equal(clicks.down(2, 30, 10, 410), 1)
})

test('rejects malformed Viewer input at the protocol boundary', () => {
  for (const input of [null, { type: 'shell' }, { type: 'key', key: 'a', modifiers: 16 },
    { type: 'pointer', action: 'down', x: NaN, y: 0 }, { type: 'text', text: {} },
    { type: 'clipboard', operation: 'cut', requestId: '1' }]) {
    assert.equal(isBrowserViewerInputMessage(input), false)
  }
  assert.equal(isBrowserViewerInputMessage({ type: 'key', key: 'Home', action: 'down' }), true)
  assert.equal(isBrowserViewerInputMessage({ type: 'reset-input' }), true)
})
