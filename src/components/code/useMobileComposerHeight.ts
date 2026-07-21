import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import { isCompactViewport } from '@/lib/responsive-mode'

export function useMobileComposerHeight(composerRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const composer = composerRef.current
    if (!composer) return undefined
    const main = composer.closest('.code-main') as HTMLElement | null
    const clear = () => {
      composer.style.removeProperty('--mobile-composer-current-height')
      main?.style.removeProperty('--mobile-composer-current-height')
    }
    const publish = () => {
      if (!isCompactViewport()) {
        clear()
        return
      }
      const height = composer.getBoundingClientRect().height
      if (height <= 0) return
      const value = `${Math.ceil(height)}px`
      composer.style.setProperty('--mobile-composer-current-height', value)
      main?.style.setProperty('--mobile-composer-current-height', value)
    }

    publish()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    observer?.observe(composer)
    window.addEventListener('resize', publish)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', publish)
      clear()
    }
  }, [composerRef])
}
