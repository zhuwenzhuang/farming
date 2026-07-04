import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  WORKSPACE_NAVIGATION_CURSOR_SETTLE_MS,
  emptyWorkspaceNavigationHistory,
  pushWorkspaceNavigationEntry,
  workspaceNavigationAgentEntry,
  workspaceNavigationFileEntry,
  type WorkspaceNavigationEntry,
  type WorkspaceNavigationFileInput,
  type WorkspaceNavigationHistorySnapshot,
} from '@/lib/workspace-navigation-history'

export function useWorkspaceNavigationHistory() {
  const [state, setState] = useState<WorkspaceNavigationHistorySnapshot>(() => emptyWorkspaceNavigationHistory())
  const stateRef = useRef(state)
  const navigatingRef = useRef(false)
  const cursorTimerRef = useRef<number | null>(null)

  const commitState = useCallback((nextState: WorkspaceNavigationHistorySnapshot) => {
    stateRef.current = nextState
    setState(nextState)
    return nextState
  }, [])

  const recordEntry = useCallback((entry: WorkspaceNavigationEntry) => {
    if (navigatingRef.current) return

    commitState(pushWorkspaceNavigationEntry(stateRef.current, entry))
  }, [commitState])

  const recordAgent = useCallback((agentId: string) => {
    recordEntry(workspaceNavigationAgentEntry(agentId))
  }, [recordEntry])

  const recordFile = useCallback((input: WorkspaceNavigationFileInput) => {
    recordEntry(workspaceNavigationFileEntry(input))
  }, [recordEntry])

  const recordFileCursor = useCallback((input: WorkspaceNavigationFileInput) => {
    if (navigatingRef.current) return
    if (cursorTimerRef.current !== null) {
      window.clearTimeout(cursorTimerRef.current)
    }
    cursorTimerRef.current = window.setTimeout(() => {
      cursorTimerRef.current = null
      recordEntry(workspaceNavigationFileEntry({ ...input, reason: 'cursor' }))
    }, WORKSPACE_NAVIGATION_CURSOR_SETTLE_MS)
  }, [recordEntry])

  const beginNavigation = useCallback((direction: -1 | 1) => {
    const current = stateRef.current
    const nextIndex = current.index + direction
    const entry = current.entries[nextIndex]
    if (!entry) return null

    navigatingRef.current = true
    commitState({
      entries: current.entries,
      index: nextIndex,
    })
    return entry
  }, [commitState])

  const finishNavigation = useCallback(() => {
    window.setTimeout(() => {
      navigatingRef.current = false
    }, 120)
  }, [])

  const pruneEntries = useCallback((shouldKeep: (entry: WorkspaceNavigationEntry) => boolean) => {
    const current = stateRef.current
    const entries = current.entries.filter(shouldKeep)
    if (entries.length === current.entries.length) return

    const currentEntry = current.entries[current.index]
    const retainedCurrentIndex = currentEntry ? entries.indexOf(currentEntry) : -1
    const index = retainedCurrentIndex >= 0
      ? retainedCurrentIndex
      : Math.min(current.index, entries.length - 1)
    commitState({ entries, index })
  }, [commitState])

  useEffect(() => () => {
    if (cursorTimerRef.current !== null) {
      window.clearTimeout(cursorTimerRef.current)
      cursorTimerRef.current = null
    }
  }, [])

  return useMemo(() => ({
    canGoBack: state.index > 0,
    canGoForward: state.index >= 0 && state.index < state.entries.length - 1,
    recordAgent,
    recordFile,
    recordFileCursor,
    beginNavigation,
    finishNavigation,
    pruneEntries,
  }), [
    beginNavigation,
    finishNavigation,
    pruneEntries,
    recordAgent,
    recordFile,
    recordFileCursor,
    state.entries.length,
    state.index,
  ])
}
