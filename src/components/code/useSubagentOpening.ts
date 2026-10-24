import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import type { Agent } from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { attachSubagent } from '@/lib/subagent-supervision'
import type { RelatedSessionTarget } from './related-session-navigation'
import type { ComposerContextReference } from './composer-message'
import type { AgentComposerState } from './composer-state'
import type { ComposerInputElement } from './composer-input-element'

const storageKey = 'farming.code.subagent-preparation.v1'
function readRequests(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter(([key, value]) => key.length < 4096 && typeof value === 'string' && /^[\w-]{1,128}$/.test(value)).slice(-20))
  } catch { return {} }
}

/** Presentation can close while the exact journalled fork continues. */
export function useSubagentOpening({ agents, title, setTarget, openParent, updateDraft, moveDraft }: {
  agents: Agent[]; title: string
  setTarget: Dispatch<SetStateAction<RelatedSessionTarget | null>>
  openParent: (id: string) => void
  updateDraft: (key: string, update: (state: AgentComposerState) => AgentComposerState) => void
  moveDraft: (source: string, target: string) => void
}) {
  const requests = useRef<Record<string, string> | null>(null)
  requests.current ??= readRequests()
  const running = useRef(new Map<string, Promise<void>>())
  return useCallback((parentAgentId: string, quote?: ComposerContextReference) => {
    const parent = agents.find(agent => agent.id === parentAgentId)
    if (!parent?.providerSessionKey) return
    const parentKey = parent.providerSessionKey
    const draftKey = `subagent-preparation:${parentKey}`
    const requestId = requests.current![parentKey] || `side-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    requests.current![parentKey] = requestId
    const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify(requests.current)) } catch { /* current page retains the exact request */ } }
    persist()
    if (quote) updateDraft(draftKey, state => ({ ...state, contextReferences: state.contextReferences?.some(item => item.id === quote.id) ? state.contextReferences : [...(state.contextReferences || []), quote] }))
    attachSubagent(parentKey)
    openParent(parentAgentId)
    setTarget({ parentAgentId, parentSessionKey: parentKey, sessionId: '', title, preparation: { requestId, draftKey } })
    if (running.current.has(parentKey)) return
    const request = (async () => {
      let retryable = false
      try {
        const response = await fetch(appPath(`/api/agents/${encodeURIComponent(parentAgentId)}/subagent`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }), signal: AbortSignal.timeout(90000),
        })
        const result = await response.json() as { agentId?: string; error?: string; uncertain?: boolean; providerSessionId?: string; providerSessionKey?: string }
        if (!response.ok || result.error) {
          // Only an explicit zero-effect rejection permits a fresh attempt.
          if (result.error && result.uncertain === false) { retryable = true; delete requests.current![parentKey]; persist() }
          throw new Error(result.error || 'Subagent could not be opened')
        }
        if (!result.providerSessionKey) throw new Error('Subagent has no durable session identity')
        const focused = document.activeElement?.closest<ComposerInputElement>('[data-testid="code-subagent-preparation-composer"] [data-composer-rich-input]')
        const preparedSelection = focused ? { start: focused.selectionStart, end: focused.selectionEnd } : undefined
        moveDraft(draftKey, `acp:${result.providerSessionKey}`)
        delete requests.current![parentKey]
        persist()
        setTarget(current => current?.preparation?.requestId === requestId && current.parentSessionKey === parentKey
          ? { parentAgentId, parentSessionKey: parentKey, sessionId: result.providerSessionId || '', subagentSessionKey: result.providerSessionKey, subagentAgentId: result.agentId, title, preparedSelection }
          : current)
      } catch (caught) {
        const error = caught instanceof Error ? caught.message : String(caught)
        setTarget(current => current?.preparation?.requestId === requestId && current.parentSessionKey === parentKey
          ? { ...current, preparation: { requestId, draftKey, error, retryable } } : current)
      } finally { running.current.delete(parentKey) }
    })()
    running.current.set(parentKey, request)
  }, [agents, title, setTarget, openParent, updateDraft, moveDraft])
}
