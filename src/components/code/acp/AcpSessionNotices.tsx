import { useState } from 'react'
import { CloseGlyph } from '@/components/IconGlyphs'
import { appPath } from '@/lib/base-path'
import type { AcpNotice } from '../../../../shared/acp-notice'
import type { CodeCopy } from '../copy'

function SessionNotice({ notice, agentId, sessionId, copy, onKeyboardDismiss }: {
  notice: AcpNotice; agentId: string; sessionId: string; copy: CodeCopy
  onKeyboardDismiss?: () => void
}) {
  const [pending, setPending] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState('')
  if (dismissed) return null
  const severity = ['warning', 'error'].includes(notice.severity) ? notice.severity : 'info'
  return (
    <section className={`code-acp-feedback code-acp-notice ${severity}`} data-testid="code-acp-notice"
      data-severity={notice.severity} role={severity === 'info' ? 'status' : 'alert'}>
      <div className="code-acp-notice-content">
        <p><strong>{notice.title}</strong></p>
        {notice.description ? <p>{notice.description}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <button type="button" className="code-agent-transcript-subagent-control" disabled={pending}
        aria-label={`${copy.close}: ${notice.title}`} onClick={event => {
          // Return keyboard users to their reading/input surface immediately.
          // Async confirmation must never steal focus from a later interaction.
          if (event.detail === 0) onKeyboardDismiss?.()
          setPending(true)
          setError('')
          void fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/acp-notices/${encodeURIComponent(sessionId)}/${encodeURIComponent(notice.id)}`), {
            method: 'DELETE', signal: AbortSignal.timeout(15000),
          }).then(async response => {
            if (!response.ok) throw new Error(copy.sessionNoticeDismissFailed)
            setDismissed(true)
          }).catch(() => setError(copy.sessionNoticeDismissFailed)).finally(() => setPending(false))
        }}><CloseGlyph /></button>
    </section>
  )
}

export function AcpSessionNotices({ notices, agentId, sessionId, copy, onKeyboardDismiss }: {
  notices?: AcpNotice[]; agentId: string; sessionId: string; copy: CodeCopy
  onKeyboardDismiss?: () => void
}) {
  if (!notices?.length) return null
  return <div className="code-acp-notices" data-testid="code-acp-notices">
    {notices.map(notice => <SessionNotice key={notice.id} notice={notice} agentId={agentId} sessionId={sessionId} copy={copy} onKeyboardDismiss={onKeyboardDismiss} />)}
  </div>
}
