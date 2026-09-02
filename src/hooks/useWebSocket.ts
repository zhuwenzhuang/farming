import { useEffect, useRef, useCallback, useState } from 'react'
import { beginInteraction } from '@/lib/interaction-performance'
import type { PerformanceTrace } from '../../shared/interaction-performance'
import type { Agent, ProjectAgentSummary, TaskHistoryEntry } from '@/types/agent'
import type { AcpSessionRevisionMessage, ClientMessage, ComposerInputAttachment, ComposerInputMessage, LanguageServerRefreshMessage, ServerMessage, StartAgentMessage, WorkspaceFileEventMessage } from '@/types/messages'
import { getStartupAccessToken } from '@/lib/auth-url'
import { appWsUrl } from '@/lib/base-path'
import { reconcileTerminalFenceError } from '@/lib/terminal-fence-error-recovery'
import {
  setTerminalSessionTransport,
  setTerminalSessionTransportReady,
  settleTerminalSessionCheckpoint,
} from '@/lib/terminal-session-client'
import {
  setWorkspaceRequestTransport,
  setWorkspaceRequestTransportReady,
  settleLanguageServerRequest,
  settleWorkspaceRequest,
} from '@/lib/workspace-request-client'
import {
  markBackendDisconnected,
  resetBackendConnectionStatus,
  updateBackendConnectionStatus,
  updateBackendSystemStats,
} from '@/lib/backend-live-status'
import {
  reconcileAgentLiveStates,
  reconcileAgentLiveStateDelta,
  resetAgentLiveStates,
  updateAgentAcpSessionRevision,
  updateAgentLiveActivities,
  updateAgentLiveActivity,
  updateAgentLivePreview,
  updateAgentReadState,
  updateAgentLiveState,
} from '@/lib/agent-live-state'
import {
  advanceAgentStateSnapshot,
  agentStateDeltaDisposition,
  applyAgentStateDelta,
  type AgentStateCursor,
  type AgentStateSnapshotCursor,
} from '../../shared/agent-state-reducer.js'
import {
  claimProtocolUpgradeReload,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  protocolCompatible,
  validateServerMessage,
} from '../../shared/browser-protocol.js'
import {
  applyBrowserResource,
  applyBrowserResourceDeletion,
  applyBrowserResourceSnapshot,
  emptyBrowserResourceState,
  type BrowserResourceState,
} from '../../extensions/browser/frontend/browser-resource-state'
import type { BrowserResource, BrowserResourceDeletion } from '../../extensions/browser/frontend/types'
import {
  applyComputerResource,
  applyComputerResourceDeletion,
  applyComputerResourceSnapshot,
  emptyComputerResourceState,
  type ComputerResourceState,
} from '../../extensions/computer/frontend/computer-resource-state'
import type { ComputerResource, ComputerResourceDeletion } from '../../extensions/computer/frontend/types'
import {
  outgoingWebSocketMessageDisposition,
  replayableWebSocketMessage,
  type WebSocketAccessMode,
} from '@/lib/websocket-access'

const LAST_MESSAGE_STATE_THROTTLE_MS = 1000
const BUSINESS_HEALTH_INTERVAL_MS = 10_000
const BUSINESS_HEALTH_DEADLINE_MS = 8_000
const FOREGROUND_BUSINESS_HEALTH_DEADLINE_MS = 2_500
const BUSINESS_HEALTH_RETRY_MS = 2_000
const WEBSOCKET_CONNECT_DEADLINE_MS = 8_000
const WEBSOCKET_CLOSE_DEADLINE_MS = 1_000
const AGENT_STATE_SNAPSHOT_PAGE_DEADLINE_MS = 30_000
let languageServerRefreshModulePromise: Promise<typeof import('../../extensions/language-server/frontend/monaco-providers')> | null = null

function refreshLanguageServerProvidersOnDemand(message: LanguageServerRefreshMessage) {
  languageServerRefreshModulePromise ??= import('../../extensions/language-server/frontend/monaco-providers')
  void languageServerRefreshModulePromise.then(module => {
    module.refreshLanguageServerProviders(message)
  })
}

export interface WebSocketState {
  accessMode: WebSocketAccessMode
  agents: Agent[]
  agentInventoryComplete: boolean
  taskHistory: TaskHistoryEntry[]
  mainPageSessionKeys: string[]
  mainAgentId: string | null
  connected: boolean
  error: string | null
  errorKind: 'recoverable' | 'error'
  errorId: number
  lastStartedAgentId: string | null
  projectWorkspaces: string[] | null
  projectAgentSummaries: ProjectAgentSummary[]
  pinnedProjectWorkspaces: string[] | null
  browserResources: BrowserResourceState | null
  computerResources: ComputerResourceState | null
}

