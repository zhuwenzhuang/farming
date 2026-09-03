export interface MobileViewportGeometryInput {
  visualWidth: number
  visualHeight: number
  visualOffsetTop: number
  visualOffsetLeft: number
  layoutWidth: number
  layoutHeight: number
  compact: boolean
  touch: boolean
}

export interface MobileViewportGeometry {
  width: number
  height: number
  offsetTop: number
  offsetLeft: number
  keyboardOffset: number
  keyboardActive: boolean
}

export function resolveMobileViewportGeometry({
  visualWidth: rawVisualWidth,
  visualHeight: rawVisualHeight,
  visualOffsetTop: rawOffsetTop,
  visualOffsetLeft: rawOffsetLeft,
  layoutWidth,
  layoutHeight,
  compact,
  touch,
}: MobileViewportGeometryInput): MobileViewportGeometry {
  const orientationMismatch = (layoutWidth > layoutHeight) !== (rawVisualWidth > rawVisualHeight)
  const directDimensionDelta = Math.abs(layoutWidth - rawVisualWidth) + Math.abs(layoutHeight - rawVisualHeight)
  const rotatedDimensionDelta = Math.abs(layoutWidth - rawVisualHeight) + Math.abs(layoutHeight - rawVisualWidth)
  const staleRotatedVisualViewport = orientationMismatch && rotatedDimensionDelta < directDimensionDelta
  const visualWidth = staleRotatedVisualViewport ? layoutWidth : rawVisualWidth
  const visualHeight = staleRotatedVisualViewport ? layoutHeight : rawVisualHeight
  const visualOffsetTop = staleRotatedVisualViewport ? 0 : rawOffsetTop
  const visualOffsetLeft = staleRotatedVisualViewport ? 0 : rawOffsetLeft
  const keyboardOffset = Math.max(0, layoutHeight - visualHeight - visualOffsetTop)
  const keyboardActive = compact && touch && keyboardOffset > 80

  return {
    width: Math.min(visualWidth, Math.max(0, layoutWidth - visualOffsetLeft)),
    // Every compact surface stays in VisualViewport coordinates. Extending a
    // standalone root to screen.height gives it plausible DOM geometry, but
    // WebKit still clips painting at the native viewport boundary. A minimum
    // height would likewise place the Composer under tall input UI.
    height: Math.max(1, visualHeight),
    offsetTop: visualOffsetTop,
    offsetLeft: visualOffsetLeft,
    keyboardOffset,
    keyboardActive,
  }
}
