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
  retryTerminalSession,
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
import { createTerminalAttachmentLeaseCoordinator } from '@/lib/terminal-attachment'

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
  onSearchOpen?: (agentId: string, query: string) => void
  onOpenUrlInFarming?: (agentId: string, url: string) => void
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
  onSearchOpen: (agentId: string, query: string) => void
  onOpenUrlInFarming: (agentId: string, url: string) => void
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
  onSearchOpen,
  onOpenUrlInFarming,
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
    onSearchOpen,
    onOpenUrlInFarming,
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
    onSearchOpen,
    onOpenUrlInFarming,
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
      onSearchOpen: (currentAgentId, query) => {
        latestHandlersRef.current.onSearchOpen?.(currentAgentId, query)
      },
      onOpenUrlInFarming: (currentAgentId, url) => {
        latestHandlersRef.current.onOpenUrlInFarming?.(currentAgentId, url)
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
  const farmingUrlOpenEnabled = Boolean(onOpenUrlInFarming)
  const latestLiveOptionsRef = useRef({
    inputDisabled,
    suppressRendererCursor,
    farmingUrlOpenEnabled,
  })
  latestLiveOptionsRef.current = {
    inputDisabled,
    suppressRendererCursor,
    farmingUrlOpenEnabled,
  }
  const attachmentLeaseCoordinatorRef = useRef<ReturnType<typeof createTerminalAttachmentLeaseCoordinator> | null>(null)
  if (!attachmentLeaseCoordinatorRef.current) {
    attachmentLeaseCoordinatorRef.current = createTerminalAttachmentLeaseCoordinator()
  }
  const attachmentLeaseCoordinator = attachmentLeaseCoordinatorRef.current

  useEffect(() => {
    if (!agentId || !containerRef.current) return

    const mountEl = containerRef.current
    const lease = attachmentLeaseCoordinator.acquire(agentId, mountEl, () => {
      const controller = new AbortController()
      mountEl.replaceChildren()

      attachTerminalSession(agentId, {
        mountEl,
        onSessionOutput: attachmentHandlers.onSessionOutput,
        suppressRendererCursor: latestLiveOptionsRef.current.suppressRendererCursor,
        inputDisabled: latestLiveOptionsRef.current.inputDisabled,
        onFollowOutputChange: attachmentHandlers.onFollowOutputChange,
        onPathOpen: attachmentHandlers.onPathOpen,
        onPathResolve: attachmentHandlers.onPathResolve,
        onSearchOpen: attachmentHandlers.onSearchOpen,
        onOpenUrlInFarming: latestLiveOptionsRef.current.farmingUrlOpenEnabled
          ? attachmentHandlers.onOpenUrlInFarming
          : undefined,
        onRecoveryStatusChange: attachmentHandlers.onRecoveryStatusChange,
        onError: attachmentHandlers.onError,
        bootstrapState: latestHandlersRef.current.bootstrapState,
        signal: controller.signal,
        onReady: attachmentHandlers.onReady,
      }).catch((error) => {
        if (controller.signal.aborted) return
        console.error('Failed to attach terminal session:', error)
        attachmentHandlers.onError(error instanceof Error ? error : new Error(String(error)))
      })

      return () => {
        controller.abort()
        detachTerminalSession(agentId, mountEl).catch((error) => {
          console.error('Failed to detach terminal session:', error)
        })
      }
    })

    return () => {
      lease.release()
    }
  }, [agentId, attachmentHandlers, attachmentLeaseCoordinator, containerRef])

  useEffect(() => {
    if (!agentId) return
    updateTerminalSessionLiveOptions(agentId, {
      inputDisabled,
      suppressRendererCursor,
      onOpenUrlInFarming: farmingUrlOpenEnabled ? attachmentHandlers.onOpenUrlInFarming : undefined,
    }).catch((error) => {
      console.error('Failed to update terminal live options:', error)
    })
  }, [agentId, attachmentHandlers, farmingUrlOpenEnabled, inputDisabled, suppressRendererCursor])

  useEffect(() => {
    // The field-level deps below are the intentional triggers: `bootstrapState` is an
    // object literal from the caller, so depending on it would reapply state every render.
    const latestBootstrapState = latestHandlersRef.current.bootstrapState
    if (!agentId || !latestBootstrapState?.runtimeEpoch || latestBootstrapState.stateRevision === null) return
    updateTerminalSessionBootstrapState(agentId, latestBootstrapState).catch((error) => {
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
        onSearchOpen: attachmentHandlers.onSearchOpen,
        onOpenUrlInFarming: latestLiveOptionsRef.current.farmingUrlOpenEnabled
          ? attachmentHandlers.onOpenUrlInFarming
          : undefined,
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

  const retry = useCallback(() => {
    if (!agentId) return false
    return retryTerminalSession(agentId)
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
    retry,
    refreshLayout,
    getSelection,
    getSelectionNow,
    getReadCutNow,
    scrollToBottom,
    search,
    clearSearch,
  }
}
