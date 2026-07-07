import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import type {
  ChangeEvent as ReactChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import type { Agent, AgentContextWindowUsage, SystemStats, TaskHistoryEntry, UsageSummary } from '@/types/agent'
import type { TerminalInputPart } from '@/types/messages'
import { appPath } from '@/lib/base-path'
import { agentTitle } from '@/lib/format'
import {
  shouldRevealSelectedWorkspaceOpenFile,
  workspaceOpenFileRequestForTarget,
  workspaceOpenFileKey,
  workspaceOpenFileTargetKey,
  type OpenWorkspaceFile,
  type WorkspaceOpenFileTarget,
} from '@/lib/workspace-open-files'
import {
  workspaceNavigationShortcutDirection,
  type WorkspaceNavigationEntry,
} from '@/lib/workspace-navigation-history'
import { isMobileTouchViewport } from '@/lib/responsive-mode'
import { buildWorkspaceHistory } from '@/lib/workspace-options'
import {
  fetchWorkspaceFile,
  fetchWorkspaceTree,
  searchWorkspaceFiles,
  type WorkspaceFileDeleteResult,
  type WorkspaceFileMove,
  type WorkspaceFileSearchMatch,
} from '@/lib/workspace-files'
import type { TerminalPathOpenTarget } from '@/lib/terminal-session-pool'
import { isOverlayShortcutTarget, isTerminalShortcutTarget, isTextEditingShortcutTarget } from '@/hooks/useKeyboard'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { CodeMainArea } from './code/CodeMainArea'
import { CodeOverlays } from './code/CodeOverlays'
import { CodeSidebar } from './code/CodeSidebar'
import {
  capabilitiesForAgent,
  inferAgentTerminalState,
  isAgentTurnActive,
  isCodexAgentWorking,
  mergeSlashCommands,
  projectCanDeleteWorktree,
  slashCommandsForAgentKind,
  type SlashCommandOption,
} from './code/capabilities'
import {
  appendDraftBlock,
  clipboardImageFiles,
  composerAttachmentMessageBlocks,
  composerMessageWithAttachments,
  createComposerAttachmentId,
  createImageAttachmentPreviewUrl,
  fileDisplayName,
  formatAttachedImage,
  formatAttachmentError,
  formatAttachmentFile,
  formatComposerMessage,
  isImageFile,
  revokeComposerAttachmentPreview,
  uploadImageAttachment,
  type ComposerAttachment,
} from './code/composer-message'
import { terminalInputPartsForComposerMessage } from './code/composer-submit'
import {
  addComposerHistoryEntry,
  canUseComposerHistoryNavigation,
  createDefaultComposerHistoryState,
  navigateComposerHistory,
  type ComposerHistoryDirection,
  type ComposerHistoryNavigationInput,
  type ComposerHistoryState,
} from './code/composer-history'
import { codeCopyForLanguage } from './code/copy'
import { scheduleFocusRetries } from './code/focus-retry'
import {
  DEFAULT_CLAUDE_SETTINGS,
  buildComposerControlState,
  isClaudePermissionMode,
  isCodexApprovalMode,
  normalizeClaudeEffort,
  normalizeClaudeModel,
  normalizeClaudeSettingsSummary,
  normalizeLaunchProfiles,
  type ClaudeSettingsSummary,
} from './code/composer-profile'
import type {
  AgentSessionHistoryItem,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexModelOption,
  CodeModelPickerPane,
  CodexModelPreset,
  ComposerMode,
  GlobalSettings,
  LegacyCodexModelOption,
  MainPaneMode,
  SearchTarget,
  SpeechRecognitionLike,
  WindowWithSpeechRecognition,
  WorkspaceFileOpenTarget,
  WorkspaceView,
} from './code/types'
import type { UiPreferences } from '@/lib/ui-preferences'
import {
  FALLBACK_CODEX_MODEL_OPTIONS,
  MAIN_AGENT_PROJECT_ID,
  agentSessionId,
  agentSessionWorkspace,
  agentSessionWorkingDirectory,
  basename,
  normalizeModelCatalog,
  projectWorkspaceForAgent,
  workspaceTargetId,
} from './code/model'
import {
  buildAgentListState,
  isAgentListLiveAgent,
} from './code/agent-list-state'
import {
  displayedProjectsForSearch,
  projectListProjectsForAgents,
  projectWorkspaceForHistoryRun,
  shouldMarkAgentUnreadForTurnTransition,
  visibleSearchTargetsForProjects,
} from './code/workspace-derived'
import {
  compactContextMenuEntries,
  type ContextMenuEntry,
} from './code/menu-model'
import {
  clampContextMenuPoint,
  estimateAgentContextMenuHeight,
  estimateContextMenuHeight,
} from './code/menu-position'
import { useWorkspaceOpenFiles } from './code/useWorkspaceOpenFiles'
import { useWorkspaceNavigationHistory } from './code/useWorkspaceNavigationHistory'
import {
  terminalTargetFilePath,
} from './code/workspace-file-view'
import {
  applySessionDisplayOverrides,
  limitProjectAgentSessions,
  loadSessionDisplayState,
  normalizeMainPageSessionKeys,
  resumedAgentSessionIdFromSource,
  resumedAgentSource,
  saveSessionDisplayState,
} from './code/session-display'
import {
  normalizeAgentLaunchOptions,
  type AgentLaunchOption,
} from './code/agent-launch-options'

export type { WorkspaceView } from './code/types'

function mobileServerLabel() {
  if (typeof window === 'undefined') return ''
  const hostname = window.location.hostname
  if (!hostname) return ''
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return 'Local server'
  return 'Remote server'
}

function languageOptionDisplayLabel(label: string) {
  return label
    .replace(/^Language:\s*/i, '')
    .replace(/^语言[:：]\s*/, '')
}

function appearanceOptionDisplayLabel(label: string) {
  return label
    .replace(/^Appearance:\s*/i, '')
    .replace(/^外观[:：]\s*/, '')
}

function sameStringSet(set: ReadonlySet<string>, values: string[]) {
  if (set.size !== values.length) return false
  return values.every(value => set.has(value))
}

export interface DeleteForkWorktreeProjectResult {
  workspace?: string
  deleted?: boolean
  forced?: boolean
  requiresForce?: boolean
  dirtyEntries?: string[]
  archivedAgentIds?: string[]
  removedMainPageSessionKeys?: string[]
  error?: string
}

export interface AgentFlagUpdateResult {
  removedMainPageSessionKeys?: string[]
  error?: string
}

type AgentFlagUpdateResponse = AgentFlagUpdateResult | boolean | void

interface CodeWorkspaceProps {
  agents: Agent[]
  taskHistory: TaskHistoryEntry[]
  mainPageSessionKeys: string[]
  activeView: WorkspaceView
  dialogOpen: boolean
  systemStats: SystemStats | null
  usageSummary: UsageSummary | null
  contextWindowByAgentId: Record<string, AgentContextWindowUsage>
  activeTerminalId: string | null
  openTerminalIds: string[]
  terminalFocusRequest: { agentId: string; nonce: number } | null
  keyMap: Map<string, string>
  keyboardShortcutsEnabled: boolean
  uiPreferences: UiPreferences
  onOpenTerminal: (agentId: string, options?: { focusTerminal?: boolean }) => void
  onNewAgent: (workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null) => void
  onStartAgent: (command: string, workspace: string, options?: { projectWorkspace?: string }) => void
  onRenameAgent: (agentId: string, title: string) => void
  onUpdateAgentFlags: (agentId: string, flags: Partial<Pick<Agent, 'pinned' | 'unread' | 'archived'>>) => AgentFlagUpdateResponse | Promise<AgentFlagUpdateResponse>
  onOpenArchivedAgent: (agentId: string) => void
  onForkAgent: (agentId: string, mode: 'same-worktree' | 'new-worktree') => void
  onDeleteForkWorktreeProject: (workspace: string, options?: { force?: boolean }) => Promise<DeleteForkWorktreeProjectResult>
  onRestartMainAgent: (command: 'bash' | 'zsh' | 'codex' | 'claude') => void
  onWorkspaceViewChange: (view: WorkspaceView) => void
  onKill: (agentId: string) => void
  onInterruptAgent: (agentId: string) => void
  sendInput: (input: string | TerminalInputPart[], agentId?: string) => boolean
  resizeAgent: (agentId: string, cols: number, rows: number) => boolean
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null) => void) => () => void
  onUpdateUiPreferences: (patch: Partial<UiPreferences>) => void
}

interface TerminalFollowState {
  following: boolean
  hasUnreadOutput: boolean
}

interface AgentComposerPendingFollowUpMessage {
  id: string
  text: string
  createdAt: number
}

interface AgentComposerPendingFollowUp {
  messages: AgentComposerPendingFollowUpMessage[]
  createdAt: number
}

interface AgentComposerUiState {
  plusMenuOpen: boolean
  approvalMenuOpen: boolean
  modelMenuOpen: boolean
  modelPickerPane: CodeModelPickerPane
}

interface AgentComposerState {
  draft: string
  attachments: ComposerAttachment[]
  mode: ComposerMode
  history: ComposerHistoryState
  pendingFollowUp?: AgentComposerPendingFollowUp
  ui: AgentComposerUiState
}

const DEFAULT_SIDEBAR_WIDTH = 296
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 520
const COLLAPSED_SIDEBAR_WIDTH = 64
const SIDEBAR_DRAG_COLLAPSE_WIDTH = 172
const DESKTOP_AUTO_COLLAPSE_WIDTH = 900
const OPTIONS_MENU_ESTIMATED_WIDTH = 168
const OPTIONS_MENU_ESTIMATED_HEIGHT = 168
const TERMINAL_PATH_SEARCH_LIMIT = 12

function isNativeTextEditingShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.isContentEditable
}

const DEFAULT_AGENT_COMPOSER_UI_STATE: AgentComposerUiState = {
  plusMenuOpen: false,
  approvalMenuOpen: false,
  modelMenuOpen: false,
  modelPickerPane: null,
}
const DEFAULT_AGENT_COMPOSER_STATE: AgentComposerState = createDefaultAgentComposerState()

function createDefaultAgentComposerState(): AgentComposerState {
  return {
    draft: '',
    attachments: [],
    mode: 'default',
    history: createDefaultComposerHistoryState(),
    ui: { ...DEFAULT_AGENT_COMPOSER_UI_STATE },
  }
}

function createPendingFollowUpMessage(text: string): AgentComposerPendingFollowUpMessage {
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return {
    id: `pending-${randomId}`,
    text,
    createdAt: Date.now(),
  }
}

function removePendingFollowUpMessage(
  pendingFollowUp: AgentComposerPendingFollowUp | undefined,
  messageId: string
): AgentComposerPendingFollowUp | undefined {
  if (!pendingFollowUp) return undefined
  const messages = pendingFollowUp.messages.filter(message => message.id !== messageId)
  return messages.length > 0
    ? { ...pendingFollowUp, messages }
    : undefined
}

function closeComposerMenusForState(state: AgentComposerState): AgentComposerState {
  if (
    !state.ui.plusMenuOpen
    && !state.ui.approvalMenuOpen
    && !state.ui.modelMenuOpen
    && state.ui.modelPickerPane === null
  ) {
    return state
  }

  return {
    ...state,
    ui: { ...DEFAULT_AGENT_COMPOSER_UI_STATE },
  }
}

function isDefaultAgentComposerUiState(ui: AgentComposerUiState) {
  return (
    !ui.plusMenuOpen
    && !ui.approvalMenuOpen
    && !ui.modelMenuOpen
    && ui.modelPickerPane === null
  )
}

function mergeAgentComposerStates(primary: AgentComposerState, incoming: AgentComposerState): AgentComposerState {
  const pendingMessages = [
    ...(primary.pendingFollowUp?.messages || []),
    ...(incoming.pendingFollowUp?.messages || []),
  ]
  const pendingCreatedAt = Math.min(
    primary.pendingFollowUp?.createdAt ?? Number.POSITIVE_INFINITY,
    incoming.pendingFollowUp?.createdAt ?? Number.POSITIVE_INFINITY
  )

  return {
    ...primary,
    draft: primary.draft || incoming.draft,
    attachments: [...incoming.attachments, ...primary.attachments],
    mode: primary.mode !== 'default' ? primary.mode : incoming.mode,
    history: {
      entries: [...incoming.history.entries, ...primary.history.entries].slice(-100),
      cursor: null,
    },
    pendingFollowUp: pendingMessages.length > 0
      ? {
        messages: pendingMessages,
        createdAt: Number.isFinite(pendingCreatedAt) ? pendingCreatedAt : Date.now(),
      }
      : undefined,
    ui: isDefaultAgentComposerUiState(primary.ui) ? incoming.ui : primary.ui,
  }
}

function providerComposerStateKey(agent: Agent | null | undefined) {
  if (!agent || agent.providerSessionTemporary === true) return ''
  if (agent.providerSessionKey) return agent.providerSessionKey
  if (agent.providerSessionProvider && agent.providerSessionId) {
    return workspaceTargetId({
      kind: 'agent-session',
      provider: agent.providerSessionProvider,
      id: agent.providerSessionId,
    })
  }
  return resumedAgentSessionIdFromSource(agent.source)
}

function composerStateKeyForAgent(agent: Agent | null | undefined) {
  if (!agent) return ''
  return providerComposerStateKey(agent) || agent.id
}

function composerStateAliasKeysForAgent(agent: Agent) {
  const keys = new Set<string>()
  if (agent.id) keys.add(agent.id)
  if (agent.providerSessionKey) keys.add(agent.providerSessionKey)
  if (agent.providerSessionProvider && agent.providerSessionId) {
    keys.add(workspaceTargetId({
      kind: 'agent-session',
      provider: agent.providerSessionProvider,
      id: agent.providerSessionId,
    }))
  }
  const sourceKey = resumedAgentSessionIdFromSource(agent.source)
  if (sourceKey) keys.add(sourceKey)
  return Array.from(keys)
}

function resumedSessionFromHistoryRunSource(source?: string) {
  const match = /^([a-z]+)-history(?:-fork)?:(.+)$/.exec(source || '')
  if (!match) return null
  const provider = match[1]
  const sessionId = match[2]
  return provider && sessionId ? { provider, sessionId } : null
}

function isMobileNavigationViewport() {
  return isMobileTouchViewport()
}

function isDesktopAutoCollapseWidth(width: number) {
  return !isMobileNavigationViewport() && width > 0 && width < DESKTOP_AUTO_COLLAPSE_WIDTH
}

function shouldCollapseSidebarInitially() {
  if (isMobileNavigationViewport()) return true
  return typeof window !== 'undefined' && isDesktopAutoCollapseWidth(window.innerWidth)
}

function consumeWorkspaceNavigationShortcut(event: KeyboardEvent) {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}

function mobileWorkspaceLabel(workspace: string | undefined) {
  const normalized = (workspace || '').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || normalized || 'workspace'
}

function openTargetForTerminalPath(target: TerminalPathOpenTarget): WorkspaceFileOpenTarget | undefined {
  if (!target.lineNumber) return undefined
  return {
    lineNumber: target.lineNumber,
    column: target.column,
    endColumn: target.endColumn,
  }
}

function uniqueTerminalPathSearchMatches(matches: WorkspaceFileSearchMatch[]) {
  const uniqueByPath = new Map<string, WorkspaceFileSearchMatch>()
  for (const match of matches) {
    if (match.kind !== 'path' || uniqueByPath.has(match.path)) continue
    uniqueByPath.set(match.path, match)
  }
  return Array.from(uniqueByPath.values())
}

function uniqueTerminalFileSearchMatches(matches: WorkspaceFileSearchMatch[]) {
  const uniqueByPath = new Map<string, WorkspaceFileSearchMatch>()
  for (const match of matches) {
    if (uniqueByPath.has(match.path)) continue
    uniqueByPath.set(match.path, match)
  }
  return Array.from(uniqueByPath.values())
}

async function writeClipboardText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the textarea copy path.
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}

