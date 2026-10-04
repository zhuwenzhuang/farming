import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalFocusScope } from '@/hooks/useModalFocusScope'
import { appPath } from '@/lib/base-path'
import { formatRelativeAge } from '@/lib/format'
import { agentSessionUpdatedAt } from './model'
import type { Agent } from '@/types/agent'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem } from './types'

export function isStoppedAgentResumeCandidate(agent: Agent, session: AgentSessionHistoryItem) {
  const workspace = agent.projectWorkspace || agent.cwd
  return Boolean(workspace && agent.providerSessionProvider && session && typeof session.id === 'string' && session.id && !session.archived
    && session.provider === agent.providerSessionProvider
    && (session.providerHomeId || 'default') === (agent.providerHomeId || 'default')
    && (session.workspace || session.cwd) === workspace)
}

interface ResumeStoppedAgentDialogProps {
  agent: Agent
  copy: CodeCopy
  onClose: () => void
  onResume: (session: AgentSessionHistoryItem) => void
}

export function ResumeStoppedAgentDialog(props: ResumeStoppedAgentDialogProps) {
  const { agent } = props
  return <ResumeStoppedAgentHistory key={JSON.stringify([
    agent.id, agent.providerSessionProvider, agent.providerHomeId || 'default', agent.projectWorkspace || agent.cwd,
  ])} {...props} />
}

function ResumeStoppedAgentHistory({ agent, copy, onClose, onResume }: ResumeStoppedAgentDialogProps) {
  // The outer key fences identity changes; ordinary Agent state updates must
  // not restart this fresh inventory read.
  const scopeAgent = useRef(agent).current
  const [request, setRequest] = useState({ cursor: '', attempt: 0 })
  const [sessions, setSessions] = useState<AgentSessionHistoryItem[]>([])
  const [nextCursor, setNextCursor] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const dialogRef = useModalFocusScope<HTMLElement>({
    open: true, initialFocusRef: cancelRef, returnFocusRef, onEscape: onClose, dismissOnPointerOutside: true,
  })

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    const timer = window.setTimeout(() => controller.abort(), 10_000)
    setLoading(true)
    setFailed(false)
    const query = new URLSearchParams({ limit: '1000' })
    if (request.cursor) query.set('cursor', request.cursor)
    else query.set('force', '1')
    void (async () => {
      try {
        const response = await fetch(appPath(`/api/agent-sessions?${query}`), {
          signal: controller.signal, cache: 'no-store',
        })
        if (!response.ok) throw new Error('History request failed')
        const page: { sessions?: AgentSessionHistoryItem[]; hasMore?: boolean; nextCursor?: string } = await response.json()
        if (!Array.isArray(page.sessions) || typeof page.hasMore !== 'boolean'
          || (page.hasMore && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === request.cursor))) {
          throw new Error('Invalid history page')
        }
        const candidates = page.sessions.filter(session => isStoppedAgentResumeCandidate(scopeAgent, session))
        if (disposed) return
        setSessions(previous => {
          const byId = new Map((request.cursor ? previous : []).map(session => [session.id, session]))
          for (const session of candidates) byId.set(session.id, session)
          return [...byId.values()]
        })
        setNextCursor(page.hasMore ? page.nextCursor! : '')
      } catch {
        if (!disposed) setFailed(true)
      } finally {
        window.clearTimeout(timer)
        if (!disposed) setLoading(false)
      }
    })()
    return () => {
      disposed = true
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [scopeAgent, request])

  return createPortal(
    <div className="code-brand-backdrop" data-testid="code-resume-stopped-dialog" role="presentation">
      <section ref={dialogRef} className="code-brand-dialog code-instance-name-dialog" role="dialog" aria-modal="true"
        aria-labelledby="code-resume-stopped-title" aria-describedby="code-resume-stopped-description"
        style={{ justifyItems: 'stretch', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto' }}>
        <h2 id="code-resume-stopped-title">{copy.resumeStoppedTitle}</h2>
        <p id="code-resume-stopped-description">{copy.resumeStoppedDescription}</p>
        <div className="code-history-list" aria-busy={loading}>
          {sessions.map(session => (
            <article key={session.id} className="code-history-card code-session">
              <button type="button" className="code-history-card-primary" data-testid="code-resume-stopped-candidate"
                data-session-id={session.id} aria-label={copy.resumeSessionAria(session.title || session.id)}
                onClick={() => onResume(session)}>
                <span className="code-history-card-copy">
                  <span className="code-history-card-title" title={session.title}>{session.title || session.id}</span>
                  <span className="code-history-meta" title={agentSessionUpdatedAt(session) ? new Date(agentSessionUpdatedAt(session)).toLocaleString() : undefined}>
                    {formatRelativeAge(agentSessionUpdatedAt(session), Date.now())}
                  </span>
                  <span className="code-history-meta" title={session.id} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{session.id}</span>
                </span>
              </button>
            </article>
          ))}
        </div>
        {loading && <p role="status">{copy.loading}</p>}
        {failed && <p className="code-instance-name-error" role="alert">{copy.resumeStoppedLoadFailed}</p>}
        {!loading && !failed && !nextCursor && sessions.length === 0 && <p>{copy.resumeStoppedEmpty}</p>}
        {nextCursor && !failed && <p>{copy.resumeStoppedIncomplete}</p>}
        <div className="code-dialog-actions">
          {failed && <button type="button" onClick={() => setRequest(value => ({ ...value, attempt: value.attempt + 1 }))}>{copy.retry}</button>}
          {!failed && nextCursor && <button type="button" disabled={loading} onClick={() => setRequest(value => ({ cursor: nextCursor, attempt: value.attempt + 1 }))}>{copy.resumeStoppedLoadMore}</button>}
          <button ref={cancelRef} type="button" onClick={onClose}>{copy.cancel}</button>
        </div>
      </section>
    </div>, document.body,
  )
}
