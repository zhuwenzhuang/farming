import { useEffect, useLayoutEffect, useRef } from 'react'
import { ChevronDownGlyph, ChevronUpGlyph, QuestionGlyph } from '@/components/IconGlyphs'
import type { AcpPendingElicitation } from '@/types/agent'
import type { CodeCopy } from '../copy'
import { AcpElicitationCard } from './AcpElicitationCard'
import {
  collapseQuestions, questionPresentation, reconcileQuestions, updateQuestionDraft,
  useQuestionPresentation, type ElicitationValues,
} from './acp-elicitation-presentation'

export type RespondToElicitation = (requestId: string, action: 'accept' | 'decline' | 'cancel', content?: ElicitationValues) => Promise<Response>

export function AcpElicitationPanel({ agentId, requests, running, onRespond, copy }: {
  agentId: string
  requests: AcpPendingElicitation[]
  running: boolean
  onRespond: RespondToElicitation
  copy: CodeCopy
}) {
  const presentation = useQuestionPresentation(agentId)
  const panelRef = useRef<HTMLElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)
  const previousReveal = useRef(presentation.reveal)
  useLayoutEffect(() => { reconcileQuestions(agentId, requests) }, [agentId, requests])
  useEffect(() => {
    if (presentation.reveal !== previousReveal.current) {
      previousReveal.current = presentation.reveal
      panelRef.current?.focus({ preventScroll: true })
    }
  }, [presentation.reveal])
  const later = () => {
    collapseQuestions(agentId, true)
    const target = expandRef.current
    requestAnimationFrame(() => {
      if (target?.isConnected && questionPresentation(agentId).collapsed) target.focus({ preventScroll: true })
    })
  }
  const respond = async (requestId: string, action: 'accept' | 'decline' | 'cancel', content?: ElicitationValues) => {
    const current = questionPresentation(agentId).requests[requestId]
    if (!current || current.status) return
    updateQuestionDraft(agentId, requestId, { status: 'submitting', error: '' })
    try {
      const response = await onRespond(requestId, action, content)
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null
        const uncertain = response.status >= 500 || response.status === 409
        updateQuestionDraft(agentId, requestId, {
          status: uncertain ? 'uncertain' : undefined,
          error: uncertain ? copy.questionUncertain : payload?.error || copy.questionFailed,
        })
      } else {
        updateQuestionDraft(agentId, requestId, { status: 'submitted' })
      }
    } catch {
      updateQuestionDraft(agentId, requestId, { status: 'uncertain', error: copy.questionUncertain })
    }
  }
  if (!requests.length) return null
  const busy = Object.values(presentation.requests).some(request => request.status === 'submitting')
  return (
    <section ref={panelRef} className="code-acp-questions" data-testid="code-acp-questions" tabIndex={-1} aria-label={copy.questionCount(requests.length)}>
      <header className="code-acp-questions-header">
        <QuestionGlyph />
        <span>{copy.questionCount(requests.length)}</span>
        {running ? <small data-testid="code-acp-questions-running">{copy.questionRunning}</small> : null}
        <button ref={expandRef} type="button" className="code-acp-questions-toggle" aria-expanded={!presentation.collapsed}
          aria-label={presentation.collapsed ? copy.questionExpand : copy.questionCollapse}
          disabled={busy} onClick={() => collapseQuestions(agentId, !presentation.collapsed)}>
          {presentation.collapsed ? <><span>{copy.questionExpand}</span><ChevronDownGlyph /></> : <ChevronUpGlyph />}
        </button>
      </header>
      <div className="code-acp-questions-body" hidden={presentation.collapsed}>
        {requests.map(request => <AcpElicitationCard key={request.requestId} request={request} copy={copy}
          draft={presentation.requests[request.requestId]}
          onValuesChange={values => updateQuestionDraft(agentId, request.requestId, { values })}
          onLater={later} onRespond={(id, action, content) => { void respond(id, action, content) }} />)}
      </div>
    </section>
  )
}
