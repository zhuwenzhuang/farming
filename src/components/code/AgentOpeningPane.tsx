import { useLayoutEffect, useRef } from 'react'
import { ArrowLeftGlyph } from '@/components/IconGlyphs'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import type { CodeCopy } from './copy'
import type { AgentOpeningState } from './useAgentOpeningController'

export function AgentOpeningPane({ state, copy, onBack, onRetry, onCheck }: {
  state: AgentOpeningState
  copy: CodeCopy
  onBack: () => void
  onRetry: () => void
  onCheck: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const surface = useRef<HTMLElement>(null)
  const ready = state.phase === 'ready'
  const failed = state.phase === 'failed'
  useInteractionLayer({ enabled: !ready, elements: () => [surface.current], onDismiss: onBack, dismissOnPointerOutside: false })
  useLayoutEffect(() => {
    if (!ready) heading.current?.focus({ preventScroll: true })
  }, [state.intent, ready])
  if (ready && state.target.source === 'projects') return null
  return (
    <section ref={surface} className={`code-agent-opening ${ready ? 'ready' : ''}`} data-testid="code-agent-opening" data-phase={state.phase}>
      <header className="code-agent-opening-header">
        <button type="button" className="code-side-view-back with-label" onClick={onBack} data-testid="code-agent-opening-back">
          <ArrowLeftGlyph />
          <span>{copy.back}{state.target.source === 'search' ? ` · ${copy.search}` : state.target.source === 'history' ? ` · ${copy.history}` : ''}</span>
        </button>
      </header>
      {!ready && <div className="code-agent-opening-body">
        <h2 ref={heading} tabIndex={-1}>{state.target.title}</h2>
        <p className="code-agent-opening-identity">{state.target.workspace}</p>
        {state.target.identity && <p className="code-agent-opening-identity">{state.target.identity.provider} · {state.target.identity.providerHomeId || 'default'} · {state.target.identity.sessionId}</p>}
        <div role={failed ? 'alert' : 'status'} aria-live="polite" className="code-agent-opening-status">
          <strong>{failed ? copy.agentOpeningFailed : state.phase === 'checking' ? copy.agentOpeningChecking : state.phase === 'waiting' ? copy.agentOpeningWaiting : copy.agentOpeningResume}</strong>
          {failed && <>
            {state.uncertain && <p>{copy.agentOpeningUncertain}</p>}
            {state.message && <p>{state.message}</p>}
            <button type="button" onClick={state.uncertain ? onCheck : onRetry} className="code-feedback-action">
              {state.uncertain ? copy.agentOpeningCheck : copy.retry}
            </button>
          </>}
        </div>
        <p className="code-agent-opening-note">{copy.agentOpeningLeaveNote}</p>
      </div>}
    </section>
  )
}
