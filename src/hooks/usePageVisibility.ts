import { useEffect, useState } from 'react'

export function isPageVisible() {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

export function usePageVisibility() {
  const [pageVisible, setPageVisible] = useState(isPageVisible)

  useEffect(() => {
    const updateVisibility = () => setPageVisible(isPageVisible())
    document.addEventListener('visibilitychange', updateVisibility)
    window.addEventListener('pagehide', updateVisibility)
    window.addEventListener('pageshow', updateVisibility)
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility)
      window.removeEventListener('pagehide', updateVisibility)
      window.removeEventListener('pageshow', updateVisibility)
    }
  }, [])

  return pageVisible
}
