export interface BrowserViewerCanvasTarget {
  height: number
  style: { height: string; width: string }
  width: number
}

export function applyBrowserViewerCanvasSize(
  canvas: BrowserViewerCanvasTarget,
  frameWidth: number,
  frameHeight: number,
  viewport: { width: number; height: number },
): boolean {
  let changed = false
  if (canvas.width !== frameWidth) {
    canvas.width = frameWidth
    changed = true
  }
  if (canvas.height !== frameHeight) {
    canvas.height = frameHeight
    changed = true
  }
  const cssWidth = `${viewport.width}px`
  const cssHeight = `${viewport.height}px`
  if (canvas.style.width !== cssWidth) {
    canvas.style.width = cssWidth
    changed = true
  }
  if (canvas.style.height !== cssHeight) {
    canvas.style.height = cssHeight
    changed = true
  }
  return changed
}
