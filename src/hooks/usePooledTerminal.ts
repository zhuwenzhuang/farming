import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import {
  attachTerminalSession,
  clearTerminalSearch,
  detachTerminalSession,
  focusTerminalSession,
  getTerminalSessionReadCut,
  getTerminalSelection,
  getTerminalSelectionNow,
  refreshTerminalSessionLayout,
  scrollTerminalSessionToBottom,
  searchTerminalSession,
  updateTerminalSessionBootstrapState,
  updateTerminalSessionLiveOptions,
  type TerminalSearchDirection,
  type TerminalSearchResult,
  type TerminalPathOpenTarget,
  type TerminalRecoveryStatus,
} from '@/lib/terminal-session-pool'
import type { TerminalSearchOptions } from '@/lib/terminal-search'
import type { SessionBootstrapState } from '@/lib/terminal-bootstrap'

interface TerminalFollowState {
  following: boolean
  hasUnreadOutput: boolean
}

interface UsePooledTerminalOptions {
  agentId: string | null
  containerRef: RefObject<HTMLDivElement | null>
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null, runtimeEpoch?: string, stateRevision?: number | null, cols?: number, rows?: number, kind?: 'output' | 'resize' | 'clear') => void) => () => void
  suppressRendererCursor?: boolean
  inputDisabled?: boolean
  onFollowOutputChange?: (state: TerminalFollowState) => void
  onPathOpen?: (agentId: string, target: TerminalPathOpenTarget) => void
  onPathResolve?: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onUrlOpen?: (agentId: string, url: string) => void
  onRecoveryStatusChange?: (status: TerminalRecoveryStatus) => void
  onReady?: () => void
  onError?: (error: Error) => void
  bootstrapState?: SessionBootstrapState
}

interface TerminalAttachmentHandlers {
  onSessionOutput: UsePooledTerminalOptions['onSessionOutput']
  onFollowOutputChange: (state: TerminalFollowState) => void
  onPathOpen: (agentId: string, target: TerminalPathOpenTarget) => void
  onPathResolve: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onUrlOpen: (agentId: string, url: string) => void
  onRecoveryStatusChange: (status: TerminalRecoveryStatus) => void
  onReady: () => void
  onError: (error: Error) => void
}

