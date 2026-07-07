import { useEffect, useRef, useCallback, useState } from 'react'
import type { Agent, SystemStats, TaskHistoryEntry } from '@/types/agent'
import type { ClientMessage, InputMessage, ServerMessage, StartAgentMessage, TerminalInputPart, WorkspaceFileEventMessage } from '@/types/messages'
import { appWsUrl } from '@/lib/base-path'
import { isPageVisible, usePageVisibility } from '@/hooks/usePageVisibility'

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
}

function isInternalMainWorkspace(cwd?: string, parentAgentId?: string) {
  if (parentAgentId) return false
  return /(^|[/\\])\.farming[/\\]?$/.test(cwd || '')
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const pageVisible = usePageVisibility()
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
  })

  // Session output callback — components can subscribe
  const outputListenersRef = useRef<Map<string, (data: string, replace?: boolean, outputSeq?: number | null) => void>>(new Map())
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
    extras?: { task?: string; workflowTemplate?: string; projectWorkspace?: string }
  ) => {
    const msg: StartAgentMessage = {
      type: 'start-agent',
      command,
      workspace,
      asMain,
    }
    if (extras?.task !== undefined) msg.task = extras.task
    if (extras?.workflowTemplate !== undefined) msg.workflowTemplate = extras.workflowTemplate
    if (extras?.projectWorkspace !== undefined) msg.projectWorkspace = extras.projectWorkspace
    return sendMessage(msg)
  }, [sendMessage])

  const sendInput = useCallback((input: string | TerminalInputPart[], agentId?: string) => {
    const message: InputMessage = Array.isArray(input)
      ? { type: 'input', inputParts: input, agentId }
      : { type: 'input', input, agentId }
    return sendMessage(message)
  }, [sendMessage])

  const focusAgent = useCallback((agentId: string) => {
    return sendMessage({ type: 'focus-agent', agentId })
  }, [sendMessage])

  const resizeAgent = useCallback((agentId: string, cols: number, rows: number) => {
    return sendMessage({ type: 'resize-agent', agentId, cols, rows })
  }, [sendMessage])

  const killAgent = useCallback((agentId: string) => {
    return sendMessage({ type: 'kill-agent', agentId })
  }, [sendMessage])

  const interruptAgent = useCallback((agentId: string) => {
    return sendMessage({ type: 'interrupt-agent', agentId })
  }, [sendMessage])

  const restartMainAgent = useCallback((command: 'bash' | 'zsh' | 'codex' | 'claude') => {
    return sendMessage({ type: 'restart-main-agent', command })
  }, [sendMessage])

  const onSessionOutput = useCallback((agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null) => void) => {
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
    let reconnectTimer: ReturnType<typeof setTimeout>
    let disposed = false
    let activeSocket: WebSocket | null = null
    let lastMessageStateUpdateAt = 0

    if (!pageVisible) {
      const existingSocket = wsRef.current
      wsRef.current = null
      existingSocket?.close()
      setState(prev => prev.connected ? { ...prev, connected: false, error: null } : prev)
      return () => {}
    }

    function markBackendMessage(receivedAt = Date.now()) {
      if (receivedAt - lastMessageStateUpdateAt < LAST_MESSAGE_STATE_THROTTLE_MS) return
      lastMessageStateUpdateAt = receivedAt
      setState(prev => ({ ...prev, lastMessageAt: receivedAt }))
    }

    function connect() {
      if (disposed || !isPageVisible()) return
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
                      }
                    : agent
                )),
              }))
              break
            case 'session-output': {
              const listener = outputListenersRef.current.get(msg.stream.agentId)
              if (listener) listener(msg.stream.data, msg.stream.replace, msg.stream.outputSeq)
              break
            }
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
  }, [pageVisible])

  return {
    ...state,
    startAgent,
    sendInput,
    focusAgent,
    resizeAgent,
    killAgent,
    interruptAgent,
    restartMainAgent,
    onSessionOutput,
    watchWorkspaceFiles,
  }
}
