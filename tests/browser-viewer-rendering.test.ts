import assert from 'node:assert/strict'
import test from 'node:test'
import { applyBrowserViewerCanvasSize } from '../extensions/browser/frontend/browser-viewer-rendering'

test('does not rewrite an unchanged Browser Viewer canvas size', () => {
  let widthWrites = 0
  let heightWrites = 0
  const target = {
    currentWidth: 1280,
    currentHeight: 720,
    style: { width: '1280px', height: '720px' },
    get width() { return this.currentWidth },
    set width(value: number) { widthWrites += 1; this.currentWidth = value },
    get height() { return this.currentHeight },
    set height(value: number) { heightWrites += 1; this.currentHeight = value },
  }

  const changed = applyBrowserViewerCanvasSize(target, 1280, 720, { width: 1280, height: 720 })

  assert.equal(changed, false)
  assert.equal(widthWrites, 0)
  assert.equal(heightWrites, 0)
})

test('updates backing and display size when the Browser viewport changes', () => {
  const target = {
    width: 800,
    height: 600,
    style: { width: '800px', height: '600px' },
  }

  const changed = applyBrowserViewerCanvasSize(target, 1600, 1200, { width: 1000, height: 750 })

  assert.equal(changed, true)
  assert.deepEqual(target, {
    width: 1600,
    height: 1200,
    style: { width: '1000px', height: '750px' },
  })
})
