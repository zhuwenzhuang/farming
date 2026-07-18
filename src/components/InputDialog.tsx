import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useKeyboard } from '@/hooks/useKeyboard'
import { appPath } from '@/lib/base-path'
import { agentDisplayName, formatRelativeAge } from '@/lib/format'
import { isMobileTouchViewport } from '@/lib/responsive-mode'
import type { CodeCopy } from '@/components/code/copy'
import { AgentLaunchIcon } from '@/components/code/AgentLaunchIcon'
import { normalizeAgentLaunchOptions } from '@/components/code/agent-launch-options'
import { ArrowDownGlyph, ArrowUpGlyph, CheckGlyph, ChevronDownGlyph, CloseGlyph, ErrorGlyph, PlusGlyph } from '@/components/IconGlyphs'
import { mergeTaskWithWorkflow, WORKFLOW_TEMPLATE_OPTIONS } from '@/lib/workflow-templates'
import { prepareWorkspaceDirectory } from '@/lib/workspace-directory'
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
  return isMobileTouchViewport()
}

function normalizeDefaultLaunchAgent(agentName: string | undefined) {
  if (agentName === 'opencode') return 'opencode'
  if (agentName === 'qoder') return 'qoder'
  if (agentName === 'bash') return 'bash'
  if (agentName === 'zsh') return 'zsh'
  return agentName === 'claude' ? 'claude' : 'codex'
}

function isResumeProvider(provider: string | undefined) {
  return provider === 'codex' || provider === 'claude' || provider === 'qoder'
}

interface CliAgent {
  name: string
  command?: string
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
  providerHomeId?: string
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
  providerHomeId?: string
  codexRuntimeMode?: 'cli' | 'app-server'
  agentRuntimeMode?: 'terminal' | 'acp' | 'json'
  resumeSession?: {
    provider: string
    id: string
    providerHomeId?: string
  }
  task?: string
  workflowTemplate?: string
  customTitle?: string
}

interface InputDialogProps {
  open: boolean
  mustStartMain: boolean
  initialWorkspace?: string
  initialCommand?: string
  initialCustomTitle?: string
  showWorkflowTaskFields?: boolean
  copy: CodeCopy
  onStart: (command: string, workspace: string, options?: StartAgentOptions) => void
  onClose: () => void
}

type DialogStep = 'agent-list' | 'workspace'