export function usePooledTerminal({
  agentId,
  containerRef,
  onSessionOutput,
  suppressRendererCursor = false,
  inputDisabled = false,
  onFollowOutputChange,
  onPathOpen,
  onPathResolve,
  onUrlOpen,
  onRecoveryStatusChange,
  onReady,
  onError,
  bootstrapState,
}: UsePooledTerminalOptions) {
  const latestHandlersRef = useRef({
    onSessionOutput,
    onFollowOutputChange,
    onPathOpen,
    onPathResolve,
    onUrlOpen,
    onRecoveryStatusChange,
    onReady,
    onError,
    bootstrapState,
  })
  latestHandlersRef.current = {
    onSessionOutput,
    onFollowOutputChange,
    onPathOpen,
    onPathResolve,
    onUrlOpen,
    onRecoveryStatusChange,
    onReady,
    onError,
    bootstrapState,
  }

  const attachmentHandlersRef = useRef<TerminalAttachmentHandlers | null>(null)
  if (!attachmentHandlersRef.current) {
    attachmentHandlersRef.current = {
      onSessionOutput: (currentAgentId, handler) => {
        return latestHandlersRef.current.onSessionOutput(currentAgentId, handler)
      },
      onFollowOutputChange: state => {
        latestHandlersRef.current.onFollowOutputChange?.(state)
      },
      onPathOpen: (currentAgentId, target) => {
        latestHandlersRef.current.onPathOpen?.(currentAgentId, target)
      },
      onPathResolve: (currentAgentId, target) => {
        return latestHandlersRef.current.onPathResolve?.(currentAgentId, target) ?? null
      },
      onUrlOpen: (currentAgentId, url) => {
        latestHandlersRef.current.onUrlOpen?.(currentAgentId, url)
      },
      onRecoveryStatusChange: status => {
        latestHandlersRef.current.onRecoveryStatusChange?.(status)
      },
      onReady: () => {
        latestHandlersRef.current.onReady?.()
      },
      onError: error => {
        latestHandlersRef.current.onError?.(error)
      },
    }
  }
  const attachmentHandlers = attachmentHandlersRef.current
  const urlOpenEnabled = Boolean(onUrlOpen)
  const latestLiveOptionsRef = useRef({
    inputDisabled,
    suppressRendererCursor,
    urlOpenEnabled,
  })
  latestLiveOptionsRef.current = {
    inputDisabled,
    suppressRendererCursor,
    urlOpenEnabled,
  }

  useEffect(() => {
    if (!agentId || !containerRef.current) return

    const mountEl = containerRef.current
    const controller = new AbortController()
    let cancelled = false

    mountEl.replaceChildren()

    attachTerminalSession(agentId, {
      mountEl,
      onSessionOutput: attachmentHandlers.onSessionOutput,
      suppressRendererCursor: latestLiveOptionsRef.current.suppressRendererCursor,
      inputDisabled: latestLiveOptionsRef.current.inputDisabled,
      onFollowOutputChange: attachmentHandlers.onFollowOutputChange,
      onPathOpen: attachmentHandlers.onPathOpen,
      onPathResolve: attachmentHandlers.onPathResolve,
      onUrlOpen: latestLiveOptionsRef.current.urlOpenEnabled ? attachmentHandlers.onUrlOpen : undefined,
      onRecoveryStatusChange: attachmentHandlers.onRecoveryStatusChange,
      onError: attachmentHandlers.onError,
      bootstrapState: latestHandlersRef.current.bootstrapState,
      signal: controller.signal,
      onReady: () => {
        if (!cancelled) {
          attachmentHandlers.onReady()
        }
      },
    }).catch((error) => {
      console.error('Failed to attach terminal session:', error)
      attachmentHandlers.onError(error instanceof Error ? error : new Error(String(error)))
    })

    return () => {
      cancelled = true
      controller.abort()
      detachTerminalSession(agentId, mountEl).catch((error) => {
        console.error('Failed to detach terminal session:', error)
      })
    }
  }, [agentId, attachmentHandlers, containerRef])

  useEffect(() => {
    if (!agentId) return
    updateTerminalSessionLiveOptions(agentId, {
      inputDisabled,
      suppressRendererCursor,
      onUrlOpen: urlOpenEnabled ? attachmentHandlers.onUrlOpen : undefined,
    }).catch((error) => {
      console.error('Failed to update terminal live options:', error)
    })
  }, [agentId, attachmentHandlers, inputDisabled, suppressRendererCursor, urlOpenEnabled])

  useEffect(() => {
    if (!agentId || !bootstrapState?.runtimeEpoch || bootstrapState.stateRevision === null) return
    updateTerminalSessionBootstrapState(agentId, bootstrapState).catch((error) => {
      console.error('Failed to apply terminal bootstrap state:', error)
    })
  }, [
    agentId,
    bootstrapState?.runtimeEpoch,
    bootstrapState?.outputSeq,
    bootstrapState?.stateRevision,
    bootstrapState?.output,
    bootstrapState?.cols,
    bootstrapState?.rows,
  ])

  const focus = useCallback(() => {
    const mountEl = containerRef.current
    if (!agentId || !mountEl) return
    focusTerminalSession(agentId).then((focused) => {
      if (focused) return

      // A visible session is already attached. Reattaching it after every
      // click moves xterm's hidden textarea while an IME may be preparing a
      // composition. Only attach here when the pooled session is absent or
      // parked; otherwise keep xterm's native focus lifecycle intact.
      return attachTerminalSession(agentId, {
        mountEl,
        onSessionOutput: attachmentHandlers.onSessionOutput,
        autoFocus: true,
        suppressRendererCursor: latestLiveOptionsRef.current.suppressRendererCursor,
        inputDisabled: latestLiveOptionsRef.current.inputDisabled,
        onFollowOutputChange: attachmentHandlers.onFollowOutputChange,
        onPathOpen: attachmentHandlers.onPathOpen,
        onPathResolve: attachmentHandlers.onPathResolve,
        onUrlOpen: latestLiveOptionsRef.current.urlOpenEnabled ? attachmentHandlers.onUrlOpen : undefined,
        onRecoveryStatusChange: attachmentHandlers.onRecoveryStatusChange,
        onError: attachmentHandlers.onError,
        bootstrapState: latestHandlersRef.current.bootstrapState,
        onReady: attachmentHandlers.onReady,
      })
    }).catch((error) => {
      console.error('Failed to focus terminal session:', error)
      attachmentHandlers.onError(error instanceof Error ? error : new Error(String(error)))
    })
  }, [agentId, attachmentHandlers, containerRef])

  const refreshLayout = useCallback((options: { autoFocus?: boolean } = {}) => {
    if (!agentId) return
    refreshTerminalSessionLayout(agentId, options).catch((error) => {
      console.error('Failed to refresh terminal layout:', error)
    })
  }, [agentId])

  const getSelection = useCallback(async () => {
    if (!agentId) return ''
    return getTerminalSelection(agentId)
  }, [agentId])

  const getSelectionNow = useCallback(() => {
    if (!agentId) return ''
    return getTerminalSelectionNow(agentId)
  }, [agentId])

  const getReadCutNow = useCallback(() => {
    if (!agentId) return null
    return getTerminalSessionReadCut(agentId)
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

  return {
    focus,
    refreshLayout,
    getSelection,
    getSelectionNow,
    getReadCutNow,
    scrollToBottom,
    search,
    clearSearch,
  }
}
