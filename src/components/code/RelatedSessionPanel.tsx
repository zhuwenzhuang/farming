import { useEffect, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { CloseGlyph } from '@/components/IconGlyphs'
import { AgentTranscriptSubagentPreview } from './AgentTranscriptPane'
import { projectAcpTranscript, type AgentTranscript } from './acp/acp-entry-projection'
import type { RelatedSessionTarget } from './related-session-navigation'
import { codeCopyForLanguage } from './copy'

export function RelatedSessionPanel({ target, refreshSignal, onClose, language }: {
  target: RelatedSessionTarget
  refreshSignal: number
  onClose: () => void
  language: string
}) {
  const [transcript, setTranscript] = useState<AgentTranscript | null>(null)
  const [error, setError] = useState('')
  const [limit, setLimit] = useState(24)
  const [readVersion, setReadVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const epochRef = useRef(target.runtimeEpoch || '')
  const closeRef = useRef<HTMLButtonElement>(null)
  const chinese = language === 'zh-CN' || language === 'zh'
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }) }, [])
  const refreshRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (target.readable === false) {
      setLoading(false)
      setError(chinese ? '此 Provider 未提供子会话内容读取能力。' : 'This provider does not expose the subagent transcript.')
      return
    }
    let current = true
    let pending = false
    let reading = false
    let controller: AbortController | null = null
    const refresh = async () => {
      pending = true
      if (reading) return
      reading = true
      while (current && pending) {
        pending = false
        controller = new AbortController()
        const request = controller
        const deadline = window.setTimeout(() => request.abort(), 15000)
        setLoading(true)
        try {
          const response = await fetch(appPath(`/api/agents/${encodeURIComponent(target.parentAgentId)}/acp-subagents/${encodeURIComponent(target.sessionId)}/transcript?maxTurns=${limit}&runtimeEpoch=${encodeURIComponent(epochRef.current)}`), { signal: request.signal })
          const payload = await response.json()
          if (!response.ok) throw new Error(payload.error || 'Subagent transcript unavailable')
          if (!epochRef.current && typeof payload.parentRuntimeEpoch === 'string') epochRef.current = payload.parentRuntimeEpoch
          const next = projectAcpTranscript(payload, { maxTurns: limit })
          if (next.sessionId !== target.sessionId) throw new Error('Subagent identity changed during read')
          if (current) { setTranscript(next); setError('') }
        } catch (caught) {
          if (current) setError(request.signal.aborted
            ? (chinese ? '读取超时，请重试。' : 'Read timed out. Try again.')
            : caught instanceof Error ? caught.message : String(caught))
          // Failure is terminal for this read. New evidence or explicit Retry
          // can request another read; do not spin on a pending refresh.
          pending = false
        } finally {
          window.clearTimeout(deadline)
        }
      }
      reading = false
      if (current) setLoading(false)
    }
    refreshRef.current = () => { void refresh() }
    void refresh()
    return () => {
      current = false
      refreshRef.current = null
      controller?.abort()
    }
  }, [target.parentAgentId, target.sessionId, target.runtimeEpoch, target.readable, limit, chinese])
  useEffect(() => { refreshRef.current?.() }, [refreshSignal, readVersion])
  return (
    <aside className="code-related-session-panel" data-testid="code-related-session-panel" aria-label={target.title}>
      <header className="code-related-session-header">
        <strong title={target.title}>{target.title}</strong>
        <button ref={closeRef} type="button" className="code-agent-transcript-subagent-control"
          onClick={onClose} aria-label={chinese ? '收起关联会话' : 'Collapse related session'}>
          <CloseGlyph />
        </button>
      </header>
      <div className="code-related-session-content" aria-busy={loading}>
        {error ? <div role="alert">{error} <button type="button" onClick={() => setReadVersion(value => value + 1)}>{chinese ? '重试' : 'Retry'}</button></div> : null}
        {!transcript && loading ? <div role="status">{chinese ? '加载中…' : 'Loading…'}</div> : null}
        {transcript?.hasMoreBefore && limit < 200 ? <button type="button" disabled={loading} onClick={() => setLimit(value => Math.min(200, value + 24))}>{chinese ? '加载更早消息' : 'Load earlier messages'}</button> : null}
        {transcript ? <AgentTranscriptSubagentPreview transcript={transcript} copy={codeCopyForLanguage(chinese ? 'zh' : 'en')} docked onStop={async () => {
          const response = await fetch(appPath(`/api/agents/${encodeURIComponent(target.parentAgentId)}/acp-subagents/${encodeURIComponent(target.sessionId)}/cancel?runtimeEpoch=${encodeURIComponent(epochRef.current)}`), { method: 'POST', signal: AbortSignal.timeout(15000) })
          if (!response.ok) { const payload = await response.json(); throw new Error(payload.error || 'Subagent stop failed') }
          setReadVersion(value => value + 1)
        }} /> : null}
      </div>
    </aside>
  )
}