type WorkspacePreparation = {
  kind: 'confirm' | 'creating' | 'error'
  workspace: string
  code?: string
}

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
  initialCustomTitle,
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
  const [agentHomes, setAgentHomes] = useState<Record<string, Array<{ id: string; path: string }>>>({})
  const [selectedHomeId, setSelectedHomeId] = useState('default')
  const [codexRuntimeMode, setCodexRuntimeMode] = useState<'cli' | 'app-server' | 'acp'>('cli')
  const [homeMenuOpen, setHomeMenuOpen] = useState(false)
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
  const [workspacePreparation, setWorkspacePreparation] = useState<WorkspacePreparation | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const homeMenuRef = useRef<HTMLDivElement>(null)
  const homeMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const workspacePathSuggestionsRef = useRef<HTMLDivElement>(null)
  const workspacePromptPrimaryRef = useRef<HTMLButtonElement>(null)
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

  useLayoutEffect(() => {
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
    setWorkspacePreparation(null)
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
    setAgentHomes({})
    setSelectedHomeId('default')
    setCodexRuntimeMode('cli')
    setHomeMenuOpen(false)
    setHistorySelection(-1)
    setAgentsLoaded(false)
    setAgentLoadFailed(false)
    setSettingsLoaded(false)

    fetch(appPath('/api/executables'), { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error(`Failed to load executables: ${r.status}`)
        return r.json()
      })
      .then((data: { agents: CliAgent[] } | CliAgent[]) => {
        if (cancelled) return
        const nextAgents = Array.isArray(data) ? data : data.agents ?? []
        const normalizedAgents = normalizeAgentLaunchOptions(nextAgents).map(agent => ({
          ...agent,
          description: agent.description ?? '',
          category: agent.category ?? 'coding',
        }))
        const initialAgent = !mustStartMain && initialCommand
          ? normalizedAgents.find(agent => agent.name === initialCommand)
          : null
        setAgents(normalizedAgents)
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
      .then((data: { settings?: { workspace?: string; lastMainWorkspace?: string; workspaceHistory?: string[]; defaultLaunchAgent?: string; codexRuntimeMode?: string; agentHomes?: Record<string, Array<{ id: string; path: string }>> } }) => {
        const settings = data.settings ?? {}
        const nextMainWorkspaceDefault = getMainWorkspaceDefault(settings)
        const history = buildWorkspaceHistory(null, settings.workspaceHistory ?? [])
        setMainWorkspaceDefault(nextMainWorkspaceDefault)
        setDefaultLaunchAgent(normalizeDefaultLaunchAgent(settings.defaultLaunchAgent))
        setWorkspaceHistory(history)
        setAgentHomes(settings.agentHomes ?? {})
        setCodexRuntimeMode(settings.codexRuntimeMode === 'app-server' ? 'app-server' : 'cli')
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

    fetch(appPath('/api/agent-sessions?limit=100&fresh=1'), { cache: 'no-store' })
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

  useLayoutEffect(() => {
    if (!workspacePreparation || workspacePreparation.kind === 'creating') return
    workspacePromptPrimaryRef.current?.focus()
  }, [workspacePreparation])

  useLayoutEffect(() => {
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

    const focusDefaultAgent = () => {
      const agentButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.agent-item:not(:disabled)'))
      const defaultAgentButton = agentButtons.find(button => button.dataset.testid === `agent-option-${effectiveDefaultLaunchAgent}`)
      ;(defaultAgentButton ?? agentButtons[0])?.focus()
    }
    focusDefaultAgent()
    const frame = requestAnimationFrame(focusDefaultAgent)
    const timer = window.setTimeout(focusDefaultAgent, 0)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
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
        providerHomeId: resumableMainAgentSession.providerHomeId,
      },
      providerHomeId: resumableMainAgentSession.providerHomeId,
    }
  }, [mustStartMain, resumableMainAgentSession, resumeMainAgent])

  const selectAgent = useCallback((agent: CliAgent) => {
    if (mustStartMain) {
      if (!settingsLoaded) return
      if (!lockStartClick()) return
      const resolvedWorkspace = resolveWorkspaceToStart(workspace, true, mainWorkspaceDefault)
      if (resolvedWorkspace) onStart(agent.command || agent.name, resolvedWorkspace, { ...(resumeStartOptions(agent) || {}), providerHomeId: selectedHomeId })
      return
    }

    setSelectedAgent(agent)
    const nextHomes = (Array.isArray(agentHomes[agent.name]) ? agentHomes[agent.name] : []) as Array<{ id: string; path: string }>
    setSelectedHomeId(nextHomes[0]?.id || 'default')
    setHomeMenuOpen(false)
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

  const startPreparedAgent = useCallback(async (resolvedWorkspace: string) => {
    if (!selectedAgent) return
    if (!mustStartMain && shouldRememberWorkspace(resolvedWorkspace)) {
      await persistWorkspaceHistory(resolvedWorkspace)
    }

    const options = resumeStartOptions(selectedAgent)
    if (options) {
      onStart(selectedAgent.command || selectedAgent.name, resolvedWorkspace, { ...options, providerHomeId: selectedHomeId })
      return
    }

    if (mustStartMain) {
      onStart(selectedAgent.command || selectedAgent.name, resolvedWorkspace, { providerHomeId: selectedHomeId })
      return
    }

    const merged = showWorkflowTaskFields
      ? mergeTaskWithWorkflow(taskText, workflowId)
      : { task: '', workflowTemplate: '' }
    onStart(selectedAgent.command || selectedAgent.name, resolvedWorkspace, {
      task: merged.task,
      workflowTemplate: merged.workflowTemplate,
      ...(initialCustomTitle ? { customTitle: initialCustomTitle } : {}),
      providerHomeId: selectedHomeId,
      ...(['codex', 'claude', 'opencode', 'qoder'].includes(selectedAgent.name) ? {
        codexRuntimeMode: codexRuntimeMode === 'app-server' ? 'app-server' : 'cli',
        agentRuntimeMode: codexRuntimeMode === 'acp' ? 'acp' : 'terminal',
      } : {}),
    })
  }, [
    selectedAgent,
    mustStartMain,
    persistWorkspaceHistory,
    resumeStartOptions,
    onStart,
    selectedHomeId,
    showWorkflowTaskFields,
    taskText,
    workflowId,
    initialCustomTitle,
    codexRuntimeMode,
  ])

  const confirm = useCallback(async () => {
    if (!selectedAgent) return
    if (!lockStartClick()) return

    const currentWorkspace = normalizeWorkspaceValue(inputRef.current?.value ?? workspace)
    const resolvedWorkspace = resolveWorkspaceToStart(currentWorkspace, mustStartMain, mainWorkspaceDefault)
    if (!resolvedWorkspace) return

    if (mustStartMain) {
      await startPreparedAgent(resolvedWorkspace)
      return
    }

    try {
      const result = await prepareWorkspaceDirectory(resolvedWorkspace)
      if (result.status === 'ready') {
        await startPreparedAgent(result.workspace)
        return
      }
      setWorkspacePreparation({
        kind: result.status === 'missing' ? 'confirm' : 'error',
        workspace: result.workspace || resolvedWorkspace,
        code: result.code,
      })
    } catch {
      setWorkspacePreparation({ kind: 'error', workspace: resolvedWorkspace })
    }
  }, [
    selectedAgent,
    workspace,
    mustStartMain,
    mainWorkspaceDefault,
    lockStartClick,
    startPreparedAgent,
  ])

  const createWorkspaceAndStart = useCallback(async () => {
    if (!workspacePreparation || workspacePreparation.kind === 'creating') return
    const target = workspacePreparation.workspace
    setWorkspacePreparation({ kind: 'creating', workspace: target })
    try {
      const result = await prepareWorkspaceDirectory(target, true)
      if (result.status === 'created' || result.status === 'ready') {
        await startPreparedAgent(result.workspace)
        return
      }
      setWorkspacePreparation({ kind: 'error', workspace: result.workspace || target, code: result.code })
    } catch {
      setWorkspacePreparation({ kind: 'error', workspace: target })
    }
  }, [startPreparedAgent, workspacePreparation])

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
      if (isMobileViewport()) {
        inputRef.current.blur()
        return
      }
      inputRef.current.focus()
      inputRef.current.setSelectionRange(nextValue.length, nextValue.length)
    })
  }, [workspaceOptions])


  const homesForSelectedAgent = useMemo(() => {
    if (!selectedAgent) return []
    const homes = (Array.isArray(agentHomes[selectedAgent.name]) ? agentHomes[selectedAgent.name] : []) as Array<{ id: string; path: string }>
    if (homes.length > 0) return homes
    if (selectedAgent.name === 'codex') return [{ id: 'default', path: '~/.codex' }]
    if (selectedAgent.name === 'claude') return [{ id: 'default', path: '~/.claude' }]
    if (selectedAgent.name === 'opencode') return [{ id: 'default', path: '~/.opencode' }]
    if (selectedAgent.name === 'qoder') return [{ id: 'default', path: '~/.qoder' }]
    return [{ id: 'default', path: `~/.${selectedAgent.name}` }]
  }, [agentHomes, selectedAgent])

  const selectedHome = useMemo(
    () => homesForSelectedAgent.find(home => home.id === selectedHomeId) ?? homesForSelectedAgent[0],
    [homesForSelectedAgent, selectedHomeId]
  )

  useEffect(() => {
    const current = homesForSelectedAgent || []
    if (current.length === 0) {
      setSelectedHomeId('default')
      return
    }
    if (!current.some(home => home.id === selectedHomeId)) {
      setSelectedHomeId(current[0]?.id || 'default')
    }
  }, [homesForSelectedAgent, selectedHomeId])

  useEffect(() => {
    if (!homeMenuOpen) return

    const closeIfOutside = (event: MouseEvent) => {
      if (!homeMenuRef.current?.contains(event.target as Node)) setHomeMenuOpen(false)
    }
    window.addEventListener('mousedown', closeIfOutside)
    return () => {
      window.removeEventListener('mousedown', closeIfOutside)
    }
  }, [homeMenuOpen])

  const selectHome = useCallback((id: string) => {
    setSelectedHomeId(id)
    setHomeMenuOpen(false)
    requestAnimationFrame(() => homeMenuTriggerRef.current?.focus())
  }, [])

  const acceptWorkspacePathSuggestion = useCallback((index: number) => {
    const suggestion = workspacePathSuggestions[index]
    if (!suggestion) return false

    workspaceTouchedRef.current = true
    setWorkspace(suggestion.path)
    setHistorySelection(-1)
    setWorkspacePathSelection(-1)
    requestAnimationFrame(() => {
      if (!inputRef.current) return
      if (isMobileViewport()) {
        inputRef.current.blur()
        return
      }
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
      {
        key: 'Escape',
        allowInOverlay: true,
        handler: () => {
          if (workspacePreparation) {
            if (workspacePreparation.kind === 'creating') return
            setWorkspacePreparation(null)
            requestAnimationFrame(() => inputRef.current?.focus())
            return
          }
          if (homeMenuOpen) {
            setHomeMenuOpen(false)
            requestAnimationFrame(() => homeMenuTriggerRef.current?.focus())
            return
          }
          setStep('agent-list')
        },
      },
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
              <CloseGlyph />
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
                    <AgentLaunchIcon name={agent.name} />
                    <span className="key-hint-badge">{i < 9 ? i + 1 : 0}</span>
                    <span className="agent-item-copy">
                      <span className="agent-item-name">{agentDisplayName(agent.name)}</span>
                      <span className="agent-item-desc">{agent.description}</span>
                    </span>
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
                      <AgentLaunchIcon name={agent.name} />
                      <span className="key-hint-badge">
                        {globalIndex < 9 ? globalIndex + 1 : 0}
                      </span>
                      <span className="agent-item-copy">
                        <span className="agent-item-name">{agentDisplayName(agent.name)}</span>
                        <span className="agent-item-desc">{agent.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {step === 'workspace' && selectedAgent && (
          <div className="workspace-input" data-testid="workspace-step">
            {(homesForSelectedAgent?.length ?? 0) > 1 && (
              <div className="workspace-home-field" ref={homeMenuRef}>
                <p className="workspace-field-copy">{agentDisplayName(selectedAgent.name)} Home</p>
                <button
                  ref={homeMenuTriggerRef}
                  type="button"
                  className="workspace-home-trigger"
                  data-testid="agent-home-select"
                  aria-label={`${agentDisplayName(selectedAgent.name)} home`}
                  aria-expanded={homeMenuOpen}
                  aria-controls="agent-home-options"
                  onClick={() => setHomeMenuOpen(open => !open)}
                  onKeyDown={event => {
                    if (event.key === 'Escape' && homeMenuOpen) {
                      event.preventDefault()
                      event.stopPropagation()
                      setHomeMenuOpen(false)
                      return
                    }
                    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                    event.preventDefault()
                    setHomeMenuOpen(true)
                    requestAnimationFrame(() => {
                      const selector = event.key === 'ArrowDown'
                        ? '[data-home-option]:first-child'
                        : '[data-home-option]:last-child'
                      homeMenuRef.current?.querySelector<HTMLButtonElement>(selector)?.focus()
                    })
                  }}
                >
                  <span className="workspace-home-trigger-copy">
                    <strong>{selectedHome?.id || 'default'}</strong>
                    <span>{formatWorkspaceForDisplay(selectedHome?.path || '')}</span>
                  </span>
                  <ChevronDownGlyph />
                </button>
                {homeMenuOpen && (
                  <div
                    className="workspace-home-menu"
                    id="agent-home-options"
                    data-testid="agent-home-menu"
                    role="listbox"
                    aria-label={`${agentDisplayName(selectedAgent.name)} home`}
                    onKeyDown={event => {
                      if (event.key !== 'Escape') return
                      event.preventDefault()
                      event.stopPropagation()
                      setHomeMenuOpen(false)
                      requestAnimationFrame(() => homeMenuTriggerRef.current?.focus())
                    }}
                  >
                    {homesForSelectedAgent.map(home => {
                      const selected = home.id === selectedHomeId
                      return (
                        <button
                          key={home.id}
                          type="button"
                          className={`workspace-home-option ${selected ? 'selected' : ''}`}
                          data-testid="agent-home-option"
                          data-home-option
                          role="option"
                          aria-selected={selected}
                          onClick={() => selectHome(home.id)}
                        >
                          <CheckGlyph className="workspace-home-option-check" />
                          <span className="workspace-home-option-copy">
                            <strong>{home.id}</strong>
                            <span>{formatWorkspaceForDisplay(home.path)}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            {['codex', 'claude', 'opencode', 'qoder'].includes(selectedAgent.name) && (
              <div className="workspace-runtime-field" data-testid="codex-runtime-mode">
                <p className="workspace-field-copy">{agentDisplayName(selectedAgent.name)} runtime</p>
                <div className="workspace-runtime-options" role="group" aria-label={`${agentDisplayName(selectedAgent.name)} runtime`}>
                  <button type="button" className={codexRuntimeMode === 'cli' ? 'active' : ''} aria-pressed={codexRuntimeMode === 'cli'} onClick={() => setCodexRuntimeMode('cli')}>Terminal</button>
                  <button type="button" className={codexRuntimeMode === 'acp' ? 'active' : ''} aria-pressed={codexRuntimeMode === 'acp'} onClick={() => setCodexRuntimeMode('acp')}>Chat <span>ACP</span></button>
                  {selectedAgent.name === 'codex' && (
                    <button type="button" className={codexRuntimeMode === 'app-server' ? 'active' : ''} aria-pressed={codexRuntimeMode === 'app-server'} onClick={() => setCodexRuntimeMode('app-server')}>App Server <span>unstable</span></button>
                  )}
                </div>
              </div>
            )}
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
                setWorkspacePreparation(null)
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
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="go"
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
              disabled={workspacePreparation !== null}
            />
            {workspacePreparation ? (
              <div
                className={`workspace-directory-prompt ${workspacePreparation.kind === 'error' ? 'error' : ''}`}
                data-testid="workspace-directory-prompt"
                role="alertdialog"
                aria-labelledby="workspace-directory-prompt-title"
                aria-describedby="workspace-directory-prompt-description"
              >
                <div className="workspace-directory-prompt-icon" aria-hidden="true">
                  {workspacePreparation.kind === 'error' ? <ErrorGlyph /> : <PlusGlyph />}
                </div>
                <div className="workspace-directory-prompt-copy">
                  <h4 id="workspace-directory-prompt-title">
                    {workspacePreparation.kind === 'error' ? copy.workspaceCreateFailedTitle : copy.workspaceMissingTitle}
                  </h4>
                  <p id="workspace-directory-prompt-description">
                    {workspacePreparation.kind === 'error'
                      ? workspacePreparation.code === 'workspace-create-forbidden'
                        ? copy.workspaceCreateForbiddenDescription
                        : copy.workspaceCreateFailedDescription
                      : copy.workspaceMissingDescription}
                  </p>
                  <code>{formatWorkspaceForDisplay(workspacePreparation.workspace)}</code>
                </div>
                <div className="workspace-directory-prompt-actions">
                  {workspacePreparation.kind === 'error' ? (
                    <button
                      ref={workspacePromptPrimaryRef}
                      type="button"
                      data-testid="workspace-directory-back"
                      onClick={() => {
                        setWorkspacePreparation(null)
                        requestAnimationFrame(() => inputRef.current?.focus())
                      }}
                    >
                      {copy.returnToWorkspace}
                    </button>
                  ) : (
                    <>
                      <button
                        ref={workspacePromptPrimaryRef}
                        type="button"
                        data-testid="workspace-directory-create"
                        disabled={workspacePreparation.kind === 'creating'}
                        onClick={() => void createWorkspaceAndStart()}
                      >
                        {workspacePreparation.kind === 'creating' ? copy.workspaceCreating : copy.workspaceCreateAndStart}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        data-testid="workspace-directory-cancel"
                        disabled={workspacePreparation.kind === 'creating'}
                        onClick={() => {
                          setWorkspacePreparation(null)
                          requestAnimationFrame(() => inputRef.current?.focus())
                        }}
                      >
                        {copy.back}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : workspacePathSuggestions.length > 0 && (
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
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="done"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                />
              </>
            )}
            {!workspacePreparation && workspaceOptions.length > 0 && (
              <div
                className="workspace-history fx-crt-panel"
                data-testid="workspace-history"
              >
                <div className="workspace-history-header">
                  <span>{copy.recentWorkspacesLower}</span>
                  <span className="hint" aria-hidden="true">
                    <ArrowUpGlyph />
                    <ArrowDownGlyph />
                  </span>
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
            {!workspacePreparation && <div className="workspace-actions">
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
            </div>}
          </div>
        )}
      </div>
    </div>
  )
}
