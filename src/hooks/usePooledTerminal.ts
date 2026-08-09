import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import {
  attachTerminalSession,
  clearTerminalSearch,
  commitTerminalSessionLinkHandlers,
  detachTerminalSession,
  focusTerminalSession,
  getTerminalSessionReadCut,
  getTerminalSelection,
  getTerminalSelectionNow,
  refreshTerminalSessionLayout,
  releaseTerminalSessionLinkHandlers,
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
import { createTerminalLinkHandlersRevisionTracker } from '@/lib/terminal-link-interaction'
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
    onOpenUrlInFarming,
    onRecoveryStatusChange,
    onReady,
    onError,
    bootstrapState,
  })
  latestHandlersRef.current = {
    onSessionOutput,
    onFollowOutputChange,
    onOpenUrlInFarming,
    onRecoveryStatusChange,
    onReady,
    onError,
    bootstrapState,
  }
  // The three link handlers are committed, not latest-read: the pool caches
  // resolutions behind these stable wrappers, so an opener may only become
  // reachable after the pool has adopted the matching revision and dropped what
  // the previous handlers produced.
  const committedLinkHandlersRef = useRef({ onPathOpen, onPathResolve, onSearchOpen })

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
        committedLinkHandlersRef.current.onPathOpen?.(currentAgentId, target)
      },
      onPathResolve: (currentAgentId, target) => {
        return committedLinkHandlersRef.current.onPathResolve?.(currentAgentId, target) ?? null
      },
      onSearchOpen: (currentAgentId, query) => {
        committedLinkHandlersRef.current.onSearchOpen?.(currentAgentId, query)
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
  const linkHandlersRevisionTrackerRef = useRef<ReturnType<typeof createTerminalLinkHandlersRevisionTracker> | null>(null)
  if (!linkHandlersRevisionTrackerRef.current) {
    linkHandlersRevisionTrackerRef.current = createTerminalLinkHandlersRevisionTracker()
  }
  // The wrappers handed to the pool are stable by design, so their references
  // can never prove that the real resolver and opener were replaced. This token
  // advances only when one of those three handlers actually changes identity,
  // which keeps a re-render - including StrictMode's double render - from
  // invalidating a resolution that is still current.
  const linkHandlersRevision = linkHandlersRevisionTrackerRef.current.revisionFor({
    onPathOpen,
    onPathResolve,
    onSearchOpen,
  })
  const latestLiveOptionsRef = useRef({
    inputDisabled,
    suppressRendererCursor,
    farmingUrlOpenEnabled,
    linkHandlersRevision,
  })
  latestLiveOptionsRef.current = {
    inputDisabled,
    suppressRendererCursor,
    farmingUrlOpenEnabled,
    linkHandlersRevision,
  }
  const attachmentLeaseCoordinatorRef = useRef<ReturnType<typeof createTerminalAttachmentLeaseCoordinator> | null>(null)
  if (!attachmentLeaseCoordinatorRef.current) {
    attachmentLeaseCoordinatorRef.current = createTerminalAttachmentLeaseCoordinator()
  }
  const attachmentLeaseCoordinator = attachmentLeaseCoordinatorRef.current

  // One atomic commit per render: the pool adopts this exact revision - which
  // invalidates every resolution and pending decision the previous handlers
  // produced - and only then do the wrappers start reaching the new opener. The
  // pool needs these exact wrappers to tell whether the live record is still this
  // owner's: a record that is absent, still being created, or still routing
  // through another owner's wrappers has nothing to invalidate yet and adopts the
  // latched revision when its own attach installs them, so a late attach cannot
  // reinstate a superseded one.
  useLayoutEffect(() => {
    const candidateLinkHandlers = { onPathOpen, onPathResolve, onSearchOpen }
    if (agentId) commitTerminalSessionLinkHandlers(agentId, linkHandlersRevision, attachmentHandlers)
    committedLinkHandlersRef.current = candidateLinkHandlers
    return () => {
      if (agentId) releaseTerminalSessionLinkHandlers(agentId, linkHandlersRevision)
    }
  }, [agentId, attachmentHandlers, linkHandlersRevision, onPathOpen, onPathResolve, onSearchOpen])

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
        linkHandlersRevision: latestLiveOptionsRef.current.linkHandlersRevision,
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
        linkHandlersRevision: latestLiveOptionsRef.current.linkHandlersRevision,
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
