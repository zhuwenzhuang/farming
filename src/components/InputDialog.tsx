import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useKeyboard } from '@/hooks/useKeyboard'
import { appPath } from '@/lib/base-path'
import { agentDisplayName, formatRelativeAge } from '@/lib/format'
import type { CodeCopy } from '@/components/code/copy'
import { mergeTaskWithWorkflow, WORKFLOW_TEMPLATE_OPTIONS } from '@/lib/workflow-templates'
import {
  buildWorkspaceHistory,
  buildWorkspaceOptions,
  formatWorkspaceForDisplay,
  getMainWorkspaceDefault,
  isFarmingInternalWorkspace,
  normalizeWorkspaceValue,
  resolveWorkspaceToStart,
  shouldRememberWorkspace,
} from '@/lib/workspace-options'

function isMobileViewport() {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(max-width: 980px)').matches
}

function normalizeDefaultLaunchAgent(agentName: string | undefined) {
  return agentName === 'claude' ? 'claude' : 'codex'
}

function isResumeProvider(provider: string | undefined) {
  return provider === 'codex' || provider === 'claude'
}

interface CliAgent {
  name: string
  description: string
  category: string
}

interface DiscoveredWorkspace {
  path: string
}

interface WorkspacePathSuggestion {
  name: string
  path: string
}

interface MainAgentResumeSession {
  provider: string
  providerName?: string
  id: string
  title: string
  cwd: string
  workspace?: string
  updatedAt?: string
  archived?: boolean
  capabilities?: string[]
}

export interface StartAgentOptions {
  resumeSession?: {
    provider: string
    id: string
  }
  task?: string
  workflowTemplate?: string
}

interface InputDialogProps {
  open: boolean
  mustStartMain: boolean
  initialWorkspace?: string
  initialCommand?: string
  showWorkflowTaskFields?: boolean
  copy: CodeCopy
  onStart: (command: string, workspace: string, options?: StartAgentOptions) => void
  onClose: () => void
}

type DialogStep = 'agent-list' | 'workspace'