export function CodeWorkspace({
  agents,
  taskHistory,
  mainPageSessionKeys: remoteMainPageSessionKeys,
  activeView,
  dialogOpen,
  systemStats,
  usageSummary,
  contextWindowByAgentId = {},
  activeTerminalId,
  openTerminalIds,
  terminalFocusRequest,
  keyMap,
  keyboardShortcutsEnabled,
  uiPreferences,
  onOpenTerminal,
  onNewAgent,
  onStartAgent,
  onRenameAgent,
  onUpdateAgentFlags,
  onOpenArchivedAgent,
  onForkAgent,
  onDeleteForkWorktreeProject,
  onRestartMainAgent,
  onWorkspaceViewChange,
  onKill,
  onInterruptAgent,
  sendInput,
  resizeAgent,
  onSessionOutput,
  onUpdateUiPreferences,
}: CodeWorkspaceProps) {
  const pageVisible = usePageVisibility()
  const [composerByAgentKey, setComposerByAgentKey] = useState<Record<string, AgentComposerState>>({})
  const pendingFollowUpAutoFlushRef = useRef<Record<string, string>>({})
  const [terminalFollowStates, setTerminalFollowStates] = useState<Record<string, TerminalFollowState>>({})
  const [mainPaneMode, setMainPaneMode] = useState<MainPaneMode>('terminal')
  const workspaceOpenFiles = useWorkspaceOpenFiles()
  const {
    recordAgent: recordWorkspaceNavigationAgent,
    recordFile: recordWorkspaceNavigationFile,
    recordFileCursor: recordWorkspaceNavigationFileCursor,
    beginNavigation: beginWorkspaceNavigation,
    finishNavigation: finishWorkspaceNavigation,
    pruneEntries: pruneWorkspaceNavigationEntries,
  } = useWorkspaceNavigationHistory()
  const openWorkspaceFile = workspaceOpenFiles.activeFile
  const openWorkspaceFiles = workspaceOpenFiles.files
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchSelectionIndex, setSearchSelectionIndex] = useState(0)
  const [, setWorkspaceHistory] = useState<string[]>([])
  const [agentLaunchOptions, setAgentLaunchOptions] = useState<AgentLaunchOption[]>([])
  const [mainPageSessionKeys, setMainPageSessionKeys] = useState<Set<string>>(() => new Set())
  const [codexApprovalMode, setCodexApprovalMode] = useState<CodexApprovalMode>('approve')
  const [codexModelPreset, setCodexModelPreset] = useState<CodexModelPreset>('gpt-5.5:xhigh')
  const [codexModel, setCodexModel] = useState('gpt-5.5')
  const [codexReasoningEffort, setCodexReasoningEffort] = useState('xhigh')
  const [codexServiceTier, setCodexServiceTier] = useState('default')
  const [codexModelOptions, setCodexModelOptions] = useState<CodexModelOption[]>(FALLBACK_CODEX_MODEL_OPTIONS)
  const [claudePermissionMode, setClaudePermissionMode] = useState<ClaudePermissionMode>('default')
  const [claudeModel, setClaudeModel] = useState('config')
  const [claudeEffort, setClaudeEffort] = useState('config')
  const [claudeSettings, setClaudeSettings] = useState<ClaudeSettingsSummary>(DEFAULT_CLAUDE_SETTINGS)
  const [discoveredSlashCommands, setDiscoveredSlashCommands] = useState<SlashCommandOption[]>([])
  const [agentSessions, setAgentSessions] = useState<AgentSessionHistoryItem[]>([])
  const [agentSessionPinnedOverrides, setAgentSessionPinnedOverrides] = useState<Record<string, boolean>>(
    () => loadSessionDisplayState().pinnedOverrides
  )
  const [speechSupported, setSpeechSupported] = useState(false)
  const [speechListening, setSpeechListening] = useState(false)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())
  const [expandedSessionProjectIds, setExpandedSessionProjectIds] = useState<Set<string>>(() => new Set())
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => shouldCollapseSidebarInitially())
  const [lastProjectWorkspace, setLastProjectWorkspace] = useState<string | undefined>(undefined)
  const [agentMenu, setAgentMenu] = useState<{ agentId: string; x: number; y: number } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; x: number; y: number } | null>(null)
  const [agentSessionMenu, setAgentSessionMenu] = useState<{ provider: string; sessionId: string; x: number; y: number } | null>(null)
  const [optionsMenu, setOptionsMenu] = useState<{ x: number; y: number; returnFocusTarget: HTMLElement | null } | null>(null)
  const [renameDialog, setRenameDialog] = useState<{ agentId: string; title: string } | null>(null)
  const [killDialog, setKillDialog] = useState<{ agentId: string; title: string } | null>(null)
  const [deleteWorktreeDialog, setDeleteWorktreeDialog] = useState<{ projectId: string; workspace: string; dirtyEntries: string[]; sessionHandles: string[] } | null>(null)
  const [copyNotice, setCopyNotice] = useState<{ id: number; kind: 'success' | 'error'; message: string } | null>(null)
  const [fileRevealRequest, setFileRevealRequest] = useState<{ agentId: string; path: string; kind: 'directory' | 'file'; requestId: number } | null>(null)
  const [fileSearchFocusRequest, setFileSearchFocusRequest] = useState<{ agentId: string; requestId: number; query?: string } | null>(null)
  const [now, setNow] = useState(Date.now())
  const workspaceRef = useRef<HTMLDivElement>(null)
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null)
  const composerAttachmentsRef = useRef<ComposerAttachment[]>([])
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  const approvalMenuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameDialogRef = useRef<HTMLFormElement>(null)
  const killDialogRef = useRef<HTMLDivElement>(null)
  const killCancelButtonRef = useRef<HTMLButtonElement>(null)
  const deleteWorktreeDialogRef = useRef<HTMLDivElement>(null)
  const deleteWorktreeCancelButtonRef = useRef<HTMLButtonElement>(null)
  const projectListRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuUserNavigatedRef = useRef(false)
  const contextMenuFocusIndexRef = useRef(0)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const codexModelsLoadedRef = useRef(false)
  const codexModelsLoadingRef = useRef(false)
  const resumeAgentSessionRef = useRef<(provider: string, sessionId: string) => void>(() => {})
  const activeTerminalIdRef = useRef<string | null>(activeTerminalId)
  const agentListOrderRef = useRef<Map<string, number>>(new Map())
  const nextAgentListOrderRef = useRef(0)
  const workspaceFileCursorRequestRef = useRef(0)
  const workspaceFileDiffRequestRef = useRef(0)
  const workspaceFileRevealRequestRef = useRef(0)
  const workspaceFileSearchFocusRequestRef = useRef(0)
  const terminalPathOpenRequestRef = useRef(0)
  const pendingProjectDialogFocusRef = useRef<{ projectId: string; agentCount: number } | null>(null)
  const restoreProjectListFocusRef = useRef<'active' | 'active-force' | 'list' | null>(null)
  const pendingArchivedFocusAgentRef = useRef<string | null>(null)
  const pendingRestoredFocusAgentRef = useRef<string | null>(null)
  const mainPageSessionKeysMutationRef = useRef(0)
  const trackedMainPageAgentKeysRef = useRef<Set<string>>(new Set())
  const resizingSidebarRef = useRef(false)
  const sidebarAutoCollapsedRef = useRef(sidebarCollapsed)

  const collapseSidebar = useCallback(() => {
    sidebarAutoCollapsedRef.current = false
    setSidebarCollapsed(true)
  }, [])

  const autoCollapseSidebar = useCallback(() => {
    setSidebarCollapsed(collapsed => {
      if (!collapsed) sidebarAutoCollapsedRef.current = true
      return true
    })
  }, [])

  const expandSidebar = useCallback(() => {
    sidebarAutoCollapsedRef.current = false
    setSidebarCollapsed(false)
  }, [])

  const toggleSidebar = useCallback(() => {
    sidebarAutoCollapsedRef.current = false
    setSidebarCollapsed(collapsed => !collapsed)
  }, [])
  activeTerminalIdRef.current = activeTerminalId
  const copy = useMemo(() => codeCopyForLanguage(uiPreferences.language), [uiPreferences.language])

  useEffect(() => {
    saveSessionDisplayState({
      promotedKeys: [],
      pinnedOverrides: agentSessionPinnedOverrides,
      archivedOverrides: {},
    })
  }, [agentSessionPinnedOverrides])

  const visibleAgents = useMemo(() => agents.filter(agent => !agent.isMain), [agents])
  const hiddenMainAgent = useMemo(() => agents.find(agent => agent.isMain) ?? null, [agents])
  const unorderedLiveAgents = useMemo(
    () => visibleAgents.filter(isAgentListLiveAgent),
    [visibleAgents]
  )
  const activeAgents = useMemo(
    () => {
      const active = unorderedLiveAgents
      const visibleIds = new Set(visibleAgents.map(agent => agent.id))
      Array.from(agentListOrderRef.current.keys()).forEach(agentId => {
        if (!visibleIds.has(agentId)) agentListOrderRef.current.delete(agentId)
      })
      active.forEach(agent => {
        if (!agentListOrderRef.current.has(agent.id)) {
          agentListOrderRef.current.set(agent.id, nextAgentListOrderRef.current)
          nextAgentListOrderRef.current += 1
        }
      })
      return active.slice().sort((a, b) => (
        (agentListOrderRef.current.get(a.id) ?? 0) - (agentListOrderRef.current.get(b.id) ?? 0)
      ))
    },
    [unorderedLiveAgents, visibleAgents]
  )
  const workspaceNavigationAgentIds = useMemo(() => {
    const ids = new Set(activeAgents.map(agent => agent.id))
    if (hiddenMainAgent) ids.add(hiddenMainAgent.id)
    return ids
  }, [activeAgents, hiddenMainAgent])

  useEffect(() => {
    pruneWorkspaceNavigationEntries(entry => workspaceNavigationAgentIds.has(entry.agentId))
  }, [pruneWorkspaceNavigationEntries, workspaceNavigationAgentIds])

  useLayoutEffect(() => {
    const retainedComposerKeys = new Set(
      agents
        .filter(agent => !agent.archived && agent.status !== 'dead' && agent.status !== 'stopped')
        .map(composerStateKeyForAgent)
        .filter(Boolean)
    )
    setComposerByAgentKey(current => {
      let next = current
      let changed = false
      const mutable = () => {
        if (next === current) next = { ...current }
        changed = true
        return next
      }

      agents.forEach(agent => {
        const canonicalKey = composerStateKeyForAgent(agent)
        if (!canonicalKey) return
        composerStateAliasKeysForAgent(agent).forEach(aliasKey => {
          if (aliasKey === canonicalKey) return
          const aliasState = next[aliasKey]
          if (!aliasState) return
          const nextStateByKey = mutable()
          nextStateByKey[canonicalKey] = nextStateByKey[canonicalKey]
            ? mergeAgentComposerStates(nextStateByKey[canonicalKey], aliasState)
            : aliasState
          delete nextStateByKey[aliasKey]
        })
      })

      Object.entries(next).forEach(([composerKey, state]) => {
        if (retainedComposerKeys.has(composerKey)) return
        const nextStateByKey = mutable()
        state.attachments.forEach(revokeComposerAttachmentPreview)
        delete nextStateByKey[composerKey]
      })
      return changed ? next : current
    })
  }, [agents])
  const decoratedAgentSessions = useMemo(
    () => applySessionDisplayOverrides(agentSessions, agentSessionPinnedOverrides, {}),
    [agentSessionPinnedOverrides, agentSessions]
  )
  const agentListState = useMemo(
    () => buildAgentListState({
      allAgents: visibleAgents,
      liveAgents: activeAgents,
      sessions: decoratedAgentSessions,
      mainPageSessionKeys,
    }),
    [activeAgents, decoratedAgentSessions, mainPageSessionKeys, visibleAgents]
  )
  const mainPageAgentSessions = agentListState.mainPageAgentSessions
  const sidebarAgentSessions = agentListState.sidebarAgentSessions
  const unclaimedSearchableAgentSessions = agentListState.searchableAgentSessions
  const historyAgentSessions = agentListState.historyAgentSessions
  const visibleLiveAgents = agentListState.liveAgents
  const visibleArchivedAgents = agentListState.archivedAgents
  const visibleArchivedRuns = taskHistory
  const visibleHistoryAgentSessions = historyAgentSessions
  const projectListProjects = useMemo(
    () => projectListProjectsForAgents(visibleLiveAgents, sidebarAgentSessions),
    [sidebarAgentSessions, visibleLiveAgents]
  )
  const projects = useMemo(() => limitProjectAgentSessions(
    projectListProjects,
    expandedSessionProjectIds,
    false
  ), [expandedSessionProjectIds, projectListProjects])
  const searchableProjects = useMemo(
    () => projectListProjectsForAgents(visibleLiveAgents, unclaimedSearchableAgentSessions),
    [unclaimedSearchableAgentSessions, visibleLiveAgents]
  )
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const hasSearchQuery = normalizedSearch.length > 0
  const displayedProjects = useMemo(() => {
    const sourceProjects = (activeView === 'search' || searchOpen) && hasSearchQuery ? searchableProjects : projects
    return displayedProjectsForSearch(
      sourceProjects,
      normalizedSearch,
      expandedSessionProjectIds
    )
  }, [activeView, expandedSessionProjectIds, hasSearchQuery, normalizedSearch, projects, searchableProjects, searchOpen])
  const hasProjectListItems = projects.some(project => project.agents.length > 0 || project.agentSessions.length > 0)
  const hasDisplayedProjectListItems = displayedProjects.some(project => project.agents.length > 0 || project.agentSessions.length > 0)
  const searchResultProjects = useMemo(
    () => hasSearchQuery ? displayedProjects : [],
    [displayedProjects, hasSearchQuery]
  )
  const visibleProjectListTargets = useMemo<SearchTarget[]>(
    () => visibleSearchTargetsForProjects(displayedProjects, collapsedProjectIds, normalizedSearch),
    [collapsedProjectIds, displayedProjects, normalizedSearch]
  )
  const visibleSearchTargets = useMemo<SearchTarget[]>(
    () => hasSearchQuery ? visibleProjectListTargets : [],
    [hasSearchQuery, visibleProjectListTargets]
  )
  const agentShortcutKeys = useMemo(() => {
    const shortcuts = new Map<string, string>()
    if (!keyboardShortcutsEnabled) return shortcuts

    keyMap.forEach((agentId, key) => {
      shortcuts.set(agentId, key)
    })
    return shortcuts
  }, [keyMap, keyboardShortcutsEnabled])
  const openAgents = useMemo(
    () => openTerminalIds
      .map(id => activeAgents.find(agent => agent.id === id) ?? (hiddenMainAgent?.id === id ? hiddenMainAgent : null))
      .filter((agent): agent is Agent => Boolean(agent)),
    [activeAgents, hiddenMainAgent, openTerminalIds]
  )
  const activeOpenAgent = useMemo(
    () => openAgents.find(agent => agent.id === activeTerminalId) ?? openAgents[0] ?? null,
    [activeTerminalId, openAgents]
  )
  const visibleOpenAgents = activeOpenAgent ? [activeOpenAgent] : []
  const activeAgent = useMemo(
    () => activeAgents.find(agent => agent.id === activeTerminalId)
      ?? (hiddenMainAgent?.id === activeTerminalId ? hiddenMainAgent : null),
    [activeAgents, activeTerminalId, hiddenMainAgent]
  )
  const activeAgentContextWindow = activeAgent ? contextWindowByAgentId[activeAgent.id] ?? null : null
  const activeComposerKey = activeAgent ? composerStateKeyForAgent(activeAgent) : ''
  const activeAgentCapabilities = useMemo(
    () => capabilitiesForAgent(activeAgent),
    [activeAgent]
  )
  const activeComposerState = activeComposerKey
    ? composerByAgentKey[activeComposerKey]
      ?? (activeAgent
        ? composerStateAliasKeysForAgent(activeAgent)
          .map(aliasKey => composerByAgentKey[aliasKey])
          .find(Boolean)
        : undefined)
      ?? DEFAULT_AGENT_COMPOSER_STATE
    : DEFAULT_AGENT_COMPOSER_STATE
  const draft = activeComposerState.draft
  const composerAttachments = activeComposerState.attachments
  const composerMode = activeComposerState.mode
  const { plusMenuOpen, approvalMenuOpen, modelMenuOpen, modelPickerPane } = activeComposerState.ui
  const activeAgentTurnActive = useMemo(
    () => isAgentTurnActive(activeAgent),
    [activeAgent]
  )
  const activeAgentTerminalState = useMemo(
    () => inferAgentTerminalState(activeAgent),
    [activeAgent]
  )
  const composerAgentKind = activeAgentCapabilities.kind
  const activeAgentCanInterrupt = useMemo(
    () => activeAgentTurnActive || (
      Boolean(activeAgent)
      && activeAgent?.status === 'running'
      && composerAgentKind === 'shell'
      && activeAgentTerminalState.terminalBusy
    ),
    [activeAgent, activeAgentTerminalState.terminalBusy, activeAgentTurnActive, composerAgentKind]
  )
  const composerSlashCommands = useMemo(
    () => mergeSlashCommands([
      ...slashCommandsForAgentKind(composerAgentKind),
      ...discoveredSlashCommands,
    ]),
    [composerAgentKind, discoveredSlashCommands]
  )
  const activePendingFollowUp = activeComposerState.pendingFollowUp

  useEffect(() => {
    if (!activeTerminalId || mainPaneMode !== 'terminal' || activeView !== 'projects') return
    recordWorkspaceNavigationAgent(activeTerminalId)
  }, [activeTerminalId, activeView, mainPaneMode, recordWorkspaceNavigationAgent])

  useEffect(() => {
    if (!openWorkspaceFile || mainPaneMode !== 'editor' || activeView !== 'projects') return
    recordWorkspaceNavigationFile({
      agentId: openWorkspaceFile.agentId,
      filePath: openWorkspaceFile.file.path,
      view: openWorkspaceFile.diffRequestId ? 'diff' : 'editor',
      lineNumber: openWorkspaceFile.cursor?.lineNumber,
      column: openWorkspaceFile.cursor?.column,
      endColumn: openWorkspaceFile.cursor?.endColumn,
    })
  }, [
    activeView,
    mainPaneMode,
    openWorkspaceFile?.agentId,
    openWorkspaceFile?.cursor?.column,
    openWorkspaceFile?.cursor?.endColumn,
    openWorkspaceFile?.cursor?.lineNumber,
    openWorkspaceFile?.cursor?.requestId,
    openWorkspaceFile?.diffRequestId,
    openWorkspaceFile?.file.path,
    recordWorkspaceNavigationFile,
  ])
  const composerHasAttachmentMessage = composerAttachmentMessageBlocks(composerAttachments).length > 0
  const composerAttachmentsUploading = composerAttachments.some(attachment => attachment.status === 'uploading')
  const composerSubmitAction = activeAgent && !composerAttachmentsUploading && (draft.trim() || composerHasAttachmentMessage)
    ? 'send'
    : activeAgentCanInterrupt
      ? 'interrupt'
      : 'disabled'
  const resolveComposerStateKey = useCallback((composerKey: string) => {
    if (!composerKey) return ''
    for (const agent of agents) {
      const canonicalKey = composerStateKeyForAgent(agent)
      if (!canonicalKey) continue
      if (composerKey === canonicalKey || composerStateAliasKeysForAgent(agent).includes(composerKey)) {
        return canonicalKey
      }
    }
    return composerKey
  }, [agents])
  const updateComposerStateForKey = useCallback((composerKey: string, updater: (state: AgentComposerState) => AgentComposerState) => {
    setComposerByAgentKey(current => {
      const canonicalKey = resolveComposerStateKey(composerKey)
      if (!canonicalKey) return current
      const previous = current[canonicalKey] ?? createDefaultAgentComposerState()
      const nextState = updater(previous)
      if (nextState === previous) return current
      return { ...current, [canonicalKey]: nextState }
    })
  }, [resolveComposerStateKey])
  const updateExistingComposerStateForKey = useCallback((composerKey: string, updater: (state: AgentComposerState) => AgentComposerState) => {
    setComposerByAgentKey(current => {
      const canonicalKey = resolveComposerStateKey(composerKey)
      if (!canonicalKey) return current
      const previous = current[canonicalKey]
      if (!previous) return current
      const nextState = updater(previous)
      if (nextState === previous) return current
      return { ...current, [canonicalKey]: nextState }
    })
  }, [resolveComposerStateKey])
  const updateActiveComposerState = useCallback((updater: (state: AgentComposerState) => AgentComposerState) => {
    if (!activeComposerKey) return
    updateComposerStateForKey(activeComposerKey, updater)
  }, [activeComposerKey, updateComposerStateForKey])
  const closeActiveComposerMenus = useCallback(() => {
    updateActiveComposerState(closeComposerMenusForState)
  }, [updateActiveComposerState])
  const contextMenuAgent = useMemo(
    () => activeAgents.find(agent => agent.id === agentMenu?.agentId) ?? null,
    [activeAgents, agentMenu?.agentId]
  )
  const previousTurnActiveByAgentRef = useRef<Map<string, boolean>>(new Map())
  const turnActiveTrackingReadyRef = useRef(false)
  const contextMenuProject = useMemo(
    () => projectListProjects.find(project => project.id === projectMenu?.projectId) ?? null,
    [projectListProjects, projectMenu?.projectId]
  )
  const contextMenuAgentSession = useMemo(
    () => displayedProjects.flatMap(project => project.agentSessions).find(session => (
      session.provider === agentSessionMenu?.provider && session.id === agentSessionMenu?.sessionId
    )) ?? null,
    [agentSessionMenu?.provider, agentSessionMenu?.sessionId, displayedProjects]
  )
  const selectedSearchTarget = searchOpen ? visibleSearchTargets[searchSelectionIndex] ?? null : null
  const selectedSearchAgentId = selectedSearchTarget?.kind === 'agent' ? selectedSearchTarget.id : null
  const selectedSearchSessionHandle = selectedSearchTarget?.kind === 'agent-session'
    ? workspaceTargetId(selectedSearchTarget)
    : null
  const activeProjectWorkspace = activeAgent ? projectWorkspaceForAgent(activeAgent) : undefined
  const projectFileSearchAgent = useMemo(() => {
    if (openWorkspaceFile) {
      return activeAgents.find(agent => agent.id === openWorkspaceFile.agentId && !agent.isMain) ?? null
    }
    if (activeAgent && !activeAgent.isMain) return activeAgent
    if (activeProjectWorkspace) {
      const workspaceAgent = activeAgents.find(agent => !agent.isMain && projectWorkspaceForAgent(agent) === activeProjectWorkspace)
      if (workspaceAgent) return workspaceAgent
    }
    return activeAgents.find(agent => !agent.isMain) ?? null
  }, [activeAgent, activeAgents, activeProjectWorkspace, openWorkspaceFile])
  const projectFileSearchAgentForShortcutTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return null
    const rowAgentId = target.closest<HTMLElement>('[data-testid="code-agent-row"][data-agent-id]')?.dataset.agentId
    if (rowAgentId) {
      const rowAgent = activeAgents.find(agent => agent.id === rowAgentId && !agent.isMain)
      if (rowAgent) return rowAgent
    }

    const projectGroup = target.closest<HTMLElement>('[data-testid="code-project-group"]')
    const projectId = projectGroup
      ?.querySelector<HTMLElement>('[data-testid="code-project-title"][data-project-id]')
      ?.dataset.projectId
    if (!projectId) return null
    return activeAgents.find(agent => !agent.isMain && projectWorkspaceForAgent(agent) === projectId) ?? null
  }, [activeAgents])
  const agentCreationWorkspace = activeAgent?.isMain
    ? lastProjectWorkspace ?? projects[0]?.workspace
    : activeProjectWorkspace ?? lastProjectWorkspace ?? projects[0]?.workspace
  const showFileEditor = mainPaneMode === 'editor' && Boolean(openWorkspaceFile)
  const composerControlState = useMemo(() => buildComposerControlState({
    agentKind: composerAgentKind,
    codexModel,
    codexReasoningEffort,
    codexServiceTier,
    codexModelPreset,
    codexModelOptions,
    codexApprovalMode,
    claudeModel,
    claudeEffort,
    claudeSettings,
    claudePermissionMode,
  }), [
    claudeEffort,
    claudeModel,
    claudePermissionMode,
    claudeSettings,
    codexApprovalMode,
    codexModel,
    codexModelOptions,
    codexModelPreset,
    codexReasoningEffort,
    codexServiceTier,
    composerAgentKind,
  ])
  const {
    agentModelOptions: activeAgentModelOptions,
    agentModel: activeAgentModel,
    agentReasoningEffort: activeAgentReasoningEffort,
    agentServiceTier: activeAgentServiceTier,
    agentModelPreset: activeAgentModelPreset,
    currentReasoningOptions,
    currentServiceTierOptions,
    currentPermissionMode,
    currentPermissionLabel,
    currentPermissionColor,
    currentModelLabel,
    currentReasoningLabel,
    currentSpeedLabel,
    permissionModeOptions,
  } = composerControlState
  const browserHost = mobileServerLabel()
  const mobileHeaderTitle = searchOpen || activeView === 'search'
    ? copy.search
    : activeView === 'history'
      ? copy.history
      : showFileEditor && openWorkspaceFile
    ? basename(openWorkspaceFile.file.path)
    : activeAgent ? agentTitle(activeAgent) : copy.codex
  const mobileHeaderWorkspace = activeAgent?.isMain
    ? 'farming'
    : mobileWorkspaceLabel(activeAgent ? projectWorkspaceForAgent(activeAgent) : undefined)
  const mobileHeaderSubtitle = activeAgent
    ? `${mobileHeaderWorkspace} · ${browserHost}`
    : browserHost
  const autoSizeComposerTextarea = useCallback(() => {
    const textarea = composerTextareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    const nextHeight = Math.min(textarea.scrollHeight, 132)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > 132 ? 'auto' : 'hidden'
  }, [])
  const focusComposerTextarea = useCallback(() => {
    const focus = () => {
      if (document.querySelector('.code-composer-menu')) return
      composerTextareaRef.current?.focus({ preventScroll: true })
    }
    scheduleFocusRetries(focus, { delays: [60] })
  }, [])
  const applyLaunchSettings = useCallback((settings: GlobalSettings) => {
    const profile = normalizeLaunchProfiles(settings)
    setCodexApprovalMode(profile.codexApprovalMode)
    setCodexModel(profile.codexModel)
    setCodexReasoningEffort(profile.codexReasoningEffort)
    setCodexServiceTier(profile.codexServiceTier)
    setCodexModelPreset(profile.codexModelPreset)
    setClaudePermissionMode(profile.claudePermissionMode)
    setClaudeModel(profile.claudeModel)
    setClaudeEffort(profile.claudeEffort)
  }, [])
  const loadGlobalSettings = useCallback(() => {
    let cancelled = false
    const loadMutationVersion = mainPageSessionKeysMutationRef.current
    fetch(appPath('/api/settings'))
      .then(response => response.json())
      .then((data: { settings?: GlobalSettings }) => {
        if (cancelled) return
        const settings = data.settings ?? {}
        if (loadMutationVersion === mainPageSessionKeysMutationRef.current) {
          setMainPageSessionKeys(new Set(normalizeMainPageSessionKeys(settings.mainPageSessionKeys ?? [])))
        }
        applyLaunchSettings(settings)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [applyLaunchSettings])
  const loadCodexModels = useCallback(() => {
    if (codexModelsLoadedRef.current || codexModelsLoadingRef.current) {
      return () => {}
    }

    let cancelled = false
    codexModelsLoadingRef.current = true
    fetch(appPath('/api/codex/models'))
      .then(response => response.json())
      .then((data: { catalog?: CodexModelOption[]; models?: LegacyCodexModelOption[] }) => {
        if (cancelled) return
        const options = normalizeModelCatalog(data)
        codexModelsLoadedRef.current = true
        if (options.length > 0) setCodexModelOptions(options)
      })
      .catch(() => {})
      .finally(() => {
        codexModelsLoadingRef.current = false
      })

    return () => {
      cancelled = true
    }
  }, [])
  const loadClaudeSettings = useCallback(() => {
    let cancelled = false
    fetch(appPath('/api/claude/settings'))
      .then(response => response.json())
      .then((data: { settings?: ClaudeSettingsSummary }) => {
        if (cancelled) return
        setClaudeSettings(normalizeClaudeSettingsSummary(data.settings))
      })
      .catch(() => {
        if (!cancelled) setClaudeSettings(DEFAULT_CLAUDE_SETTINGS)
      })

    return () => {
      cancelled = true
    }
  }, [])
  const fetchAgentSessions = useCallback(async () => {
    const response = await fetch(appPath('/api/agent-sessions?limit=60'))
    const data = await response.json() as { sessions?: AgentSessionHistoryItem[] }
    return Array.isArray(data.sessions) ? data.sessions : []
  }, [])
  const loadAgentSessions = useCallback(() => {
    let cancelled = false
    fetchAgentSessions()
      .then((sessions: AgentSessionHistoryItem[]) => {
        if (cancelled) return
        setAgentSessions(sessions)
      })
      .catch(() => {
        if (!cancelled) setAgentSessions([])
      })

    return () => {
      cancelled = true
    }
  }, [fetchAgentSessions])
  const refreshAgentSessions = useCallback(() => {
    fetchAgentSessions()
      .then(setAgentSessions)
      .catch(() => setAgentSessions([]))
  }, [fetchAgentSessions])

  const loadSlashCommands = useCallback((provider: string, workspace?: string) => {
    if (provider !== 'codex' && provider !== 'claude') {
      setDiscoveredSlashCommands([])
      return () => {}
    }

    let cancelled = false
    const params = new URLSearchParams({ provider })
    if (workspace) params.set('workspace', workspace)

    fetch(appPath(`/api/slash-commands?${params.toString()}`))
      .then(response => response.json())
      .then((data: { commands?: SlashCommandOption[] }) => {
        if (cancelled) return
        setDiscoveredSlashCommands(Array.isArray(data.commands) ? data.commands : [])
      })
      .catch(() => {
        if (!cancelled) setDiscoveredSlashCommands([])
      })

    return () => {
      cancelled = true
    }
  }, [])
  const chooseAttachmentFile = useCallback(() => {
    if (!activeComposerKey) return
    updateActiveComposerState(state => ({
      ...state,
      ui: { ...state.ui, plusMenuOpen: false },
    }))
    attachmentInputRef.current?.click()
  }, [activeComposerKey, updateActiveComposerState])

  const addImageAttachment = useCallback((composerKey: string, file: File) => {
    const id = createComposerAttachmentId(file)
    const name = fileDisplayName(file, 'pasted image')
    const previewUrl = createImageAttachmentPreviewUrl(file)
    const initialAttachment: ComposerAttachment = {
      id,
      kind: 'image',
      name,
      type: file.type || 'image/png',
      size: file.size,
      status: 'uploading',
      previewUrl,
    }

    updateComposerStateForKey(composerKey, state => ({
      ...state,
      attachments: [...state.attachments, initialAttachment],
    }))

    void uploadImageAttachment(file)
      .then(uploaded => {
        updateExistingComposerStateForKey(composerKey, state => ({
          ...state,
          attachments: state.attachments.map(attachment => (
            attachment.id === id
              ? {
                ...attachment,
                name: uploaded.name || name,
                type: uploaded.type || attachment.type,
                size: uploaded.size || attachment.size,
                status: 'ready',
                messageBlock: formatAttachedImage(uploaded),
                error: undefined,
              }
              : attachment
          )),
        }))
      })
      .catch(() => {
        updateExistingComposerStateForKey(composerKey, state => ({
          ...state,
          attachments: state.attachments.map(attachment => (
            attachment.id === id
              ? {
                ...attachment,
                status: 'error',
                messageBlock: formatAttachmentError(file),
                error: 'Upload failed',
              }
              : attachment
          )),
        }))
      })
  }, [updateComposerStateForKey, updateExistingComposerStateForKey])

  const appendAttachmentFiles = useCallback(async (files: File[]) => {
    if (!activeComposerKey || files.length === 0) return

    const imageFiles = files.filter(isImageFile)
    imageFiles.forEach(file => addImageAttachment(activeComposerKey, file))

    const textFiles = files.filter(file => !isImageFile(file))
    if (textFiles.length === 0) {
      focusComposerTextarea()
      return
    }

    const blocks: string[] = []
    for (const file of textFiles) {
      try {
        blocks.push(await formatAttachmentFile(file))
      } catch {
        blocks.push(formatAttachmentError(file))
      }
    }

    updateComposerStateForKey(activeComposerKey, state => ({
      ...state,
      draft: appendDraftBlock(state.draft, blocks.join('\n\n')),
    }))
    focusComposerTextarea()
  }, [activeComposerKey, addImageAttachment, focusComposerTextarea, updateComposerStateForKey])

  const removeComposerAttachment = useCallback((attachmentId: string) => {
    updateActiveComposerState(state => {
      const attachment = state.attachments.find(item => item.id === attachmentId)
      if (attachment) revokeComposerAttachmentPreview(attachment)
      return {
        ...state,
        attachments: state.attachments.filter(item => item.id !== attachmentId),
      }
    })
    focusComposerTextarea()
  }, [focusComposerTextarea, updateActiveComposerState])

  const handleAttachmentFiles = useCallback((event: ReactChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    void appendAttachmentFiles(files)
  }, [appendAttachmentFiles])

  const handlePasteAttachment = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardImageFiles(event.clipboardData)
    if (files.length === 0) return

    event.preventDefault()
    void appendAttachmentFiles(files)
  }, [appendAttachmentFiles])

  useEffect(() => {
    const input = attachmentInputRef.current
    if (!input) return

    input.addEventListener('cancel', focusComposerTextarea)
    return () => input.removeEventListener('cancel', focusComposerTextarea)
  }, [focusComposerTextarea])

  useEffect(() => {
    composerAttachmentsRef.current = Object.values(composerByAgentKey).flatMap(state => state.attachments)
  }, [composerByAgentKey])

  useEffect(() => () => {
    composerAttachmentsRef.current.forEach(revokeComposerAttachmentPreview)
  }, [])

  const activateComposerMode = useCallback((mode: Exclude<ComposerMode, 'default'>) => {
    updateActiveComposerState(state => ({
      ...state,
      mode,
      ui: { ...state.ui, plusMenuOpen: false },
    }))
    focusComposerTextarea()
  }, [focusComposerTextarea, updateActiveComposerState])

  const markAgentReadIfNeeded = useCallback((agentId: string) => {
    const agent = activeAgents.find(candidate => candidate.id === agentId)
    if (agent?.unread) onUpdateAgentFlags(agentId, { unread: false })
  }, [activeAgents, onUpdateAgentFlags])

  const handleTerminalFollowOutputChange = useCallback((agentId: string, state: TerminalFollowState) => {
    setTerminalFollowStates(current => {
      const previous = current[agentId]
      if (previous?.following === state.following && previous?.hasUnreadOutput === state.hasUnreadOutput) return current
      return { ...current, [agentId]: state }
    })
    if (state.following && !state.hasUnreadOutput) {
      markAgentReadIfNeeded(agentId)
    }
  }, [markAgentReadIfNeeded])

  useEffect(() => {
    if (!activeTerminalId || mainPaneMode !== 'terminal') return
    const state = terminalFollowStates[activeTerminalId]
    const terminalFollowingLatest = state
      ? state.following && !state.hasUnreadOutput
      : true
    if (terminalFollowingLatest) {
      markAgentReadIfNeeded(activeTerminalId)
    }
  }, [activeTerminalId, mainPaneMode, markAgentReadIfNeeded, terminalFollowStates])

  const handleDraftChange = useCallback((value: string) => {
    updateActiveComposerState(state => ({
      ...state,
      draft: value,
      history: { ...state.history, cursor: null },
    }))
    if (activeAgent) markAgentReadIfNeeded(activeAgent.id)
  }, [activeAgent, markAgentReadIfNeeded, updateActiveComposerState])

  const navigateActiveComposerHistory = useCallback((
    direction: ComposerHistoryDirection,
    input: ComposerHistoryNavigationInput
  ) => {
    if (!activeAgent || !activeComposerKey) return null
    if (!canUseComposerHistoryNavigation(input)) return null

    const result = navigateComposerHistory(activeComposerState.history, direction, input.value)
    if (!result.changed) return null

    updateComposerStateForKey(activeComposerKey, state => ({
      ...state,
      draft: result.value,
      history: result.history,
    }))
    markAgentReadIfNeeded(activeAgent.id)
    return result.value
  }, [activeAgent, activeComposerKey, activeComposerState.history, markAgentReadIfNeeded, updateComposerStateForKey])

  const sendComposerMessageToAgent = useCallback((agent: Agent, message: string) => {
    markAgentReadIfNeeded(agent.id)
    if (capabilitiesForAgent(agent).kind === 'shell') {
      return sendInput(`${message}\r`, agent.id)
    }
    return sendInput(terminalInputPartsForComposerMessage(message), agent.id)
  }, [markAgentReadIfNeeded, sendInput])

  const submitDraft = useCallback(() => {
    const latestDraft = composerTextareaRef.current?.value ?? draft
    const text = composerMessageWithAttachments(latestDraft, composerAttachments)
    if (!text || !activeAgent || !activeComposerKey || composerAttachments.some(attachment => attachment.status === 'uploading')) return
    const message = formatComposerMessage(composerMode, text)
    let submitted = true
    if (isCodexAgentWorking(activeAgent)) {
      markAgentReadIfNeeded(activeAgent.id)
      updateComposerStateForKey(activeComposerKey, state => {
        const existing = state.pendingFollowUp
        return {
          ...state,
          pendingFollowUp: {
            messages: [...(existing?.messages || []), createPendingFollowUpMessage(message)],
            createdAt: existing?.createdAt || Date.now(),
          },
        }
      })
    } else {
      submitted = sendComposerMessageToAgent(activeAgent, message)
    }
    if (!submitted) return
    updateComposerStateForKey(activeComposerKey, state => {
      state.attachments.forEach(revokeComposerAttachmentPreview)
      return {
        ...state,
        draft: '',
        attachments: [],
        mode: 'default',
        history: addComposerHistoryEntry(state.history, latestDraft),
      }
    })
    focusComposerTextarea()
  }, [activeAgent, activeComposerKey, composerAttachments, composerMode, draft, focusComposerTextarea, markAgentReadIfNeeded, sendComposerMessageToAgent, updateComposerStateForKey])

  const interruptActiveAgent = useCallback(() => {
    if (!activeAgent || !activeAgentCanInterrupt) return
    onInterruptAgent(activeAgent.id)
    focusComposerTextarea()
  }, [activeAgent, activeAgentCanInterrupt, focusComposerTextarea, onInterruptAgent])

  const steerPendingFollowUp = useCallback((messageId: string) => {
    if (!activeAgent || !activeComposerKey) return
    const pending = composerByAgentKey[activeComposerKey]?.pendingFollowUp
    if (!pending || pending.messages.length === 0) return
    const message = pending.messages.find(item => item.id === messageId)
    if (!message) return
    if (!sendComposerMessageToAgent(activeAgent, message.text)) return
    pendingFollowUpAutoFlushRef.current[activeComposerKey] = message.id
    updateComposerStateForKey(activeComposerKey, state => {
      if (!state.pendingFollowUp) return state
      return { ...state, pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, messageId) }
    })
    focusComposerTextarea()
  }, [activeAgent, activeComposerKey, composerByAgentKey, focusComposerTextarea, sendComposerMessageToAgent, updateComposerStateForKey])

  const discardPendingFollowUp = useCallback((messageId: string) => {
    if (!activeAgent || !activeComposerKey) return
    updateComposerStateForKey(activeComposerKey, state => {
      if (!state.pendingFollowUp) return state
      return { ...state, pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, messageId) }
    })
    focusComposerTextarea()
  }, [activeAgent, activeComposerKey, focusComposerTextarea, updateComposerStateForKey])

  useEffect(() => {
    const pendingFlushes: Array<{
      agent: Agent
      composerKey: string
      message: AgentComposerPendingFollowUpMessage
    }> = []

    activeAgents.forEach(agent => {
      const composerKey = composerStateKeyForAgent(agent)
      if (!composerKey) return
      const pending = composerByAgentKey[composerKey]?.pendingFollowUp
      if (!pending || pending.messages.length === 0) {
        delete pendingFollowUpAutoFlushRef.current[composerKey]
        return
      }
      if (agent.archived || agent.status === 'dead' || agent.status === 'stopped') return
      if (isCodexAgentWorking(agent)) {
        delete pendingFollowUpAutoFlushRef.current[composerKey]
        return
      }
      if (pendingFollowUpAutoFlushRef.current[composerKey]) return
      const nextMessage = pending.messages[0]
      if (!nextMessage) return
      pendingFlushes.push({ agent, composerKey, message: nextMessage })
    })

    if (pendingFlushes.length === 0) return

    pendingFlushes.forEach(({ agent, composerKey, message }) => {
      if (!sendComposerMessageToAgent(agent, message.text)) return
      pendingFollowUpAutoFlushRef.current[composerKey] = message.id
      setComposerByAgentKey(current => {
        const state = current[composerKey]
        if (!state?.pendingFollowUp) return current
        return {
          ...current,
          [composerKey]: {
            ...state,
            pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, message.id),
          },
        }
      })
    })
  }, [activeAgents, composerByAgentKey, sendComposerMessageToAgent])

  const openSearch = useCallback(() => {
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    closeActiveComposerMenus()
    expandSidebar()
    onWorkspaceViewChange('search')
    setSearchOpen(true)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [closeActiveComposerMenus, expandSidebar, onWorkspaceViewChange])

  const closeSidebarForMobile = useCallback(() => {
    if (isMobileNavigationViewport()) autoCollapseSidebar()
  }, [autoCollapseSidebar])

  const openMobileSidebar = useCallback(() => {
    expandSidebar()
  }, [expandSidebar])

  const startNewAgentFromSidebar = useCallback((workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null) => {
    onNewAgent(workspace, command, returnFocusTarget)
    closeSidebarForMobile()
  }, [closeSidebarForMobile, onNewAgent])

  useEffect(() => {
    let cancelled = false
    fetch(appPath('/api/executables'))
      .then(response => {
        if (!response.ok) throw new Error(`Failed to load executables: ${response.status}`)
        return response.json()
      })
      .then((data: { agents?: AgentLaunchOption[] } | AgentLaunchOption[]) => {
        if (cancelled) return
        const agents = Array.isArray(data) ? data : data.agents ?? []
        setAgentLaunchOptions(normalizeAgentLaunchOptions(agents))
      })
      .catch(() => {
        if (!cancelled) setAgentLaunchOptions([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  const persistMainPageSessionKeys = useCallback((keys: string[]) => {
    fetch(appPath('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mainPageSessionKeys: normalizeMainPageSessionKeys(keys) }),
    }).catch(() => {})
  }, [])

  const updateMainPageSessionKeys = useCallback((updater: (previous: ReadonlySet<string>) => string[]) => {
    setMainPageSessionKeys(previous => {
      const normalized = normalizeMainPageSessionKeys(updater(previous))
      if (sameStringSet(previous, normalized)) return previous
      mainPageSessionKeysMutationRef.current += 1
      persistMainPageSessionKeys(normalized)
      return new Set(normalized)
    })
  }, [persistMainPageSessionKeys])

  useEffect(() => {
    const normalized = normalizeMainPageSessionKeys(remoteMainPageSessionKeys)
    setMainPageSessionKeys(previous => sameStringSet(previous, normalized) ? previous : new Set(normalized))
  }, [remoteMainPageSessionKeys])

  const addMainPageAgentSession = useCallback((provider: string, sessionId: string) => {
    const sessionHandle = workspaceTargetId({ kind: 'agent-session', provider, id: sessionId })
    updateMainPageSessionKeys(previous => [...previous, sessionHandle])
  }, [updateMainPageSessionKeys])

  const removeMainPageAgentSession = useCallback((sessionHandle: string) => {
    updateMainPageSessionKeys(previous => Array.from(previous).filter(key => key !== sessionHandle))
  }, [updateMainPageSessionKeys])

  const removeMainPageAgentSessions = useCallback((sessionHandles: string[]) => {
    const removeKeys = new Set(sessionHandles)
    updateMainPageSessionKeys(previous => Array.from(previous).filter(key => !removeKeys.has(key)))
  }, [updateMainPageSessionKeys])

  const syncRemovedMainPageSessionsFromAgentUpdate = useCallback((result: AgentFlagUpdateResponse | Promise<AgentFlagUpdateResponse>) => {
    Promise.resolve(result)
      .then(value => {
        if (!value || typeof value !== 'object') return
        const removedKeys = Array.isArray(value.removedMainPageSessionKeys) ? value.removedMainPageSessionKeys : []
        if (removedKeys.length > 0) {
          removeMainPageAgentSessions(removedKeys)
        }
      })
      .catch(() => {})
  }, [removeMainPageAgentSessions])

  useEffect(() => {
    activeAgents.forEach(agent => {
      if (agent.providerSessionTemporary === true) return
      const sessionHandle = agent.providerSessionKey || resumedAgentSessionIdFromSource(agent.source)
      if (!sessionHandle) return
      const trackingKey = `${agent.id}:${sessionHandle}`
      if (trackedMainPageAgentKeysRef.current.has(trackingKey)) return
      trackedMainPageAgentKeysRef.current.add(trackingKey)
      updateMainPageSessionKeys(previous => [...previous, sessionHandle])
      refreshAgentSessions()
    })
  }, [activeAgents, refreshAgentSessions, updateMainPageSessionKeys])

  useEffect(() => {
    if (!pageVisible) return undefined
    const hasTemporaryProviderSession = activeAgents.some(agent => agent.providerSessionTemporary === true)
    if (!hasTemporaryProviderSession) return undefined

    refreshAgentSessions()
    const timer = window.setInterval(refreshAgentSessions, 5_000)
    return () => window.clearInterval(timer)
  }, [activeAgents, pageVisible, refreshAgentSessions])

  const focusActiveProjectListTargetNow = useCallback(() => {
    const activeAgentId = activeTerminalIdRef.current
    const rows = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-testid="code-agent-row"], [data-testid="code-active-session-row"]') ?? [])
    const activeRow = activeAgentId
      ? rows.find(row => row.dataset.agentId === activeAgentId)
      : null

    const target = activeRow ?? rows[0] ?? projectListRef.current
    if (!target) return false
    target.focus({ preventScroll: true })
    return document.activeElement === target
  }, [])

  const focusProjectListTargetNow = useCallback((target: SearchTarget) => {
    const rows = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-testid="code-agent-row"], [data-testid="code-active-session-row"]') ?? [])
    const row = rows.find(candidate => {
      if (target.kind === 'agent') return candidate.dataset.agentId === target.id
      return candidate.dataset.provider === target.provider && candidate.dataset.sessionId === target.id
    })
    if (!row) return false

    row.focus({ preventScroll: true })
    return document.activeElement === row
  }, [])

  const shouldSkipProjectFocusRestore = useCallback(() => {
    if (dialogOpen) return true
    if (document.querySelector('.code-context-menu')) return true
    if (document.querySelector('.code-composer.menu-open, .code-composer-menu')) return true

    const activeElement = document.activeElement
    if (!(activeElement instanceof HTMLElement)) return false
    if (activeElement.closest('.code-context-menu')) return true
    if (activeElement === document.body || activeElement === document.documentElement) return false
    if (projectListRef.current?.contains(activeElement)) return false
    if (activeElement.closest('.code-sidebar')) return false
    return Boolean(activeElement.closest('.code-composer'))
  }, [dialogOpen])

  const focusActiveProjectListTarget = useCallback((options?: { skipIfFocusMoved?: boolean }) => {
    window.requestAnimationFrame(() => {
      if (options?.skipIfFocusMoved && shouldSkipProjectFocusRestore()) return
      focusActiveProjectListTargetNow()
    })
  }, [focusActiveProjectListTargetNow, shouldSkipProjectFocusRestore])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchOpen(false)
    setSearchSelectionIndex(0)
  }, [])

  const closeSearchView = useCallback(() => {
    clearSearch()
    onWorkspaceViewChange('projects')
    restoreProjectListFocusRef.current = 'active-force'
  }, [clearSearch, onWorkspaceViewChange])

  const openWorkspaceView = useCallback((view: WorkspaceView) => {
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    if (view === 'projects') {
      expandSidebar()
      clearSearch()
    } else if (view !== 'search') {
      clearSearch()
    }
    onWorkspaceViewChange(view)
  }, [clearSearch, expandSidebar, onWorkspaceViewChange])

  const openSearchFromSidebar = useCallback(() => {
    openSearch()
    closeSidebarForMobile()
  }, [closeSidebarForMobile, openSearch])

  const openWorkspaceViewFromSidebar = useCallback((view: WorkspaceView) => {
    openWorkspaceView(view)
    closeSidebarForMobile()
  }, [closeSidebarForMobile, openWorkspaceView])

  const toggleProject = useCallback((projectId: string) => {
    setCollapsedProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  const toggleProjectSessions = useCallback((projectId: string) => {
    setExpandedSessionProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  useEffect(() => {
    const previous = previousTurnActiveByAgentRef.current
    const next = new Map<string, boolean>()

    for (const agent of activeAgents) {
      const turnActive = isAgentTurnActive(agent)
      next.set(agent.id, turnActive)

      if (!turnActiveTrackingReadyRef.current) continue
      const wasActive = previous.get(agent.id) === true
      const isTerminalPaneViewed = agent.id === activeTerminalId && mainPaneMode === 'terminal'
      const terminalFollowState = terminalFollowStates[agent.id]
      const terminalFollowingLatest = terminalFollowState
        ? terminalFollowState.following && !terminalFollowState.hasUnreadOutput
        : true
      if (shouldMarkAgentUnreadForTurnTransition({
        wasTurnActive: wasActive,
        isTurnActive: turnActive,
        isMain: agent.isMain,
        alreadyUnread: agent.unread === true,
        terminalPaneViewed: isTerminalPaneViewed,
        terminalFollowingLatest,
      })) {
        onUpdateAgentFlags(agent.id, { unread: true })
      }
    }

    previousTurnActiveByAgentRef.current = next
    turnActiveTrackingReadyRef.current = true
  }, [activeAgents, activeTerminalId, mainPaneMode, onUpdateAgentFlags, terminalFollowStates])

  const openVisibleTarget = useCallback((target: SearchTarget, options?: { focusTerminal?: boolean }) => {
    setMainPaneMode('terminal')
    onWorkspaceViewChange('projects')
    if (target.kind === 'agent') {
      onOpenTerminal(target.id, { focusTerminal: options?.focusTerminal })
    } else {
      resumeAgentSessionRef.current(target.provider, target.id)
    }
  }, [onOpenTerminal, onWorkspaceViewChange])

  const currentProjectListTargetId = useCallback(() => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement) {
      const row = activeElement.closest<HTMLElement>('[data-testid="code-agent-row"], [data-testid="code-active-session-row"]')
      if (row?.dataset.agentId) return workspaceTargetId({ kind: 'agent', id: row.dataset.agentId })
      if (row?.dataset.sessionId && row.dataset.provider) {
        return workspaceTargetId({ kind: 'agent-session', provider: row.dataset.provider, id: row.dataset.sessionId })
      }
    }

    const activeAgentId = activeTerminalIdRef.current
    return activeAgentId ? workspaceTargetId({ kind: 'agent', id: activeAgentId }) : ''
  }, [])

  const openAdjacentVisibleTarget = useCallback((direction: 1 | -1) => {
    if (visibleProjectListTargets.length === 0) return

    const currentTargetId = currentProjectListTargetId()
    const currentIndex = visibleProjectListTargets.findIndex(target => workspaceTargetId(target) === currentTargetId)
    const startIndex = direction > 0 ? -1 : 0
    const nextIndex = ((currentIndex === -1 ? startIndex : currentIndex) + direction + visibleProjectListTargets.length) % visibleProjectListTargets.length
    const nextTarget = visibleProjectListTargets[nextIndex]
    if (!nextTarget) return

    openVisibleTarget(nextTarget, { focusTerminal: false })
    if (nextTarget.kind === 'agent') {
      if (!shouldSkipProjectFocusRestore()) focusProjectListTargetNow(nextTarget)
      window.requestAnimationFrame(() => {
        if (!shouldSkipProjectFocusRestore()) focusProjectListTargetNow(nextTarget)
      })
    }
    restoreProjectListFocusRef.current = 'active'
  }, [currentProjectListTargetId, focusProjectListTargetNow, openVisibleTarget, shouldSkipProjectFocusRestore, visibleProjectListTargets])

  const handleProjectListKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return

    if (event.key === '/' && !event.shiftKey) {
      event.preventDefault()
      openSearch()
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openAdjacentVisibleTarget(1)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAdjacentVisibleTarget(-1)
    }
  }, [openAdjacentVisibleTarget, openSearch])

  const moveSearchSelection = useCallback((direction: 1 | -1) => {
    if (visibleSearchTargets.length === 0) return

    setSearchSelectionIndex(index => (index + direction + visibleSearchTargets.length) % visibleSearchTargets.length)
  }, [visibleSearchTargets.length])

  const openSelectedSearchTarget = useCallback(() => {
    if (!selectedSearchTarget) return

    openVisibleTarget(selectedSearchTarget)
    clearSearch()
  }, [clearSearch, openVisibleTarget, selectedSearchTarget])

  const handleSearchInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchView()
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSearchSelection(1)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSearchSelection(-1)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      openSelectedSearchTarget()
    }
  }, [closeSearchView, moveSearchSelection, openSelectedSearchTarget])

  const updateSidebarWidth = useCallback((clientX: number) => {
    const workspaceLeft = workspaceRef.current?.getBoundingClientRect().left ?? 0
    const rawWidth = clientX - workspaceLeft
    if (rawWidth <= SIDEBAR_DRAG_COLLAPSE_WIDTH) {
      collapseSidebar()
      return
    }

    const nextWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, rawWidth))
    expandSidebar()
    setSidebarWidth(nextWidth)
  }, [collapseSidebar, expandSidebar])

  const focusAgentRowNow = useCallback((agentId: string) => {
    const rows = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-testid="code-agent-row"]') ?? [])
    const row = rows.find(candidate => candidate.dataset.agentId === agentId)
    if (!row) return false

    row.focus({ preventScroll: true })
    return document.activeElement === row
  }, [])

  const focusAgentRow = useCallback((agentId: string) => {
    scheduleFocusRetries(() => {
      focusAgentRowNow(agentId)
    }, { delays: [80, 180] })
  }, [focusAgentRowNow])

  const focusAgentSessionRow = useCallback((provider: string, sessionId: string) => {
    window.requestAnimationFrame(() => {
      const rows = Array.from(workspaceRef.current?.querySelectorAll<HTMLButtonElement>('[data-testid="code-active-session-row"]') ?? [])
      rows.find(row => row.dataset.provider === provider && row.dataset.sessionId === sessionId)?.focus({ preventScroll: true })
    })
  }, [])

  const focusProjectTitle = useCallback((projectId: string) => {
    window.requestAnimationFrame(() => {
      const titles = Array.from(workspaceRef.current?.querySelectorAll<HTMLButtonElement>('[data-testid="code-project-title"]') ?? [])
      titles.find(title => title.dataset.projectId === projectId)?.focus()
    })
  }, [])

  const toggleContextMenuAgentSessionPinned = useCallback(() => {
    if (!contextMenuAgentSession) return
    const sessionId = agentSessionId(contextMenuAgentSession)
    const nextPinned = contextMenuAgentSession.pinned !== true
    setAgentSessionPinnedOverrides(previous => ({
      ...previous,
      [sessionId]: nextPinned,
    }))
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    if (mainPageSessionKeys.has(sessionId)) {
      focusAgentSessionRow(contextMenuAgentSession.provider, contextMenuAgentSession.id)
    } else {
      window.requestAnimationFrame(() => projectListRef.current?.focus({ preventScroll: true }))
    }
  }, [contextMenuAgentSession, focusAgentSessionRow, mainPageSessionKeys])

  const archiveContextMenuAgentSession = useCallback(() => {
    if (!contextMenuAgentSession) return
    const sessionId = agentSessionId(contextMenuAgentSession)
    setAgentSessionPinnedOverrides(previous => ({
      ...previous,
      [sessionId]: false,
    }))
    removeMainPageAgentSession(sessionId)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    window.requestAnimationFrame(() => projectListRef.current?.focus({ preventScroll: true }))
  }, [contextMenuAgentSession, removeMainPageAgentSession])

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    expandSidebar()
    resizingSidebarRef.current = true
    document.body.classList.add('code-resizing-sidebar')
    updateSidebarWidth(event.clientX)
  }, [expandSidebar, updateSidebarWidth])

  const openTerminalFromWorkspace = useCallback((agentId: string, options?: { focusTerminal?: boolean }) => {
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    clearSearch()
    setMainPaneMode('terminal')
    onWorkspaceViewChange('projects')
    onOpenTerminal(agentId, options)
  }, [clearSearch, onOpenTerminal, onWorkspaceViewChange])

  const openTerminalFromSidebar = useCallback((agentId: string) => {
    openTerminalFromWorkspace(agentId)
    closeSidebarForMobile()
  }, [closeSidebarForMobile, openTerminalFromWorkspace])

  const createWorkspaceOpenFileRequest = useCallback((target?: WorkspaceFileOpenTarget) => (
    workspaceOpenFileRequestForTarget(target, {
      cursorRequestId: target?.lineNumber
        ? (workspaceFileCursorRequestRef.current += 1)
        : workspaceFileCursorRequestRef.current,
      diffRequestId: target?.view === 'diff'
        ? (workspaceFileDiffRequestRef.current += 1)
        : workspaceFileDiffRequestRef.current,
    })
  ), [])

  const openProjectFile = useCallback((agentId: string, file: OpenWorkspaceFile['file'], target?: WorkspaceFileOpenTarget) => {
    const agent = activeAgents.find(candidate => candidate.id === agentId)
    const workspaceRoot = agent && !agent.isMain ? projectWorkspaceForAgent(agent) : undefined
    if (agent) {
      const projectId = agent.isMain ? MAIN_AGENT_PROJECT_ID : projectWorkspaceForAgent(agent)
      setCollapsedProjectIds(previous => {
        if (!previous.has(projectId)) return previous
        const next = new Set(previous)
        next.delete(projectId)
        return next
      })
    }
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    clearSearch()
    onWorkspaceViewChange('projects')
    setMainPaneMode('editor')
    const openRequest = {
      ...createWorkspaceOpenFileRequest(target),
      workspaceRoot,
      sourceAgentId: agentId,
    }
    workspaceOpenFiles.openFromRead(agentId, file, openRequest)
    if (shouldRevealSelectedWorkspaceOpenFile(target)) {
      setFileRevealRequest({
        agentId,
        path: file.path,
        kind: 'file',
        requestId: workspaceFileRevealRequestRef.current += 1,
      })
    }
    markAgentReadIfNeeded(agentId)
    onOpenTerminal(agentId, { focusTerminal: false })
    closeSidebarForMobile()
  }, [activeAgents, clearSearch, closeSidebarForMobile, createWorkspaceOpenFileRequest, markAgentReadIfNeeded, onOpenTerminal, onWorkspaceViewChange, workspaceOpenFiles])

  const focusWorkspaceFilesSearch = useCallback((agentId: string, query?: string) => {
    const agent = activeAgents.find(candidate => candidate.id === agentId)
    if (agent) {
      const projectId = agent.isMain ? MAIN_AGENT_PROJECT_ID : projectWorkspaceForAgent(agent)
      setCollapsedProjectIds(previous => {
        if (!previous.has(projectId)) return previous
        const next = new Set(previous)
        next.delete(projectId)
        return next
      })
    }
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    clearSearch()
    expandSidebar()
    onWorkspaceViewChange('projects')
    setFileSearchFocusRequest({
      agentId,
      ...(query ? { query } : {}),
      requestId: workspaceFileSearchFocusRequestRef.current += 1,
    })
  }, [activeAgents, clearSearch, expandSidebar, onWorkspaceViewChange])

  const revealWorkspaceFileInExplorer = useCallback((agentId: string, filePath: string, kind: 'directory' | 'file') => {
    const agent = activeAgents.find(candidate => candidate.id === agentId)
    if (agent) {
      const projectId = agent.isMain ? MAIN_AGENT_PROJECT_ID : projectWorkspaceForAgent(agent)
      setCollapsedProjectIds(previous => {
        if (!previous.has(projectId)) return previous
        const next = new Set(previous)
        next.delete(projectId)
        return next
      })
    }
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    clearSearch()
    expandSidebar()
    onWorkspaceViewChange('projects')
    setFileRevealRequest({
      agentId,
      path: filePath,
      kind,
      requestId: workspaceFileRevealRequestRef.current += 1,
    })
  }, [activeAgents, clearSearch, expandSidebar, onWorkspaceViewChange])

  const resolveTerminalPathTarget = useCallback(async (agentId: string, target: TerminalPathOpenTarget) => {
    const agent = activeAgents.find(candidate => candidate.id === agentId)
    const filePath = terminalTargetFilePath(target.path, agent ? projectWorkspaceForAgent(agent) : '')
    if (!filePath) return null

    try {
      const results = await searchWorkspaceFiles(agentId, filePath, { limit: TERMINAL_PATH_SEARCH_LIMIT })
      const pathMatches = uniqueTerminalPathSearchMatches(results.matches)
      const exactPathMatch = pathMatches.find(match => match.path === filePath)
      const resolvedPath = exactPathMatch?.path ?? (pathMatches.length === 1 ? pathMatches[0]?.path : '')
      return resolvedPath ? { ...target, path: resolvedPath } : null
    } catch {
      return null
    }
  }, [activeAgents])

  const openTerminalPathTarget = useCallback((agentId: string, target: TerminalPathOpenTarget) => {
    const agent = activeAgents.find(candidate => candidate.id === agentId)
    const filePath = terminalTargetFilePath(target.path, agent ? projectWorkspaceForAgent(agent) : '')
    if (!filePath) return

    const requestId = terminalPathOpenRequestRef.current + 1
    terminalPathOpenRequestRef.current = requestId
    const openTarget = openTargetForTerminalPath(target)

    const openResolvedFile = async (resolvedPath: string, resolvedTarget = openTarget) => {
      const file = await fetchWorkspaceFile(agentId, resolvedPath)
      if (terminalPathOpenRequestRef.current !== requestId) return
      openProjectFile(agentId, file, resolvedTarget)
    }

    const revealResolvedDirectory = (resolvedPath: string) => {
      if (terminalPathOpenRequestRef.current !== requestId) return
      revealWorkspaceFileInExplorer(agentId, resolvedPath, 'directory')
    }

    const openResolvedPathMatch = async (match: WorkspaceFileSearchMatch) => {
      if (match.entryType === 'directory') {
        revealResolvedDirectory(match.path)
        return
      }
      await openResolvedFile(match.path)
    }

    const revealSearch = () => {
      if (terminalPathOpenRequestRef.current !== requestId) return
      focusWorkspaceFilesSearch(agentId, filePath)
    }

    void (async () => {
      try {
        await fetchWorkspaceTree(agentId, filePath)
        revealResolvedDirectory(filePath)
        return
      } catch {
        // Fall through to file open for normal files.
      }

      try {
        await openResolvedFile(filePath)
        return
      } catch {
        // Fall through to path search for basename-only or shortened paths.
      }

      try {
        const results = await searchWorkspaceFiles(agentId, filePath, { limit: TERMINAL_PATH_SEARCH_LIMIT })
        if (terminalPathOpenRequestRef.current !== requestId) return
        const pathMatches = uniqueTerminalPathSearchMatches(results.matches)
        if (pathMatches.length === 1) {
          const match = pathMatches[0]
          if (!match) return
          await openResolvedPathMatch(match)
          return
        }

        const fileMatches = uniqueTerminalFileSearchMatches(results.matches)
        if (pathMatches.length === 0 && fileMatches.length === 1) {
          const match = fileMatches[0]
          if (!match) return
          await openResolvedFile(match.path, openTarget ?? (match.kind === 'content' ? {
            lineNumber: match.lineNumber,
            column: match.ranges[0] ? match.ranges[0].start + 1 : undefined,
            endColumn: match.ranges[0] ? Math.max(match.ranges[0].start + 1, match.ranges[0].end + 1) : undefined,
          } : undefined))
          return
        }
      } catch {
        // Search failures still leave the user in the Files search UI.
      }

      revealSearch()
    })()
  }, [activeAgents, focusWorkspaceFilesSearch, openProjectFile, revealWorkspaceFileInExplorer])

  const selectOpenWorkspaceFile = useCallback((agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => {
    const agent = activeAgents.find(candidate => candidate.id === agentId)
    const workspaceRoot = agent && !agent.isMain ? projectWorkspaceForAgent(agent) : undefined
    if (agent) {
      const projectId = agent.isMain ? MAIN_AGENT_PROJECT_ID : projectWorkspaceForAgent(agent)
      setCollapsedProjectIds(previous => {
        if (!previous.has(projectId)) return previous
        const next = new Set(previous)
        next.delete(projectId)
        return next
      })
    }
    const requestedKey = workspaceOpenFileTargetKey({
      agentId,
      workspaceRoot,
      filePath,
    })
    const hasOpenFile = openWorkspaceFiles.some(file => workspaceOpenFileKey(file) === requestedKey)
    if (!hasOpenFile) return false
    const openRequest = {
      ...createWorkspaceOpenFileRequest(target),
      workspaceRoot,
      sourceAgentId: agentId,
    }
    if (!workspaceOpenFiles.select(agentId, filePath, openRequest)) return false
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    clearSearch()
    onWorkspaceViewChange('projects')
    setMainPaneMode('editor')
    if (shouldRevealSelectedWorkspaceOpenFile(target)) {
      setFileRevealRequest({
        agentId,
        path: filePath,
        kind: 'file',
        requestId: workspaceFileRevealRequestRef.current += 1,
      })
    }
    markAgentReadIfNeeded(agentId)
    onOpenTerminal(agentId, { focusTerminal: false })
    closeSidebarForMobile()
    return true
  }, [activeAgents, clearSearch, closeSidebarForMobile, createWorkspaceOpenFileRequest, markAgentReadIfNeeded, onOpenTerminal, onWorkspaceViewChange, openWorkspaceFiles, workspaceOpenFiles])

  const restoreWorkspaceNavigationEntry = useCallback(async (entry: WorkspaceNavigationEntry) => {
    if (!workspaceNavigationAgentIds.has(entry.agentId)) return false

    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    clearSearch()
    onWorkspaceViewChange('projects')

    if (entry.kind === 'agent') {
      setMainPaneMode('terminal')
      onOpenTerminal(entry.agentId)
      closeSidebarForMobile()
      return true
    }

    const target: WorkspaceFileOpenTarget = {
      view: entry.view,
      lineNumber: entry.lineNumber,
      column: entry.column,
      endColumn: entry.endColumn,
    }

    if (selectOpenWorkspaceFile(entry.agentId, entry.filePath, target)) return true

    try {
      const file = await fetchWorkspaceFile(entry.agentId, entry.filePath)
      openProjectFile(entry.agentId, file, target)
      return true
    } catch {
      focusWorkspaceFilesSearch(entry.agentId, entry.filePath)
      return true
    }
  }, [
    clearSearch,
    closeSidebarForMobile,
    focusWorkspaceFilesSearch,
    onOpenTerminal,
    onWorkspaceViewChange,
    openProjectFile,
    selectOpenWorkspaceFile,
    workspaceNavigationAgentIds,
  ])

  const navigateWorkspaceHistory = useCallback((direction: -1 | 1) => {
    const entry = beginWorkspaceNavigation(direction)
    if (!entry) return false
    void (async () => {
      let currentEntry: WorkspaceNavigationEntry | null = entry
      while (currentEntry) {
        if (await restoreWorkspaceNavigationEntry(currentEntry)) return
        currentEntry = beginWorkspaceNavigation(direction)
      }
    })().finally(() => {
      finishWorkspaceNavigation()
    })
    return true
  }, [beginWorkspaceNavigation, finishWorkspaceNavigation, restoreWorkspaceNavigationEntry])

  const backToAgentFromFile = useCallback((agentId: string) => {
    setMainPaneMode('terminal')
    onWorkspaceViewChange('projects')
    onOpenTerminal(agentId, { focusTerminal: true })
    closeSidebarForMobile()
  }, [closeSidebarForMobile, onOpenTerminal, onWorkspaceViewChange])

  const closeOpenWorkspaceFiles = useCallback((targets: WorkspaceOpenFileTarget[]) => {
    const nextState = workspaceOpenFiles.close(targets)
    if (nextState.closedFiles.length === 0) return
    if (nextState.activeFileClosed) {
      setMainPaneMode(nextState.activeFile ? 'editor' : 'terminal')
    }
  }, [workspaceOpenFiles])

  const closeOpenWorkspaceFile = useCallback((agentId: string, filePath: string, workspaceRoot?: string) => {
    closeOpenWorkspaceFiles([{ agentId, filePath, workspaceRoot }])
  }, [closeOpenWorkspaceFiles])

  const updateOpenWorkspaceFile = useCallback((nextFile: OpenWorkspaceFile) => {
    workspaceOpenFiles.update(nextFile)
  }, [workspaceOpenFiles])

  const updateOpenWorkspaceFileDraft = useCallback((nextDraft: string) => {
    workspaceOpenFiles.updateDraft(nextDraft)
  }, [workspaceOpenFiles])

  const handleWorkspaceFileMove = useCallback((agentId: string, moves: WorkspaceFileMove[]) => {
    if (moves.length === 0) return

    workspaceOpenFiles.move(agentId, moves)
  }, [workspaceOpenFiles])

  const handleWorkspaceFileDelete = useCallback((agentId: string, deletions: WorkspaceFileDeleteResult[]) => {
    if (deletions.length === 0) return

    const nextState = workspaceOpenFiles.deleteEntries(agentId, deletions)
    if (nextState.activeFileDeleted) {
      if (!nextState.activeFile) setMainPaneMode('terminal')
    }
  }, [workspaceOpenFiles])

  const openAgentContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>, agentId: string) => {
    event.preventDefault()
    event.stopPropagation()
    const agent = activeAgents.find(item => item.id === agentId)
    const point = clampContextMenuPoint(
      event.clientX,
      event.clientY,
      estimateAgentContextMenuHeight(agent)
    )
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    setAgentMenu({
      agentId,
      x: point.x,
      y: point.y,
    })
  }, [activeAgents])

  const openAgentKeyboardMenu = useCallback((event: ReactKeyboardEvent<HTMLElement>, agentId: string) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return

    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const agent = activeAgents.find(item => item.id === agentId)
    const point = clampContextMenuPoint(
      rect.left + 24,
      rect.top + rect.height,
      estimateAgentContextMenuHeight(agent)
    )
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    setAgentMenu({
      agentId,
      x: point.x,
      y: point.y,
    })
  }, [activeAgents])

  const openProjectContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>, projectId: string) => {
    event.preventDefault()
    event.stopPropagation()
    const project = projectListProjects.find(item => item.id === projectId)
    const point = clampContextMenuPoint(event.clientX, event.clientY, estimateContextMenuHeight(projectCanDeleteWorktree(project) ? 3 : 2))
    setAgentMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    setProjectMenu({
      projectId,
      x: point.x,
      y: point.y,
    })
  }, [projectListProjects])

  const openProjectKeyboardMenu = useCallback((event: ReactKeyboardEvent<HTMLElement>, projectId: string) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return

    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const project = projectListProjects.find(item => item.id === projectId)
    const point = clampContextMenuPoint(rect.left + 24, rect.top + rect.height, estimateContextMenuHeight(projectCanDeleteWorktree(project) ? 3 : 2))
    setAgentMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    setProjectMenu({
      projectId,
      x: point.x,
      y: point.y,
    })
  }, [projectListProjects])

  const openAgentSessionContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>, provider: string, sessionId: string) => {
    event.preventDefault()
    event.stopPropagation()
    const point = clampContextMenuPoint(event.clientX, event.clientY, estimateContextMenuHeight(3))
    setAgentMenu(null)
    setProjectMenu(null)
    setOptionsMenu(null)
    setAgentSessionMenu({
      provider,
      sessionId,
      x: point.x,
      y: point.y,
    })
  }, [])

  const openAgentSessionKeyboardMenu = useCallback((event: ReactKeyboardEvent<HTMLElement>, provider: string, sessionId: string) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return

    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const point = clampContextMenuPoint(rect.left + 24, rect.top + rect.height, estimateContextMenuHeight(3))
    setAgentMenu(null)
    setProjectMenu(null)
    setOptionsMenu(null)
    setAgentSessionMenu({
      provider,
      sessionId,
      x: point.x,
      y: point.y,
    })
  }, [])

  const renameContextMenuAgent = useCallback(() => {
    if (!contextMenuAgent) return

    const currentTitle = agentTitle(contextMenuAgent)
    setAgentMenu(null)
    setOptionsMenu(null)
    setRenameDialog({ agentId: contextMenuAgent.id, title: currentTitle })
  }, [contextMenuAgent])

  const closeRenameDialog = useCallback(() => {
    const agentId = renameDialog?.agentId
    setRenameDialog(null)
    if (agentId) focusAgentRow(agentId)
  }, [focusAgentRow, renameDialog?.agentId])

  const submitRenameDialog = useCallback(() => {
    if (!renameDialog) return
    const title = renameDialog.title.trim()
    if (title) {
      onRenameAgent(renameDialog.agentId, title)
    }
    setRenameDialog(null)
    focusAgentRow(renameDialog.agentId)
  }, [focusAgentRow, onRenameAgent, renameDialog])

  const copyContextMenuValue = useCallback(async (value: string, focusTarget?: SearchTarget) => {
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    const copied = await writeClipboardText(value)
    setCopyNotice({
      id: Date.now(),
      kind: copied ? 'success' : 'error',
      message: copied ? copy.copiedWorkingDirectory : copy.copyFailed,
    })
    if (focusTarget?.kind === 'agent') focusAgentRow(focusTarget.id)
    if (focusTarget?.kind === 'agent-session') focusAgentSessionRow(focusTarget.provider, focusTarget.id)
  }, [copy.copiedWorkingDirectory, copy.copyFailed, focusAgentRow, focusAgentSessionRow])

  const killContextMenuAgent = useCallback(() => {
    if (!contextMenuAgent) return
    setAgentMenu(null)
    setOptionsMenu(null)
    setKillDialog({ agentId: contextMenuAgent.id, title: agentTitle(contextMenuAgent) })
  }, [contextMenuAgent])

  const closeKillDialog = useCallback(() => {
    const agentId = killDialog?.agentId
    setKillDialog(null)
    if (agentId) focusAgentRow(agentId)
  }, [focusAgentRow, killDialog?.agentId])

  const submitKillDialog = useCallback(() => {
    if (!killDialog) return
    onKill(killDialog.agentId)
    setKillDialog(null)
  }, [killDialog, onKill])

  const forkContextMenuAgent = useCallback((mode: 'same-worktree' | 'new-worktree') => {
    if (!contextMenuAgent) return
    setAgentMenu(null)
    setOptionsMenu(null)
    onForkAgent(contextMenuAgent.id, mode)
  }, [contextMenuAgent, onForkAgent])

  const updateContextMenuAgentFlags = useCallback((flags: Partial<Pick<Agent, 'pinned' | 'unread' | 'archived'>>) => {
    if (!contextMenuAgent) return
    const agentId = contextMenuAgent.id
    setAgentMenu(null)
    setOptionsMenu(null)
    if (flags.archived === true) {
      const sessionHandle = contextMenuAgent.providerSessionKey || resumedAgentSessionIdFromSource(contextMenuAgent.source)
      if (sessionHandle) removeMainPageAgentSession(sessionHandle)
      pendingArchivedFocusAgentRef.current = agentId
      window.setTimeout(() => focusActiveProjectListTargetNow(), 120)
      window.setTimeout(() => focusActiveProjectListTargetNow(), 360)
      window.setTimeout(() => focusActiveProjectListTargetNow(), 720)
    }
    const result = onUpdateAgentFlags(agentId, flags)
    if (flags.archived === true) syncRemovedMainPageSessionsFromAgentUpdate(result)
    if (flags.archived !== true) focusAgentRow(agentId)
  }, [contextMenuAgent, focusActiveProjectListTargetNow, focusAgentRow, onUpdateAgentFlags, removeMainPageAgentSession, syncRemovedMainPageSessionsFromAgentUpdate])

  const updateSidebarAgentFlags = useCallback((agent: Agent, flags: Partial<Pick<Agent, 'pinned' | 'archived'>>) => {
    const agentId = agent.id
    setAgentMenu(null)
    setOptionsMenu(null)
    if (flags.archived === true) {
      const sessionHandle = agent.providerSessionKey || resumedAgentSessionIdFromSource(agent.source)
      if (sessionHandle) removeMainPageAgentSession(sessionHandle)
      pendingArchivedFocusAgentRef.current = agentId
      window.setTimeout(() => focusActiveProjectListTargetNow(), 120)
      window.setTimeout(() => focusActiveProjectListTargetNow(), 360)
      window.setTimeout(() => focusActiveProjectListTargetNow(), 720)
    }
    const result = onUpdateAgentFlags(agentId, flags)
    if (flags.archived === true) syncRemovedMainPageSessionsFromAgentUpdate(result)
    if (flags.archived !== true) focusAgentRow(agentId)
  }, [focusActiveProjectListTargetNow, focusAgentRow, onUpdateAgentFlags, removeMainPageAgentSession, syncRemovedMainPageSessionsFromAgentUpdate])

  const restoreArchivedAgent = useCallback((agentId: string) => {
    pendingArchivedFocusAgentRef.current = null
    pendingRestoredFocusAgentRef.current = agentId
    onUpdateAgentFlags(agentId, { archived: false })
    clearSearch()
    onWorkspaceViewChange('projects')
    ;[120, 360, 720, 1200, 1800].forEach(delay => {
      window.setTimeout(() => {
        if (!shouldSkipProjectFocusRestore()) focusAgentRowNow(agentId)
      }, delay)
    })
  }, [clearSearch, focusAgentRowNow, onUpdateAgentFlags, onWorkspaceViewChange, shouldSkipProjectFocusRestore])

  const openArchivedAgent = useCallback((agentId: string) => {
    onOpenArchivedAgent(agentId)
  }, [onOpenArchivedAgent])

  const resumeAgentSession = useCallback(async (provider: string, sessionId: string) => {
    const sessionHandle = workspaceTargetId({ kind: 'agent-session', provider, id: sessionId })
    const existingAgent = activeAgents.find(agent => (
      (
        agent.providerSessionKey === sessionHandle
        || agent.source === resumedAgentSource(provider, sessionId)
      )
      && agent.archived !== true
      && agent.status !== 'dead'
      && agent.status !== 'stopped'
    ))
    if (existingAgent) {
      addMainPageAgentSession(provider, sessionId)
      onOpenTerminal(existingAgent.id)
      closeSidebarForMobile()
      return
    }

    try {
      const response = await fetch(appPath(`/api/agent-sessions/${encodeURIComponent(provider)}/${encodeURIComponent(sessionId)}/resume`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json().catch(() => null) as { agentId?: string; error?: string } | null
      if (!response.ok || !data?.agentId) {
        setCopyNotice({ id: Date.now(), kind: 'error', message: data?.error || `Failed to resume agent session (${response.status})` })
        return
      }
      addMainPageAgentSession(provider, sessionId)
      onOpenTerminal(data.agentId)
      closeSidebarForMobile()
    } catch (error) {
      setCopyNotice({ id: Date.now(), kind: 'error', message: error instanceof Error ? error.message : 'Failed to resume agent session' })
    }
  }, [activeAgents, addMainPageAgentSession, closeSidebarForMobile, onOpenTerminal])
  resumeAgentSessionRef.current = resumeAgentSession

  const continueArchivedRun = useCallback((entry: TaskHistoryEntry) => {
    const resumedSession = resumedSessionFromHistoryRunSource(entry.source)
    if (resumedSession) {
      resumeAgentSession(resumedSession.provider, resumedSession.sessionId)
      onWorkspaceViewChange('projects')
      return
    }

    onNewAgent(projectWorkspaceForHistoryRun(entry), entry.command || undefined, null)
  }, [onNewAgent, onWorkspaceViewChange, resumeAgentSession])

  const openOptionsMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const point = clampContextMenuPoint(
      rect.right - OPTIONS_MENU_ESTIMATED_WIDTH,
      rect.bottom + 8,
      OPTIONS_MENU_ESTIMATED_HEIGHT,
      undefined,
      OPTIONS_MENU_ESTIMATED_WIDTH
    )

    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu({
      x: point.x,
      y: point.y,
      returnFocusTarget: event.currentTarget,
    })
  }, [])

  const updateLanguagePreference = useCallback((language: UiPreferences['language']) => {
    setOptionsMenu(null)
    onUpdateUiPreferences({ language })
  }, [onUpdateUiPreferences])

  const updateAppearancePreference = useCallback((appearance: UiPreferences['appearance']) => {
    setOptionsMenu(null)
    onUpdateUiPreferences({ appearance })
  }, [onUpdateUiPreferences])

  const optionsMenuEntries = useMemo<ContextMenuEntry[]>(() => compactContextMenuEntries([
    {
      type: 'item',
      id: 'options-appearance-light',
      label: appearanceOptionDisplayLabel(copy.appearanceLight),
      ariaLabel: copy.appearanceLight,
      checked: uiPreferences.appearance === 'light',
      onSelect: () => updateAppearancePreference('light'),
    },
    {
      type: 'item',
      id: 'options-appearance-dark',
      label: appearanceOptionDisplayLabel(copy.appearanceDark),
      ariaLabel: copy.appearanceDark,
      checked: uiPreferences.appearance === 'dark',
      onSelect: () => updateAppearancePreference('dark'),
    },
    { type: 'separator', id: 'options-appearance-language-separator' },
    {
      type: 'item',
      id: 'options-language-en',
      label: languageOptionDisplayLabel(copy.languageEnglish),
      ariaLabel: copy.languageEnglish,
      checked: uiPreferences.language === 'en',
      onSelect: () => updateLanguagePreference('en'),
    },
    {
      type: 'item',
      id: 'options-language-zh',
      label: languageOptionDisplayLabel(copy.languageChinese),
      ariaLabel: copy.languageChinese,
      checked: uiPreferences.language === 'zh',
      onSelect: () => updateLanguagePreference('zh'),
    },
  ]), [
    copy.appearanceDark,
    copy.appearanceLight,
    copy.languageChinese,
    copy.languageEnglish,
    uiPreferences.appearance,
    uiPreferences.language,
    updateAppearancePreference,
    updateLanguagePreference,
  ])

  const persistAgentLaunchProfile = useCallback((agentName: 'codex' | 'claude', updates: Record<string, string>) => {
    fetch(appPath('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentLaunchProfiles: {
          [agentName]: updates,
        },
      }),
    }).catch(() => {})
  }, [])

  const updatePermissionMode = useCallback((mode: string) => {
    if (composerAgentKind === 'claude') {
      const nextMode = isClaudePermissionMode(mode) ? mode : 'default'
      setClaudePermissionMode(nextMode)
      persistAgentLaunchProfile('claude', { permissionMode: nextMode })
      closeActiveComposerMenus()
      focusComposerTextarea()
      return
    }

    const nextMode = isCodexApprovalMode(mode) ? mode : 'approve'
    setCodexApprovalMode(nextMode)
    persistAgentLaunchProfile('codex', { approvalMode: nextMode })
    closeActiveComposerMenus()
    focusComposerTextarea()
  }, [closeActiveComposerMenus, composerAgentKind, focusComposerTextarea, persistAgentLaunchProfile])

  const updateAgentModel = useCallback((model: string) => {
    if (composerAgentKind === 'claude') {
      const nextModel = normalizeClaudeModel(model)
      setClaudeModel(nextModel)
      closeActiveComposerMenus()
      focusComposerTextarea()
      persistAgentLaunchProfile('claude', {
        model: nextModel,
        effort: claudeEffort,
      })
      return
    }

    const option = codexModelOptions.find(item => item.value === model)
    const reasoningLevels = option?.reasoningLevels ?? []
    const serviceTiers = option?.serviceTiers ?? []
    const nextEffort = reasoningLevels.some(level => level.value === codexReasoningEffort)
      ? codexReasoningEffort
      : (option?.defaultEffort || reasoningLevels[0]?.value || codexReasoningEffort)
    const nextServiceTier = serviceTiers.some(tier => tier.value === codexServiceTier)
      ? codexServiceTier
      : 'default'

    setCodexModel(model)
    setCodexReasoningEffort(nextEffort)
    setCodexServiceTier(nextServiceTier)
    setCodexModelPreset(`${model}:${nextEffort}`)
    closeActiveComposerMenus()
    focusComposerTextarea()
    persistAgentLaunchProfile('codex', {
      model,
      reasoningEffort: nextEffort,
      serviceTier: nextServiceTier,
    })
  }, [claudeEffort, closeActiveComposerMenus, codexModelOptions, codexReasoningEffort, codexServiceTier, composerAgentKind, focusComposerTextarea, persistAgentLaunchProfile])

  const updateAgentReasoningEffort = useCallback((effort: string) => {
    if (composerAgentKind === 'claude') {
      const nextEffort = normalizeClaudeEffort(effort)
      setClaudeEffort(nextEffort)
      closeActiveComposerMenus()
      focusComposerTextarea()
      persistAgentLaunchProfile('claude', {
        model: claudeModel,
        effort: nextEffort,
      })
      return
    }

    setCodexReasoningEffort(effort)
    setCodexModelPreset(`${codexModel}:${effort}`)
    closeActiveComposerMenus()
    focusComposerTextarea()
    persistAgentLaunchProfile('codex', {
      model: codexModel,
      reasoningEffort: effort,
      serviceTier: codexServiceTier,
    })
  }, [claudeModel, closeActiveComposerMenus, codexModel, codexServiceTier, composerAgentKind, focusComposerTextarea, persistAgentLaunchProfile])

  const updateAgentServiceTier = useCallback((tier: string) => {
    if (composerAgentKind === 'claude') return

    setCodexServiceTier(tier)
    closeActiveComposerMenus()
    focusComposerTextarea()
    persistAgentLaunchProfile('codex', {
      model: codexModel,
      reasoningEffort: codexReasoningEffort,
      serviceTier: tier,
    })
  }, [closeActiveComposerMenus, codexModel, codexReasoningEffort, composerAgentKind, focusComposerTextarea, persistAgentLaunchProfile])

  const toggleSpeechInput = useCallback(() => {
    if (speechListening) {
      recognitionRef.current?.stop()
      setSpeechListening(false)
      return
    }

    const targetComposerKey = activeComposerKey
    if (!targetComposerKey) return

    const SpeechRecognition = (window as WindowWithSpeechRecognition).SpeechRecognition
      || (window as WindowWithSpeechRecognition).webkitSpeechRecognition
    if (!SpeechRecognition) return

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = navigator.language || 'en-US'
    recognition.onresult = event => {
      let transcript = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        transcript += event.results[index]?.[0]?.transcript ?? ''
      }
      if (!transcript.trim()) return
      updateComposerStateForKey(targetComposerKey, state => {
        const separator = state.draft && !/\s$/.test(state.draft) ? ' ' : ''
        return {
          ...state,
          draft: `${state.draft}${separator}${transcript.trim()}`,
        }
      })
      focusComposerTextarea()
    }
    recognition.onerror = () => {
      setSpeechListening(false)
    }
    recognition.onend = () => {
      setSpeechListening(false)
      recognitionRef.current = null
    }
    recognitionRef.current = recognition
    setSpeechListening(true)
    recognition.start()
  }, [activeComposerKey, focusComposerTextarea, speechListening, updateComposerStateForKey])

  const startAgentInContextProject = useCallback((command?: string) => {
    if (!contextMenuProject) return
    const projectTitle = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-testid="code-project-title"]') ?? [])
      .find(title => title.dataset.projectId === contextMenuProject.id)
    setProjectMenu(null)
    setOptionsMenu(null)
    if (command) {
      onStartAgent(command, contextMenuProject.workspace)
      return
    }
    pendingProjectDialogFocusRef.current = {
      projectId: contextMenuProject.id,
      agentCount: activeAgents.length,
    }
    onNewAgent(contextMenuProject.workspace, undefined, projectTitle ?? null)
  }, [activeAgents.length, contextMenuProject, onNewAgent, onStartAgent])

  const archiveContextProject = useCallback(() => {
    if (!contextMenuProject) return

    const workspace = contextMenuProject.workspace
    const archivableAgents = contextMenuProject.agents.filter(agent => !agent.isMain)
    const projectSessions = mainPageAgentSessions.filter(session => agentSessionWorkspace(session) === workspace)
    if (archivableAgents.length === 0 && projectSessions.length === 0) {
      setProjectMenu(null)
      setOptionsMenu(null)
      restoreProjectListFocusRef.current = 'list'
      return
    }

    archivableAgents.forEach(agent => {
      onUpdateAgentFlags(agent.id, { archived: true })
    })

    removeMainPageAgentSessions(projectSessions.map(agentSessionId))

    setProjectMenu(null)
    setOptionsMenu(null)
    restoreProjectListFocusRef.current = 'list'
  }, [mainPageAgentSessions, contextMenuProject, onUpdateAgentFlags, removeMainPageAgentSessions])

  const deleteContextProjectWorktree = useCallback(async () => {
    if (!contextMenuProject) return

    const projectId = contextMenuProject.id
    const workspace = contextMenuProject.workspace
    const sessionHandles = mainPageAgentSessions
      .filter(session => agentSessionWorkspace(session) === workspace)
      .map(agentSessionId)
    setProjectMenu(null)
    setOptionsMenu(null)

    const result = await onDeleteForkWorktreeProject(workspace)
    if (result.requiresForce) {
      setDeleteWorktreeDialog({
        projectId,
        workspace,
        dirtyEntries: result.dirtyEntries ?? [],
        sessionHandles,
      })
      return
    }

    if (result.deleted) {
      removeMainPageAgentSessions([...sessionHandles, ...(result.removedMainPageSessionKeys ?? [])])
      restoreProjectListFocusRef.current = 'list'
    }
  }, [contextMenuProject, mainPageAgentSessions, onDeleteForkWorktreeProject, removeMainPageAgentSessions])

  const closeDeleteWorktreeDialog = useCallback(() => {
    const projectId = deleteWorktreeDialog?.projectId
    setDeleteWorktreeDialog(null)
    if (projectId) focusProjectTitle(projectId)
  }, [deleteWorktreeDialog?.projectId, focusProjectTitle])

  const submitDeleteWorktreeDialog = useCallback(async () => {
    if (!deleteWorktreeDialog) return
    const dialog = deleteWorktreeDialog
    const result = await onDeleteForkWorktreeProject(dialog.workspace, { force: true })
    if (result.deleted) {
      removeMainPageAgentSessions([...dialog.sessionHandles, ...(result.removedMainPageSessionKeys ?? [])])
      restoreProjectListFocusRef.current = 'list'
      setDeleteWorktreeDialog(null)
    }
  }, [deleteWorktreeDialog, onDeleteForkWorktreeProject, removeMainPageAgentSessions])

  const closeContextMenuAndRestoreFocus = useCallback(() => {
    const agentId = agentMenu?.agentId
    const projectId = projectMenu?.projectId
    const provider = agentSessionMenu?.provider
    const sessionId = agentSessionMenu?.sessionId
    const optionsReturnFocusTarget = optionsMenu?.returnFocusTarget ?? null
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    if (agentId) {
      focusAgentRow(agentId)
    } else if (projectId) {
      focusProjectTitle(projectId)
    } else if (provider && sessionId) {
      focusAgentSessionRow(provider, sessionId)
    } else if (optionsReturnFocusTarget) {
      window.requestAnimationFrame(() => optionsReturnFocusTarget.focus({ preventScroll: true }))
    }
  }, [agentMenu?.agentId, agentSessionMenu?.provider, agentSessionMenu?.sessionId, focusAgentRow, focusAgentSessionRow, focusProjectTitle, optionsMenu?.returnFocusTarget, projectMenu?.projectId])

  const handleContextMenuNavigation = useCallback((event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>, menu: HTMLElement | null) => {
    if (!menu) return false
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    if (buttons.length === 0) return
    const activeIndex = buttons.findIndex(button => button === document.activeElement)
    const fallbackIndex = Math.min(contextMenuFocusIndexRef.current, buttons.length - 1)
    const currentIndex = activeIndex !== -1
      ? activeIndex
      : fallbackIndex
    const focusMenuButton = (index: number) => {
      contextMenuFocusIndexRef.current = index
      buttons[index]?.focus()
    }

    if (event.key === 'Tab') {
      contextMenuUserNavigatedRef.current = true
      event.preventDefault()
      event.stopPropagation()
      const direction = event.shiftKey ? -1 : 1
      const nextIndex = currentIndex + direction
      if (nextIndex < 0 || nextIndex >= buttons.length) {
        closeContextMenuAndRestoreFocus()
        return
      }
      focusMenuButton(nextIndex)
      return true
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      contextMenuUserNavigatedRef.current = true
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = currentIndex === -1
        ? (direction > 0 ? 0 : buttons.length - 1)
        : (currentIndex + direction + buttons.length) % buttons.length
      focusMenuButton(nextIndex)
      return true
    }

    if (event.key === 'Home') {
      contextMenuUserNavigatedRef.current = true
      event.preventDefault()
      event.stopPropagation()
      focusMenuButton(0)
      return true
    }

    if (event.key === 'End') {
      contextMenuUserNavigatedRef.current = true
      event.preventDefault()
      event.stopPropagation()
      focusMenuButton(buttons.length - 1)
      return true
    }

    return false
  }, [closeContextMenuAndRestoreFocus])

  const handleContextMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    handleContextMenuNavigation(event.nativeEvent, event.currentTarget)
  }, [handleContextMenuNavigation])

  useLayoutEffect(() => {
    if (!agentMenu && !projectMenu && !agentSessionMenu && !optionsMenu) return

    const handleNativeContextMenuKeyDown = (event: KeyboardEvent) => {
      const menu = document.querySelector<HTMLElement>('.code-context-menu')
      if (handleContextMenuNavigation(event, menu)) {
        event.stopImmediatePropagation()
      }
    }

    document.addEventListener('keydown', handleNativeContextMenuKeyDown, true)
    return () => document.removeEventListener('keydown', handleNativeContextMenuKeyDown, true)
  }, [agentMenu, agentSessionMenu, handleContextMenuNavigation, optionsMenu, projectMenu])

  const handleComposerMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const targetButton = event.target instanceof Element
      ? event.target.closest('button')
      : null
    const currentIndex = buttons.findIndex(button => button === targetButton || button === document.activeElement)

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeActiveComposerMenus()
      focusComposerTextarea()
      return
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      const focusTarget = approvalMenuOpen
        ? '[data-testid="code-composer-model-picker"]'
        : modelMenuOpen
          ? (isMobileNavigationViewport() ? '[data-testid="code-composer-send"]' : '[data-testid="code-composer-mic"]')
          : '[data-testid="code-composer-approval"]'
      closeActiveComposerMenus()
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(focusTarget)?.focus({ preventScroll: true })
      })
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = currentIndex === -1
        ? (direction > 0 ? 0 : buttons.length - 1)
        : (currentIndex + direction + buttons.length) % buttons.length
      buttons[nextIndex]?.focus()
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      event.stopPropagation()
      buttons[0]?.focus()
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      event.stopPropagation()
      buttons[buttons.length - 1]?.focus()
    }
  }, [approvalMenuOpen, closeActiveComposerMenus, focusComposerTextarea, modelMenuOpen])

  const closeComposerMenuOnBlur = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (!nextTarget) return
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    if (nextTarget instanceof Element && nextTarget.closest('.code-composer')) return
    closeActiveComposerMenus()
  }, [closeActiveComposerMenus])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (dialogOpen) return

      const target = event.target
      if (agentMenu || projectMenu || agentSessionMenu || optionsMenu) {
        if (handleContextMenuNavigation(event, contextMenuRef.current)) return
        if (
          event.key.length === 1
          || event.key === 'Tab'
          || event.key === 'ArrowDown'
          || event.key === 'ArrowUp'
          || event.key === 'Home'
          || event.key === 'End'
        ) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
      }

      if (event.key === 'Escape' && renameDialog) {
        event.preventDefault()
        closeRenameDialog()
        return
      }

      if (event.key === 'Escape' && killDialog) {
        event.preventDefault()
        closeKillDialog()
        return
      }

      if (event.key === 'Escape' && deleteWorktreeDialog) {
        event.preventDefault()
        closeDeleteWorktreeDialog()
        return
      }

      if (renameDialog || killDialog || deleteWorktreeDialog) {
        if (!isOverlayShortcutTarget(target)) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }

      const workspaceNavigationDirection = keyboardShortcutsEnabled
        ? workspaceNavigationShortcutDirection(event)
        : null
      if (workspaceNavigationDirection) {
        consumeWorkspaceNavigationShortcut(event)
        navigateWorkspaceHistory(workspaceNavigationDirection)
        return
      }

      if (
        (event.ctrlKey || event.metaKey)
        && event.key.toLowerCase() === 'p'
        && !event.altKey
        && !event.shiftKey
        && !renameDialog
        && !killDialog
        && !deleteWorktreeDialog
        && !isOverlayShortcutTarget(target)
        && !isNativeTextEditingShortcutTarget(target)
        && !isTerminalShortcutTarget(target)
      ) {
        const targetProjectFileSearchAgent = projectFileSearchAgentForShortcutTarget(target) ?? projectFileSearchAgent
        if (!targetProjectFileSearchAgent) return
        event.preventDefault()
        focusWorkspaceFilesSearch(targetProjectFileSearchAgent.id)
        return
      }

      const isTypingTarget = isTextEditingShortcutTarget(target)
      if (isTypingTarget || isTerminalShortcutTarget(target)) return
      if (isOverlayShortcutTarget(target) && event.key !== 'Escape') return

      if (event.key === 'Escape' && (plusMenuOpen || approvalMenuOpen || modelMenuOpen)) {
        event.preventDefault()
        closeActiveComposerMenus()
        focusComposerTextarea()
        return
      }

      if (event.key === 'Escape' && activeView !== 'projects') {
        event.preventDefault()
        setAgentMenu(null)
        setProjectMenu(null)
        setAgentSessionMenu(null)
        setOptionsMenu(null)
        clearSearch()
        onWorkspaceViewChange('projects')
        restoreProjectListFocusRef.current = 'active-force'
        return
      }

      if (event.key === 'Escape' && (agentMenu || projectMenu || agentSessionMenu || optionsMenu)) {
        event.preventDefault()
        const agentId = agentMenu?.agentId
        const projectId = projectMenu?.projectId
        const provider = agentSessionMenu?.provider
        const sessionId = agentSessionMenu?.sessionId
        const optionsReturnFocusTarget = optionsMenu?.returnFocusTarget ?? null
        setAgentMenu(null)
        setProjectMenu(null)
        setAgentSessionMenu(null)
        setOptionsMenu(null)
        if (agentId) {
          focusAgentRow(agentId)
        } else if (projectId) {
          focusProjectTitle(projectId)
        } else if (provider && sessionId) {
          focusAgentSessionRow(provider, sessionId)
        } else if (optionsReturnFocusTarget) {
          window.requestAnimationFrame(() => optionsReturnFocusTarget.focus({ preventScroll: true }))
        }
        return
      }

      if (!keyboardShortcutsEnabled) return

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleSidebar()
        return
      }

      if (
        event.key === '/'
        && !event.ctrlKey
        && !event.metaKey
        && !event.altKey
        && !event.shiftKey
      ) {
        event.preventDefault()
        openSearch()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [activeView, agentMenu, approvalMenuOpen, closeActiveComposerMenus, closeDeleteWorktreeDialog, closeKillDialog, closeRenameDialog, agentSessionMenu, deleteWorktreeDialog, dialogOpen, focusAgentRow, focusAgentSessionRow, focusComposerTextarea, focusProjectTitle, focusWorkspaceFilesSearch, handleContextMenuNavigation, killDialog, keyboardShortcutsEnabled, modelMenuOpen, navigateWorkspaceHistory, optionsMenu, plusMenuOpen, projectFileSearchAgent, projectFileSearchAgentForShortcutTarget, projectMenu, renameDialog, clearSearch, onWorkspaceViewChange, openSearch, toggleSidebar])

  useEffect(() => {
    if (!renameDialog?.agentId) return
    const initialTitle = renameDialog.title
    const focusRenameInput = () => {
      const input = renameInputRef.current
      if (!input) return
      const activeElement = document.activeElement
      if (activeElement !== input && !renameDialogRef.current?.contains(activeElement)) {
        input.focus()
      }
      if (document.activeElement === input && input.value === initialTitle) {
        input.select()
      }
    }
    return scheduleFocusRetries(focusRenameInput, { delays: [0, 80, 180, 360] })
  }, [renameDialog?.agentId])

  useEffect(() => {
    if (!killDialog) return
    const focusCancelButton = () => {
      if (killDialogRef.current?.contains(document.activeElement)) return
      killCancelButtonRef.current?.focus()
    }
    return scheduleFocusRetries(focusCancelButton, { runNow: false, delays: [180] })
  }, [killDialog])

  useEffect(() => {
    if (!deleteWorktreeDialog) return
    const focusCancelButton = () => {
      if (deleteWorktreeDialogRef.current?.contains(document.activeElement)) return
      deleteWorktreeCancelButtonRef.current?.focus()
    }
    return scheduleFocusRetries(focusCancelButton, { runNow: false, delays: [180] })
  }, [deleteWorktreeDialog])

  useEffect(() => {
    if (!copyNotice) return
    const timer = window.setTimeout(() => setCopyNotice(null), 1700)
    return () => window.clearTimeout(timer)
  }, [copyNotice])

  useEffect(() => {
    function closeMenuOnOutsidePointer(event: PointerEvent) {
      const target = event.target
      if (target instanceof Element && target.closest('.code-context-menu')) return
      setAgentMenu(null)
      setProjectMenu(null)
      setAgentSessionMenu(null)
      setOptionsMenu(null)
    }

    if (!agentMenu && !projectMenu && !agentSessionMenu && !optionsMenu) return
    window.addEventListener('pointerdown', closeMenuOnOutsidePointer)
    return () => window.removeEventListener('pointerdown', closeMenuOnOutsidePointer)
  }, [agentMenu, agentSessionMenu, optionsMenu, projectMenu])

  useEffect(() => {
    function closeComposerPopover(event: PointerEvent) {
      const target = event.target
      if (target instanceof Element && target.closest('.code-composer-menu-anchor')) return
      closeActiveComposerMenus()
    }

    if (!plusMenuOpen && !approvalMenuOpen && !modelMenuOpen) return
    window.addEventListener('pointerdown', closeComposerPopover)
    return () => window.removeEventListener('pointerdown', closeComposerPopover)
  }, [approvalMenuOpen, closeActiveComposerMenus, modelMenuOpen, plusMenuOpen])

  useLayoutEffect(() => {
    if (!agentMenu && !projectMenu && !agentSessionMenu && !optionsMenu) return
    contextMenuUserNavigatedRef.current = false
    contextMenuFocusIndexRef.current = 0
    const focusFirstMenuButton = () => {
      if (contextMenuUserNavigatedRef.current) return
      const menu = contextMenuRef.current
      if (!menu) return
      const activeElement = document.activeElement
      if (activeElement instanceof HTMLButtonElement && menu.contains(activeElement)) return
      const firstButton = menu.querySelector<HTMLButtonElement>('button:not(:disabled)')
      if (!firstButton) return
      contextMenuFocusIndexRef.current = 0
      firstButton.focus()
    }
    return scheduleFocusRetries(focusFirstMenuButton, { delays: [0, 80, 180, 360] })
  }, [agentMenu, agentSessionMenu, optionsMenu, projectMenu])

  useEffect(() => {
    if (!modelMenuOpen) return
    const timer = window.setTimeout(() => {
      const selector = modelPickerPane === 'model'
        ? '.code-model-submenu .code-model-option.selected'
        : modelPickerPane === 'speed'
          ? '.code-speed-submenu .code-model-option.selected'
          : '.code-model-picker-menu > .code-model-option.selected'
      const selectedButton = modelMenuRef.current?.querySelector<HTMLButtonElement>(selector)
      const firstButton = modelMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ;(selectedButton ?? firstButton)?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [modelMenuOpen, modelPickerPane, activeAgentModel, activeAgentReasoningEffort, activeAgentServiceTier])

  useEffect(() => {
    if (!plusMenuOpen) return
    const timer = window.setTimeout(() => {
      plusMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [plusMenuOpen])

  useEffect(() => {
    if (!approvalMenuOpen) return
    const timer = window.setTimeout(() => {
      const selectedButton = approvalMenuRef.current?.querySelector<HTMLButtonElement>('.code-approval-option.selected')
      const firstButton = approvalMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ;(selectedButton ?? firstButton)?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [approvalMenuOpen, currentPermissionMode])

  useEffect(() => {
    if (!pageVisible) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [pageVisible])

  useEffect(() => {
    const SpeechRecognition = (window as WindowWithSpeechRecognition).SpeechRecognition
      || (window as WindowWithSpeechRecognition).webkitSpeechRecognition
    setSpeechSupported(Boolean(SpeechRecognition))

    return () => {
      recognitionRef.current?.stop()
      recognitionRef.current = null
    }
  }, [])

  useEffect(() => loadGlobalSettings(), [loadGlobalSettings])
  useEffect(() => loadClaudeSettings(), [loadClaudeSettings])
  useEffect(
    () => loadSlashCommands(composerAgentKind || '', activeAgent?.cwd),
    [activeAgent?.cwd, composerAgentKind, loadSlashCommands]
  )
  useEffect(() => {
    if (!modelMenuOpen) return undefined
    return loadCodexModels()
  }, [loadCodexModels, modelMenuOpen])
  useEffect(() => {
    if (!modelMenuOpen || composerAgentKind !== 'claude') return undefined
    return loadClaudeSettings()
  }, [composerAgentKind, loadClaudeSettings, modelMenuOpen])
  useEffect(() => loadAgentSessions(), [loadAgentSessions])

  useEffect(() => {
    autoSizeComposerTextarea()
  }, [autoSizeComposerTextarea, activeComposerKey, composerMode, draft])

  useEffect(() => {
    if (activeAgentCapabilities.composer.permissionMode || activeAgentCapabilities.composer.modelPicker) return
    updateActiveComposerState(state => {
      const closed = closeComposerMenusForState(state)
      if (activeAgentCapabilities.composer.plusMenu || closed.mode === 'default') return closed
      return { ...closed, mode: 'default' }
    })
  }, [activeAgentCapabilities, updateActiveComposerState])

  useEffect(() => {
    if (activeView !== 'search' && searchOpen) {
      clearSearch()
    }

    if (activeView === 'projects') return

    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    closeActiveComposerMenus()
  }, [activeView, clearSearch, closeActiveComposerMenus, searchOpen])

  useEffect(() => {
    if (!dialogOpen) return

    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    closeActiveComposerMenus()
  }, [closeActiveComposerMenus, dialogOpen])

  useEffect(() => {
    if (dialogOpen) return

    const pending = pendingProjectDialogFocusRef.current
    if (!pending) return

    pendingProjectDialogFocusRef.current = null
    if (pending.agentCount === activeAgents.length) {
      focusProjectTitle(pending.projectId)
    }
  }, [activeAgents.length, dialogOpen, focusProjectTitle])

  useEffect(() => {
    if (activeView !== 'projects') return undefined
    return loadGlobalSettings()
  }, [activeView, loadGlobalSettings])

  useEffect(() => {
    if (activeView !== 'history') return

    let cancelled = false
    const loadMutationVersion = mainPageSessionKeysMutationRef.current
    fetch(appPath('/api/settings'))
      .then(response => response.json())
      .then((data: { settings?: GlobalSettings }) => {
        if (cancelled) return
        const settings = data.settings ?? {}
        setWorkspaceHistory(buildWorkspaceHistory(settings.lastMainWorkspace, settings.workspaceHistory ?? []))
        if (loadMutationVersion === mainPageSessionKeysMutationRef.current) {
          setMainPageSessionKeys(new Set(normalizeMainPageSessionKeys(settings.mainPageSessionKeys ?? [])))
        }
        applyLaunchSettings(settings)
        loadAgentSessions()
      })
      .catch(() => {
        if (!cancelled) setWorkspaceHistory([])
      })

    return () => {
      cancelled = true
    }
  }, [activeView, applyLaunchSettings, loadAgentSessions])

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!resizingSidebarRef.current) return

      event.preventDefault()
      updateSidebarWidth(event.clientX)
    }

    function stopSidebarResize() {
      if (!resizingSidebarRef.current) return

      resizingSidebarRef.current = false
      document.body.classList.remove('code-resizing-sidebar')
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopSidebarResize)
    window.addEventListener('pointercancel', stopSidebarResize)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopSidebarResize)
      window.removeEventListener('pointercancel', stopSidebarResize)
      document.body.classList.remove('code-resizing-sidebar')
    }
  }, [updateSidebarWidth])

  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace || typeof ResizeObserver === 'undefined') return

    const syncSidebarForWorkspaceWidth = (width: number) => {
      if (isMobileNavigationViewport()) {
        autoCollapseSidebar()
        return
      }

      if (isDesktopAutoCollapseWidth(width)) {
        autoCollapseSidebar()
        return
      }

      if (sidebarAutoCollapsedRef.current) {
        expandSidebar()
      }
    }

    syncSidebarForWorkspaceWidth(workspace.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? workspace.getBoundingClientRect().width
      syncSidebarForWorkspaceWidth(width)
    })
    observer.observe(workspace)

    return () => observer.disconnect()
  }, [autoCollapseSidebar, expandSidebar])

  useEffect(() => {
    const restoreTarget = restoreProjectListFocusRef.current
    if (!restoreTarget) return
    if (activeView !== 'projects' || searchOpen) return

    restoreProjectListFocusRef.current = null
    let retryTimer: number | undefined
    let attempts = 0
    const maxAttempts = restoreTarget === 'active-force' ? 4 : 12
    const retryRestoreFocus = () => {
      if (attempts >= maxAttempts) return
      retryTimer = window.setTimeout(restoreFocus, 90)
    }
    const restoreFocus = () => {
      attempts += 1
      if (shouldSkipProjectFocusRestore()) {
        retryRestoreFocus()
        return
      }
      let focused = false
      if (restoreTarget === 'list') {
        projectListRef.current?.focus({ preventScroll: true })
        focused = document.activeElement === projectListRef.current
      } else {
        focused = focusActiveProjectListTargetNow()
      }
      if (!focused || restoreTarget === 'active-force') retryRestoreFocus()
    }
    const timer = window.setTimeout(() => {
      restoreFocus()
    }, restoreTarget === 'list' ? 0 : 50)
    return () => {
      window.clearTimeout(timer)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [activeTerminalId, activeView, focusActiveProjectListTargetNow, searchOpen, shouldSkipProjectFocusRestore])

  useEffect(() => {
    const archivedAgentId = pendingArchivedFocusAgentRef.current
    if (!archivedAgentId) return
    if (activeView !== 'projects' || searchOpen) return

    pendingArchivedFocusAgentRef.current = null
    let retryTimer: number | undefined
    let attempts = 0
    const retryRestoreFocus = () => {
      if (attempts >= 12) return
      retryTimer = window.setTimeout(restoreFocus, 90)
    }
    const restoreFocus = () => {
      attempts += 1
      if (shouldSkipProjectFocusRestore()) {
        retryRestoreFocus()
        return
      }
      focusActiveProjectListTarget({ skipIfFocusMoved: true })
      retryRestoreFocus()
    }
    const timer = window.setTimeout(() => {
      restoreFocus()
      retryTimer = window.setTimeout(restoreFocus, 180)
    }, 50)
    return () => {
      window.clearTimeout(timer)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [activeAgents.length, activeTerminalId, activeView, focusActiveProjectListTarget, searchOpen, shouldSkipProjectFocusRestore])

  useEffect(() => {
    const restoredAgentId = pendingRestoredFocusAgentRef.current
    if (!restoredAgentId) return
    if (activeView !== 'projects' || searchOpen) return
    if (!activeAgents.some(agent => agent.id === restoredAgentId)) return

    pendingRestoredFocusAgentRef.current = null
    let retryTimer: number | undefined
    let attempts = 0
    const restoreFocus = () => {
      attempts += 1
      if (!shouldSkipProjectFocusRestore()) {
        focusAgentRowNow(restoredAgentId)
      }
      if (attempts >= 60) return
      retryTimer = window.setTimeout(() => {
        window.requestAnimationFrame(restoreFocus)
      }, 80)
    }
    const timer = window.setTimeout(() => {
      window.requestAnimationFrame(restoreFocus)
    }, 50)
    return () => {
      window.clearTimeout(timer)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [activeAgents, activeView, focusAgentRowNow, searchOpen, shouldSkipProjectFocusRestore])

  useEffect(() => {
    if (!activeTerminalId) return
    onWorkspaceViewChange('projects')
  }, [activeTerminalId, onWorkspaceViewChange])

  useEffect(() => {
    if (activeProjectWorkspace) {
      setLastProjectWorkspace(activeProjectWorkspace)
    }
  }, [activeProjectWorkspace])

  useEffect(() => {
    setSearchSelectionIndex(0)
  }, [normalizedSearch, searchOpen])

  useEffect(() => {
    setSearchSelectionIndex(index => {
      if (visibleSearchTargets.length === 0) return 0
      return Math.min(index, visibleSearchTargets.length - 1)
    })
  }, [visibleSearchTargets.length])

  const workspaceStyle = {
    '--code-sidebar-width': `${sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarWidth}px`,
  } as CSSProperties

  return (
    <div
      className={`code-workspace ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
      data-testid="code-workspace"
      ref={workspaceRef}
      style={workspaceStyle}
    >
      <CodeSidebar
        sidebarCollapsed={sidebarCollapsed}
        activeView={activeView}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        displayedProjects={displayedProjects}
        collapsedProjectIds={collapsedProjectIds}
        normalizedSearch={normalizedSearch}
        hasProjectListItems={hasProjectListItems}
        hasDisplayedProjectListItems={hasDisplayedProjectListItems}
        activeTerminalId={activeTerminalId}
        selectedSearchAgentId={selectedSearchAgentId}
        selectedSearchSessionHandle={selectedSearchSessionHandle}
        claimedAgentSessionKeyByAgentId={agentListState.claimedAgentSessionKeyByAgentId}
        agentShortcutKeys={agentShortcutKeys}
        keyboardShortcutsEnabled={keyboardShortcutsEnabled}
        now={now}
        mainAgent={hiddenMainAgent}
        systemStats={systemStats}
        usageSummary={usageSummary}
        agentLaunchOptions={agentLaunchOptions}
        agentCreationWorkspace={agentCreationWorkspace}
        openWorkspaceFile={openWorkspaceFile}
        openWorkspaceFiles={openWorkspaceFiles}
        fileRevealRequest={fileRevealRequest}
        fileSearchFocusRequest={fileSearchFocusRequest}
        searchInputRef={searchInputRef}
        projectListRef={projectListRef}
        onNewAgent={startNewAgentFromSidebar}
        onStartAgent={onStartAgent}
        onToggleSidebar={toggleSidebar}
        onOpenSearch={openSearchFromSidebar}
        onOpenWorkspaceView={openWorkspaceViewFromSidebar}
        onOpenMainAgent={() => {
          if (!hiddenMainAgent) return
          setMainPaneMode('terminal')
          onWorkspaceViewChange('projects')
          onOpenTerminal(hiddenMainAgent.id)
        }}
        onRestartMainAgent={onRestartMainAgent}
        onSearchQueryChange={setSearchQuery}
        onSearchKeyDown={handleSearchInputKeyDown}
        onCloseSearch={closeSearchView}
        onProjectListKeyDown={handleProjectListKeyDown}
        onToggleProject={toggleProject}
        onToggleProjectSessions={toggleProjectSessions}
        onOpenProjectContextMenu={openProjectContextMenu}
        onOpenProjectKeyboardMenu={openProjectKeyboardMenu}
        onOpenAgent={openTerminalFromSidebar}
        onUpdateAgentFlags={updateSidebarAgentFlags}
        onOpenAgentContextMenu={openAgentContextMenu}
        onOpenAgentKeyboardMenu={openAgentKeyboardMenu}
        onResumeAgentSession={resumeAgentSession}
        onOpenAgentSessionContextMenu={openAgentSessionContextMenu}
        onOpenAgentSessionKeyboardMenu={openAgentSessionKeyboardMenu}
        onOpenProjectFile={openProjectFile}
        onSelectOpenWorkspaceFile={selectOpenWorkspaceFile}
        onCloseOpenWorkspaceFile={closeOpenWorkspaceFile}
        onMoveWorkspaceEntries={handleWorkspaceFileMove}
        onDeleteWorkspaceEntries={handleWorkspaceFileDelete}
        onOpenOptionsMenu={openOptionsMenu}
        copy={copy}
      />

      <div
        className="code-sidebar-resizer"
        data-testid="code-sidebar-resizer"
        onPointerDown={beginSidebarResize}
      />

      {!sidebarCollapsed && (
        <button
          type="button"
          className="code-mobile-sidebar-backdrop"
          data-testid="code-mobile-sidebar-backdrop"
          aria-label={copy.closeNavigation}
          onClick={autoCollapseSidebar}
        />
      )}

      <div className="code-mobile-topbar" data-testid="code-mobile-topbar">
        <button
          type="button"
          className="code-mobile-topbar-button menu"
          data-testid="code-mobile-menu"
          aria-label={copy.openNavigation}
          onClick={openMobileSidebar}
        >
          <span aria-hidden="true" />
        </button>
        <div className="code-mobile-topbar-title">
          <strong>{mobileHeaderTitle}</strong>
          {mobileHeaderSubtitle && (
            <span>
              <i aria-hidden="true" />
              {mobileHeaderSubtitle}
            </span>
          )}
        </div>
        <button
          type="button"
          className="code-mobile-topbar-button more"
          data-testid="code-mobile-more"
          aria-label={copy.openOptions}
          onClick={openOptionsMenu}
        >
          <span aria-hidden="true" />
        </button>
      </div>

      {optionsMenu && (
        <div
          className="code-context-menu code-options-menu"
          data-testid="code-options-menu"
          style={{ left: optionsMenu.x, top: optionsMenu.y }}
          role="menu"
          ref={contextMenuRef}
          onKeyDownCapture={handleContextMenuKeyDown}
          onKeyDown={handleContextMenuKeyDown}
        >
          <CodexMenuEntries entries={optionsMenuEntries} />
        </div>
      )}

      <CodeMainArea
        activeView={activeView}
        showFileEditor={showFileEditor}
        openWorkspaceFile={openWorkspaceFile}
        openWorkspaceFiles={openWorkspaceFiles}
        openAgentsCount={openAgents.length}
        visibleOpenAgents={visibleOpenAgents}
        activeTerminalId={activeTerminalId}
        terminalFocusRequest={terminalFocusRequest}
        agentCreationWorkspace={agentCreationWorkspace}
        displayedProjects={searchResultProjects}
        searchHasQuery={hasSearchQuery}
        visibleSearchTargetCount={visibleSearchTargets.length}
        selectedSearchAgentId={selectedSearchAgentId}
        selectedSearchSessionHandle={selectedSearchSessionHandle}
        archivedRuns={visibleArchivedRuns}
        archivedAgents={visibleArchivedAgents}
        historyAgentSessions={visibleHistoryAgentSessions}
        now={now}
        composerProps={{
          active: Boolean(activeAgent),
          capabilities: activeAgentCapabilities.composer,
          slashCommands: composerSlashCommands,
          draft,
          attachments: composerAttachments,
          composerMode,
          plusMenuOpen,
          approvalMenuOpen,
          modelMenuOpen,
          modelPickerPane,
          agentModelPreset: activeAgentModelPreset,
          agentModel: activeAgentModel,
          agentReasoningEffort: activeAgentReasoningEffort,
          agentServiceTier: activeAgentServiceTier,
          agentModelOptions: activeAgentModelOptions,
          currentPermissionMode,
          currentPermissionLabel,
          currentPermissionColor,
          currentModelLabel,
          currentReasoningLabel,
          currentSpeedLabel,
          currentReasoningOptions,
          currentServiceTierOptions,
          permissionModeOptions,
          contextWindow: activeAgentContextWindow,
          pendingFollowUp: activePendingFollowUp
            ? {
              messages: activePendingFollowUp.messages,
              createdAt: activePendingFollowUp.createdAt,
            }
            : null,
          submitAction: composerSubmitAction,
          speechSupported,
          speechListening,
          textareaRef: composerTextareaRef,
          attachmentInputRef,
          plusMenuRef,
          approvalMenuRef,
          modelMenuRef,
          onDraftChange: handleDraftChange,
          onNavigateHistory: navigateActiveComposerHistory,
          onRemoveAttachment: removeComposerAttachment,
          onSubmit: submitDraft,
          onInterrupt: interruptActiveAgent,
          onSteerPendingFollowUp: steerPendingFollowUp,
          onDiscardPendingFollowUp: discardPendingFollowUp,
          onPasteAttachment: handlePasteAttachment,
          onAttachmentFiles: handleAttachmentFiles,
          onChooseAttachmentFile: chooseAttachmentFile,
          onActivateComposerMode: activateComposerMode,
          onClearComposerMode: () => {
            updateActiveComposerState(state => ({ ...state, mode: 'default' }))
            focusComposerTextarea()
          },
          onTogglePlusMenu: () => {
            updateActiveComposerState(state => ({
              ...state,
              ui: {
                plusMenuOpen: !state.ui.plusMenuOpen,
                approvalMenuOpen: false,
                modelMenuOpen: false,
                modelPickerPane: null,
              },
            }))
          },
          onToggleApprovalMenu: () => {
            updateActiveComposerState(state => ({
              ...state,
              ui: {
                plusMenuOpen: false,
                approvalMenuOpen: !state.ui.approvalMenuOpen,
                modelMenuOpen: false,
                modelPickerPane: null,
              },
            }))
          },
          onToggleModelMenu: () => {
            updateActiveComposerState(state => ({
              ...state,
              ui: {
                plusMenuOpen: false,
                approvalMenuOpen: false,
                modelMenuOpen: !state.ui.modelMenuOpen,
                modelPickerPane: null,
              },
            }))
          },
          onSetModelPickerPane: pane => {
            updateActiveComposerState(state => ({
              ...state,
              ui: { ...state.ui, modelPickerPane: pane },
            }))
          },
          onComposerMenuKeyDown: handleComposerMenuKeyDown,
          onComposerMenuBlur: closeComposerMenuOnBlur,
          onUpdatePermissionMode: updatePermissionMode,
          onUpdateModel: updateAgentModel,
          onUpdateReasoningEffort: updateAgentReasoningEffort,
          onUpdateServiceTier: updateAgentServiceTier,
          onToggleSpeechInput: toggleSpeechInput,
        }}
        onNewAgent={onNewAgent}
        onOpenTerminal={onOpenTerminal}
        onOpenTerminalPath={openTerminalPathTarget}
        onResolveTerminalPath={resolveTerminalPathTarget}
        onTerminalFollowOutputChange={handleTerminalFollowOutputChange}
        sendInput={sendInput}
        resizeAgent={resizeAgent}
        onSessionOutput={onSessionOutput}
        onOpenSearchAgent={openTerminalFromWorkspace}
        onOpenSearchSession={session => {
          resumeAgentSession(session.provider, session.id)
          clearSearch()
          onWorkspaceViewChange('projects')
        }}
        onResumeHistorySession={resumeAgentSession}
        onContinueArchivedRun={continueArchivedRun}
        onOpenArchivedAgent={openArchivedAgent}
        onRestoreArchivedAgent={restoreArchivedAgent}
        onChangeWorkspaceFileDraft={updateOpenWorkspaceFileDraft}
        onUpdateOpenWorkspaceFile={updateOpenWorkspaceFile}
        onSelectOpenWorkspaceFile={selectOpenWorkspaceFile}
        onCloseOpenWorkspaceFile={closeOpenWorkspaceFile}
        onCloseOpenWorkspaceFiles={closeOpenWorkspaceFiles}
        onRevealWorkspaceFileInExplorer={revealWorkspaceFileInExplorer}
        onFocusWorkspaceFilesSearch={focusWorkspaceFilesSearch}
        onRecordWorkspaceNavigationCursor={recordWorkspaceNavigationFileCursor}
        onBackToAgentFromFile={backToAgentFromFile}
        copy={copy}
      />
      <CodeOverlays
        contextMenuAgent={contextMenuAgent}
        contextMenuAgentSession={contextMenuAgentSession}
        contextMenuProject={contextMenuProject}
        agentMenu={agentMenu}
        projectMenu={projectMenu}
        agentSessionMenu={agentSessionMenu}
        renameDialog={renameDialog}
        killDialog={killDialog}
        deleteWorktreeDialog={deleteWorktreeDialog}
        copyNotice={copyNotice}
        agentLaunchOptions={agentLaunchOptions}
        contextMenuRef={contextMenuRef}
        renameDialogRef={renameDialogRef}
        renameInputRef={renameInputRef}
        killDialogRef={killDialogRef}
        killCancelButtonRef={killCancelButtonRef}
        deleteWorktreeDialogRef={deleteWorktreeDialogRef}
        deleteWorktreeCancelButtonRef={deleteWorktreeCancelButtonRef}
        onContextMenuKeyDown={handleContextMenuKeyDown}
        onUpdateAgentFlags={updateContextMenuAgentFlags}
        onRenameAgent={renameContextMenuAgent}
        onCopyAgentWorkingDirectory={() => {
          if (!contextMenuAgent) return
          copyContextMenuValue(projectWorkspaceForAgent(contextMenuAgent), { kind: 'agent', id: contextMenuAgent.id })
        }}
        onForkAgent={forkContextMenuAgent}
        onKillAgent={killContextMenuAgent}
        onOpenSession={(provider, sessionId) => {
          setAgentSessionMenu(null)
          setOptionsMenu(null)
          resumeAgentSession(provider, sessionId)
          focusAgentSessionRow(provider, sessionId)
        }}
        onToggleSessionPinned={toggleContextMenuAgentSessionPinned}
        onArchiveSession={archiveContextMenuAgentSession}
        onCopySessionWorkingDirectory={() => {
          if (!contextMenuAgentSession) return
          copyContextMenuValue(agentSessionWorkingDirectory(contextMenuAgentSession), {
            kind: 'agent-session',
            provider: contextMenuAgentSession.provider,
            id: contextMenuAgentSession.id,
          })
        }}
        onStartAgentInProject={startAgentInContextProject}
        onArchiveProject={archiveContextProject}
        onDeleteWorktreeProject={deleteContextProjectWorktree}
        onCloseRenameDialog={closeRenameDialog}
        onRenameDialogTitleChange={title => setRenameDialog(current => current
          ? { ...current, title }
          : current)}
        onSubmitRenameDialog={submitRenameDialog}
        onCloseKillDialog={closeKillDialog}
        onSubmitKillDialog={submitKillDialog}
        onCloseDeleteWorktreeDialog={closeDeleteWorktreeDialog}
        onSubmitDeleteWorktreeDialog={submitDeleteWorktreeDialog}
        copy={copy}
      />
    </div>
  )
}

function CodexMenuEntries({ entries }: { entries: ContextMenuEntry[] }) {
  return (
    <>
      {entries.map(entry => {
        if (entry.type === 'separator') {
          return <div key={entry.id} className="code-context-menu-separator" role="separator" />
        }

        return (
          <button
            key={entry.id}
            type="button"
            role={typeof entry.checked === 'boolean' ? 'menuitemradio' : 'menuitem'}
            aria-checked={typeof entry.checked === 'boolean' ? entry.checked : undefined}
            aria-label={entry.ariaLabel}
            className={[
              entry.danger ? 'danger' : '',
              typeof entry.checked === 'boolean' ? 'selectable' : '',
              entry.checked ? 'checked' : '',
            ].filter(Boolean).join(' ') || undefined}
            disabled={entry.disabled}
            onClick={entry.onSelect}
          >
            {typeof entry.checked === 'boolean' && (
              <span className="code-options-menu-check" aria-hidden="true">{entry.checked ? '✓' : ''}</span>
            )}
            <span>{entry.label}</span>
          </button>
        )
      })}
    </>
  )
}
