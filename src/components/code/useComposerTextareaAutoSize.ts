import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

function resizeComposerTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto'
  const styles = window.getComputedStyle(textarea)
  const minHeight = Number.parseFloat(styles.minHeight) || 0
  const maxHeight = Number.parseFloat(styles.maxHeight) || Number.POSITIVE_INFINITY
  const height = Math.min(maxHeight, Math.max(minHeight, textarea.scrollHeight))
  textarea.style.height = `${Math.ceil(height)}px`
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
}

export function useComposerTextareaAutoSize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return undefined
    const resize = () => resizeComposerTextarea(textarea)
    resize()
    let observedWidth = textarea.getBoundingClientRect().width
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? textarea.getBoundingClientRect().width
      if (Math.abs(width - observedWidth) < 0.5) return
      observedWidth = width
      resize()
    })
    observer?.observe(textarea)
    window.addEventListener('resize', resize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      textarea.style.removeProperty('height')
      textarea.style.removeProperty('overflow-y')
    }
  }, [textareaRef, value])
}
