import { useEffect, useRef, useCallback, useState } from 'react'
import type { Agent, TaskHistoryEntry } from '@/types/agent'
import type { AcpRealtimeEvent, ClientMessage, ComposerInputAttachment, ComposerInputMessage, ServerMessage, StartAgentMessage, WorkspaceFileEventMessage } from '@/types/messages'
import { appWsUrl } from '@/lib/base-path'
import { setTerminalSessionTransport } from '@/lib/terminal-session-client'
import {
  resetBackendConnectionStatus,
  updateBackendConnectionStatus,
  updateBackendSystemStats,
} from '@/lib/backend-live-status'
import {
  reconcileAgentLiveStates,
  resetAgentLiveStates,
  updateAgentLiveActivity,
  updateAgentLivePreview,
  updateAgentLiveState,
} from '@/lib/agent-live-state'
import {
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

const LAST_MESSAGE_STATE_THROTTLE_MS = 1000
const BUSINESS_HEALTH_INTERVAL_MS = 10_000
const BUSINESS_HEALTH_DEADLINE_MS = 8_000
const BUSINESS_HEALTH_RETRY_MS = 2_000

export interface WebSocketState {
  agents: Agent[]
  taskHistory: TaskHistoryEntry[]
  mainPageSessionKeys: string[]
  mainAgentId: string | null
  connected: boolean
  error: string | null
  errorKind: 'recoverable' | 'error'
  errorId: number
  lastStartedAgentId: string | null
  projectWorkspaces: string[] | null
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

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const agentStateSignaturesRef = useRef<Map<string, string>>(new Map())
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
    agents: [],
    taskHistory: [],
    mainPageSessionKeys: [],
    mainAgentId: null,
    connected: false,
    error: null,
    errorKind: 'error',
    errorId: 0,
    lastStartedAgentId: null,
    projectWorkspaces: null,
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
  const workspaceFileListenersRef = useRef<Map<string, Set<(event: WorkspaceFileEventMessage['event']) => void>>>(new Map())
  const acpRealtimeListenersRef = useRef<Map<string, Set<(event: AcpRealtimeEvent) => void>>>(new Map())

  const sendMessage = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
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

  const focusAgent = useCallback((agentId: string) => {
    return sendMessage({ type: 'focus-agent', agentId })
  }, [sendMessage])

  const killAgent = useCallback((
    agentId: string,
    options: { acknowledgeUnprovenAcpExit?: boolean } = {},
  ) => {
    return sendMessage({
      type: 'kill-agent',
      agentId,
      ...(options.acknowledgeUnprovenAcpExit === true
        ? { acknowledgeUnprovenAcpExit: true }
        : {}),
    })
  }, [sendMessage])

  const interruptAgent = useCallback((agentId: string) => {
    return sendMessage({ type: 'interrupt-agent', agentId })
  }, [sendMessage])

  const restartMainAgent = useCallback((command: 'codex' | 'claude' | 'opencode' | 'qoder' | 'qwen' | 'bash' | 'zsh') => {
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

  const watchWorkspaceFiles = useCallback((agentId: string, handler: (event: WorkspaceFileEventMessage['event']) => void) => {
    let listeners = workspaceFileListenersRef.current.get(agentId)
    if (!listeners) {
      listeners = new Set()
      workspaceFileListenersRef.current.set(agentId, listeners)
      sendMessage({ type: 'watch-workspace-files', agentId })
    }
    listeners.add(handler)
    return () => {
      const currentListeners = workspaceFileListenersRef.current.get(agentId)
      if (!currentListeners) return

      currentListeners.delete(handler)
      if (currentListeners.size === 0) {
        workspaceFileListenersRef.current.delete(agentId)
        sendMessage({ type: 'unwatch-workspace-files', agentId })
      }
    }
  }, [sendMessage])

  const onAcpRealtime = useCallback((agentId: string, handler: (event: AcpRealtimeEvent) => void) => {
    let listeners = acpRealtimeListenersRef.current.get(agentId)
    if (!listeners) {
      listeners = new Set()
      acpRealtimeListenersRef.current.set(agentId, listeners)
    }
    listeners.add(handler)
    return () => {
      const currentListeners = acpRealtimeListenersRef.current.get(agentId)
      if (!currentListeners) return
      currentListeners.delete(handler)
      if (currentListeners.size === 0) acpRealtimeListenersRef.current.delete(agentId)
    }
  }, [])

  useEffect(() => {
    setTerminalSessionTransport(message => sendMessage(message))
    return () => setTerminalSessionTransport(null)
  }, [sendMessage])

  useEffect(() => {
    resetBackendConnectionStatus()
    resetAgentLiveStates()
    let reconnectTimer: ReturnType<typeof setTimeout>
    let disposed = false
    let activeSocket: WebSocket | null = null
    let lastMessageStateUpdateAt = 0
    let businessProbeTimer: ReturnType<typeof setTimeout> | null = null
    let businessProbeDeadline: ReturnType<typeof setTimeout> | null = null
    let pendingBusinessProbeId = ''
    let businessProbeSequence = 0

    function markBackendMessage(receivedAt = Date.now()) {
      if (receivedAt - lastMessageStateUpdateAt < LAST_MESSAGE_STATE_THROTTLE_MS) return
      lastMessageStateUpdateAt = receivedAt
      updateBackendConnectionStatus({ lastMessageAt: receivedAt })
    }

    function clearBusinessProbeTimers() {
      if (businessProbeTimer) clearTimeout(businessProbeTimer)
      if (businessProbeDeadline) clearTimeout(businessProbeDeadline)
      businessProbeTimer = null
      businessProbeDeadline = null
    }

    function scheduleBusinessProbe(ws: WebSocket, delay: number) {
      if (businessProbeTimer) clearTimeout(businessProbeTimer)
      businessProbeTimer = setTimeout(() => {
        businessProbeTimer = null
        sendBusinessProbe(ws)
      }, delay)
    }

    function sendBusinessProbe(ws: WebSocket) {
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
      ws.send(JSON.stringify({ type: 'business-health-probe', requestId }))
      businessProbeDeadline = setTimeout(() => {
        if (pendingBusinessProbeId !== requestId || wsRef.current !== ws) return
        pendingBusinessProbeId = ''
        businessProbeDeadline = null
        updateBackendConnectionStatus({
          businessStatus: 'unresponsive',
          businessCheckedAt: Date.now(),
        })
        scheduleBusinessProbe(ws, BUSINESS_HEALTH_RETRY_MS)
      }, BUSINESS_HEALTH_DEADLINE_MS)
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

    function handlePageVisibilityChange() {
      const ws = activeSocket
      resetBusinessProbeObservation()
      if (document.visibilityState !== 'hidden' && ws?.readyState === WebSocket.OPEN) {
        sendBusinessProbe(ws)
      }
    }

    document.addEventListener('visibilitychange', handlePageVisibilityChange)

    function connect() {
      // ACP transcript revisions and terminal output arrive on this socket.
      // Keep it alive in hidden tabs so Chat keeps progressing and returning
      // to the page does not manufacture a disconnected/reconnecting state.
      if (disposed) return
      let wsUrl = appWsUrl()
      const queryToken = new URLSearchParams(location.search).get('token')
      // Attach token from cookie for mobile WS compatibility
      const tokenMatch = document.cookie.match(/(?:^|;\s*)farming_token=([^;]+)/)
      const token = queryToken || tokenMatch?.[1] || ''
      if (token) {
        wsUrl += `?token=${token}`
      }
      const ws = new WebSocket(wsUrl)
      activeSocket = ws
      wsRef.current = ws

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return
        lastMessageStateUpdateAt = Date.now()
        setState(prev => ({
          ...prev,
          connected: true,
          error: null,
        }))
        updateBackendConnectionStatus({
          connected: true,
          everConnected: true,
          lastMessageAt: lastMessageStateUpdateAt,
          disconnectedAt: null,
          businessStatus: 'checking',
          businessCheckedAt: null,
          businessServerEpoch: '',
        })
        ws.send(JSON.stringify({ type: 'protocol-hello', protocolVersion: PROTOCOL_VERSION }))
        sendBusinessProbe(ws)
        window.dispatchEvent(new Event('farming:backend-connected'))
        workspaceFileListenersRef.current.forEach((listeners, agentId) => {
          if (listeners.size > 0) {
            ws.send(JSON.stringify({ type: 'watch-workspace-files', agentId }))
          }
        })
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
            case 'protocol-hello':
              if (!protocolCompatible(msg.protocolVersion)) {
                ws.close(4002, `Unsupported Farming protocol version ${msg.protocolVersion}`)
              }
              break
            case 'protocol-error':
              setState(prev => ({
                ...prev,
                error: msg.message,
                errorKind: 'error',
                errorId: prev.errorId + 1,
              }))
              break
            case 'business-health-result':
              if (msg.requestId !== pendingBusinessProbeId) break
              pendingBusinessProbeId = ''
              if (businessProbeDeadline) clearTimeout(businessProbeDeadline)
              businessProbeDeadline = null
              updateBackendConnectionStatus({
                businessStatus: msg.status,
                businessCheckedAt: Date.now(),
                businessServerEpoch: msg.serverEpoch,
              })
              scheduleBusinessProbe(
                ws,
                msg.status === 'ready' ? BUSINESS_HEALTH_INTERVAL_MS : BUSINESS_HEALTH_RETRY_MS,
              )
              break
            case 'command-ack':
              break
            case 'state':
              if (msg.state.systemStats !== undefined) {
                updateBackendSystemStats(msg.state.systemStats ?? null)
              }
              reconcileAgentLiveStates(msg.state.agents)
              setState(prev => {
                const previousAgents = new Map(prev.agents.map(agent => [agent.id, agent]))
                let agentsChanged = prev.agents.length !== msg.state.agents.length
                const nextAgentSignatures = new Map<string, string>()
                const reconciledAgents = msg.state.agents.map((agent, index) => {
                  const previous = previousAgents.get(agent.id)
                  const signature = JSON.stringify(agent)
                  nextAgentSignatures.set(agent.id, signature)
                  const isMain = agent.isMain || agent.id === msg.state.mainAgentId || isInternalMainWorkspace(agent.cwd, agent.parentAgentId)
                  if (
                    previous
                    && previous.id === prev.agents[index]?.id
                    && previous.isMain === isMain
                    && agentStateSignaturesRef.current.get(agent.id) === signature
                  ) {
                    return previous
                  }
                  const normalizedAgent = {
                    ...agent,
                    isMain,
                  }
                  agentsChanged = true
                  return previous?.previewSnapshot
                    ? { ...normalizedAgent, previewSnapshot: previous.previewSnapshot }
                    : normalizedAgent
                })
                agentStateSignaturesRef.current = nextAgentSignatures

                const nextAgents = agentsChanged ? reconciledAgents : prev.agents
                const nextTaskHistory = msg.state.taskHistory ?? prev.taskHistory
                const nextMainPageSessionKeys = Array.isArray(msg.state.mainPageSessionKeys)
                  ? msg.state.mainPageSessionKeys
                  : prev.mainPageSessionKeys
                const nextProjectWorkspaces = Array.isArray(msg.state.projectWorkspaces)
                  ? msg.state.projectWorkspaces
                  : prev.projectWorkspaces
                const nextPinnedProjectWorkspaces = Array.isArray(msg.state.pinnedProjectWorkspaces)
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
                  && msg.state.mainAgentId === prev.mainAgentId
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
                  mainAgentId: msg.state.mainAgentId,
                }
              })
              break
            case 'error':
              setState(prev => ({
                ...prev,
                error: msg.message,
                errorKind: 'error',
                errorId: prev.errorId + 1,
              }))
              break
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
              setState(prev => {
                let changed = false
                const agents = prev.agents.map(agent => {
                  if (
                    agent.id !== msg.session.agentId
                    || agent.runtimeBinding?.kind !== 'acp'
                    || msg.session.revision <= agent.runtimeBinding.sessionRevision
                  ) return agent
                  changed = true
                  return {
                    ...agent,
                    runtimeBinding: {
                      ...agent.runtimeBinding,
                      sessionRevision: msg.session.revision,
                      sessionUpdatedAt: msg.session.updatedAt,
                    },
                  }
                })
                return changed ? { ...prev, agents } : prev
              })
              break
            case 'acp-realtime':
              acpRealtimeListenersRef.current.get(msg.event.agentId)?.forEach(listener => listener(msg.event))
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
            case 'agent-read':
              setState(prev => ({
                ...prev,
                agents: prev.agents.map(agent => (
                  agent.id === msg.read.agentId
                    ? { ...agent, ...msg.read, id: agent.id }
                    : agent
                )),
              }))
              break
            case 'workspace-file-watch':
              break
            case 'workspace-file-event':
              workspaceFileListenersRef.current.get(msg.event.agentId)?.forEach(listener => listener(msg.event))
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
        resetBusinessProbeObservation()
        wsRef.current = null
        composerRequestResolversRef.current.forEach(({ resolve, timeout }) => {
          window.clearTimeout(timeout)
          resolve(false)
        })
        composerRequestResolversRef.current.clear()
        setState(prev => ({
          ...prev,
          connected: false,
          error: event.code === 4001 ? 'Farming token expired or is invalid' : prev.error,
          errorKind: event.code === 4001 ? 'error' : prev.errorKind,
          errorId: event.code === 4001 ? prev.errorId + 1 : prev.errorId,
          browserResources: null,
          computerResources: null,
        }))
        updateBackendConnectionStatus({
          connected: false,
          disconnectedAt: Date.now(),
        })
        window.dispatchEvent(new CustomEvent('farming:backend-disconnected', {
          detail: { code: event.code, reason: event.reason },
        }))
        reconnectTimer = setTimeout(connect, 1000)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      document.removeEventListener('visibilitychange', handlePageVisibilityChange)
      clearBusinessProbeTimers()
      if (wsRef.current === activeSocket) {
        wsRef.current = null
      }
      updateBackendConnectionStatus({
        connected: false,
        disconnectedAt: Date.now(),
      })
      activeSocket?.close()
    }
  }, [])

  return {
    ...state,
    startAgent,
    sendComposerInput,
    focusAgent,
    killAgent,
    interruptAgent,
    restartMainAgent,
    onSessionOutput,
    onAcpRealtime,
    watchWorkspaceFiles,
    mergeBrowserResource,
    deleteBrowserResource,
    mergeComputerResource,
    deleteComputerResource,
  }
}
