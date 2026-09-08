import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'

/** Presentation only: the existing draft, textarea and submit owner stay intact. */
export function useComposerExpandedEditor({ agentId, enabled, textareaRef, composerRef }: {
  agentId: string
  enabled: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  composerRef: RefObject<HTMLElement | null>
}) {
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null)
  const expanded = enabled && expandedAgentId === agentId
  const position = useRef<{ start: number; end: number; direction: 'forward' | 'backward' | 'none'; top: number } | null>(null)

  useLayoutEffect(() => { setExpandedAgentId(null) }, [agentId, enabled])

  function toggle() {
    const textarea = textareaRef.current
    if (!textarea) return
    position.current = {
      start: textarea.selectionStart, end: textarea.selectionEnd,
      direction: textarea.selectionDirection, top: textarea.scrollTop,
    }
    setExpandedAgentId(expanded ? null : agentId)
    // Keep focus within the original user gesture so iOS keeps the keyboard.
    textarea.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    const saved = position.current
    position.current = null
    if (!textarea || !saved) return
    textarea.setSelectionRange(saved.start, saved.end, saved.direction)
    textarea.scrollTop = saved.top
  }, [expanded, textareaRef])

  useInteractionLayer({
    enabled: expanded,
    elements: () => [composerRef.current],
    dismissOnPointerOutside: false,
    onDismiss: toggle,
    returnFocus: () => textareaRef.current,
  })

  return { expanded, toggle }
}
