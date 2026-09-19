import { useEffect, useRef, useState } from 'react'
import type { Agent } from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { isAcpRuntime } from '@/lib/agent-runtime'
import { ChatBubblesGlyph } from '../IconGlyphs'
import type { RelatedSessionTarget } from './related-session-navigation'

type Inventory = { parentSessionKey: string; runtimeEpoch: string; children: Array<{ sessionId: string; title: string; state: string; readable: boolean }> }
export function NativeRelatedRows({ parent, active, selected, onOpen }: {
  parent: Agent; active: boolean; selected: RelatedSessionTarget | null; onOpen: (target: RelatedSessionTarget) => void
}) {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [error, setError] = useState('')
  const refreshRef = useRef<(() => void) | null>(null)
  const structured = isAcpRuntime(parent)
  const revision = isAcpRuntime(parent) ? parent.runtimeBinding.sessionRevision : 0
  useEffect(() => {
    if (!active || !structured) return
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
  }, [parent.id, parent.providerSessionKey, active, structured])
  useEffect(() => { if (active) refreshRef.current?.() }, [revision, active])
  if (!inventory || inventory.parentSessionKey !== parent.providerSessionKey) return error && active
    ? <button type="button" className="code-agent-row related-child" onClick={() => refreshRef.current?.()} title={error}>Related sessions unavailable · Retry</button> : null
  return <>
    {inventory.children.map(child => <button type="button" key={`${inventory.runtimeEpoch}:${child.sessionId}`}
      className={`code-agent-row related-child ${selected?.parentAgentId === parent.id && selected.sessionId === child.sessionId && !selected.subagentSessionKey ? 'active' : ''}`}
      data-testid="code-native-related-row" aria-label={child.title} title={`${child.title} · ${child.state}`}
      onClick={() => onOpen({ parentAgentId: parent.id, parentSessionKey: parent.providerSessionKey,
        sessionId: child.sessionId, title: child.title, runtimeEpoch: inventory.runtimeEpoch, readable: child.readable })}>
      <span className="code-agent-row-provider-icon"><ChatBubblesGlyph /></span>
      <span className="code-agent-row-copy"><span className="code-agent-name">{child.title}</span></span>
      <span className="code-agent-row-trailing">{child.state}</span>
    </button>)}
    {error && active ? <button type="button" className="code-agent-row related-child" title={error} onClick={() => refreshRef.current?.()}>Refresh related sessions</button> : null}
  </>
}
