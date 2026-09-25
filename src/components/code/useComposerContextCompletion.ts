import { useEffect, useMemo, useState } from 'react'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import { searchWorkspaceFiles } from '@/lib/workspace-files'
import { findComposerContextTrigger } from './composer-context-trigger'

const SEARCH_DEADLINE_MS = 2_500

export interface ComposerContextCandidate {
  kind: 'file' | 'directory'
  path: string
}

export function useComposerContextCompletion({ agentId, workspace, draft, selectionStart, active, focused }: {
  agentId: string
  workspace: string
  draft: string
  selectionStart: number
  active: boolean
  focused: boolean
}) {
  const trigger = useMemo(() => findComposerContextTrigger(draft, selectionStart), [draft, selectionStart])
  const triggerId = trigger ? `${agentId}:${workspace}:${trigger.start}:${trigger.end}:${trigger.query}` : ''
  const [dismissedId, setDismissedId] = useState('')
  const [result, setResult] = useState<{ id: string; candidates: ComposerContextCandidate[]; status: 'ready' | 'error'; truncated: boolean } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const open = active && focused && Boolean(workspace) && Boolean(trigger) && triggerId !== dismissedId

  useEffect(() => {
    setActiveIndex(0)
    if (!open || !trigger) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      controller.abort()
      setResult({ id: triggerId, candidates: [], status: 'error', truncated: false })
    }, SEARCH_DEADLINE_MS)
    const debounce = window.setTimeout(() => {
      const rootId = projectFilesWorkspaceId(workspace)
      void searchWorkspaceFiles(rootId, trigger.query || '.', { scope: 'entries', limit: 16, signal: controller.signal })
        .then(search => {
          if (controller.signal.aborted) return
          setResult({
            id: triggerId,
            candidates: search.matches.flatMap(match => match.entryType === 'file' || match.entryType === 'directory'
              ? [{ kind: match.entryType, path: match.path }]
              : []).slice(0, 12),
            status: 'ready',
            truncated: search.truncated || search.matches.length > 12,
          })
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ id: triggerId, candidates: [], status: 'error', truncated: false })
        })
        .finally(() => window.clearTimeout(timer))
    }, trigger.query ? 120 : 0)
    return () => {
      window.clearTimeout(debounce)
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [open, trigger, triggerId, workspace])

  const current = result?.id === triggerId ? result : null
  const status: 'loading' | 'ready' | 'error' = current?.status ?? 'loading'
  return {
    trigger,
    open,
    candidates: current?.candidates || [],
    status,
    truncated: current?.truncated || false,
    activeIndex,
    setActiveIndex,
    dismiss: () => setDismissedId(triggerId),
  }
}
