// Keep Code CSS media queries aligned with this shared layout policy.
// Mouse-driven windows retain desktop navigation until they are phone-width.
export const COMPACT_VIEWPORT_QUERY = '(max-width: 767px), (max-width: 980px) and (pointer: coarse)'

export function isCompactViewport() {
  if (typeof window === 'undefined') return false
  return window.matchMedia(COMPACT_VIEWPORT_QUERY).matches
}

export function isTouchInputViewport() {
  if (typeof window === 'undefined') return false
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
