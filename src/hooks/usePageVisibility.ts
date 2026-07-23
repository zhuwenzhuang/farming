import { useEffect, useState } from 'react'
import { reducePageVisibilitySnapshot } from '../../shared/backend-connection-status.js'

export function isPageVisible() {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

export function usePageVisibilitySnapshot() {
  const [snapshot, setSnapshot] = useState(() => {
    const visible = isPageVisible()
    return {
      visible,
      visibleSince: visible ? Date.now() : 0,
    }
  })

  useEffect(() => {
    const updateVisibility = (event: Event) => {
      const changedAt = Date.now()
      setSnapshot(current => reducePageVisibilitySnapshot(current, {
        eventType: event.type,
        documentVisible: isPageVisible(),
        changedAt,
      }))
    }
    document.addEventListener('visibilitychange', updateVisibility)
    window.addEventListener('pagehide', updateVisibility)
    window.addEventListener('pageshow', updateVisibility)
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility)
      window.removeEventListener('pagehide', updateVisibility)
      window.removeEventListener('pageshow', updateVisibility)
    }
  }, [])

  return snapshot
}

export function usePageVisibility() {
  return usePageVisibilitySnapshot().visible
}
