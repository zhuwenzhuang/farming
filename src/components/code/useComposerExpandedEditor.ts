import { useComposerSubmission } from './composer-submission-state'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'

/** Presentation only: the existing draft, textarea and submit owner stay intact. */
export function useComposerExpandedEditor({ agentId, enabled, textareaRef, composerRef }: {
  agentId: string
  enabled: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  composerRef: RefObject<HTMLElement | null>
}) {
  const submission = useComposerSubmission(agentId)
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null)
  const expanded = enabled && expandedAgentId === agentId
  const pendingAgents = useRef(new Set<string>())
  const [submittingAgents, setSubmittingAgents] = useState(new Set<string>())
  const presentationRevision = useRef(0)
  const position = useRef<{ start: number; end: number; direction: 'forward' | 'backward' | 'none'; top: number } | null>(null)

  useLayoutEffect(() => { presentationRevision.current += 1; setExpandedAgentId(null) }, [agentId, enabled])

  function toggle() {
    presentationRevision.current += 1
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

  function submit(action: () => boolean | Promise<boolean>) {
    if (pendingAgents.current.has(agentId) || submission) return
    const revision = presentationRevision.current
    const submittedDraft = textareaRef.current?.value
    const accepted = (result: boolean) => {
      if (!result || presentationRevision.current !== revision) return
      const currentDraft = textareaRef.current?.value
      if (currentDraft && currentDraft !== submittedDraft) return
      setExpandedAgentId(null)
    }
    const result = action()
    if (typeof result === 'boolean') accepted(result)
    else {
      pendingAgents.current.add(agentId)
      setSubmittingAgents(new Set(pendingAgents.current))
      const settled = () => {
        pendingAgents.current.delete(agentId)
        setSubmittingAgents(new Set(pendingAgents.current))
      }
      void result.then(value => { accepted(value); settled() }, settled)
    }
  }

  return {
    expanded,
    toggle,
    submit,
    submissionPhase: submission?.phase,
    submitting: Boolean(submission) || submittingAgents.has(agentId),
  }
}
