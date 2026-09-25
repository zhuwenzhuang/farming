import { useLayoutEffect, useRef } from 'react'
import { ChevronDownGlyph, QuestionGlyph } from '@/components/IconGlyphs'
import type { AcpPendingElicitation } from '@/types/agent'
import type { CodeCopy } from '../copy'
import { AcpElicitationCard } from './AcpElicitationCard'
import {
  questionPresentation, reconcileQuestions, updateQuestionDraft,
  useQuestionPresentation, type ElicitationValues,
} from './acp-elicitation-presentation'

export type RespondToElicitation = (requestId: string, action: 'accept' | 'decline' | 'cancel', content?: ElicitationValues) => Promise<Response>

export function AcpElicitationPanel({ agentId, requests, requestId, running, onRespond, copy }: {
  agentId: string
  requests: AcpPendingElicitation[]
  requestId: string
  running: boolean
  onRespond: RespondToElicitation
  copy: CodeCopy
}) {
  const presentation = useQuestionPresentation(agentId)
  const expandRef = useRef<HTMLButtonElement>(null)
  const collapsed = presentation.requests[requestId]?.collapsed === true
  const request = requests.find(candidate => candidate.requestId === requestId)
  useLayoutEffect(() => { reconcileQuestions(agentId, requests) }, [agentId, requests])
  const later = () => {
    updateQuestionDraft(agentId, requestId, { collapsed: true })
    const target = expandRef.current
    requestAnimationFrame(() => {
      if (target?.isConnected && questionPresentation(agentId).requests[requestId]?.collapsed) target.focus({ preventScroll: true })
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
  if (!request) return null
  const busy = Object.values(presentation.requests).some(request => request.status === 'submitting')
  return (
    <section className="code-acp-questions" data-testid="code-acp-questions" tabIndex={-1} aria-label={copy.questionCount(1)}>
      <header className="code-acp-questions-header" hidden={!collapsed}>
        <QuestionGlyph />
        <span>{request.message}</span>
        {running ? <small data-testid="code-acp-questions-running">{copy.questionRunning}</small> : null}
        <button ref={expandRef} type="button" className="code-acp-questions-toggle" aria-expanded={!collapsed}
          aria-label={collapsed ? copy.questionExpand : copy.questionCollapse}
          disabled={busy} onClick={() => updateQuestionDraft(agentId, requestId, { collapsed: false })}>
          <span>{copy.questionExpand}</span><ChevronDownGlyph />
        </button>
      </header>
      <div className="code-acp-questions-body" hidden={collapsed}>
        <AcpElicitationCard key={request.requestId} request={request} copy={copy}
          draft={presentation.requests[request.requestId]}
          onDetailsChange={detailsExpanded => updateQuestionDraft(agentId, request.requestId, { detailsExpanded })}
          onValuesChange={values => updateQuestionDraft(agentId, request.requestId, { values })}
          onLater={later} onRespond={(id, action, content) => { void respond(id, action, content) }} />
      </div>
    </section>
  )
}
