import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import {
  attachTerminalSession,
  clearTerminalSearch,
  detachTerminalSession,
  focusTerminalSession,
  getTerminalSelection,
  getTerminalSelectionNow,
  scrollTerminalSessionToBottom,
  searchTerminalSession,
  type TerminalSearchDirection,
  type TerminalSearchResult,
  type TerminalPathOpenTarget,
} from '@/lib/terminal-session-pool'
import type { TerminalSearchOptions } from '@/lib/terminal-search'

interface TerminalFollowState {
  following: boolean
  hasUnreadOutput: boolean
}

interface UsePooledTerminalOptions {
  agentId: string | null
  containerRef: RefObject<HTMLDivElement | null>
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => boolean | void
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null) => void) => () => void
  suppressRendererCursor?: boolean
  onFollowOutputChange?: (state: TerminalFollowState) => void
  onPathOpen?: (agentId: string, target: TerminalPathOpenTarget) => void
  onPathResolve?: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onReady?: () => void
  onError?: (error: Error) => void
}

export function usePooledTerminal({
  agentId,
  containerRef,
  onInput,
  onResize,
  onSessionOutput,
  suppressRendererCursor = false,
  onFollowOutputChange,
  onPathOpen,
  onPathResolve,
  onReady,
  onError,
}: UsePooledTerminalOptions) {
  const latestHandlersRef = useRef({
    onInput,
    onResize,
    onSessionOutput,
    onFollowOutputChange,
    onPathOpen,
    onPathResolve,
    onReady,
    onError,
  })
  latestHandlersRef.current = {
    onInput,
    onResize,
    onSessionOutput,
    onFollowOutputChange,
    onPathOpen,
    onPathResolve,
    onReady,
    onError,
  }

  const handleInput = useCallback((data: string) => {
    latestHandlersRef.current.onInput(data)
  }, [])

  const handleResize = useCallback((cols: number, rows: number) => {
    return latestHandlersRef.current.onResize(cols, rows)
  }, [])

  const handleSessionOutput = useCallback((currentAgentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null) => void) => {
    return latestHandlersRef.current.onSessionOutput(currentAgentId, handler)
  }, [])

  const handleFollowOutputChange = useCallback((state: TerminalFollowState) => {
    latestHandlersRef.current.onFollowOutputChange?.(state)
  }, [])

  const handlePathOpen = useCallback((currentAgentId: string, target: TerminalPathOpenTarget) => {
    latestHandlersRef.current.onPathOpen?.(currentAgentId, target)
  }, [])

  const handlePathResolve = useCallback((currentAgentId: string, target: TerminalPathOpenTarget) => {
    return latestHandlersRef.current.onPathResolve?.(currentAgentId, target) ?? null
  }, [])

  const handleReady = useCallback(() => {
    latestHandlersRef.current.onReady?.()
  }, [])

  const handleError = useCallback((error: Error) => {
    latestHandlersRef.current.onError?.(error)
  }, [])

  useEffect(() => {
    if (!agentId || !containerRef.current) return

    const mountEl = containerRef.current
    const controller = new AbortController()
    let cancelled = false

    mountEl.replaceChildren()

    attachTerminalSession(agentId, {
      mountEl,
      onInput: handleInput,
      onResize: handleResize,
      onSessionOutput: handleSessionOutput,
      suppressRendererCursor,
      onFollowOutputChange: handleFollowOutputChange,
      onPathOpen: handlePathOpen,
      onPathResolve: handlePathResolve,
      onError: handleError,
      signal: controller.signal,
      onReady: () => {
        if (!cancelled) {
          handleReady()
        }
      },
    }).catch((error) => {
      console.error('Failed to attach terminal session:', error)
      handleError(error instanceof Error ? error : new Error(String(error)))
    })

    return () => {
      cancelled = true
      controller.abort()
      detachTerminalSession(agentId, mountEl).catch((error) => {
        console.error('Failed to detach terminal session:', error)
      })
    }
  }, [agentId, containerRef, handleError, handleFollowOutputChange, handleInput, handlePathOpen, handlePathResolve, handleReady, handleResize, handleSessionOutput, suppressRendererCursor])

  const focus = useCallback(() => {
    if (!agentId || !containerRef.current) return
    focusTerminalSession(agentId).catch((error) => {
      console.error('Failed to focus terminal session:', error)
    })
    attachTerminalSession(agentId, {
      mountEl: containerRef.current,
      onInput: handleInput,
      onResize: handleResize,
      onSessionOutput: handleSessionOutput,
      autoFocus: true,
      suppressRendererCursor,
      onFollowOutputChange: handleFollowOutputChange,
      onPathOpen: handlePathOpen,
      onPathResolve: handlePathResolve,
      onError: handleError,
      onReady: handleReady,
    }).catch((error) => {
      console.error('Failed to refocus terminal session:', error)
      handleError(error instanceof Error ? error : new Error(String(error)))
    })
  }, [agentId, containerRef, handleError, handleFollowOutputChange, handleInput, handlePathOpen, handlePathResolve, handleReady, handleResize, handleSessionOutput, suppressRendererCursor])

  const getSelection = useCallback(async () => {
    if (!agentId) return ''
    return getTerminalSelection(agentId)
  }, [agentId])

  const getSelectionNow = useCallback(() => {
    if (!agentId) return ''
    return getTerminalSelectionNow(agentId)
  }, [agentId])

  const scrollToBottom = useCallback(() => {
    if (!agentId) return
    scrollTerminalSessionToBottom(agentId).catch((error) => {
      console.error('Failed to scroll terminal session to bottom:', error)
    })
  }, [agentId])

  const search = useCallback((term: string, direction: TerminalSearchDirection = 'next', options?: TerminalSearchOptions): Promise<TerminalSearchResult> => {
    if (!agentId) return Promise.resolve({ found: false, resultIndex: 0, resultCount: 0 })
    return searchTerminalSession(agentId, term, direction, options)
  }, [agentId])

  const clearSearch = useCallback(() => {
    if (!agentId) return Promise.resolve()
    return clearTerminalSearch(agentId)
  }, [agentId])

  return { focus, getSelection, getSelectionNow, scrollToBottom, search, clearSearch }
}