function isInternalMainWorkspace(cwd?: string, parentAgentId?: string) {
  if (parentAgentId) return false
  return /(^|[/\\])\.farming[/\\]?$/.test(cwd || '')
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameJsonValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

type WorkspaceFileListener = (event: WorkspaceFileEventMessage['event']) => void
export type WorkspaceFileWatchReadyReason = 'reconnected' | 'watch-added'
interface WorkspaceFileListenerRegistration {
  onEvent: WorkspaceFileListener
  onReady?: (paths: readonly string[], reason: WorkspaceFileWatchReadyReason) => void
  pendingReadyReasons: Map<string, WorkspaceFileWatchReadyReason>
  paths: readonly string[]
}

interface WorkspaceFileWatchRegistration {
  update(paths: readonly string[]): void
  close(): void
}

function workspaceFileListenerPaths(listeners: Map<WorkspaceFileListener, WorkspaceFileListenerRegistration>) {
  return Array.from(new Set(Array.from(listeners.values()).flatMap(listener => listener.paths))).sort()
}

function normalizeStateAgent(agent: Agent, mainAgentId: string | null, previous?: Agent): Agent {
  const normalizedAgent = {
    ...agent,
    isMain: agent.isMain
      || agent.id === mainAgentId
      || isInternalMainWorkspace(agent.cwd, agent.parentAgentId),
  }
  return previous?.previewSnapshot
    ? { ...normalizedAgent, previewSnapshot: previous.previewSnapshot }
    : normalizedAgent
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const accessModeRef = useRef<WebSocketAccessMode>('unknown')
  const pendingAccessMessagesRef = useRef<ClientMessage[]>([])
  const focusedAgentIdRef = useRef<string | null>(null)
  const agentActivityScopeRef = useRef<'all' | 'focused' | 'none'>('all')
  const agentPreviewScopeRef = useRef<'all' | 'focused' | 'none'>('none')
  const watchedAcpTranscriptAgentIdsRef = useRef<string[]>([])
  const agentStateSignaturesRef = useRef<Map<string, string>>(new Map())
  const agentStateCursorRef = useRef<AgentStateCursor | null>(null)
  const agentStateSnapshotAgentsRef = useRef<Agent[]>([])
  const agentStateSnapshotCursorRef = useRef<AgentStateSnapshotCursor | null>(null)
  const agentStateResyncPendingRef = useRef(false)
  const composerRequestSequenceRef = useRef(0)
  const composerRequestResolversRef = useRef(new Map<string, {
    resolve: (accepted: boolean) => void
    timeout: number
    promise: Promise<boolean>
  }>())
  const composerRequestIdsRef = useRef(new Map<string, string>())
  const composerRequestKeysRef = useRef(new Map<string, string>())
  const composerAcceptedRequestsRef = useRef(new Set<string>())
  const [state, setState] = useState<WebSocketState>({
    accessMode: 'unknown',
    agents: [],
    agentInventoryComplete: false,
    taskHistory: [],
    mainPageSessionKeys: [],
    mainAgentId: null,
    connected: false,
    error: null,
    errorKind: 'error',
    errorId: 0,
    lastStartedAgentId: null,
    projectWorkspaces: null,
    projectAgentSummaries: [],
    pinnedProjectWorkspaces: null,
    browserResources: null,
    computerResources: null,
  })

  const mergeBrowserResource = useCallback((resource: BrowserResource) => {
    setState(prev => {
      const current = prev.browserResources
      if (!current) return prev
      const browserResources = applyBrowserResource(current, resource)
      return browserResources === current ? prev : { ...prev, browserResources }
    })
  }, [])

  const deleteBrowserResource = useCallback((deletion: BrowserResourceDeletion) => {
    setState(prev => {
      const current = prev.browserResources
      if (!current) return prev
      const browserResources = applyBrowserResourceDeletion(current, deletion)
      return browserResources === current ? prev : { ...prev, browserResources }
    })
  }, [])

  const mergeComputerResource = useCallback((resource: ComputerResource) => {
    setState(prev => {
      const current = prev.computerResources
      if (!current) return prev
      const computerResources = applyComputerResource(current, resource)
      return computerResources === current ? prev : { ...prev, computerResources }
    })
  }, [])

  const deleteComputerResource = useCallback((deletion: ComputerResourceDeletion) => {
    setState(prev => {
      const current = prev.computerResources
      if (!current) return prev
      const computerResources = applyComputerResourceDeletion(current, deletion)
      return computerResources === current ? prev : { ...prev, computerResources }
    })
  }, [])

  // Session output callback — components can subscribe
  const outputListenersRef = useRef<Map<string, (
    data: string,
    replace?: boolean,
    outputSeq?: number | null,
    runtimeEpoch?: string,
    stateRevision?: number | null,
    cols?: number,
    rows?: number,
    kind?: 'output' | 'resize' | 'clear',
  ) => void>>(new Map())
  const workspaceFileListenersRef = useRef<Map<string, Map<WorkspaceFileListener, WorkspaceFileListenerRegistration>>>(new Map())
  const acpRevisionListenersRef = useRef(new Set<(session: AcpSessionRevisionMessage['session']) => void>())

  const sendMessage = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      const disposition = outgoingWebSocketMessageDisposition(accessModeRef.current, msg)
      if (disposition === 'queue') {
        pendingAccessMessagesRef.current.push(msg)
        return true
      }
      if (disposition === 'silent') return true
      ws.send(JSON.stringify(msg))
      return true
    }
    setState(prev => ({
      ...prev,
      error: 'Farming backend is not connected',
      errorKind: 'recoverable',
      errorId: prev.errorId + 1,
    }))
    return false
  }, [])

  const syncWorkspaceFileWatch = useCallback((rootId: string) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || accessModeRef.current === 'unknown') return
    const listeners = workspaceFileListenersRef.current.get(rootId)
    const message: ClientMessage = listeners && listeners.size > 0
      ? { type: 'watch-workspace-files', rootId, paths: workspaceFileListenerPaths(listeners) }
      : { type: 'unwatch-workspace-files', rootId }
    if (outgoingWebSocketMessageDisposition(accessModeRef.current, message) === 'send') {
      ws.send(JSON.stringify(message))
    }
  }, [])

  const settleComposerRequest = useCallback((
    requestId: string,
    accepted: boolean,
    message = '',
    definitive = true,
    errorKind: WebSocketState['errorKind'] = 'error',
  ) => {
    const pending = composerRequestResolversRef.current.get(requestId)
    const requestKey = composerRequestKeysRef.current.get(requestId)
    if (!pending && accepted && requestKey) {
      composerAcceptedRequestsRef.current.add(requestId)
      return
    }
    if (definitive) {
      if (requestKey && composerRequestIdsRef.current.get(requestKey) === requestId) {
        composerRequestIdsRef.current.delete(requestKey)
      }
      composerRequestKeysRef.current.delete(requestId)
      composerAcceptedRequestsRef.current.delete(requestId)
    }
    if (!pending) return
    composerRequestResolversRef.current.delete(requestId)
    window.clearTimeout(pending.timeout)
    if (!accepted && message) {
      setState(prev => ({
        ...prev,
        error: message,
        errorKind,
        errorId: prev.errorId + 1,
      }))
    }
    pending.resolve(accepted)
  }, [])

  // The socket effect below must run exactly once: adding these handlers to its
  // dependency array would tear down and reconnect the WebSocket whenever any of
  // them is reidentified. Read them through a ref that is refreshed every render.
  const latestHandlersRef = useRef({
    settleComposerRequest,
    mergeBrowserResource,
    deleteBrowserResource,
    mergeComputerResource,
    deleteComputerResource,
  })
  latestHandlersRef.current = {
    settleComposerRequest,
    mergeBrowserResource,
    deleteBrowserResource,
    mergeComputerResource,
    deleteComputerResource,
  }

  const startAgent = useCallback((
    command: string,
    workspace?: string,
    asMain?: boolean,
    extras?: { task?: string; workflowTemplate?: string; customTitle?: string; projectWorkspace?: string; codexApprovalMode?: string; agentRuntimeMode?: 'terminal' | 'chat' | 'acp'; dangerouslySkipPermissions?: boolean; providerHomeId?: string; additionalDirectories?: string[]; mcpServers?: Array<Record<string, unknown>> }
  ) => {
    const msg: StartAgentMessage = {
      type: 'start-agent',
      requestId: globalThis.crypto?.randomUUID?.(),
      command,
      workspace,
      asMain,
    }
    if (extras?.task !== undefined) msg.task = extras.task
    if (extras?.workflowTemplate !== undefined) msg.workflowTemplate = extras.workflowTemplate
    if (extras?.customTitle !== undefined) msg.customTitle = extras.customTitle
    if (extras?.projectWorkspace !== undefined) msg.projectWorkspace = extras.projectWorkspace
    if (extras?.codexApprovalMode !== undefined) msg.codexApprovalMode = extras.codexApprovalMode
    if (extras?.agentRuntimeMode !== undefined) msg.agentRuntimeMode = extras.agentRuntimeMode
    if (extras?.dangerouslySkipPermissions !== undefined) msg.dangerouslySkipPermissions = extras.dangerouslySkipPermissions
    if (extras?.providerHomeId !== undefined) msg.providerHomeId = extras.providerHomeId
    if (extras?.additionalDirectories !== undefined) msg.additionalDirectories = extras.additionalDirectories
    if (extras?.mcpServers !== undefined) msg.mcpServers = extras.mcpServers
    return sendMessage(msg)
  }, [sendMessage])

  const sendComposerInput = useCallback((
    message: string,
    agentId?: string,
    attachments: ComposerInputAttachment[] = [],
    options?: { awaitResult?: boolean; requestId?: string; delivery?: 'prompt' | 'steer' },
  ) => {
    const explicitRequestId = String(options?.requestId || '').trim()
    const requestKey = explicitRequestId
      ? `request:${explicitRequestId}`
      : JSON.stringify({
        agentId: agentId || '',
        message,
        delivery: options?.delivery || '',
        attachments: attachments.map(attachment => ({
          kind: attachment.kind,
          path: attachment.path,
          type: attachment.type,
        })),
      })
    const requestId = explicitRequestId
      || composerRequestIdsRef.current.get(requestKey)
      || globalThis.crypto?.randomUUID?.()
      || `composer-${Date.now().toString(36)}-${++composerRequestSequenceRef.current}`
    composerRequestIdsRef.current.set(requestKey, requestId)
    composerRequestKeysRef.current.set(requestId, requestKey)
    if (composerAcceptedRequestsRef.current.delete(requestId)) {
      composerRequestIdsRef.current.delete(requestKey)
      composerRequestKeysRef.current.delete(requestId)
      return Promise.resolve(true)
    }
    const pending = composerRequestResolversRef.current.get(requestId)
    if (pending) return pending.promise
    const input: ComposerInputMessage = {
      type: 'composer-input',
      requestId,
      message,
      agentId,
      ...(options?.delivery ? { delivery: options.delivery } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    }
    let resolveRequest: (accepted: boolean) => void = () => {}
    const promise = new Promise<boolean>(resolve => {
      resolveRequest = resolve
    })
    const timeout = window.setTimeout(() => {
        settleComposerRequest(
          requestId,
          false,
          'Chat submission has an uncertain outcome. Your draft is still available; retrying will reconcile the same request.',
          false,
        )
    }, 15_000)
    composerRequestResolversRef.current.set(requestId, { resolve: resolveRequest, timeout, promise })
    if (!sendMessage(input)) {
      settleComposerRequest(
        requestId,
        false,
        'Farming backend is not connected. Your draft is still available.',
        true,
        'recoverable',
      )
    }
    return promise
  }, [sendMessage, settleComposerRequest])

  const focusAgent = useCallback((
    agentId: string | null,
    options: {
      activityScope?: 'all' | 'focused' | 'none'
      previewScope?: 'all' | 'focused' | 'none'
    } = {},
  ) => {
    const activityScope = options.activityScope ?? 'all'
    const previewScope = options.previewScope ?? agentPreviewScopeRef.current
    focusedAgentIdRef.current = agentId
    agentActivityScopeRef.current = activityScope
    agentPreviewScopeRef.current = previewScope
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({
      type: 'focus-agent',
      agentId,
      activityScope,
      previewScope,
    }))
    return true
  }, [])

  const watchAcpTranscripts = useCallback((agentIds: readonly string[]) => {
    const normalizedAgentIds = Array.from(new Set(agentIds)).sort().slice(0, 20)
    if (sameStringArray(watchedAcpTranscriptAgentIdsRef.current, normalizedAgentIds)) return true
    watchedAcpTranscriptAgentIdsRef.current = normalizedAgentIds
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || accessModeRef.current === 'unknown') return false
    ws.send(JSON.stringify({ type: 'watch-acp-transcripts', agentIds: normalizedAgentIds }))
    return true
  }, [])

  const onAcpSessionRevision = useCallback((handler: (session: AcpSessionRevisionMessage['session']) => void) => {
    acpRevisionListenersRef.current.add(handler)
    return () => { acpRevisionListenersRef.current.delete(handler) }
  }, [])

  const interruptAgent = useCallback((agentId: string) => {
    return sendMessage({ type: 'interrupt-agent', agentId })
  }, [sendMessage])

  const restartMainAgent = useCallback((command: string) => {
    return sendMessage({ type: 'restart-main-agent', command })
  }, [sendMessage])

  const onSessionOutput = useCallback((agentId: string, handler: (
    data: string,
    replace?: boolean,
    outputSeq?: number | null,
    runtimeEpoch?: string,
    stateRevision?: number | null,
    cols?: number,
    rows?: number,
    kind?: 'output' | 'resize' | 'clear',
  ) => void) => {
    outputListenersRef.current.set(agentId, handler)
    return () => { outputListenersRef.current.delete(agentId) }
  }, [])

  const watchWorkspaceFiles = useCallback((
    agentId: string,
    paths: readonly string[],
    handler: WorkspaceFileListener,
    onReady?: (paths: readonly string[], reason: WorkspaceFileWatchReadyReason) => void,
  ): WorkspaceFileWatchRegistration => {
    const normalizedPaths = Array.from(new Set(paths)).sort()
    if (normalizedPaths.length === 0) return { update: () => {}, close: () => {} }
    let listeners = workspaceFileListenersRef.current.get(agentId)
    if (!listeners) {
      listeners = new Map()
      workspaceFileListenersRef.current.set(agentId, listeners)
    }
    const registration: WorkspaceFileListenerRegistration = {
      onEvent: handler,
      onReady,
      paths: normalizedPaths,
      pendingReadyReasons: new Map(normalizedPaths.map(filePath => [filePath, 'watch-added'])),
    }
    listeners.set(handler, registration)
    syncWorkspaceFileWatch(agentId)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      const currentListeners = workspaceFileListenersRef.current.get(agentId)
      if (!currentListeners) return

      currentListeners.delete(handler)
      if (currentListeners.size === 0) {
        workspaceFileListenersRef.current.delete(agentId)
      }
      syncWorkspaceFileWatch(agentId)
    }
    return {
      update(nextPaths) {
        if (closed) return
        const nextNormalizedPaths = Array.from(new Set(nextPaths)).sort()
        if (sameStringArray([...registration.paths], nextNormalizedPaths)) return
        const nextPathSet = new Set(nextNormalizedPaths)
        registration.paths.forEach(filePath => {
          if (!nextPathSet.has(filePath)) registration.pendingReadyReasons.delete(filePath)
        })
        nextNormalizedPaths.forEach(filePath => {
          if (!registration.paths.includes(filePath)) {
            registration.pendingReadyReasons.set(filePath, 'watch-added')
          }
        })
        registration.paths = nextNormalizedPaths
        const currentListeners = workspaceFileListenersRef.current.get(agentId)
        if (currentListeners?.get(handler) !== registration) return
        if (nextNormalizedPaths.length === 0) {
          close()
          return
        }
        syncWorkspaceFileWatch(agentId)
      },
      close,
    }
  }, [syncWorkspaceFileWatch])

  useEffect(() => {
    setTerminalSessionTransport(message => sendMessage(message))
    setTerminalSessionTransportReady(false)
    setWorkspaceRequestTransport(message => sendMessage(message))
    setWorkspaceRequestTransportReady(false)
    return () => {
      setTerminalSessionTransportReady(false)
      setTerminalSessionTransport(null)
      setWorkspaceRequestTransportReady(false)
      setWorkspaceRequestTransport(null)
    }
  }, [sendMessage])

  useEffect(() => {
    resetBackendConnectionStatus()
    resetAgentLiveStates()
    let reconnectTimer: ReturnType<typeof setTimeout>
    let disposed = false
    let reconnectBlocked = false
    let activeSocket: WebSocket | null = null
    let lastMessageStateUpdateAt = 0
    let businessProbeTimer: ReturnType<typeof setTimeout> | null = null
    let businessProbeTrace: PerformanceTrace | null = null
    let businessProbeDeadline: ReturnType<typeof setTimeout> | null = null
    let socketConnectDeadline: ReturnType<typeof setTimeout> | null = null
    let socketCloseDeadline: ReturnType<typeof setTimeout> | null = null
    let agentStateSnapshotDeadline: ReturnType<typeof setTimeout> | null = null
    let pendingBusinessProbeId = ''
    let businessProbeSequence = 0
    let nativeBrowserUnsubscribe: (() => void) | null = null
    let nativeBrowserAdapterServerEpoch = ''
    let nativeBrowserAdapterRegisteredServerEpoch = ''
    let nativeBrowserReconciliationGeneration = 0
    let nativeBrowserLeaseInvalidation: Promise<void> = Promise.resolve()

    function invalidateNativeBrowserLease() {
      nativeBrowserReconciliationGeneration += 1
      nativeBrowserUnsubscribe?.()
      nativeBrowserUnsubscribe = null
      nativeBrowserAdapterServerEpoch = ''
      nativeBrowserAdapterRegisteredServerEpoch = ''
      const nativeBrowser = window.farmingDesktop?.nativeBrowser
      if (!nativeBrowser) return
      nativeBrowserLeaseInvalidation = nativeBrowserLeaseInvalidation
        .catch(() => {})
        .then(() => nativeBrowser.invalidateLease())
        .catch(() => {})
    }

    async function reconcileAndRegisterNativeBrowserAdapter(
      ws: WebSocket,
      serverEpoch: string,
    ) {
      const nativeBrowser = window.farmingDesktop?.nativeBrowser
      if (!nativeBrowser || accessModeRef.current !== 'owner') return
      if (
        nativeBrowserAdapterServerEpoch === serverEpoch
        && nativeBrowserUnsubscribe
      ) {
        if (nativeBrowserAdapterRegisteredServerEpoch === serverEpoch) return
        ws.send(JSON.stringify({
          type: 'desktop-browser-adapter-register',
          adapterId: nativeBrowser.adapterId,
        }))
        return
      }
      const reconciliationGeneration = ++nativeBrowserReconciliationGeneration
      nativeBrowserUnsubscribe?.()
      nativeBrowserUnsubscribe = null
      nativeBrowserAdapterServerEpoch = ''
      nativeBrowserAdapterRegisteredServerEpoch = ''
      await nativeBrowserLeaseInvalidation
      await nativeBrowser.reconcileBackendEpoch(serverEpoch)
      if (
        reconciliationGeneration !== nativeBrowserReconciliationGeneration
        || disposed
        || wsRef.current !== ws
        || ws.readyState !== WebSocket.OPEN
        || accessModeRef.current !== 'owner'
      ) return
      nativeBrowserUnsubscribe = nativeBrowser.onEvent(event => {
        if (
          disposed
          || wsRef.current !== ws
          || ws.readyState !== WebSocket.OPEN
          || accessModeRef.current !== 'owner'
        ) return
        ws.send(JSON.stringify({
          type: 'desktop-browser-adapter-event',
          adapterId: nativeBrowser.adapterId,
          ...event,
        }))
      })
      nativeBrowserAdapterServerEpoch = serverEpoch
      ws.send(JSON.stringify({
        type: 'desktop-browser-adapter-register',
        adapterId: nativeBrowser.adapterId,
      }))
    }

    function clearAgentStateSnapshotDeadline() {
      if (agentStateSnapshotDeadline) clearTimeout(agentStateSnapshotDeadline)
      agentStateSnapshotDeadline = null
    }

    function requestAgentStateResync(ws: WebSocket, snapshotFailed = false) {
      if (ws.readyState !== WebSocket.OPEN) return
      const discardSequence = snapshotFailed || Boolean(agentStateSnapshotCursorRef.current)
      agentStateResyncPendingRef.current = true
      agentStateSnapshotAgentsRef.current = []
      agentStateSnapshotCursorRef.current = null
      clearAgentStateSnapshotDeadline()
      ws.send(JSON.stringify({
        type: 'state-resync',
        generation: discardSequence ? undefined : agentStateCursorRef.current?.generation,
        afterSequence: discardSequence ? undefined : agentStateCursorRef.current?.sequence,
      }))
      armAgentStateSnapshotDeadline(ws)
    }

    function armAgentStateSnapshotDeadline(ws: WebSocket) {
      clearAgentStateSnapshotDeadline()
      agentStateSnapshotDeadline = setTimeout(() => {
        agentStateSnapshotDeadline = null
        if (disposed || wsRef.current !== ws) return
        if (agentStateSnapshotCursorRef.current) {
          requestAgentStateResync(ws, true)
        } else if (agentStateResyncPendingRef.current) {
          ws.close(4000, 'Agent state resync timed out')
        }
      }, AGENT_STATE_SNAPSHOT_PAGE_DEADLINE_MS)
    }

    function markBackendMessage(receivedAt = Date.now()) {
      if (receivedAt - lastMessageStateUpdateAt < LAST_MESSAGE_STATE_THROTTLE_MS) return
      lastMessageStateUpdateAt = receivedAt
      updateBackendConnectionStatus({ lastMessageAt: receivedAt })
    }

    function clearBusinessProbeTimers() {
      businessProbeTrace?.end(document.visibilityState === 'hidden' ? 'hidden' : 'cancelled')
      businessProbeTrace = null
      if (businessProbeTimer) clearTimeout(businessProbeTimer)
      if (businessProbeDeadline) clearTimeout(businessProbeDeadline)
      businessProbeTimer = null
      businessProbeDeadline = null
    }

    function clearSocketConnectDeadline() {
      if (socketConnectDeadline) clearTimeout(socketConnectDeadline)
      socketConnectDeadline = null
    }

    function clearSocketCloseDeadline() {
      if (socketCloseDeadline) clearTimeout(socketCloseDeadline)
      socketCloseDeadline = null
    }

    function scheduleBusinessProbe(ws: WebSocket, delay: number) {
      if (businessProbeTimer) clearTimeout(businessProbeTimer)
      businessProbeTimer = setTimeout(() => {
        businessProbeTimer = null
        sendBusinessProbe(ws)
      }, delay)
    }

    function sendBusinessProbe(
      ws: WebSocket,
      deadlineMs = BUSINESS_HEALTH_DEADLINE_MS,
      replaceOnTimeout = false,
    ) {
      if (
        disposed
        || wsRef.current !== ws
        || ws.readyState !== WebSocket.OPEN
        || document.visibilityState === 'hidden'
      ) return

      if (businessProbeDeadline) clearTimeout(businessProbeDeadline)
      const requestId = globalThis.crypto?.randomUUID?.()
        || `health-${Date.now().toString(36)}-${++businessProbeSequence}`
      pendingBusinessProbeId = requestId
      businessProbeTrace?.end('superseded')
      businessProbeTrace = beginInteraction('connection.probe', { requestId, timeout: deadlineMs + 1000 })
      businessProbeTrace.metric({ socketBytes: ws.bufferedAmount })
      ws.send(JSON.stringify({ type: 'business-health-probe', requestId }))
      businessProbeTrace.mark('sent')
      businessProbeDeadline = setTimeout(() => {
        if (pendingBusinessProbeId !== requestId || wsRef.current !== ws) return
        businessProbeTrace?.end('timeout'); businessProbeTrace = null
        pendingBusinessProbeId = ''
        businessProbeDeadline = null
        updateBackendConnectionStatus({
          businessStatus: 'unresponsive',
          businessCheckedAt: Date.now(),
        })
        if (replaceOnTimeout) {
          replaceConnection(ws, 'Business health probe timed out')
        } else {
          scheduleBusinessProbe(ws, BUSINESS_HEALTH_RETRY_MS)
        }
      }, deadlineMs)
    }

    function resetBusinessProbeObservation() {
      clearBusinessProbeTimers()
      pendingBusinessProbeId = ''
      updateBackendConnectionStatus({
        businessStatus: 'checking',
        businessCheckedAt: null,
        businessServerEpoch: '',
      })
    }

    function replaceConnection(ws: WebSocket, reason: string, closeCode = 4000) {
      if (disposed || reconnectBlocked || wsRef.current !== ws) return
      clearSocketCloseDeadline()
      try {
        ws.close(closeCode, reason)
      } catch {
        // The bounded fallback below owns cleanup if the mobile browser has
        // already discarded the native socket behind this JavaScript object.
      }
      socketCloseDeadline = setTimeout(() => {
        socketCloseDeadline = null
        if (disposed || wsRef.current !== ws) return
        const closeHandler = ws.onclose
        ws.onclose = null
        closeHandler?.call(ws, new CloseEvent('close', { code: closeCode, reason, wasClean: false }))
      }, WEBSOCKET_CLOSE_DEADLINE_MS)
    }

    function recoverForegroundConnection() {
      resetBusinessProbeObservation()
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        sendBusinessProbe(ws, FOREGROUND_BUSINESS_HEALTH_DEADLINE_MS, true)
        return
      }
      if (ws?.readyState === WebSocket.CONNECTING) return
      if (ws) {
        // Mobile browsers can update readyState after suspending a page but
        // omit or indefinitely delay the matching close event. Reuse the
        // bounded replacement path so a stale CLOSING/CLOSED object cannot
        // keep wsRef occupied forever on resume.
        replaceConnection(ws, 'WebSocket was closed while the page was suspended')
        return
      }
      connect()
    }

    function handlePageVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        resetBusinessProbeObservation()
        return
      }
      recoverForegroundConnection()
    }

    function handlePageShow() {
      recoverForegroundConnection()
    }

    function handleOnline() {
      recoverForegroundConnection()
    }

    document.addEventListener('visibilitychange', handlePageVisibilityChange)
    window.addEventListener('pageshow', handlePageShow)
    window.addEventListener('online', handleOnline)

    function connect() {
      // ACP transcript revisions and terminal output arrive on this socket.
      // Keep it alive in hidden tabs so Chat keeps progressing and returning
      // to the page does not manufacture a disconnected/reconnecting state.
      if (disposed || reconnectBlocked) return
      const currentSocket = wsRef.current
      if (
        currentSocket
        && (currentSocket.readyState === WebSocket.OPEN || currentSocket.readyState === WebSocket.CONNECTING)
      ) return
      setTerminalSessionTransportReady(false)
      setWorkspaceRequestTransportReady(false)
      accessModeRef.current = 'unknown'
      pendingAccessMessagesRef.current = []
      setState(prev => prev.accessMode === 'unknown' ? prev : { ...prev, accessMode: 'unknown' })
      let wsUrl = appWsUrl()
      const startupToken = getStartupAccessToken()
      // Attach token from cookie for mobile WS compatibility
      const tokenMatch = document.cookie.match(/(?:^|;\s*)farming_token=([^;]+)/)
      const token = startupToken || tokenMatch?.[1] || ''
      if (token) {
        wsUrl += `?token=${token}`
      }
      const ws = new WebSocket(wsUrl)
      activeSocket = ws
      wsRef.current = ws
      clearSocketConnectDeadline()
      socketConnectDeadline = setTimeout(() => {
        socketConnectDeadline = null
        if (disposed || wsRef.current !== ws || ws.readyState === WebSocket.OPEN) return
        replaceConnection(ws, 'WebSocket connection timed out')
      }, WEBSOCKET_CONNECT_DEADLINE_MS)
      // Actionable upgrade guidance shown when this connection ends with a
      // protocol-mismatch close instead of the generic refresh hint.
      let protocolMismatchNotice = ''

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return
        clearSocketConnectDeadline()
        lastMessageStateUpdateAt = Date.now()
        setState(prev => ({
          ...prev,
          connected: true,
          error: null,
        }))
        updateBackendConnectionStatus({
          connected: true,
          reconnecting: false,
          everConnected: true,
          lastMessageAt: lastMessageStateUpdateAt,
          disconnectedAt: null,
          businessStatus: 'checking',
          businessCheckedAt: null,
          businessServerEpoch: '',
        })
        ws.send(JSON.stringify({ type: 'protocol-hello', protocolVersion: PROTOCOL_VERSION }))
        ws.send(JSON.stringify({
          type: 'focus-agent',
          agentId: focusedAgentIdRef.current,
          activityScope: agentActivityScopeRef.current,
          previewScope: agentPreviewScopeRef.current,
        }))
        sendBusinessProbe(ws)
        window.dispatchEvent(new Event('farming:backend-connected'))
      }

      ws.onmessage = (event) => {
        if (disposed || wsRef.current !== ws) return
        markBackendMessage()
        try {
          const parsed: unknown = JSON.parse(event.data)
          const validation = validateServerMessage(parsed)
          if (!validation.ok) throw new Error(validation.error)
          const msg = parsed as ServerMessage
          switch (msg.type) {
            case 'protocol-hello': {
              const accessMode = msg.accessMode === 'read-only' ? 'read-only' : 'owner'
              accessModeRef.current = accessMode
              setState(prev => ({
                ...prev,
                accessMode,
              }))
              if (!protocolCompatible(msg.protocolVersion)) {
                if (claimProtocolUpgradeReload(
                  PROTOCOL_VERSION,
                  msg.protocolVersion,
                  window.sessionStorage,
                  `code:${appWsUrl()}`,
                )) {
                  window.location.reload()
                  return
                }
                protocolMismatchNotice = msg.protocolVersion < MIN_PROTOCOL_VERSION
                  ? `This page requires a newer Farming backend (protocol ${MIN_PROTOCOL_VERSION}, backend has ${msg.protocolVersion}). Update and restart the Farming backend.`
                  : 'The Farming backend is newer than this page. Refresh this page to load the updated interface.'
                replaceConnection(
                  ws,
                  `Unsupported Farming protocol version ${msg.protocolVersion}`,
                  4002,
                )
              } else {
                setTerminalSessionTransportReady(true)
                setWorkspaceRequestTransportReady(
                  true,
                  msg.maxInlineWorkspaceMessageBytes,
                )
                const pendingMessages = pendingAccessMessagesRef.current
                pendingAccessMessagesRef.current = []
                pendingMessages.forEach(message => {
                  if (replayableWebSocketMessage(accessMode, message)) {
                    ws.send(JSON.stringify(message))
                  }
                })
                workspaceFileListenersRef.current.forEach((listeners, rootId) => {
                  if (listeners.size === 0) return
                  listeners.forEach(listener => {
                    listener.pendingReadyReasons = new Map(
                      listener.paths.map(filePath => [filePath, 'reconnected']),
                    )
                  })
                  ws.send(JSON.stringify({
                    type: 'watch-workspace-files',
                    rootId,
                    paths: workspaceFileListenerPaths(listeners),
                  }))
                })
                ws.send(JSON.stringify({
                  type: 'watch-acp-transcripts',
                  agentIds: watchedAcpTranscriptAgentIdsRef.current,
                }))
              }
              break
            }
            case 'protocol-error':
              protocolMismatchNotice = msg.message
              setState(prev => ({
                ...prev,
                error: msg.message,
                errorKind: 'error',
                errorId: prev.errorId + 1,
              }))
              break
            case 'business-health-result': {
              if (msg.requestId !== pendingBusinessProbeId) break
              businessProbeTrace?.mark('received')
              businessProbeTrace?.end(msg.status === 'ready' ? 'completed' : 'failed')
              businessProbeTrace = null
              pendingBusinessProbeId = ''
              if (businessProbeDeadline) clearTimeout(businessProbeDeadline)
              businessProbeDeadline = null
              updateBackendConnectionStatus({
                businessStatus: msg.status,
                businessCheckedAt: Date.now(),
                businessServerEpoch: msg.serverEpoch,
              })
              void reconcileAndRegisterNativeBrowserAdapter(ws, msg.serverEpoch).catch(error => {
                if (disposed || wsRef.current !== ws) return
                setState(prev => ({
                  ...prev,
                  error: error instanceof Error
                    ? `Desktop Browser lease reconciliation failed: ${error.message}`
                    : 'Desktop Browser lease reconciliation failed',
                  errorKind: 'error',
                  errorId: prev.errorId + 1,
                }))
              })
              scheduleBusinessProbe(
                ws,
                msg.status === 'ready' ? BUSINESS_HEALTH_INTERVAL_MS : BUSINESS_HEALTH_RETRY_MS,
              )
              break
            }
            case 'terminal-checkpoint-result':
              settleTerminalSessionCheckpoint(msg)
              break
            case 'command-ack':
              break
            case 'state': {
              if (
                agentStateResyncPendingRef.current
                && msg.snapshot
                && msg.snapshot.offset !== 0
              ) break
              if (
                msg.snapshot?.offset === 0
                && (
                  !Object.prototype.hasOwnProperty.call(msg.state, 'mainAgentId')
                  || !Array.isArray(msg.state.taskHistory)
                )
              ) {
                requestAgentStateResync(ws, true)
                break
              }
              const snapshotTransition = msg.snapshot
                ? advanceAgentStateSnapshot(
                    agentStateSnapshotCursorRef.current,
                    msg.generation,
                    msg.sequence,
                    msg.snapshot,
                    msg.state.agents.length,
                  )
                : { cursor: null, disposition: 'replace' as const }
              if (snapshotTransition.disposition === 'resync') {
                requestAgentStateResync(ws, true)
                break
              }
              const previousAgentSignatures = new Map(agentStateSignaturesRef.current)
              if (
                snapshotTransition.disposition === 'append'
                && (
                  previousAgentSignatures.size !== msg.snapshot?.offset
                  || msg.state.agents.some(agent => previousAgentSignatures.has(agent.id))
                )
              ) {
                requestAgentStateResync(ws, true)
                break
              }
              agentStateSnapshotCursorRef.current = snapshotTransition.cursor
              if (!snapshotTransition.cursor) {
                agentStateCursorRef.current = {
                  generation: msg.generation,
                  sequence: msg.sequence,
                }
              }
              agentStateResyncPendingRef.current = false
              if (snapshotTransition.cursor) armAgentStateSnapshotDeadline(ws)
              else clearAgentStateSnapshotDeadline()
              if (msg.state.systemStats !== undefined) {
                updateBackendSystemStats(msg.state.systemStats ?? null)
              }
              const snapshotAgents = snapshotTransition.disposition === 'append'
                ? [...agentStateSnapshotAgentsRef.current, ...msg.state.agents]
                : [...msg.state.agents]
              agentStateSnapshotAgentsRef.current = snapshotTransition.cursor ? snapshotAgents : []
              if (snapshotTransition.disposition === 'append') {
                msg.state.agents.forEach(agent => {
                  agentStateSignaturesRef.current.set(agent.id, JSON.stringify(agent))
                })
              } else {
                agentStateSignaturesRef.current = new Map(msg.state.agents.map(agent => [
                  agent.id,
                  JSON.stringify(agent),
                ]))
              }
              if (snapshotTransition.disposition === 'append' && snapshotTransition.cursor) {
                reconcileAgentLiveStateDelta(msg.state.agents, [])
                setState(prev => {
                  const previousAgents = new Map(prev.agents.map(agent => [agent.id, agent]))
                  const normalizedUpserts = msg.state.agents.map(agent => (
                    normalizeStateAgent(agent, prev.mainAgentId, previousAgents.get(agent.id))
                  ))
                  const nextAgents = applyAgentStateDelta(prev.agents, normalizedUpserts, [])
                  if (nextAgents === prev.agents && prev.agentInventoryComplete === false) return prev
                  return { ...prev, agents: nextAgents, agentInventoryComplete: false }
                })
                break
              }

              const authoritativeAgents = snapshotTransition.cursor ? msg.state.agents : snapshotAgents
              if (snapshotTransition.cursor) reconcileAgentLiveStateDelta(msg.state.agents, [])
              else reconcileAgentLiveStates(authoritativeAgents)
              const nextAgentSignatures = agentStateSignaturesRef.current
              setState(prev => {
                const nextMainAgentId = Object.prototype.hasOwnProperty.call(msg.state, 'mainAgentId')
                  ? msg.state.mainAgentId ?? null
                  : prev.mainAgentId
                const previousAgents = new Map(prev.agents.map(agent => [agent.id, agent]))
                let agentsChanged = prev.agents.length !== authoritativeAgents.length
                const reconciledAgents = authoritativeAgents.map((agent, index) => {
                  const previous = previousAgents.get(agent.id)
                  const signature = nextAgentSignatures.get(agent.id)
                  const isMain = agent.isMain || agent.id === nextMainAgentId || isInternalMainWorkspace(agent.cwd, agent.parentAgentId)
                  if (
                    previous
                    && previous.id === prev.agents[index]?.id
                    && previous.isMain === isMain
                    && previousAgentSignatures.get(agent.id) === signature
                  ) {
                    return previous
                  }
                  agentsChanged = true
                  return normalizeStateAgent(agent, nextMainAgentId, previous)
                })

                const nextAgents = snapshotTransition.cursor
                  ? applyAgentStateDelta(prev.agents, reconciledAgents, [])
                  : (agentsChanged ? reconciledAgents : prev.agents)
                const nextTaskHistory = msg.state.taskHistory ?? prev.taskHistory
                const nextMainPageSessionKeys = Array.isArray(msg.state.mainPageSessionKeys)
                  ? msg.state.mainPageSessionKeys
                  : prev.mainPageSessionKeys
                const nextProjectWorkspaces = Array.isArray(msg.state.projectWorkspaces)
                  ? msg.state.projectWorkspaces
                  : prev.projectWorkspaces
                const nextProjectAgentSummaries = Array.isArray(msg.state.projectAgentSummaries)
                  ? msg.state.projectAgentSummaries
                  : prev.projectAgentSummaries
                const nextPinnedProjectWorkspaces = Array.isArray(msg.state.pinnedProjectWorkspaces)
                  ? msg.state.pinnedProjectWorkspaces
                  : prev.pinnedProjectWorkspaces
                const taskHistoryChanged = nextTaskHistory !== prev.taskHistory
                  && !sameJsonValue(nextTaskHistory, prev.taskHistory)
                const mainPageSessionKeysChanged = nextMainPageSessionKeys !== prev.mainPageSessionKeys
                  && !sameStringArray(nextMainPageSessionKeys, prev.mainPageSessionKeys)
                const projectWorkspacesChanged = nextProjectWorkspaces !== prev.projectWorkspaces
                  && (prev.projectWorkspaces === null || !sameStringArray(nextProjectWorkspaces ?? [], prev.projectWorkspaces))
                const projectAgentSummariesChanged = nextProjectAgentSummaries !== prev.projectAgentSummaries
                  && !sameJsonValue(nextProjectAgentSummaries, prev.projectAgentSummaries)
                const pinnedProjectWorkspacesChanged = nextPinnedProjectWorkspaces !== prev.pinnedProjectWorkspaces
                  && (prev.pinnedProjectWorkspaces === null || !sameStringArray(nextPinnedProjectWorkspaces ?? [], prev.pinnedProjectWorkspaces))

                if (
                  nextAgents === prev.agents
                  && !taskHistoryChanged
                  && !mainPageSessionKeysChanged
                  && !projectWorkspacesChanged
                  && !projectAgentSummariesChanged
                  && !pinnedProjectWorkspacesChanged
                  && nextMainAgentId === prev.mainAgentId
                  && prev.agentInventoryComplete === !snapshotTransition.cursor
                ) {
                  return prev
                }

                return {
                  ...prev,
                  agents: nextAgents,
                  agentInventoryComplete: !snapshotTransition.cursor,
                  taskHistory: taskHistoryChanged ? nextTaskHistory : prev.taskHistory,
                  mainPageSessionKeys: mainPageSessionKeysChanged ? nextMainPageSessionKeys : prev.mainPageSessionKeys,
                  projectWorkspaces: projectWorkspacesChanged ? nextProjectWorkspaces : prev.projectWorkspaces,
                  projectAgentSummaries: projectAgentSummariesChanged
                    ? nextProjectAgentSummaries
                    : prev.projectAgentSummaries,
                  pinnedProjectWorkspaces: pinnedProjectWorkspacesChanged
                    ? nextPinnedProjectWorkspaces
                    : prev.pinnedProjectWorkspaces,
                  mainAgentId: nextMainAgentId,
                }
              })
              break
            }
            case 'state-delta': {
              if (agentStateResyncPendingRef.current) break
              if (agentStateSnapshotCursorRef.current) {
                requestAgentStateResync(ws)
                break
              }
              const disposition = agentStateDeltaDisposition(
                agentStateCursorRef.current,
                msg.generation,
                msg.sequence,
              )
              if (disposition === 'ignore') break
              if (disposition === 'resync') {
                requestAgentStateResync(ws)
                break
              }

              agentStateCursorRef.current = {
                generation: msg.generation,
                sequence: msg.sequence,
              }
              if (msg.state?.systemStats !== undefined) {
                updateBackendSystemStats(msg.state.systemStats ?? null)
              }
              reconcileAgentLiveStateDelta(msg.upserts, msg.removedAgentIds)
              setState(prev => {
                const hasMainAgentId = msg.state !== undefined
                  && Object.prototype.hasOwnProperty.call(msg.state, 'mainAgentId')
                const nextMainAgentId = hasMainAgentId
                  ? msg.state?.mainAgentId ?? null
                  : prev.mainAgentId
                const previousAgents = new Map(prev.agents.map(agent => [agent.id, agent]))
                const normalizedUpserts = msg.upserts.map(agent => {
                  agentStateSignaturesRef.current.set(agent.id, JSON.stringify(agent))
                  return normalizeStateAgent(agent, nextMainAgentId, previousAgents.get(agent.id))
                })
                msg.removedAgentIds.forEach(agentId => agentStateSignaturesRef.current.delete(agentId))
                const nextAgents = applyAgentStateDelta(
                  prev.agents,
                  normalizedUpserts,
                  msg.removedAgentIds,
                )
                const nextTaskHistory = msg.state?.taskHistory ?? prev.taskHistory
                const nextMainPageSessionKeys = Array.isArray(msg.state?.mainPageSessionKeys)
                  ? msg.state.mainPageSessionKeys
                  : prev.mainPageSessionKeys
                const nextProjectWorkspaces = Array.isArray(msg.state?.projectWorkspaces)
                  ? msg.state.projectWorkspaces
                  : prev.projectWorkspaces
                const nextPinnedProjectWorkspaces = Array.isArray(msg.state?.pinnedProjectWorkspaces)
                  ? msg.state.pinnedProjectWorkspaces
                  : prev.pinnedProjectWorkspaces
                const taskHistoryChanged = nextTaskHistory !== prev.taskHistory
                  && !sameJsonValue(nextTaskHistory, prev.taskHistory)
                const mainPageSessionKeysChanged = nextMainPageSessionKeys !== prev.mainPageSessionKeys
                  && !sameStringArray(nextMainPageSessionKeys, prev.mainPageSessionKeys)
                const projectWorkspacesChanged = nextProjectWorkspaces !== prev.projectWorkspaces
                  && (prev.projectWorkspaces === null || !sameStringArray(nextProjectWorkspaces ?? [], prev.projectWorkspaces))
                const pinnedProjectWorkspacesChanged = nextPinnedProjectWorkspaces !== prev.pinnedProjectWorkspaces
                  && (prev.pinnedProjectWorkspaces === null || !sameStringArray(nextPinnedProjectWorkspaces ?? [], prev.pinnedProjectWorkspaces))

                if (
                  nextAgents === prev.agents
                  && !taskHistoryChanged
                  && !mainPageSessionKeysChanged
                  && !projectWorkspacesChanged
                  && !pinnedProjectWorkspacesChanged
                  && nextMainAgentId === prev.mainAgentId
                ) {
                  return prev
                }

                return {
                  ...prev,
                  agents: nextAgents,
                  taskHistory: taskHistoryChanged ? nextTaskHistory : prev.taskHistory,
                  mainPageSessionKeys: mainPageSessionKeysChanged ? nextMainPageSessionKeys : prev.mainPageSessionKeys,
                  projectWorkspaces: projectWorkspacesChanged ? nextProjectWorkspaces : prev.projectWorkspaces,
                  pinnedProjectWorkspaces: pinnedProjectWorkspacesChanged
                    ? nextPinnedProjectWorkspaces
                    : prev.pinnedProjectWorkspaces,
                  mainAgentId: nextMainAgentId,
                }
              })
              break
            }
            case 'error': {
              setState(prev => ({
                ...prev,
                error: msg.message,
                errorKind: 'error',
                errorId: prev.errorId + 1,
              }))
              // Visible fence errors and unconfirmed deliveries drive the
              // explicit viewer-observed reconciliation: request the
              // checkpoint for the exact Agent so an attached session
              // recovers without a reconnect or a sacrificial second input.
              reconcileTerminalFenceError(msg as { agentId?: unknown; reason?: unknown })
              break
            }
            case 'composer-input-result':
              latestHandlersRef.current.settleComposerRequest(msg.requestId, msg.accepted, msg.message || '', msg.uncertain !== true)
              break
            case 'agent-started':
              setState(prev => ({ ...prev, lastStartedAgentId: msg.agentId }))
              break
            case 'agent-update':
              updateAgentLiveState(msg.update.agentId, msg.update.patch)
              break
            case 'acp-session-revision':
              acpRevisionListenersRef.current.forEach(listener => listener(msg.session))
              if (msg.session.agentId === focusedAgentIdRef.current) {
                updateAgentAcpSessionRevision(msg.session)
              }
              break
            case 'session-preview':
              updateAgentLivePreview(msg.preview)
              break
            case 'session-output': {
              const listener = outputListenersRef.current.get(msg.stream.agentId)
              if (listener && msg.stream.replace === true) {
                listener(
                  msg.stream.data,
                  true,
                  msg.stream.outputSeq,
                  msg.stream.runtimeEpoch,
                  msg.stream.stateRevision,
                  msg.stream.cols,
                  msg.stream.rows,
                )
              }
              if (listener && Array.isArray(msg.stream.chunks)) {
                msg.stream.chunks.forEach(chunk => {
                  listener(
                    chunk.data,
                    false,
                    chunk.outputSeq,
                    chunk.runtimeEpoch,
                    chunk.stateRevision,
                    chunk.cols,
                    chunk.rows,
                    chunk.kind,
                  )
                })
              } else if (listener && msg.stream.replace !== true) {
                listener(
                  msg.stream.data,
                  msg.stream.replace,
                  msg.stream.outputSeq,
                  msg.stream.runtimeEpoch,
                  msg.stream.stateRevision,
                  msg.stream.cols,
                  msg.stream.rows,
                  msg.stream.kind,
                )
              }
              break
            }
            case 'agent-activity':
              updateAgentLiveActivity(msg.activity)
              break
            case 'agent-activity-snapshot':
              updateAgentLiveActivities(msg.activities)
              break
            case 'agent-read':
              updateAgentReadState(msg.read)
              break
            case 'workspace-file-watch':
              workspaceFileListenersRef.current.get(msg.rootId)?.forEach(listener => {
                const readyByReason = new Map<WorkspaceFileWatchReadyReason, string[]>()
                listener.pendingReadyReasons.forEach((reason, filePath) => {
                  if (!msg.paths.includes(filePath)) return
                  const paths = readyByReason.get(reason) ?? []
                  paths.push(filePath)
                  readyByReason.set(reason, paths)
                  listener.pendingReadyReasons.delete(filePath)
                })
                readyByReason.forEach((paths, reason) => listener.onReady?.(paths, reason))
              })
              break
            case 'workspace-file-event':
              workspaceFileListenersRef.current.get(msg.event.rootId)?.forEach(listener => {
                if (msg.event.type === 'error' || (msg.event.path && listener.paths.includes(msg.event.path))) {
                  listener.onEvent(msg.event)
                }
              })
              break
            case 'workspace-result':
              settleWorkspaceRequest(msg)
              break
            case 'language-server-result':
              settleLanguageServerRequest(msg)
              break
            case 'language-server-refresh':
              refreshLanguageServerProvidersOnDemand(msg)
              break
            case 'browser-resource-snapshot':
              setState(prev => {
                const current = prev.browserResources ?? emptyBrowserResourceState()
                const browserResources = applyBrowserResourceSnapshot(current, msg.snapshot)
                return browserResources === current && prev.browserResources !== null
                  ? prev
                  : { ...prev, browserResources }
              })
              break
            case 'browser-resource-updated':
              latestHandlersRef.current.mergeBrowserResource(msg.resource)
              break
            case 'browser-resource-deleted':
              latestHandlersRef.current.deleteBrowserResource(msg.deletion)
              break
            case 'computer-resource-snapshot':
              setState(prev => {
                const current = prev.computerResources ?? emptyComputerResourceState()
                const computerResources = applyComputerResourceSnapshot(current, msg.snapshot)
                return computerResources === current && prev.computerResources !== null
                  ? prev
                  : { ...prev, computerResources }
              })
              break
            case 'computer-resource-updated':
              latestHandlersRef.current.mergeComputerResource(msg.resource)
              break
            case 'computer-resource-deleted':
              latestHandlersRef.current.deleteComputerResource(msg.deletion)
              break
            case 'desktop-browser-adapter-registered': {
              const nativeBrowser = window.farmingDesktop?.nativeBrowser
              if (
                !nativeBrowser
                || msg.adapterId !== nativeBrowser.adapterId
                || msg.serverEpoch !== nativeBrowserAdapterServerEpoch
              ) break
              nativeBrowserAdapterRegisteredServerEpoch = msg.serverEpoch
              window.dispatchEvent(new CustomEvent('farming:desktop-native-browser-capability-changed'))
              break
            }
            case 'desktop-browser-command': {
              const nativeBrowser = window.farmingDesktop?.nativeBrowser
              const command = msg.command
              const respond = (payload: Record<string, unknown>) => {
                if (disposed || wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return
                ws.send(JSON.stringify({
                  type: 'desktop-browser-adapter-response',
                  adapterId: command.adapterId,
                  generation: command.generation,
                  requestId: command.requestId,
                  resourceId: command.resourceId,
                  sessionId: command.sessionId,
                  ...payload,
                }))
              }
              if (!nativeBrowser || command.adapterId !== nativeBrowser.adapterId) {
                respond({
                  code: 'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE',
                  error: 'The requested Farming Desktop Browser adapter is unavailable.',
                  ok: false,
                  status: 503,
                })
                break
              }
              void nativeBrowser.command({
                generation: command.generation,
                input: command.input,
                operation: command.operation,
                resourceId: command.resourceId,
                sessionId: command.sessionId,
              }).then(({ result }) => {
                respond({ ok: true, result })
              }).catch(error => {
                const record = error && typeof error === 'object'
                  ? error as { code?: unknown; status?: unknown; uncertain?: unknown }
                  : {}
                respond({
                  code: typeof record.code === 'string' ? record.code : 'BROWSER_DESKTOP_COMMAND_FAILED',
                  error: error instanceof Error ? error.message : String(error),
                  ok: false,
                  status: Number.isInteger(record.status) ? Number(record.status) : 500,
                  ...(record.uncertain === true ? { uncertain: true } : {}),
                })
              })
              break
            }
            case 'system-stats':
              updateBackendSystemStats(msg.stats ?? null)
              break
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid Farming backend message'
          setState(prev => ({
            ...prev,
            error: message,
            errorKind: 'error',
            errorId: prev.errorId + 1,
          }))
        }
      }

      ws.onclose = (event) => {
        if (disposed || wsRef.current !== ws) return
        invalidateNativeBrowserLease()
        clearSocketCloseDeadline()
        setTerminalSessionTransportReady(false)
        setWorkspaceRequestTransportReady(false)
        const terminalError = event.code === 4001
          ? 'Farming token expired or is invalid'
          : event.code === 4002
            ? (protocolMismatchNotice || 'Farming frontend and backend versions differ. Refresh this page.')
            : null
        clearSocketConnectDeadline()
        resetBusinessProbeObservation()
        clearAgentStateSnapshotDeadline()
        accessModeRef.current = 'unknown'
        pendingAccessMessagesRef.current = []
        wsRef.current = null
        agentStateCursorRef.current = null
        agentStateSnapshotAgentsRef.current = []
        agentStateSnapshotCursorRef.current = null
        agentStateSignaturesRef.current = new Map()
        agentStateResyncPendingRef.current = false
        composerRequestResolversRef.current.forEach(({ resolve, timeout }) => {
          window.clearTimeout(timeout)
          resolve(false)
        })
        composerRequestResolversRef.current.clear()
        setState(prev => ({
          ...prev,
          connected: false,
          error: terminalError ?? prev.error,
          errorKind: terminalError ? 'error' : prev.errorKind,
          errorId: terminalError ? prev.errorId + 1 : prev.errorId,
          browserResources: null,
          computerResources: null,
        }))
        reconnectBlocked = Boolean(terminalError)
        updateBackendConnectionStatus({ reconnecting: terminalError === null })
        markBackendDisconnected()
        window.dispatchEvent(new CustomEvent('farming:backend-disconnected', {
          detail: { code: event.code, reason: event.reason },
        }))
        if (!terminalError) {
          reconnectTimer = setTimeout(connect, 1000)
        }
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      disposed = true
      invalidateNativeBrowserLease()
      setTerminalSessionTransportReady(false)
      setWorkspaceRequestTransportReady(false)
      clearTimeout(reconnectTimer)
      clearSocketConnectDeadline()
      clearSocketCloseDeadline()
      document.removeEventListener('visibilitychange', handlePageVisibilityChange)
      window.removeEventListener('pageshow', handlePageShow)
      window.removeEventListener('online', handleOnline)
      clearBusinessProbeTimers()
      clearAgentStateSnapshotDeadline()
      if (wsRef.current === activeSocket) {
        wsRef.current = null
      }
      accessModeRef.current = 'unknown'
      pendingAccessMessagesRef.current = []
      markBackendDisconnected()
      activeSocket?.close()
    }
  }, [])

  return {
    ...state,
    startAgent,
    sendComposerInput,
    focusAgent,
    watchAcpTranscripts,
    onAcpSessionRevision,
    interruptAgent,
    restartMainAgent,
    onSessionOutput,
    watchWorkspaceFiles,
    mergeBrowserResource,
    deleteBrowserResource,
    mergeComputerResource,
    deleteComputerResource,
  }
}