function agentSessionUpdatedAt(session: MainAgentResumeSession) {
  const parsed = Date.parse(session.updatedAt || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function canResumeMainAgentSession(session: MainAgentResumeSession) {
  return isResumeProvider(session.provider)
    && session.archived !== true
    && Array.isArray(session.capabilities)
    && session.capabilities.includes('resume')
    && (
      isFarmingInternalWorkspace(session.cwd)
      || isFarmingInternalWorkspace(session.workspace)
    )
}

function mainAgentResumeLabel(session: MainAgentResumeSession, copy: CodeCopy) {
  const provider = session.providerName || agentDisplayName(session.provider)
  const age = formatRelativeAge(agentSessionUpdatedAt(session))
  return [
    session.title || copy.sessionFallbackTitle(provider),
    provider,
    age,
  ].filter(Boolean).join(' · ')
}

export function InputDialog({
  open,
  mustStartMain,
  initialWorkspace,
  initialCommand,
  showWorkflowTaskFields = true,
  copy,
  onStart,
  onClose,
}: InputDialogProps) {
  const [step, setStep] = useState<DialogStep>('agent-list')
  const [agents, setAgents] = useState<CliAgent[]>([])
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const [agentLoadFailed, setAgentLoadFailed] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<CliAgent | null>(null)
  const [workspace, setWorkspace] = useState('')
  const [taskText, setTaskText] = useState('')
  const [workflowId, setWorkflowId] = useState('')
  const [workspaceHistory, setWorkspaceHistory] = useState<string[]>([])
  const [discoveredWorkspaces, setDiscoveredWorkspaces] = useState<string[]>([])
  const [workspacePathSuggestions, setWorkspacePathSuggestions] = useState<WorkspacePathSuggestion[]>([])
  const [workspacePathSelection, setWorkspacePathSelection] = useState(-1)
  const [mainAgentResumeSession, setMainAgentResumeSession] = useState<MainAgentResumeSession | null>(null)
  const [resumeMainAgent, setResumeMainAgent] = useState(true)
  const [mainWorkspaceDefault, setMainWorkspaceDefault] = useState('~/.farming')
  const [defaultLaunchAgent, setDefaultLaunchAgent] = useState('codex')
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [historySelection, setHistorySelection] = useState(-1)
  const [startClickLocked, setStartClickLocked] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const workspacePathSuggestionsRef = useRef<HTMLDivElement>(null)
  const workspaceTouchedRef = useRef(false)
  const startClickLockedRef = useRef(false)
  const startClickUnlockTimerRef = useRef<number | null>(null)
  const workspaceOptions = useMemo(
    () => mustStartMain ? [] : buildWorkspaceOptions(workspaceHistory, discoveredWorkspaces),
    [workspaceHistory, discoveredWorkspaces, mustStartMain]
  )
  const resumableMainAgentSession = useMemo(() => {
    if (!mainAgentResumeSession) return null
    return agents.some(agent => agent.name === mainAgentResumeSession.provider)
      ? mainAgentResumeSession
      : null
  }, [agents, mainAgentResumeSession])
  const effectiveDefaultLaunchAgent = resumeMainAgent && resumableMainAgentSession
    ? resumableMainAgentSession.provider
    : defaultLaunchAgent

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setStep('agent-list')
    setSelectedAgent(null)
    setWorkspace(mustStartMain ? '' : normalizeWorkspaceValue(initialWorkspace || ''))
    setTaskText('')
    setWorkflowId('')
    workspaceTouchedRef.current = false
    startClickLockedRef.current = false
    setStartClickLocked(false)
    if (startClickUnlockTimerRef.current !== null) {
      window.clearTimeout(startClickUnlockTimerRef.current)
      startClickUnlockTimerRef.current = null
    }
    setDiscoveredWorkspaces([])
    setWorkspacePathSuggestions([])
    setWorkspacePathSelection(-1)
    setMainAgentResumeSession(null)
    setResumeMainAgent(true)
    setDefaultLaunchAgent('codex')
    setHistorySelection(-1)
    setAgentsLoaded(false)
    setAgentLoadFailed(false)
    setSettingsLoaded(false)

    fetch(appPath('/api/executables'))
      .then(r => {
        if (!r.ok) throw new Error(`Failed to load executables: ${r.status}`)
        return r.json()
      })
      .then((data: { agents: CliAgent[] } | CliAgent[]) => {
        if (cancelled) return
        const nextAgents = Array.isArray(data) ? data : data.agents ?? []
        const initialAgent = !mustStartMain && initialCommand
          ? nextAgents.find(agent => agent.name === initialCommand)
          : null
        setAgents(nextAgents)
        setAgentLoadFailed(false)
        const nextSelectedAgent = !mustStartMain ? initialAgent : null
        if (nextSelectedAgent) {
          setSelectedAgent(nextSelectedAgent)
          setStep('workspace')
          if (!isMobileViewport()) {
            setTimeout(() => inputRef.current?.focus(), 50)
          }
        }
      })
      .catch(() => {
        if (cancelled) return
        setAgents([])
        setAgentLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled) setAgentsLoaded(true)
      })

    fetch(appPath('/api/settings'))
      .then(r => r.json())
      .then((data: { settings?: { workspace?: string; lastMainWorkspace?: string; workspaceHistory?: string[]; defaultLaunchAgent?: string } }) => {
        const settings = data.settings ?? {}
        const nextMainWorkspaceDefault = getMainWorkspaceDefault(settings)
        const history = buildWorkspaceHistory(null, settings.workspaceHistory ?? [])
        setMainWorkspaceDefault(nextMainWorkspaceDefault)
        setDefaultLaunchAgent(normalizeDefaultLaunchAgent(settings.defaultLaunchAgent))
        setWorkspaceHistory(history)
        if (mustStartMain && !workspaceTouchedRef.current) {
          setWorkspace(nextMainWorkspaceDefault)
        }
        setSettingsLoaded(true)
      })
      .catch(() => {
        setWorkspaceHistory([])
        setMainWorkspaceDefault('~/.farming')
        if (mustStartMain && !workspaceTouchedRef.current) {
          setWorkspace('~/.farming')
        }
        setSettingsLoaded(true)
      })

    return () => {
      cancelled = true
    }
  }, [open, mustStartMain, initialWorkspace, initialCommand])

  useEffect(() => {
    if (!open || !mustStartMain) return

    let active = true
    setMainAgentResumeSession(null)
    setResumeMainAgent(true)

    fetch(appPath('/api/agent-sessions?limit=100'))
      .then(response => response.json())
      .then((data: { sessions?: MainAgentResumeSession[] }) => {
        if (!active) return
        const session = (data.sessions ?? [])
          .filter(canResumeMainAgentSession)
          .sort((a, b) => agentSessionUpdatedAt(b) - agentSessionUpdatedAt(a))[0] ?? null
        setMainAgentResumeSession(session)
      })
      .catch(() => {
        if (active) setMainAgentResumeSession(null)
      })

    return () => {
      active = false
    }
  }, [open, mustStartMain])

  useEffect(() => () => {
    if (startClickUnlockTimerRef.current !== null) {
      window.clearTimeout(startClickUnlockTimerRef.current)
      startClickUnlockTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!open || step !== 'agent-list' || !agentsLoaded || agentLoadFailed) return
    if (mustStartMain && !settingsLoaded) return

    const dialog = dialogRef.current
    if (!dialog) return
    const activeElement = document.activeElement
    if (
      activeElement instanceof HTMLElement
      && dialog.contains(activeElement)
      && (
        activeElement.matches('.agent-item')
        || activeElement.matches('input, textarea, select')
      )
    ) {
      return
    }

    requestAnimationFrame(() => {
      const agentButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.agent-item:not(:disabled)'))
      const defaultAgentButton = agentButtons.find(button => button.dataset.testid === `agent-option-${effectiveDefaultLaunchAgent}`)
      ;(defaultAgentButton ?? agentButtons[0])?.focus()
    })
  }, [agentLoadFailed, agentsLoaded, effectiveDefaultLaunchAgent, mustStartMain, open, settingsLoaded, step])

  const lockStartClick = useCallback(() => {
    if (startClickLockedRef.current) return false
    startClickLockedRef.current = true
    setStartClickLocked(true)
    startClickUnlockTimerRef.current = window.setTimeout(() => {
      startClickLockedRef.current = false
      setStartClickLocked(false)
      startClickUnlockTimerRef.current = null
    }, 1200)
    return true
  }, [])

  useEffect(() => {
    if (!open || mustStartMain || !selectedAgent) return

    let active = true
    setDiscoveredWorkspaces([])
    const params = new URLSearchParams({
      limit: '12',
      agent: selectedAgent.name,
    })

    fetch(appPath(`/api/workspaces/discovered?${params.toString()}`))
      .then(r => r.json())
      .then((data: { workspaces?: DiscoveredWorkspace[] }) => {
        if (!active) return
        const discovered = (data.workspaces ?? [])
          .map(item => normalizeWorkspaceValue(item.path))
          .filter(entry => shouldRememberWorkspace(entry))
        setDiscoveredWorkspaces(discovered)
      })
      .catch(() => {
        if (active) setDiscoveredWorkspaces([])
      })

    return () => {
      active = false
    }
  }, [open, mustStartMain, selectedAgent])

  useEffect(() => {
    if (!open || step !== 'workspace') {
      setWorkspacePathSuggestions([])
      setWorkspacePathSelection(-1)
      return
    }

    const value = workspace.trim()
    if (!value || (!value.includes('/') && !value.startsWith('~'))) {
      setWorkspacePathSuggestions([])
      setWorkspacePathSelection(-1)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        path: value,
        limit: '50',
      })
      fetch(appPath(`/api/workspaces/complete?${params.toString()}`), { signal: controller.signal })
        .then(response => response.json())
        .then((data: { suggestions?: WorkspacePathSuggestion[] }) => {
          const suggestions = (data.suggestions ?? [])
            .filter(item => typeof item.path === 'string' && item.path)
          setWorkspacePathSuggestions(suggestions)
          setWorkspacePathSelection(current => suggestions.length === 0 ? -1 : Math.min(current, suggestions.length - 1))
        })
        .catch(error => {
          if (error?.name === 'AbortError') return
          setWorkspacePathSuggestions([])
          setWorkspacePathSelection(-1)
        })
    }, 120)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [open, step, workspace])

  useEffect(() => {
    if (workspacePathSelection < 0) return
    const container = workspacePathSuggestionsRef.current
    if (!container) return
    const activeItem = container.querySelector<HTMLElement>('[aria-selected="true"]')
    activeItem?.scrollIntoView({ block: 'nearest' })
  }, [workspacePathSelection, workspacePathSuggestions.length])

  const resumeStartOptions = useCallback((agent: CliAgent): StartAgentOptions | undefined => {
    if (!mustStartMain || !resumeMainAgent || !resumableMainAgentSession) return undefined
    if (agent.name !== resumableMainAgentSession.provider) return undefined
    return {
      resumeSession: {
        provider: resumableMainAgentSession.provider,
        id: resumableMainAgentSession.id,
      },
    }
  }, [mustStartMain, resumableMainAgentSession, resumeMainAgent])

  const selectAgent = useCallback((agent: CliAgent) => {
    if (mustStartMain) {
      if (!settingsLoaded) return
      if (!lockStartClick()) return
      const resolvedWorkspace = resolveWorkspaceToStart(workspace, true, mainWorkspaceDefault)
      if (resolvedWorkspace) onStart(agent.name, resolvedWorkspace, resumeStartOptions(agent))
      return
    }

    setSelectedAgent(agent)
    workspaceTouchedRef.current = false
    setWorkspace(normalizeWorkspaceValue(initialWorkspace || ''))
    setDiscoveredWorkspaces([])
    setHistorySelection(-1)
    setStep('workspace')
    if (!isMobileViewport()) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [initialWorkspace, lockStartClick, mainWorkspaceDefault, mustStartMain, onStart, resumeStartOptions, settingsLoaded, workspace])

  const persistWorkspaceHistory = useCallback(async (nextWorkspace: string) => {
    const nextHistory = buildWorkspaceHistory(nextWorkspace, workspaceHistory)

    const response = await fetch(appPath('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceHistory: nextHistory,
      }),
    }).catch(() => {})

    if (!response?.ok) return

    const data = await response.json().catch(() => null) as { settings?: { workspaceHistory?: string[] } } | null
    const settings = data?.settings ?? {}
    const savedHistory = buildWorkspaceHistory(null, settings.workspaceHistory ?? [])
    setWorkspaceHistory(savedHistory)
  }, [workspaceHistory])

  const confirm = useCallback(async () => {
    if (!selectedAgent) return
    if (!lockStartClick()) return

    const currentWorkspace = normalizeWorkspaceValue(inputRef.current?.value ?? workspace)
    const resolvedWorkspace = resolveWorkspaceToStart(currentWorkspace, mustStartMain, mainWorkspaceDefault)
    if (!resolvedWorkspace) return

    if (!mustStartMain && shouldRememberWorkspace(resolvedWorkspace)) {
      await persistWorkspaceHistory(resolvedWorkspace)
    }

    const options = resumeStartOptions(selectedAgent)
    if (options) {
      onStart(selectedAgent.name, resolvedWorkspace, options)
      return
    }

    if (mustStartMain) {
      onStart(selectedAgent.name, resolvedWorkspace)
      return
    }

    const merged = showWorkflowTaskFields
      ? mergeTaskWithWorkflow(taskText, workflowId)
      : { task: '', workflowTemplate: '' }
    onStart(selectedAgent.name, resolvedWorkspace, {
      task: merged.task,
      workflowTemplate: merged.workflowTemplate,
    })
  }, [
    selectedAgent,
    workspace,
    mustStartMain,
    mainWorkspaceDefault,
    lockStartClick,
    persistWorkspaceHistory,
    onStart,
    resumeStartOptions,
    showWorkflowTaskFields,
    taskText,
    workflowId,
  ])

  const syncSelectionWithValue = useCallback((value: string) => {
    const normalizedValue = normalizeWorkspaceValue(value)
    setHistorySelection(workspaceOptions.findIndex(entry => entry === normalizedValue))
  }, [workspaceOptions])

  const selectWorkspaceHistory = useCallback((index: number) => {
    if (!workspaceOptions.length) return
    const normalizedIndex = ((index % workspaceOptions.length) + workspaceOptions.length) % workspaceOptions.length
    const nextValue = workspaceOptions[normalizedIndex] ?? ''

    workspaceTouchedRef.current = true
    setWorkspace(nextValue)
    setHistorySelection(normalizedIndex)
    requestAnimationFrame(() => {
      if (!inputRef.current) return
      inputRef.current.focus()
      inputRef.current.setSelectionRange(nextValue.length, nextValue.length)
    })
  }, [workspaceOptions])

  const acceptWorkspacePathSuggestion = useCallback((index: number) => {
    const suggestion = workspacePathSuggestions[index]
    if (!suggestion) return false

    workspaceTouchedRef.current = true
    setWorkspace(suggestion.path)
    setHistorySelection(-1)
    setWorkspacePathSelection(-1)
    requestAnimationFrame(() => {
      if (!inputRef.current) return
      inputRef.current.focus()
      inputRef.current.setSelectionRange(suggestion.path.length, suggestion.path.length)
    })
    return true
  }, [workspacePathSuggestions])

  const moveWorkspacePathSelection = useCallback((direction: number) => {
    if (workspacePathSuggestions.length === 0) return false
    const nextIndex = workspacePathSelection === -1
      ? (direction > 0 ? 0 : workspacePathSuggestions.length - 1)
      : workspacePathSelection + direction
    const normalizedIndex = ((nextIndex % workspacePathSuggestions.length) + workspacePathSuggestions.length) % workspacePathSuggestions.length
    setWorkspacePathSelection(normalizedIndex)
    setHistorySelection(-1)
    return true
  }, [workspacePathSelection, workspacePathSuggestions])

  const moveWorkspaceHistorySelection = useCallback((direction: number) => {
    if (!workspaceOptions.length) return false

    const nextIndex = historySelection === -1
      ? (direction > 0 ? 0 : workspaceOptions.length - 1)
      : historySelection + direction
    selectWorkspaceHistory(nextIndex)
    return true
  }, [workspaceOptions, historySelection, selectWorkspaceHistory])

  const moveAgentListFocus = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current
    if (!dialog) return

    const agentButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.agent-item:not(:disabled)'))
      .filter(element => element.offsetParent !== null)
    if (agentButtons.length === 0) return

    const activeIndex = agentButtons.indexOf(document.activeElement as HTMLButtonElement)
    const lastIndex = agentButtons.length - 1
    let nextIndex = activeIndex

    if (event.key === 'ArrowDown') {
      nextIndex = activeIndex === -1 ? 0 : (activeIndex + 1) % agentButtons.length
    } else if (event.key === 'ArrowUp') {
      nextIndex = activeIndex === -1 ? lastIndex : (activeIndex - 1 + agentButtons.length) % agentButtons.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = lastIndex
    } else {
      return
    }

    event.preventDefault()
    agentButtons[nextIndex]?.focus()
  }, [])

  const handleDialogKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (step === 'agent-list') {
      moveAgentListFocus(event)
      if (event.defaultPrevented) return
    }

    if (event.key !== 'Tab') return

    const dialog = dialogRef.current
    if (!dialog) return

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
    )).filter(element => element.offsetParent !== null)
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const activeElement = document.activeElement
    if (event.shiftKey) {
      if (activeElement === first || !dialog.contains(activeElement)) {
        event.preventDefault()
        last?.focus()
      }
      return
    }

    if (activeElement === last || !dialog.contains(activeElement)) {
      event.preventDefault()
      first?.focus()
    }
  }, [moveAgentListFocus, step])

  // Keyboard shortcuts for agent list
  const agentListShortcuts = agents.slice(0, 10).map((agent, i) => ({
    key: String(i < 9 ? i + 1 : 0),
    allowInOverlay: true,
    handler: () => selectAgent(agent),
  }))

  useKeyboard(
    [
      ...agentListShortcuts,
      { key: 'Escape', allowInOverlay: true, handler: () => !mustStartMain && onClose() },
    ],
    open && step === 'agent-list'
  )

  useKeyboard(
    [
      { key: 'Escape', allowInOverlay: true, handler: () => setStep('agent-list') },
    ],
    open && step === 'workspace'
  )

  if (!open) return null

  const codingAgents = agents.filter(a => a.category === 'coding')
  const otherAgents = agents.filter(a => a.category !== 'coding')

  return (
    <div className="dialog-overlay" data-testid="dialog-overlay">
      <div
        className="input-dialog fx-crt-panel"
        data-testid="input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="input-dialog-title"
        ref={dialogRef}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="dialog-header fx-crt-panel-compact">
          <div className="dialog-header-copy">
            <h3 id="input-dialog-title" className="dialog-header-title">
              {mustStartMain ? copy.startMainAgent : copy.startNewAgent}
            </h3>
          </div>
          {!mustStartMain && (
            <button
              type="button"
              className="close-btn"
              data-testid="input-dialog-close"
              aria-label={copy.close}
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>

        {step === 'agent-list' && (
          <div className="agent-list">
            {!agentsLoaded && (
              <div className="agent-list-status fx-crt-panel" data-testid="agent-list-status">
                <span className="agent-list-spinner" aria-hidden="true" />
                <span>{copy.loadingAgents}</span>
              </div>
            )}
            {agentsLoaded && agentLoadFailed && (
              <div className="agent-list-status fx-crt-panel" data-testid="agent-list-status">
                {copy.agentListUnavailable}
              </div>
            )}
            {agentsLoaded && !agentLoadFailed && codingAgents.length === 0 && otherAgents.length === 0 && (
              <div className="agent-list-status fx-crt-panel" data-testid="agent-list-status">
                {copy.noSupportedAgentsFound}
              </div>
            )}
            {mustStartMain && resumableMainAgentSession && (
              <label className="main-agent-resume-option fx-crt-panel" data-testid="main-agent-resume-option">
                <input
                  type="checkbox"
                  data-testid="main-agent-resume-toggle"
                  checked={resumeMainAgent}
                  onChange={event => setResumeMainAgent(event.target.checked)}
                />
                <span className="main-agent-resume-copy">
                  <span className="main-agent-resume-title">{copy.resumePreviousMainAgent}</span>
                  <span className="main-agent-resume-detail">{mainAgentResumeLabel(resumableMainAgentSession, copy)}</span>
                </span>
              </label>
            )}
            {codingAgents.length > 0 && (
              <div className="agent-group">
                <div className="group-label">{copy.codingAgents}</div>
                {codingAgents.map((agent, i) => (
                  <button
                    key={agent.name}
                    className="agent-item fx-crt-panel"
                    data-testid={`agent-option-${agent.name}`}
                    disabled={mustStartMain && (startClickLocked || !settingsLoaded)}
                    onClick={() => selectAgent(agent)}
                  >
                    <span className="key-hint-badge">{i < 9 ? i + 1 : 0}</span>
                    <span className="agent-item-name">{agentDisplayName(agent.name)}</span>
                    <span className="agent-item-desc">{agent.description}</span>
                  </button>
                ))}
              </div>
            )}
            {otherAgents.length > 0 && (
              <div className="agent-group">
                <div className="group-label">{copy.otherAgents}</div>
                {otherAgents.map((agent, i) => {
                  const globalIndex = codingAgents.length + i
                  return (
                    <button
                      key={agent.name}
                      className="agent-item fx-crt-panel"
                      data-testid={`agent-option-${agent.name}`}
                      disabled={mustStartMain && (startClickLocked || !settingsLoaded)}
                      onClick={() => selectAgent(agent)}
                    >
                      <span className="key-hint-badge">
                        {globalIndex < 9 ? globalIndex + 1 : 0}
                      </span>
                      <span className="agent-item-name">{agentDisplayName(agent.name)}</span>
                      <span className="agent-item-desc">{agent.description}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {step === 'workspace' && selectedAgent && (
          <div className="workspace-input" data-testid="workspace-step">
            <p className="workspace-field-copy">{copy.workspace}</p>
            <input
              ref={inputRef}
              data-testid="workspace-input"
              type="text"
              value={workspace}
              onFocus={() => syncSelectionWithValue(workspace)}
              onChange={e => {
                const nextValue = e.target.value
                workspaceTouchedRef.current = true
                setWorkspace(nextValue)
                syncSelectionWithValue(nextValue)
              }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  if (workspacePathSuggestions.length > 0 && moveWorkspacePathSelection(1)) {
                    e.preventDefault()
                    return
                  }
                  if (moveWorkspaceHistorySelection(1)) {
                    e.preventDefault()
                  }
                  return
                }
                if (e.key === 'ArrowUp') {
                  if (workspacePathSuggestions.length > 0 && moveWorkspacePathSelection(-1)) {
                    e.preventDefault()
                    return
                  }
                  if (moveWorkspaceHistorySelection(-1)) {
                    e.preventDefault()
                  }
                  return
                }
                if (e.key === 'Tab' && workspacePathSuggestions.length > 0) {
                  if (acceptWorkspacePathSuggestion(workspacePathSelection === -1 ? 0 : workspacePathSelection)) {
                    e.preventDefault()
                  }
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (workspacePathSelection !== -1 && acceptWorkspacePathSuggestion(workspacePathSelection)) {
                    return
                  }
                  void confirm()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setStep('agent-list')
                }
              }}
              placeholder={copy.workspacePathPlaceholder}
              name="workspace-path"
              inputMode="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
            />
            {workspacePathSuggestions.length > 0 && (
              <div
                ref={workspacePathSuggestionsRef}
                className="workspace-path-suggestions fx-crt-panel"
                data-testid="workspace-path-suggestions"
                role="listbox"
              >
                {workspacePathSuggestions.map((suggestion, index) => (
                  <button
                    key={suggestion.path}
                    type="button"
                    className={`workspace-path-suggestion ${index === workspacePathSelection ? 'active' : ''}`}
                    data-testid="workspace-path-suggestion"
                    role="option"
                    aria-selected={index === workspacePathSelection}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      acceptWorkspacePathSuggestion(index)
                    }}
                  >
                    <span className="workspace-path-suggestion-name">{suggestion.name}</span>
                    <span className="workspace-path-suggestion-path">{formatWorkspaceForDisplay(suggestion.path)}</span>
                  </button>
                ))}
              </div>
            )}
            {!mustStartMain && showWorkflowTaskFields && (
              <>
                <p className="workspace-field-copy">Workflow:</p>
                <select
                  className="workflow-select fx-crt-panel"
                  data-testid="workflow-template-select"
                  value={workflowId}
                  onChange={e => setWorkflowId(e.target.value)}
                  aria-label="Workflow template"
                >
                  {WORKFLOW_TEMPLATE_OPTIONS.map(opt => (
                    <option key={opt.id || 'none'} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
                <p className="workspace-field-copy">Task (optional):</p>
                <textarea
                  className="task-input fx-crt-panel"
                  data-testid="task-input"
                  value={taskText}
                  onChange={e => setTaskText(e.target.value)}
                  placeholder="Describe what this agent should focus on"
                  rows={4}
                  name="agent-task"
                  autoComplete="off"
                  spellCheck={false}
                />
              </>
            )}
            {workspaceOptions.length > 0 && (
              <div
                className="workspace-history fx-crt-panel"
                data-testid="workspace-history"
              >
                <div className="workspace-history-header">
                  <span>{copy.recentWorkspacesLower}</span>
                  <span className="hint">↑ ↓</span>
                </div>
                <div className="workspace-history-list">
                  {workspaceOptions.map((entry, index) => (
                    <button
                      key={entry}
                      type="button"
                      className={`workspace-history-item ${index === historySelection ? 'active' : ''}`}
                      data-testid="workspace-history-item"
                      onMouseDown={(event) => {
                        event.preventDefault()
                        selectWorkspaceHistory(index)
                      }}
                    >
                      <span className="workspace-history-index">{index + 1}</span>
                      <span className="workspace-history-path">{formatWorkspaceForDisplay(entry)}</span>
                      {index === 0 && entry === workspaceHistory[0] && <span className="workspace-history-badge">{copy.latest}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="workspace-actions">
              <button
                type="button"
                data-testid="workspace-start"
                aria-label={copy.start}
                disabled={startClickLocked}
                onClick={() => void confirm()}
              >
                {copy.start}
              </button>
              <button
                type="button"
                data-testid="workspace-back"
                aria-label={copy.back}
                onClick={() => setStep('agent-list')}
              >
                {copy.back}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
