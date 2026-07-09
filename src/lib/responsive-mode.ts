const MOBILE_NAVIGATION_MAX_WIDTH = 980

export function isMobileTouchViewport(maxWidth = MOBILE_NAVIGATION_MAX_WIDTH) {
  if (typeof window === 'undefined') return false
  if (!window.matchMedia(`(max-width: ${maxWidth}px)`).matches) return false
  return window.matchMedia('(any-pointer: coarse)').matches ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
}

export function isIOSLikeTouchViewport() {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform || ''
  const userAgent = navigator.userAgent || ''
  return /iP(?:ad|hone|od)/.test(platform)
    || /iP(?:ad|hone|od)/.test(userAgent)
    || (platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1)
}
