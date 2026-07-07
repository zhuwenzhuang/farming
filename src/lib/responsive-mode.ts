const MOBILE_NAVIGATION_MAX_WIDTH = 980

export function isMobileTouchViewport(maxWidth = MOBILE_NAVIGATION_MAX_WIDTH) {
  if (typeof window === 'undefined') return false
  if (!window.matchMedia(`(max-width: ${maxWidth}px)`).matches) return false
  return window.matchMedia('(any-pointer: coarse)').matches ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
}
