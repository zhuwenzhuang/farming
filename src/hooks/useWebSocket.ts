import { useEffect, useRef, useCallback, useState } from 'react'
import type { Agent, SystemStats, TaskHistoryEntry } from '@/types/agent'
import type { AppServerRequestResponseMessage, ClientMessage, ComposerInputAttachment, ComposerInputMessage, ServerMessage, StartAgentMessage, WorkspaceFileEventMessage } from '@/types/messages'
import { appWsUrl } from '@/lib/base-path'
import {
  publishTerminalGeometry,
  setTerminalGeometryTransport,
} from '@/lib/terminal-geometry-client'

const LAST_MESSAGE_STATE_THROTTLE_MS = 1000

export interface WebSocketState {
  agents: Agent[]
  taskHistory: TaskHistoryEntry[]
  mainPageSessionKeys: string[]
  mainAgentId: string | null
  systemStats: SystemStats | null
  uptime: number
  connected: boolean
  everConnected: boolean
  lastMessageAt: number
  error: string | null
  errorId: number
  lastStartedAgentId: string | null
}

function isInternalMainWorkspace(cwd?: string, parentAgentId?: string) {
  if (parentAgentId) return false
  return /(^|[/\\])\.farming[/\\]?$/.test(cwd || '')
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<WebSocketState>({
    agents: [],
    taskHistory: [],
    mainPageSessionKeys: [],
    mainAgentId: null,
    systemStats: null,
    uptime: 0,
    connected: false,
    everConnected: false,
    lastMessageAt: Date.now(),
    error: null,
    errorId: 0,
    lastStartedAgentId: null,
  })

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

  const sendMessage = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
      return true
    }
    setState(prev => ({
      ...prev,
      error: 'Farming backend is not connected',
      errorId: prev.errorId + 1,
    }))
    return false
  }, [])

  const startAgent = useCallback((
    command: string,
    workspace?: string,
    asMain?: boolean,
    extras?: { task?: string; workflowTemplate?: string; customTitle?: string; projectWorkspace?: string; codexApprovalMode?: string; codexRuntimeMode?: 'cli' | 'app-server'; agentRuntimeMode?: 'terminal' | 'acp' | 'json'; dangerouslySkipPermissions?: boolean; providerHomeId?: string }
  ) => {
    const msg: StartAgentMessage = {
      type: 'start-agent',
      command,
      workspace,
      asMain,
    }
    if (extras?.task !== undefined) msg.task = extras.task
    if (extras?.workflowTemplate !== undefined) msg.workflowTemplate = extras.workflowTemplate
    if (extras?.customTitle !== undefined) msg.customTitle = extras.customTitle
    if (extras?.projectWorkspace !== undefined) msg.projectWorkspace = extras.projectWorkspace
    if (extras?.codexApprovalMode !== undefined) msg.codexApprovalMode = extras.codexApprovalMode
    if (extras?.codexRuntimeMode !== undefined) msg.codexRuntimeMode = extras.codexRuntimeMode
    if (extras?.agentRuntimeMode !== undefined) msg.agentRuntimeMode = extras.agentRuntimeMode
    if (extras?.dangerouslySkipPermissions !== undefined) msg.dangerouslySkipPermissions = extras.dangerouslySkipPermissions
    if (extras?.providerHomeId !== undefined) msg.providerHomeId = extras.providerHomeId
    return sendMessage(msg)
  }, [sendMessage])

  const sendComposerInput = useCallback((message: string, agentId?: string, attachments: ComposerInputAttachment[] = []) => {
    const input: ComposerInputMessage = {
      type: 'composer-input',
      message,
      agentId,
      ...(attachments.length > 0 ? { attachments } : {}),
    }
    return sendMessage(input)
  }, [sendMessage])

  const respondToAppServerRequest = useCallback((
    agentId: string,
    requestId: string,
    result?: unknown,
    options?: { reject?: boolean; reason?: string },
  ) => {
    const message: AppServerRequestResponseMessage = {
      type: 'app-server-request-response',
      agentId,
      requestId,
      result,
      ...(options?.reject === true ? { reject: true } : {}),
      ...(options?.reason ? { reason: options.reason } : {}),
    }
    return sendMessage(message)
  }, [sendMessage])

  const focusAgent = useCallback((agentId: string) => {
    return sendMessage({ type: 'focus-agent', agentId, refreshState: true })
  }, [sendMessage])

  const killAgent = useCallback((agentId: string) => {
    return sendMessage({ type: 'kill-agent', agentId })
  }, [sendMessage])

  const interruptAgent = useCallback((agentId: string) => {
    return sendMessage({ type: 'interrupt-agent', agentId })
  }, [sendMessage])

  const restartMainAgent = useCallback((command: 'codex' | 'claude' | 'opencode' | 'qoder' | 'bash' | 'zsh') => {
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

  useEffect(() => {
    setTerminalGeometryTransport(message => sendMessage(message))
    return () => setTerminalGeometryTransport(null)
  }, [sendMessage])

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>
    let disposed = false
    let activeSocket: WebSocket | null = null
    let lastMessageStateUpdateAt = 0

    function markBackendMessage(receivedAt = Date.now()) {
      if (receivedAt - lastMessageStateUpdateAt < LAST_MESSAGE_STATE_THROTTLE_MS) return
      lastMessageStateUpdateAt = receivedAt
      setState(prev => ({ ...prev, lastMessageAt: receivedAt }))
    }

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
          everConnected: true,
          lastMessageAt: lastMessageStateUpdateAt,
          error: null,
        }))
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
          const msg = JSON.parse(event.data) as ServerMessage
          switch (msg.type) {
            case 'state':
              setState(prev => {
                const previousAgents = new Map(prev.agents.map(agent => [agent.id, agent]))
                const nextAgents = msg.state.agents.map(agent => {
                  const previous = previousAgents.get(agent.id)
                  const normalizedAgent = {
                    ...agent,
                    isMain: agent.isMain || agent.id === msg.state.mainAgentId || isInternalMainWorkspace(agent.cwd, agent.parentAgentId),
                  }
                  return previous?.previewSnapshot
                    ? { ...normalizedAgent, previewSnapshot: previous.previewSnapshot }
                    : normalizedAgent
                })

                return {
                  ...prev,
                  agents: nextAgents,
                  taskHistory: msg.state.taskHistory ?? prev.taskHistory,
                  mainPageSessionKeys: Array.isArray(msg.state.mainPageSessionKeys) ? msg.state.mainPageSessionKeys : prev.mainPageSessionKeys,
                  mainAgentId: msg.state.mainAgentId,
                  systemStats: msg.state.systemStats ?? prev.systemStats,
                }
              })
              break
            case 'error':
              setState(prev => ({ ...prev, error: msg.message, errorId: prev.errorId + 1 }))
              break
            case 'agent-started':
              setState(prev => ({ ...prev, lastStartedAgentId: msg.agentId }))
              break
            case 'session-preview':
              setState(prev => ({
                ...prev,
                agents: prev.agents.map(agent => (
                  agent.id === msg.preview.agentId
                    ? {
                        ...agent,
                        previewText: msg.preview.previewText,
                        previewCols: msg.preview.cols,
                        previewRows: msg.preview.rows,
                        previewSnapshot: msg.preview.previewSnapshot ?? null,
                        terminalStatus: msg.preview.terminalStatus ?? agent.terminalStatus ?? null,
                        codexTerminalProfile: msg.preview.codexTerminalProfile ?? agent.codexTerminalProfile ?? null,
                      }
                    : agent
                )),
              }))
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
            case 'terminal-controller':
              publishTerminalGeometry(msg)
              break
            case 'workspace-file-watch':
              break
            case 'workspace-file-event':
              workspaceFileListenersRef.current.get(msg.event.agentId)?.forEach(listener => listener(msg.event))
              break
            case 'system-stats':
              setState(prev => ({
                ...prev,
                systemStats: msg.stats ?? prev.systemStats,
                uptime: msg.uptime ?? prev.uptime,
              }))
              break
          }
        } catch {
          // ignore parse errors
        }
      }

      ws.onclose = (event) => {
        if (disposed || wsRef.current !== ws) return
        wsRef.current = null
        setState(prev => ({
          ...prev,
          connected: false,
          error: event.code === 4001 ? 'Farming token expired or is invalid' : prev.error,
          errorId: event.code === 4001 ? prev.errorId + 1 : prev.errorId,
        }))
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
      if (wsRef.current === activeSocket) {
        wsRef.current = null
      }
      activeSocket?.close()
    }
  }, [])

  return {
    ...state,
    startAgent,
    sendComposerInput,
    respondToAppServerRequest,
    focusAgent,
    killAgent,
    interruptAgent,
    restartMainAgent,
    onSessionOutput,
    watchWorkspaceFiles,
  }
}
