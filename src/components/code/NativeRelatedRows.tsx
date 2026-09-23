import { ChevronRightGlyph } from '@/components/IconGlyphs'
import { AgentStatusIndicator } from './AgentStatusIndicator'
import type { CodeCopy } from './copy'
import { relatedSessionStatusLabel, relatedSessionFinished, relatedSessionIndicator } from './related-session-status'
import { useEffect, useRef, useState } from 'react'
import type { Agent } from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { isAcpRuntime } from '@/lib/agent-runtime'
import { CollaborationAgentIcon } from './CollaborationAgentIcon'
import type { RelatedSessionTarget } from './related-session-navigation'

type Inventory = { parentSessionKey: string; runtimeEpoch: string; children: Array<{ sessionId: string; title: string; state: string; stopReason?: string; readable: boolean }> }
export function NativeRelatedRows({ parent, active, selected, onOpen, copy, onChildrenSessionChange }: {
  copy: CodeCopy; parent: Agent; active: boolean; selected: RelatedSessionTarget | null; onOpen: (target: RelatedSessionTarget) => void
  onChildrenSessionChange: (sessionKey: string | null) => void
}) {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [error, setError] = useState('')
  const [visibleCount, setVisibleCount] = useState(6)
  const [finishedCount, setFinishedCount] = useState(6)
  const refreshRef = useRef<(() => void) | null>(null)
  const readable = isAcpRuntime(parent) && Boolean(parent.providerSessionKey)
    && ['idle', 'working', 'waiting-for-permission', 'waiting-for-input', 'interrupting'].includes(parent.runtimeBinding.state)
  const lastRevisionRef = useRef(0)
  const revision = isAcpRuntime(parent) ? parent.runtimeBinding.sessionRevision : 0
  const revisionRef = useRef(revision)
  revisionRef.current = revision
  useEffect(() => {
    onChildrenSessionChange(inventory && inventory.parentSessionKey === parent.providerSessionKey && inventory.children.length
      ? inventory.parentSessionKey : null)
  }, [inventory, parent.providerSessionKey, onChildrenSessionChange])
  useEffect(() => {
    setError('')
    if (!active || !readable) return
    lastRevisionRef.current = revisionRef.current
    let current = true
    let dirty = false
    let running = false
    let request: AbortController | null = null
    const refresh = async () => {
      dirty = true
      if (running) return
      running = true
      while (current && dirty) {
        dirty = false
        request = new AbortController()
        const deadline = setTimeout(() => request?.abort(), 15000)
        try {
          const response = await fetch(appPath(`/api/agents/${encodeURIComponent(parent.id)}/related-sessions`), { signal: request.signal })
          const payload = await response.json()
          if (!response.ok) throw new Error(payload.error || 'Related sessions unavailable')
          if (payload.parentSessionKey !== parent.providerSessionKey) throw new Error('Parent identity changed')
          if (current) { setInventory(payload); setError('') }
        } catch (caught) {
          if (current) setError(caught instanceof Error ? caught.message : String(caught))
          dirty = false
        } finally { clearTimeout(deadline) }
      }
      running = false
    }
    refreshRef.current = () => { void refresh() }
    void refresh()
    return () => { current = false; request?.abort(); refreshRef.current = null }
  // Runtime revisions request a serial refresh below; they never abort a read.
  }, [parent.id, parent.providerSessionKey, active, readable])
  useEffect(() => {
    if (!active || !readable || lastRevisionRef.current === revision) return
    lastRevisionRef.current = revision
    refreshRef.current?.()
  }, [revision, active, readable])
  if (!inventory || inventory.parentSessionKey !== parent.providerSessionKey) return error && active && readable
    ? <button type="button" className="code-agent-row related-child" data-testid="code-related-inventory-error" onClick={() => refreshRef.current?.()} title={error}>Related sessions unavailable · Retry</button> : null
  const isSelected = (child: Inventory['children'][number]) => selected?.parentAgentId === parent.id
    && selected.parentSessionKey === parent.providerSessionKey && !selected.subagentSessionKey && selected.sessionId === child.sessionId
  const current = inventory.children.filter(child => !relatedSessionFinished(child.state) || isSelected(child))
  const finished = inventory.children.filter(child => relatedSessionFinished(child.state) && !isSelected(child))
  const renderChild = (child: Inventory['children'][number]) => <button type="button" key={`${inventory.runtimeEpoch}:${child.sessionId}`}
      className={`code-agent-row related-child ${selected?.parentAgentId === parent.id && selected.sessionId === child.sessionId && !selected.subagentSessionKey ? 'active' : ''}`}
      data-testid="code-native-related-row" aria-label={`${child.title} · ${relatedSessionStatusLabel(child.state, copy, child.stopReason)}`} title={`${child.title} · ${relatedSessionStatusLabel(child.state, copy, child.stopReason)}`}
      onClick={() => onOpen({ parentAgentId: parent.id, parentSessionKey: parent.providerSessionKey,
        sessionId: child.sessionId, title: child.title, runtimeEpoch: inventory.runtimeEpoch, readable: child.readable })}>
      <CollaborationAgentIcon sessionId={child.sessionId} />
      <span className="code-agent-row-copy"><span className="code-agent-name">{child.title}</span></span>
      <span className="code-agent-row-trailing"><AgentStatusIndicator className="code-agent-dot" state={relatedSessionIndicator(`${inventory.runtimeEpoch}:${child.sessionId}`, child.state, copy, child.stopReason)} /></span>
    </button>
  return <>
    {current.filter((child, index) => index < visibleCount || isSelected(child)).map(renderChild)}
    {current.length > visibleCount ? <button type="button" className="code-agent-row related-child" onClick={() => setVisibleCount(value => value + 6)}>{copy.relatedShowMore}</button> : null}
    {visibleCount > 6 ? <button type="button" className="code-agent-row related-child" onClick={() => setVisibleCount(6)}>{copy.relatedShowLess}</button> : null}
    {finished.length ? <details className="code-related-finished" data-testid="code-native-related-finished"><summary className="code-agent-row related-child"><ChevronRightGlyph className="code-related-disclosure-icon" /><span className="code-agent-name">{copy.relatedFinished(finished.length)}</span></summary>
      {finished.slice(0, finishedCount).map(renderChild)}
      {finished.length > finishedCount ? <button type="button" className="code-agent-row related-child" onClick={() => setFinishedCount(value => value + 6)}>{copy.relatedShowMore}</button> : null}
      {finishedCount > 6 ? <button type="button" className="code-agent-row related-child" onClick={() => setFinishedCount(6)}>{copy.relatedShowLess}</button> : null}
    </details> : null}
    {error && active && readable ? <button type="button" className="code-agent-row related-child" title={error} onClick={() => refreshRef.current?.()}>Refresh related sessions</button> : null}
  </>
}
