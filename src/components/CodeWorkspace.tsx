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
import type {
  Agent,
  AgentContextWindowUsage,
  CodexTerminalProfile,
  SystemStats,
  TaskHistoryEntry,
  UsageSummary,
} from '@/types/agent'
import { CheckGlyph } from '@/components/IconGlyphs'
import { appPath } from '@/lib/base-path'
import { agentTitle } from '@/lib/format'
import {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  GLOBAL_WORKSPACE_FILES_ROOT,
  isGlobalWorkspaceFilesAgentId,
  normalizeGlobalWorkspaceFilePath,
} from '@/lib/global-workspace-files'
import {
  normalizeProjectWorkspaces,
  projectFilesWorkspaceId,
  projectWorkspaceFromFilesId,
} from '@/lib/project-workspaces'
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
import {
  clearWorkspaceShareTargetSearch,
  resolveWorkspaceSharePath,
  workspaceShareAbsolutePath,
  workspaceShareProjectLabel,
  workspaceFileOpenTargetFromShareTarget,
  workspaceFolderPreviewFilePath,
  workspaceShareTargetFromSearch,
  type WorkspaceShareTarget,
} from '@/lib/workspace-share-target'
import { isIOSLikeTouchViewport, isMobileTouchViewport } from '@/lib/responsive-mode'
import { buildWorkspaceHistory } from '@/lib/workspace-options'
import {
  fetchWorkspaceFile,
  fetchWorkspaceTree,
  searchWorkspaceFiles,
  type WorkspaceFileDeleteResult,
  type WorkspaceFileMove,
  type WorkspaceFileSearchMatch,
} from '@/lib/workspace-files'
import {
  sendTerminalSessionInput,
  type TerminalPathOpenTarget,
} from '@/lib/terminal-session-pool'
import { isOverlayShortcutTarget, isTerminalShortcutTarget, isTextEditingShortcutTarget } from '@/hooks/useKeyboard'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { CodeMainArea } from './code/CodeMainArea'
import { respondToAcpElicitation, respondToAcpPermission, submitAcpDraft as submitAcpComposerDraft } from './code/acp/acp-composer-behavior'
import { acpComposerStateAliasKeysForAgent, acpComposerStateKeyForAgent } from './code/acp/acp-composer-state'
import { MobileShareSheet } from './code/MobileShareSheet'
import { CodeOverlays } from './code/CodeOverlays'
import { CodeSidebar } from './code/CodeSidebar'
import { AgentHomesSettingsPanel } from './code/AgentHomesSettingsPanel'
import {
  capabilitiesForAgent,
  agentKindForCommand,
  inferAgentTerminalState,
  isAgentTurnActive,
  isCodexAgentWorking,
  mergeSlashCommands,
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
  type ComposerPromptAttachment,
} from './code/composer-message'
import { terminalInputPartsForComposerMessage } from './code/composer-submit'
import {
  addComposerHistoryEntry,
  canUseComposerHistoryNavigation,
  navigateComposerHistory,
  type ComposerHistoryDirection,
  type ComposerHistoryNavigationInput,
} from './code/composer-history'
import {
  closeComposerMenusForState,
  composerStateAliasKeysForAgent,
  composerStateKeyForAgent,
  createPendingFollowUpMessage,
  DEFAULT_AGENT_COMPOSER_STATE,
  removePendingFollowUpMessage,
  type AgentComposerPendingFollowUpMessage,
  type AgentComposerState,
} from './code/composer-state'
import { codeCopyForLanguage } from './code/copy'
import { scheduleFocusRetries } from './code/focus-retry'
import {
  DEFAULT_CLAUDE_SETTINGS,
  buildComposerControlState,
  effectiveClaudePermissionModeForSession,
  effectiveCodexApprovalModeForSession,
  isClaudePermissionMode,
  isCodexApprovalMode,
  normalizeClaudeEffort,
  normalizeClaudeModel,
  normalizeClaudeSettingsSummary,
  normalizeLaunchProfiles,
  resolveCodexComposerProfile,
  type ClaudeSettingsSummary,
} from './code/composer-profile'
import type {
  AgentSessionHistoryItem,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexModelOption,
  ComposerMode,
  CodexModelPreset,
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
  historyAgentSessionsForSessions,
  isAgentListLiveAgent,
  unclaimedAgentSessions,
} from './code/agent-list-state'
import {
  displayedProjectsForSearch,
  projectListProjectsForAgents,
  projectWorkspaceForHistoryRun,
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
  mobileActionMenuPoint,
  outwardContextMenuPoint,
} from './code/menu-position'
import { useWorkspaceOpenFiles } from './code/useWorkspaceOpenFiles'
import { useWorkspaceNavigationHistory } from './code/useWorkspaceNavigationHistory'
import {
  loadCodeWorkspaceViewState,
  saveCodeWorkspaceViewState,
  type CodeWorkspaceSurface,
} from './code/workspace-view-state'
import { useAgentComposerState } from './code/useAgentComposerState'
import {
  terminalTargetFilePath,
} from './code/workspace-file-view'
import {
  applySessionDisplayOverrides,
  limitProjectAgentSessions,
  loadSessionDisplayState,
  normalizeMainPageSessionKeys,
  resumedAgentSessionFromSource,
  resumedAgentSessionIdFromSource,
  resumedAgentSource,
  saveSessionDisplayState,
} from './code/session-display'
import {
  normalizeAgentLaunchOptions,
  type AgentLaunchOption,
} from './code/agent-launch-options'

export type { WorkspaceView } from './code/types'

type RenameDialogState =
  | { kind: 'agent'; agentId: string; title: string }
  | { kind: 'project'; projectId: string; workspace: string; title: string }

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

function normalizeProjectNames(projectNames: unknown): Record<string, string> {
  if (!projectNames || typeof projectNames !== 'object' || Array.isArray(projectNames)) return {}
  const normalized: Record<string, string> = {}
  Object.entries(projectNames as Record<string, unknown>).forEach(([workspace, name]) => {
    const key = workspace.trim()
    const value = String(name ?? '').trim()
    if (!key || !value) return
    normalized[key] = value.slice(0, 80)
  })
  return normalized
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

function isReopenClosedEditorShortcut(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey)
    && event.shiftKey
    && !event.altKey
    && event.key.toLowerCase() === 't'
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
  restarted?: boolean
  restartedAgentId?: string
  launchPermissionMode?: string
  agentRuntimeMode?: string
  switchFailed?: boolean
  warning?: string
  error?: string
}

interface TerminalReadCut {
  runtimeEpoch: string
  outputSeq: number
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
  permissionSwitchingAgentId: string | null
  agentSwitchingKind: 'permission' | 'runtime' | null
  permissionSwitchReplacement: { originalAgentId: string; replacementAgentId: string } | null
  openTerminalIds: string[]
  terminalFocusRequest: { agentId: string; nonce: number } | null
  keyMap: Map<string, string>
  keyboardShortcutsEnabled: boolean
  uiPreferences: UiPreferences
  onOpenTerminal: (agentId: string, options?: { focusTerminal?: boolean }) => void
  onOpenTerminalWhenReady: (agentId: string, options?: { focusTerminal?: boolean }) => void
  onNewAgent: (workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null, customTitle?: string) => void
  onStartAgent: (command: string, workspace: string, options?: { projectWorkspace?: string; codexApprovalMode?: string; codexRuntimeMode?: 'cli' | 'app-server'; agentRuntimeMode?: 'terminal' | 'acp' | 'json'; dangerouslySkipPermissions?: boolean; providerHomeId?: string }) => void
  onRenameAgent: (agentId: string, title: string) => void
  onUpdateAgentFlags: (
    agentId: string,
    flags: Partial<Pick<Agent, 'pinned' | 'unread' | 'archived' | 'launchPermissionMode' | 'readAttentionSeq'>>
      & { agentRuntimeMode?: 'terminal' | 'acp' | 'json'; readOutputEpoch?: string; readOutputSeq?: number },
  ) => AgentFlagUpdateResponse | Promise<AgentFlagUpdateResponse>
  onOpenArchivedAgent: (agentId: string) => void
  onForkAgent: (agentId: string, mode: 'same-worktree' | 'new-worktree') => void
  onDeleteForkWorktreeProject: (workspace: string, options?: { force?: boolean }) => Promise<DeleteForkWorktreeProjectResult>
  onRestartMainAgent: (command: 'codex' | 'claude' | 'opencode' | 'qoder' | 'bash' | 'zsh') => void
  onWorkspaceViewChange: (view: WorkspaceView) => void
  onKill: (agentId: string) => void
  onInterruptAgent: (agentId: string) => void
  sendComposerInput: (message: string, agentId?: string, attachments?: ComposerPromptAttachment[]) => boolean
  respondToAppServerRequest: (agentId: string, requestId: string, result?: unknown, options?: { reject?: boolean; reason?: string }) => boolean
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null, runtimeEpoch?: string, stateRevision?: number | null, cols?: number, rows?: number, kind?: 'output' | 'resize' | 'clear') => void) => () => void
  onUpdateUiPreferences: (patch: Partial<UiPreferences>) => void
}

interface TerminalFollowState {
  following: boolean
  hasUnreadOutput: boolean
}

const DEFAULT_SIDEBAR_WIDTH = 296
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 840
const MIN_MAIN_PANE_WIDTH = 360
const CODEX_MODEL_CATALOG_TTL_MS = 5 * 60_000
const COLLAPSED_SIDEBAR_WIDTH = 52
const SIDEBAR_DRAG_COLLAPSE_WIDTH = 172
const DESKTOP_AUTO_COLLAPSE_WIDTH = 900
const TERMINAL_PATH_SEARCH_LIMIT = 12
const MOBILE_PROJECT_CONTEXT_MENU_WIDTH = 214
const MOBILE_PROJECT_CONTEXT_MENU_HEIGHT = 122
const AGENT_SESSION_PAGE_SIZE = 60
const AGENT_SESSION_SEARCH_LIMIT = 1000
const AGENT_SESSION_SEARCH_DEBOUNCE_MS = 150
const CODEX_TERMINAL_PROFILE_REQUEST_TIMEOUT_MS = 35_000


function shouldUseNativeMobileDictation() {
  if (typeof window === 'undefined') return false
  return isMobileTouchViewport() && isIOSLikeTouchViewport()
}

function isPlainTextComposerAgentCommand(command?: string) {
  const executable = (command || '')
    .trim()
    .split(/\s+/)
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
  const basename = executable?.split('/').pop() || ''
  return basename === 'qoder' || basename === 'qodercli' || basename === 'opencode'
}

function isCodexTerminalAgent(agent: Agent | null | undefined) {
  return Boolean(
    agent
    && agentKindForCommand(agent.command) === 'codex'
    && !['acp', 'json'].includes(agent.agentRuntimeMode || '')
    && agent.codexRuntimeMode !== 'app-server'
  )
}

function isNativeTextEditingShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.isContentEditable
}

function resumedSessionFromHistoryRunSource(source?: string) {
  return resumedAgentSessionFromSource(source)
}

function searchTargetHandle(target: SearchTarget) {
  return target.kind === 'agent-session' ? agentSessionId(target) : workspaceTargetId(target)
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
  textarea.setAttribute('autocomplete', 'off')
  textarea.setAttribute('autocorrect', 'off')
  textarea.setAttribute('autocapitalize', 'none')
  textarea.setAttribute('spellcheck', 'false')
  textarea.setAttribute('data-lpignore', 'true')
  textarea.setAttribute('data-1p-ignore', 'true')
  textarea.setAttribute('data-bwignore', 'true')
  textarea.setAttribute('data-form-type', 'other')
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
  permissionSwitchingAgentId,
  agentSwitchingKind,
  permissionSwitchReplacement,
  openTerminalIds,
  terminalFocusRequest,
  keyMap,
  keyboardShortcutsEnabled,
  uiPreferences,
  onOpenTerminal,
  onOpenTerminalWhenReady,
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
  sendComposerInput,
  respondToAppServerRequest,
  onSessionOutput,
  onUpdateUiPreferences,
}: CodeWorkspaceProps) {
  const pageVisible = usePageVisibility()
  const {
    composerByAgentKey,
    updateComposerStateForKey,
    updateExistingComposerStateForKey,
  } = useAgentComposerState({
    agents,
    permissionSwitchReplacement,
    onDiscardAttachment: revokeComposerAttachmentPreview,
  })
  const pendingFollowUpAutoFlushRef = useRef<Record<string, string>>({})
  const [, setTerminalFollowStates] = useState<Record<string, TerminalFollowState>>({})
  const [mainPaneMode, setMainPaneMode] = useState<MainPaneMode>('terminal')
  const [initialWorkspaceSurface] = useState<CodeWorkspaceSurface | undefined>(() => (
    loadCodeWorkspaceViewState().surface
  ))
  const workspaceSurfaceRestoreStartedRef = useRef(false)
  const workspaceSurfaceRestoredRef = useRef(!initialWorkspaceSurface)
  const workspaceOpenFiles = useWorkspaceOpenFiles()
  const {
    canGoBack: canNavigateWorkspaceBack,
    canGoForward: canNavigateWorkspaceForward,
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
  const [projectWorkspaces, setProjectWorkspaces] = useState<string[]>([])
  const [projectWorkspacesLoaded, setProjectWorkspacesLoaded] = useState(false)
  const projectWorkspacesRef = useRef<string[]>([])
  const projectWorkspacesMutationRef = useRef(0)
  const projectWorkspacesSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const [projectNames, setProjectNames] = useState<Record<string, string>>({})
  const [agentLaunchOptions, setAgentLaunchOptions] = useState<AgentLaunchOption[]>([])
  const [mainPageSessionKeys, setMainPageSessionKeys] = useState<Set<string>>(() => new Set())
  const [codexApprovalMode, setCodexApprovalMode] = useState<CodexApprovalMode>('approve')
  const [, setCodexModelPreset] = useState<CodexModelPreset>('gpt-5.5:xhigh')
  const [codexModel, setCodexModel] = useState('gpt-5.5')
  const [codexReasoningEffort, setCodexReasoningEffort] = useState('xhigh')
  const [codexServiceTier, setCodexServiceTier] = useState('default')
  const [codexModelOptions, setCodexModelOptions] = useState<CodexModelOption[]>([])
  const [codexTerminalProfileApplyingAgentIds, setCodexTerminalProfileApplyingAgentIds] = useState<Set<string>>(() => new Set())
  const [pendingCodexTerminalProfiles, setPendingCodexTerminalProfiles] = useState<Map<string, CodexTerminalProfile>>(() => new Map())
  const codexTerminalProfileRequestAgentIdsRef = useRef(new Set<string>())
  const [claudePermissionMode, setClaudePermissionMode] = useState<ClaudePermissionMode>('default')
  const [claudeModel, setClaudeModel] = useState('config')
  const [claudeEffort, setClaudeEffort] = useState('config')
  const [claudeSettings, setClaudeSettings] = useState<ClaudeSettingsSummary>(DEFAULT_CLAUDE_SETTINGS)
  const [discoveredSlashCommands, setDiscoveredSlashCommands] = useState<SlashCommandOption[]>([])
  const [agentSessions, setAgentSessions] = useState<AgentSessionHistoryItem[]>([])
  const [agentSessionNextCursor, setAgentSessionNextCursor] = useState('')
  const [agentSessionsHasMore, setAgentSessionsHasMore] = useState(false)
  const [searchedAgentSessions, setSearchedAgentSessions] = useState<AgentSessionHistoryItem[]>([])
  const [agentSessionSearchLoading, setAgentSessionSearchLoading] = useState(false)
  const agentSessionsLoadingRef = useRef(false)
  const agentSessionsRefreshInFlightRef = useRef<Promise<void> | null>(null)
  const agentSessionLoadedCountRef = useRef(AGENT_SESSION_PAGE_SIZE)
  const [agentSessionPinnedOverrides, setAgentSessionPinnedOverrides] = useState<Record<string, boolean>>(
    () => loadSessionDisplayState().pinnedOverrides
  )
  const [speechSupported, setSpeechSupported] = useState(false)
  const [speechListening, setSpeechListening] = useState(false)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())
  const [expandedSessionProjectIds, setExpandedSessionProjectIds] = useState<Set<string>>(() => new Set())
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => shouldCollapseSidebarInitially())
  const [pendingShareTarget, setPendingShareTarget] = useState<WorkspaceShareTarget | null>(() => (
    typeof window === 'undefined' ? null : workspaceShareTargetFromSearch(window.location.search)
  ))
  const [shareTargetRestoreTick, setShareTargetRestoreTick] = useState(0)
  const [lastProjectWorkspace, setLastProjectWorkspace] = useState<string | undefined>(undefined)
  const [agentMenu, setAgentMenu] = useState<{ agentId: string; x: number; y: number } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; x: number; y: number } | null>(null)
  const [agentSessionMenu, setAgentSessionMenu] = useState<{ provider: string; sessionId: string; x: number; y: number } | null>(null)
  const [optionsMenu, setOptionsMenu] = useState<{ x: number; y: number; returnFocusTarget: HTMLElement | null } | null>(null)
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false)
  const [mobileShareUrl, setMobileShareUrl] = useState('')
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(null)
  const [killDialog, setKillDialog] = useState<{ agentId: string; title: string } | null>(null)
  const [deleteWorktreeDialog, setDeleteWorktreeDialog] = useState<{ projectId: string; workspace: string; dirtyEntries: string[]; sessionHandles: string[] } | null>(null)
  const [copyNotice, setCopyNotice] = useState<{ id: number; kind: 'success' | 'error'; message: string } | null>(null)
  const [fileRevealRequest, setFileRevealRequest] = useState<{ agentId: string; path: string; kind: 'directory' | 'file'; requestId: number } | null>(null)
  const [fileSearchFocusRequest, setFileSearchFocusRequest] = useState<{ agentId: string; requestId: number; query?: string } | null>(null)
  const renameDialogIdentity = renameDialog
    ? renameDialog.kind === 'agent'
      ? `agent:${renameDialog.agentId}`
      : `project:${renameDialog.projectId}`
    : ''
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
  const codexModelsLoadedAtRef = useRef(0)
  const codexModelsLoadingRef = useRef(false)
  const resumeAgentSessionRef = useRef<(provider: string, sessionId: string, providerHomeId?: string) => void>(() => {})
  const activeTerminalIdRef = useRef<string | null>(activeTerminalId)
  const workspaceFileCursorRequestRef = useRef(0)
  const workspaceFileDiffRequestRef = useRef(0)
  const workspaceFileRevealRequestRef = useRef(0)
  const workspaceFileSearchFocusRequestRef = useRef(0)
  const terminalPathOpenRequestRef = useRef(0)
  const shareTargetRestoreAttemptsRef = useRef(0)
  const restoreProjectListFocusRef = useRef<'active' | 'active-force' | 'list' | null>(null)
  const pendingArchivedFocusAgentRef = useRef<string | null>(null)
  const pendingRestoredFocusAgentRef = useRef<string | null>(null)
  const mainPageSessionKeysMutationRef = useRef(0)
  const trackedMainPageAgentKeysRef = useRef<Set<string>>(new Set())
  const resizingSidebarRef = useRef(false)
  const sidebarAutoCollapsedRef = useRef(sidebarCollapsed)
  const mobileNavigationViewportRef = useRef(isMobileNavigationViewport())

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
  const activeAgents = unorderedLiveAgents
  const workspaceNavigationAgentIds = useMemo(() => {
    const ids = new Set(activeAgents.map(agent => agent.id))
    if (hiddenMainAgent) ids.add(hiddenMainAgent.id)
    return ids
  }, [activeAgents, hiddenMainAgent])
  const workspaceNavigationFileIds = useMemo(() => {
    const ids = new Set<string>([GLOBAL_WORKSPACE_FILES_AGENT_ID])
    projectWorkspaces.forEach(workspace => ids.add(projectFilesWorkspaceId(workspace)))
    activeAgents.forEach(agent => ids.add(projectFilesWorkspaceId(projectWorkspaceForAgent(agent))))
    workspaceNavigationAgentIds.forEach(agentId => ids.add(agentId))
    return ids
  }, [activeAgents, projectWorkspaces, workspaceNavigationAgentIds])

  useEffect(() => {
    pruneWorkspaceNavigationEntries(entry => (
      entry.kind === 'agent'
        ? workspaceNavigationAgentIds.has(entry.agentId)
        : workspaceNavigationFileIds.has(entry.agentId)
    ))
  }, [pruneWorkspaceNavigationEntries, workspaceNavigationAgentIds, workspaceNavigationFileIds])

  const resolveWorkspaceFileIdentity = useCallback((candidateId: string, requestedSourceAgentId?: string) => {
    const sourceCandidates = hiddenMainAgent ? [...activeAgents, hiddenMainAgent] : activeAgents
    if (isGlobalWorkspaceFilesAgentId(candidateId)) {
      const sourceAgent = sourceCandidates.find(agent => agent.id === requestedSourceAgentId)
      return {
        filesId: GLOBAL_WORKSPACE_FILES_AGENT_ID,
        workspaceRoot: GLOBAL_WORKSPACE_FILES_ROOT,
        sourceAgentId: sourceAgent?.id,
        sourceAgent,
      }
    }

    const projectWorkspace = projectWorkspaceFromFilesId(candidateId)
    if (projectWorkspace) {
      const sourceAgent = activeAgents.find(agent => (
        agent.id === requestedSourceAgentId
        && projectFilesWorkspaceId(projectWorkspaceForAgent(agent)) === projectFilesWorkspaceId(projectWorkspace)
      ))
      return {
        filesId: projectFilesWorkspaceId(projectWorkspace),
        workspaceRoot: projectWorkspace,
        sourceAgentId: sourceAgent?.id,
        sourceAgent,
      }
    }

    const candidateAgent = sourceCandidates.find(agent => agent.id === candidateId)
    if (candidateAgent && !candidateAgent.isMain) {
      const workspaceRoot = projectWorkspaceForAgent(candidateAgent)
      const requestedSourceAgent = activeAgents.find(agent => (
        agent.id === requestedSourceAgentId
        && projectFilesWorkspaceId(projectWorkspaceForAgent(agent)) === projectFilesWorkspaceId(workspaceRoot)
      ))
      const sourceAgent = requestedSourceAgent ?? candidateAgent
      return {
        filesId: projectFilesWorkspaceId(workspaceRoot),
        workspaceRoot,
        sourceAgentId: sourceAgent.id,
        sourceAgent,
      }
    }

    return {
      filesId: candidateId,
      workspaceRoot: candidateAgent ? projectWorkspaceForAgent(candidateAgent) : undefined,
      sourceAgentId: candidateAgent?.id,
      sourceAgent: candidateAgent,
    }
  }, [activeAgents, hiddenMainAgent])

  useEffect(() => {
    if (!openWorkspaceFile?.sourceAgentId) return
    const identity = resolveWorkspaceFileIdentity(openWorkspaceFile.agentId, openWorkspaceFile.sourceAgentId)
    if (identity.sourceAgentId) return
    workspaceOpenFiles.update({ ...openWorkspaceFile, sourceAgentId: undefined })
  }, [openWorkspaceFile, resolveWorkspaceFileIdentity, workspaceOpenFiles])

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
  const searchedAgentSessionIds = useMemo(
    () => new Set(searchedAgentSessions.map(agentSessionId)),
    [searchedAgentSessions]
  )
  const searchedAgentIds = useMemo(() => new Set(
    Array.from(agentListState.claimedAgentSessionKeyByAgentId.entries())
      .filter(([, sessionId]) => searchedAgentSessionIds.has(sessionId))
      .map(([agentId]) => agentId)
  ), [agentListState.claimedAgentSessionKeyByAgentId, searchedAgentSessionIds])
  const searchableAgentSessions = useMemo(() => {
    const sessionsById = new Map(unclaimedSearchableAgentSessions.map(session => [agentSessionId(session), session]))
    searchedAgentSessions.forEach(session => sessionsById.set(agentSessionId(session), session))
    return unclaimedAgentSessions(Array.from(sessionsById.values()), agentListState.claimedAgentSessionKeys)
  }, [agentListState.claimedAgentSessionKeys, searchedAgentSessions, unclaimedSearchableAgentSessions])
  const projectListProjects = useMemo(
    () => projectListProjectsForAgents(
      visibleLiveAgents,
      sidebarAgentSessions,
      projectNames,
      openWorkspaceFiles,
      visibleAgents,
      projectWorkspaces,
    ),
    [openWorkspaceFiles, projectNames, projectWorkspaces, sidebarAgentSessions, visibleAgents, visibleLiveAgents]
  )
  const projects = useMemo(() => limitProjectAgentSessions(
    projectListProjects,
    expandedSessionProjectIds,
    false
  ), [expandedSessionProjectIds, projectListProjects])
  const searchableProjects = useMemo(
    () => projectListProjectsForAgents(
      visibleLiveAgents,
      searchableAgentSessions,
      projectNames,
      openWorkspaceFiles,
      visibleAgents,
      projectWorkspaces,
    ),
    [openWorkspaceFiles, projectNames, projectWorkspaces, searchableAgentSessions, visibleAgents, visibleLiveAgents]
  )
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const hasSearchQuery = normalizedSearch.length > 0
  const displayedProjects = useMemo(() => {
    const sourceProjects = (activeView === 'search' || searchOpen) && hasSearchQuery ? searchableProjects : projects
    return displayedProjectsForSearch(
      sourceProjects,
      normalizedSearch,
      expandedSessionProjectIds,
      searchedAgentSessionIds,
      searchedAgentIds
    )
  }, [activeView, expandedSessionProjectIds, hasSearchQuery, normalizedSearch, projects, searchableProjects, searchedAgentIds, searchedAgentSessionIds, searchOpen])
  const hasProjectListItems = projects.some(project => (
    Boolean(project.workspace)
  ))
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
  const activeAgentPermissionSwitching = Boolean(
    activeAgent && activeAgent.id === permissionSwitchingAgentId
  )
  const activeCodexTerminalProfileApplying = Boolean(
    activeAgent && codexTerminalProfileApplyingAgentIds.has(activeAgent.id)
  )
  const activeAgentContextWindow = activeAgent ? contextWindowByAgentId[activeAgent.id] ?? null : null
  const activeComposerKey = activeAgent?.agentRuntimeMode === 'acp'
    ? acpComposerStateKeyForAgent(activeAgent)
    : activeAgent
      ? composerStateKeyForAgent(activeAgent)
      : ''
  const activeAgentCapabilities = useMemo(
    () => capabilitiesForAgent(activeAgent),
    [activeAgent]
  )
  const activeComposerState = activeComposerKey
    ? composerByAgentKey[activeComposerKey]
      ?? (activeAgent
        ? (activeAgent.agentRuntimeMode === 'acp'
          ? acpComposerStateAliasKeysForAgent(activeAgent)
          : composerStateAliasKeysForAgent(activeAgent))
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
  const displayedCodexApprovalMode = useMemo(() => effectiveCodexApprovalModeForSession(
    Boolean(activeAgent && composerAgentKind === 'codex'),
    activeAgent?.launchPermissionMode,
    codexApprovalMode,
  ), [activeAgent, codexApprovalMode, composerAgentKind])
  const displayedClaudePermissionMode = useMemo(() => effectiveClaudePermissionModeForSession(
    Boolean(activeAgent && composerAgentKind === 'claude'),
    activeAgent?.launchPermissionMode,
    claudePermissionMode,
  ), [activeAgent, claudePermissionMode, composerAgentKind])
  const pendingCodexTerminalProfile = activeAgent
    ? pendingCodexTerminalProfiles.get(activeAgent.id) || null
    : null
  const displayedCodexProfile = useMemo(() => resolveCodexComposerProfile(
    pendingCodexTerminalProfile || activeAgent?.codexTerminalProfile,
    {
      model: codexModel,
      reasoningEffort: codexReasoningEffort,
      serviceTier: codexServiceTier,
    },
  ), [
    pendingCodexTerminalProfile?.model,
    pendingCodexTerminalProfile?.reasoningEffort,
    pendingCodexTerminalProfile?.serviceTier,
    activeAgent?.codexTerminalProfile?.model,
    activeAgent?.codexTerminalProfile?.reasoningEffort,
    activeAgent?.codexTerminalProfile?.serviceTier,
    codexModel,
    codexReasoningEffort,
    codexServiceTier,
  ])
  const displayedCodexModel = displayedCodexProfile.model
  const displayedCodexReasoningEffort = displayedCodexProfile.reasoningEffort
  const displayedCodexServiceTier = displayedCodexProfile.serviceTier
  const displayedCodexModelPreset = `${displayedCodexModel}:${displayedCodexReasoningEffort}`
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
      sourceAgentId: openWorkspaceFile.sourceAgentId,
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
    openWorkspaceFile?.sourceAgentId,
    recordWorkspaceNavigationFile,
  ])
  const composerHasAttachmentMessage = composerAttachmentMessageBlocks(composerAttachments).length > 0
  const composerAttachmentsUploading = composerAttachments.some(attachment => attachment.status === 'uploading')
  const composerSubmitAction = activeCodexTerminalProfileApplying
    ? 'disabled'
    : activeAgent && !composerAttachmentsUploading && (draft.trim() || composerHasAttachmentMessage)
      ? 'send'
      : activeAgentCanInterrupt
        ? 'interrupt'
        : 'disabled'
  const acpComposerSubmitAction = activeAgent?.agentRuntimeMode === 'acp'
    ? composerSubmitAction
    : 'disabled'
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
  const contextMenuProject = useMemo(
    () => projectListProjects.find(project => project.id === projectMenu?.projectId) ?? null,
    [projectListProjects, projectMenu?.projectId]
  )
  const contextMenuAgentSession = useMemo(
    () => displayedProjects.flatMap(project => project.agentSessions).find(session => (
      session.provider === agentSessionMenu?.provider && agentSessionId(session) === agentSessionMenu?.sessionId
    )) ?? null,
    [agentSessionMenu?.provider, agentSessionMenu?.sessionId, displayedProjects]
  )
  const selectedSearchTarget = searchOpen ? visibleSearchTargets[searchSelectionIndex] ?? null : null
  const selectedSearchAgentId = selectedSearchTarget?.kind === 'agent' ? selectedSearchTarget.id : null
  const selectedSearchSessionHandle = selectedSearchTarget?.kind === 'agent-session'
    ? agentSessionId(selectedSearchTarget)
    : null
  const activeProjectWorkspace = activeAgent ? projectWorkspaceForAgent(activeAgent) : undefined
  const projectFileSearchId = useMemo(() => {
    if (openWorkspaceFile && !isGlobalWorkspaceFilesAgentId(openWorkspaceFile.agentId)) {
      return openWorkspaceFile.agentId
    }
    if (activeAgent && !activeAgent.isMain) {
      return projectFilesWorkspaceId(projectWorkspaceForAgent(activeAgent))
    }
    if (activeProjectWorkspace) return projectFilesWorkspaceId(activeProjectWorkspace)
    const firstProjectAgent = activeAgents.find(agent => !agent.isMain)
    return firstProjectAgent ? projectFilesWorkspaceId(projectWorkspaceForAgent(firstProjectAgent)) : null
  }, [activeAgent, activeAgents, activeProjectWorkspace, openWorkspaceFile])
  const projectFileSearchIdForShortcutTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return null
    const rowAgentId = target.closest<HTMLElement>('[data-testid="code-agent-row"][data-agent-id], [data-testid="code-project-agent-compact"][data-agent-id], [data-testid="code-pinned-agent-compact"][data-agent-id], [data-testid="code-agent-rail-item"][data-agent-id]')?.dataset.agentId
    if (rowAgentId) {
      const rowAgent = activeAgents.find(agent => agent.id === rowAgentId && !agent.isMain)
      if (rowAgent) return projectFilesWorkspaceId(projectWorkspaceForAgent(rowAgent))
    }

    const projectGroup = target.closest<HTMLElement>('[data-testid="code-project-group"]')
    const projectId = projectGroup
      ?.querySelector<HTMLElement>('[data-testid="code-project-title"][data-project-id]')
      ?.dataset.projectId
    if (!projectId || projectId === MAIN_AGENT_PROJECT_ID) return null
    return projectFilesWorkspaceId(projectId)
  }, [activeAgents])
  const agentCreationWorkspace = activeAgent?.isMain
    ? lastProjectWorkspace ?? projects[0]?.workspace
    : activeProjectWorkspace ?? lastProjectWorkspace ?? projects[0]?.workspace
  const showFileEditor = mainPaneMode === 'editor' && Boolean(openWorkspaceFile)
  const shareTarget = useMemo<WorkspaceShareTarget | null>(() => {
    if (showFileEditor && openWorkspaceFile) {
      const workspaceRoot = openWorkspaceFile.workspaceRoot
        ?? activeAgents.find(agent => agent.id === openWorkspaceFile.agentId)?.projectWorkspace
        ?? activeAgents.find(agent => agent.id === openWorkspaceFile.agentId)?.cwd
        ?? ''
      return {
        kind: 'file',
        agentId: openWorkspaceFile.agentId,
        filePath: openWorkspaceFile.file.path,
        ...(workspaceRoot ? { absolutePath: workspaceShareAbsolutePath(workspaceRoot, openWorkspaceFile.file.path) } : {}),
        ...(workspaceRoot ? { projectLabel: workspaceShareProjectLabel(workspaceRoot) } : {}),
        view: openWorkspaceFile.diffRequestId ? 'diff' : 'editor',
        lineNumber: openWorkspaceFile.cursor?.lineNumber,
        column: openWorkspaceFile.cursor?.column,
        endColumn: openWorkspaceFile.cursor?.endColumn,
      }
    }
    if (activeTerminalId && workspaceNavigationAgentIds.has(activeTerminalId)) {
      return {
        kind: 'agent',
        agentId: activeTerminalId,
      }
    }
    return null
  }, [
    activeTerminalId,
    openWorkspaceFile?.agentId,
    openWorkspaceFile?.cursor?.column,
    openWorkspaceFile?.cursor?.endColumn,
    openWorkspaceFile?.cursor?.lineNumber,
    openWorkspaceFile?.diffRequestId,
    openWorkspaceFile?.file.path,
    openWorkspaceFile?.workspaceRoot,
    showFileEditor,
    activeAgents,
    workspaceNavigationAgentIds,
  ])
  const composerControlState = useMemo(() => buildComposerControlState({
    agentKind: composerAgentKind,
    codexModel: displayedCodexModel,
    codexReasoningEffort: displayedCodexReasoningEffort,
    codexServiceTier: displayedCodexServiceTier,
    codexModelPreset: displayedCodexModelPreset,
    codexModelOptions,
    codexApprovalMode: displayedCodexApprovalMode,
    claudeModel,
    claudeEffort,
    claudeSettings,
    claudePermissionMode: displayedClaudePermissionMode,
  }), [
    claudeEffort,
    claudeModel,
    claudeSettings,
    displayedClaudePermissionMode,
    displayedCodexApprovalMode,
    displayedCodexModel,
    codexModelOptions,
    displayedCodexModelPreset,
    displayedCodexReasoningEffort,
    displayedCodexServiceTier,
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
  const mobileBackAgentId = showFileEditor && openWorkspaceFile
    ? openWorkspaceFile.sourceAgentId
    : null
  const showMobileBackButton = Boolean(mobileBackAgentId)
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
      const input = composerTextareaRef.current
        ?? document.querySelector<HTMLElement>('[data-testid="code-composer-input"]')
      input?.focus({ preventScroll: true })
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
        setProjectWorkspaces(normalizeProjectWorkspaces(settings.projectWorkspaces))
        setProjectWorkspacesLoaded(true)
        setProjectNames(normalizeProjectNames(settings.projectNames))
        applyLaunchSettings(settings)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [applyLaunchSettings])
  const loadCodexModels = useCallback(() => {
    const catalogAgeMs = Date.now() - codexModelsLoadedAtRef.current
    if (
      codexModelsLoadingRef.current
      || (codexModelsLoadedAtRef.current > 0 && catalogAgeMs <= CODEX_MODEL_CATALOG_TTL_MS)
    ) {
      return () => {}
    }

    let cancelled = false
    codexModelsLoadingRef.current = true
    fetch(appPath('/api/codex/models'))
      .then(async response => {
        const data = await response.json().catch(() => ({})) as {
          catalog?: CodexModelOption[]
          models?: LegacyCodexModelOption[]
          error?: string
        }
        if (!response.ok) {
          throw new Error(data.error || `Failed to load Codex model catalog (${response.status})`)
        }
        return data
      })
      .then((data: { catalog?: CodexModelOption[]; models?: LegacyCodexModelOption[] }) => {
        if (cancelled) return
        const options = normalizeModelCatalog(data)
        if (options.length === 0) throw new Error('Codex model catalog did not contain any visible models')
        codexModelsLoadedAtRef.current = Date.now()
        setCodexModelOptions(options)
      })
      .catch(error => {
        if (cancelled) return
        codexModelsLoadedAtRef.current = 0
        setCodexModelOptions([])
        setCopyNotice({
          id: Date.now(),
          kind: 'error',
          message: error instanceof Error ? error.message : 'Failed to load Codex model catalog',
        })
      })
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
  const fetchSearchedAgentSessions = useCallback(async (query: string, signal: AbortSignal) => {
    const params = new URLSearchParams({
      q: query,
      limit: String(AGENT_SESSION_SEARCH_LIMIT),
      fresh: '1',
    })
    const response = await fetch(appPath(`/api/agent-sessions/search?${params.toString()}`), {
      signal,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Failed to search Agent sessions: ${response.status}`)
    const data = await response.json() as { sessions?: AgentSessionHistoryItem[] }
    return Array.isArray(data.sessions) ? data.sessions : []
  }, [])
  const searchHistoryAgentSessions = useCallback(async (query: string, signal: AbortSignal) => {
    const sessions = await fetchSearchedAgentSessions(query, signal)
    const decoratedSessions = applySessionDisplayOverrides(sessions, agentSessionPinnedOverrides, {})
    return historyAgentSessionsForSessions(
      decoratedSessions,
      mainPageSessionKeys,
      agentListState.claimedAgentSessionKeys
    )
  }, [agentListState.claimedAgentSessionKeys, agentSessionPinnedOverrides, fetchSearchedAgentSessions, mainPageSessionKeys])
  const fetchAgentSessions = useCallback(async (options: { cursor?: string; limit?: number; fresh?: boolean } = {}) => {
    const params = new URLSearchParams({ limit: String(options.limit || AGENT_SESSION_PAGE_SIZE) })
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.fresh) params.set('fresh', '1')
    const response = await fetch(appPath(`/api/agent-sessions?${params.toString()}`), {
      cache: options.fresh ? 'no-store' : 'default',
    })
    const data = await response.json() as {
      sessions?: AgentSessionHistoryItem[]
      nextCursor?: string
      hasMore?: boolean
    }
    return {
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : '',
      hasMore: data.hasMore === true,
    }
  }, [])
  const loadAgentSessions = useCallback((fresh = false) => {
    let cancelled = false
    fetchAgentSessions({ fresh })
      .then(page => {
        if (cancelled) return
        setAgentSessions(page.sessions)
        setAgentSessionNextCursor(page.nextCursor)
        setAgentSessionsHasMore(page.hasMore)
        agentSessionLoadedCountRef.current = Math.max(AGENT_SESSION_PAGE_SIZE, page.sessions.length)
      })
      .catch(() => {
        if (!cancelled) {
          setAgentSessions([])
          setAgentSessionNextCursor('')
          setAgentSessionsHasMore(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [fetchAgentSessions])
  const refreshAgentSessions = useCallback(() => {
    if (agentSessionsRefreshInFlightRef.current) return agentSessionsRefreshInFlightRef.current
    const refresh = fetchAgentSessions({ limit: agentSessionLoadedCountRef.current, fresh: true })
      .then(page => {
        setAgentSessions(page.sessions)
        setAgentSessionNextCursor(page.nextCursor)
        setAgentSessionsHasMore(page.hasMore)
      })
      .catch(() => setAgentSessions([]))
      .finally(() => {
        if (agentSessionsRefreshInFlightRef.current === refresh) {
          agentSessionsRefreshInFlightRef.current = null
        }
      })
    agentSessionsRefreshInFlightRef.current = refresh
    return refresh
  }, [fetchAgentSessions])
  const loadMoreAgentSessions = useCallback(() => {
    if (!agentSessionsHasMore || !agentSessionNextCursor || agentSessionsLoadingRef.current) return
    agentSessionsLoadingRef.current = true
    fetchAgentSessions({ cursor: agentSessionNextCursor })
      .then(page => {
        setAgentSessions(current => {
          const seen = new Set(current.map(agentSessionId))
          const next = [...current]
          page.sessions.forEach(session => {
            const sessionId = agentSessionId(session)
            if (seen.has(sessionId)) return
            seen.add(sessionId)
            next.push(session)
          })
          agentSessionLoadedCountRef.current = Math.max(AGENT_SESSION_PAGE_SIZE, next.length)
          return next
        })
        setAgentSessionNextCursor(page.nextCursor)
        setAgentSessionsHasMore(page.hasMore)
      })
      .catch(() => {})
      .finally(() => {
        agentSessionsLoadingRef.current = false
      })
  }, [agentSessionNextCursor, agentSessionsHasMore, fetchAgentSessions])

  useEffect(() => {
    const searchActive = (activeView === 'search' || searchOpen) && hasSearchQuery
    if (!searchActive) {
      setSearchedAgentSessions([])
      setAgentSessionSearchLoading(false)
      return undefined
    }

    const controller = new AbortController()
    setSearchedAgentSessions([])
    setAgentSessionSearchLoading(true)
    const timer = window.setTimeout(() => {
      fetchSearchedAgentSessions(normalizedSearch, controller.signal)
        .then(setSearchedAgentSessions)
        .catch(error => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          setSearchedAgentSessions([])
        })
        .finally(() => {
          if (!controller.signal.aborted) setAgentSessionSearchLoading(false)
        })
    }, AGENT_SESSION_SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [activeView, fetchSearchedAgentSessions, hasSearchQuery, normalizedSearch, searchOpen])

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
                name,
                type: uploaded.type || attachment.type,
                size: uploaded.size || attachment.size,
                status: 'ready',
                path: uploaded.path,
                messageBlock: formatAttachedImage({ ...uploaded, name }),
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

  const handlePasteAttachment = useCallback((event: ReactClipboardEvent<HTMLElement>) => {
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

  const markAgentReadIfNeeded = useCallback((
    agentId: string,
    force = false,
    readCut: TerminalReadCut | null = null,
  ) => {
    const agent = activeAgents.find(candidate => candidate.id === agentId)
    if (!agent) return
    const attentionSeq = Number.isFinite(agent.attentionSeq) ? Math.max(0, Number(agent.attentionSeq)) : 0
    const readAttentionSeq = Number.isFinite(agent.readAttentionSeq) ? Math.max(0, Number(agent.readAttentionSeq)) : 0
    if (!force && attentionSeq <= readAttentionSeq && !agent.unread) return
    // `unread: false` means "read through the backend's current authoritative
    // attention cursor", so an explicit jump is safe even if this projection
    // is one websocket update behind.
    onUpdateAgentFlags(agentId, {
      unread: false,
      ...(readCut
        ? {
          readOutputEpoch: readCut.runtimeEpoch,
          readOutputSeq: readCut.outputSeq,
        }
        : {}),
    })
  }, [activeAgents, onUpdateAgentFlags])

  const markAgentReadLatest = useCallback((agentId: string, readCut: TerminalReadCut | null = null) => {
    markAgentReadIfNeeded(agentId, true, readCut)
  }, [markAgentReadIfNeeded])

  const handleTerminalFollowOutputChange = useCallback((agentId: string, state: TerminalFollowState) => {
    setTerminalFollowStates(current => {
      const previous = current[agentId]
      if (previous?.following === state.following && previous?.hasUnreadOutput === state.hasUnreadOutput) return current
      return { ...current, [agentId]: state }
    })
  }, [])

  const handleDraftChange = useCallback((value: string) => {
    updateActiveComposerState(state => ({
      ...state,
      draft: value,
      history: { ...state.history, cursor: null },
    }))
  }, [updateActiveComposerState])

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
    return result.value
  }, [activeAgent, activeComposerKey, activeComposerState.history, updateComposerStateForKey])

  const applyCodexTerminalProfile = useCallback(async (
    agent: Agent,
    model: string,
    effort: string,
    serviceTier: string,
  ) => {
    if (!isCodexTerminalAgent(agent)) return true
    if (codexTerminalProfileRequestAgentIdsRef.current.has(agent.id)) return false
    codexTerminalProfileRequestAgentIdsRef.current.add(agent.id)
    const pendingProfile: CodexTerminalProfile = {
      model,
      reasoningEffort: effort,
      serviceTier,
      source: 'pending-terminal-command',
    }
    setPendingCodexTerminalProfiles(current => {
      const next = new Map(current)
      next.set(agent.id, pendingProfile)
      return next
    })
    setCodexTerminalProfileApplyingAgentIds(current => new Set(current).add(agent.id))
    setCopyNotice({ id: Date.now(), kind: 'success', message: copy.terminalProfileApplying })
    const requestController = new AbortController()
    const requestTimeout = window.setTimeout(() => {
      requestController.abort(new DOMException(
        'Timed out applying the Codex Terminal profile',
        'TimeoutError',
      ))
    }, CODEX_TERMINAL_PROFILE_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(agent.id)}/codex-terminal-profile`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: requestController.signal,
        body: JSON.stringify({
          model,
          effort,
          serviceTier,
        }),
      })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(data.error || `Failed to update Codex Terminal (${response.status})`)
      setCopyNotice({ id: Date.now(), kind: 'success', message: copy.terminalProfileApplied })
      return true
    } catch (error) {
      setPendingCodexTerminalProfiles(current => {
        const next = new Map(current)
        next.delete(agent.id)
        return next
      })
      const message = error instanceof Error ? error.message : 'Failed to update Codex Terminal'
      setCopyNotice({ id: Date.now(), kind: 'error', message: copy.terminalProfileFailed(message) })
      return false
    } finally {
      window.clearTimeout(requestTimeout)
      codexTerminalProfileRequestAgentIdsRef.current.delete(agent.id)
      setCodexTerminalProfileApplyingAgentIds(current => {
        const next = new Set(current)
        next.delete(agent.id)
        return next
      })
    }
  }, [copy.terminalProfileApplied, copy.terminalProfileApplying, copy.terminalProfileFailed])

  useEffect(() => {
    if (pendingCodexTerminalProfiles.size === 0) return
    setPendingCodexTerminalProfiles(current => {
      let next: Map<string, CodexTerminalProfile> | null = null
      for (const [agentId, pending] of current) {
        const live = activeAgents.find(agent => agent.id === agentId)?.codexTerminalProfile
        if (!live) continue
        if (
          live.model === pending.model
          && live.reasoningEffort === pending.reasoningEffort
          && live.serviceTier === pending.serviceTier
        ) {
          if (!next) next = new Map(current)
          next.delete(agentId)
        }
      }
      return next || current
    })
  }, [activeAgents, pendingCodexTerminalProfiles.size])

  const sendComposerMessageToAgent = useCallback((agent: Agent, message: string, attachments: ComposerPromptAttachment[] = []) => {
    if (['acp', 'json'].includes(agent.agentRuntimeMode || '') || (agent.providerSessionProvider === 'codex' && agent.codexRuntimeMode === 'app-server')) {
      return sendComposerInput(message, agent.id, agent.agentRuntimeMode === 'acp' ? attachments : [])
    }
    if (
      agentKindForCommand(agent.command) === 'shell'
      || capabilitiesForAgent(agent).kind === 'shell'
      || isPlainTextComposerAgentCommand(agent.command)
    ) {
      return sendTerminalSessionInput(agent.id, `${message}\r`)
    }
    return sendTerminalSessionInput(agent.id, terminalInputPartsForComposerMessage(message))
  }, [sendComposerInput])

  const setNativeCodexGoalFromComposer = useCallback(async (agent: Agent, objective: string) => {
    const response = await fetch(appPath(`/api/agents/${encodeURIComponent(agent.id)}/codex-goal`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective,
        status: 'active',
        tokenBudget: null,
      }),
    })
    return response.ok
  }, [])

  const submitDraft = useCallback((submittedDraft?: string) => {
    const latestDraft = submittedDraft ?? composerTextareaRef.current?.value ?? draft
    const text = composerMessageWithAttachments(latestDraft, composerAttachments)
    if (!text || !activeAgent || !activeComposerKey || composerAttachments.some(attachment => attachment.status === 'uploading')) return

    if (composerMode === 'goal' && activeAgent.providerSessionProvider === 'codex' && activeAgent.codexRuntimeMode === 'app-server') {
      void (async () => {
        const goalSaved = await setNativeCodexGoalFromComposer(activeAgent, text)
        if (!goalSaved) return
        const submitted = sendComposerMessageToAgent(activeAgent, text)
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
      })()
      return
    }

    const message = formatComposerMessage(composerMode, text)
    let submitted = true
    if (isCodexAgentWorking(activeAgent) && activeAgent.codexRuntimeMode !== 'app-server' && !['acp', 'json'].includes(activeAgent.agentRuntimeMode || '')) {
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
  }, [activeAgent, activeComposerKey, composerAttachments, composerMode, draft, focusComposerTextarea, sendComposerMessageToAgent, setNativeCodexGoalFromComposer, updateComposerStateForKey])

  const submitAcpDraft = useCallback((submittedDraft?: string) => {
    const latestDraft = submittedDraft ?? composerTextareaRef.current?.value ?? draft
    const submitted = submitAcpComposerDraft({
      agent: activeAgent,
      composerKey: activeComposerKey,
      draft: latestDraft,
      attachments: composerAttachments,
      composerMode,
      turnActive: activeAgentTurnActive,
      sendMessage: sendComposerMessageToAgent,
      updateComposerState: updateComposerStateForKey,
    })
    if (submitted) focusComposerTextarea()
  }, [activeAgent, activeAgentTurnActive, activeComposerKey, composerAttachments, composerMode, draft, focusComposerTextarea, sendComposerMessageToAgent, updateComposerStateForKey])

  const interruptActiveAgent = useCallback(() => {
    if (!activeAgent || !activeAgentCanInterrupt) return
    onInterruptAgent(activeAgent.id)
    focusComposerTextarea()
  }, [activeAgent, activeAgentCanInterrupt, focusComposerTextarea, onInterruptAgent])

  const respondToActiveAppServerRequest = useCallback((requestId: string, result: unknown) => {
    if (!activeAgent) return
    respondToAppServerRequest(activeAgent.id, requestId, result)
  }, [activeAgent, respondToAppServerRequest])

  const rejectActiveAppServerRequest = useCallback((requestId: string) => {
    if (!activeAgent) return
    respondToAppServerRequest(activeAgent.id, requestId, undefined, {
      reject: true,
      reason: 'Declined in Farming',
    })
  }, [activeAgent, respondToAppServerRequest])

  const respondToActiveAcpPermission = useCallback((requestId: string, optionId?: string, cancelled?: boolean) => {
    if (!activeAgent) return
    void respondToAcpPermission(activeAgent.id, requestId, optionId, cancelled === true)
  }, [activeAgent])

  const respondToActiveAcpElicitation = useCallback((requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, string | number | boolean | string[]>) => {
    if (!activeAgent) return
    void respondToAcpElicitation(activeAgent.id, requestId, action, content)
  }, [activeAgent])

  const steerPendingFollowUp = useCallback((messageId: string) => {
    if (!activeAgent || !activeComposerKey) return
    const pending = composerByAgentKey[activeComposerKey]?.pendingFollowUp
    if (!pending || pending.messages.length === 0) return
    const message = pending.messages.find(item => item.id === messageId)
    if (!message) return
    if (!sendComposerMessageToAgent(activeAgent, message.text, message.attachments)) return
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
      const composerKey = agent.agentRuntimeMode === 'acp'
        ? acpComposerStateKeyForAgent(agent)
        : composerStateKeyForAgent(agent)
      if (!composerKey) return
      const pending = composerByAgentKey[composerKey]?.pendingFollowUp
      if (!pending || pending.messages.length === 0) {
        delete pendingFollowUpAutoFlushRef.current[composerKey]
        return
      }
      if (agent.archived || agent.status === 'dead' || agent.status === 'stopped') return
      if (agent.agentRuntimeMode === 'acp' ? isAgentTurnActive(agent) : isCodexAgentWorking(agent)) {
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
      if (!sendComposerMessageToAgent(agent, message.text, message.attachments)) return
      pendingFollowUpAutoFlushRef.current[composerKey] = message.id
      updateExistingComposerStateForKey(composerKey, state => {
        if (!state.pendingFollowUp) return state
        return { ...state, pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, message.id) }
      })
    })
  }, [activeAgents, composerByAgentKey, sendComposerMessageToAgent, updateExistingComposerStateForKey])

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

  const startAgentWithLaunchProfile = useCallback((
    command: string,
    workspace: string,
    options?: { projectWorkspace?: string; codexApprovalMode?: string; codexRuntimeMode?: 'cli' | 'app-server'; agentRuntimeMode?: 'terminal' | 'acp' | 'json'; dangerouslySkipPermissions?: boolean; providerHomeId?: string },
  ) => {
    setSearchQuery('')
    setSearchOpen(false)
    setSearchSelectionIndex(0)
    setMainPaneMode('terminal')
    onWorkspaceViewChange('projects')

    if (agentKindForCommand(command) !== 'codex') {
      onStartAgent(command, workspace, options)
      return
    }

    const selectedApprovalMode = options?.codexApprovalMode || codexApprovalMode
    onStartAgent(command, workspace, {
      ...options,
      codexApprovalMode: selectedApprovalMode,
      ...(selectedApprovalMode === 'full' ? { dangerouslySkipPermissions: true } : {}),
    })
  }, [codexApprovalMode, onStartAgent, onWorkspaceViewChange])

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

  const addMainPageAgentSession = useCallback((provider: string, sessionId: string, providerHomeId = '') => {
    const sessionHandle = agentSessionId({ provider, id: sessionId, providerHomeId })
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
    let discoveredSession = false
    activeAgents.forEach(agent => {
      if (agent.providerSessionTemporary === true) return
      const sessionHandle = agent.providerSessionKey || resumedAgentSessionIdFromSource(agent.source)
      if (!sessionHandle) return
      const trackingKey = `${agent.id}:${sessionHandle}`
      if (trackedMainPageAgentKeysRef.current.has(trackingKey)) return
      trackedMainPageAgentKeysRef.current.add(trackingKey)
      updateMainPageSessionKeys(previous => [...previous, sessionHandle])
      discoveredSession = true
    })
    if (discoveredSession) refreshAgentSessions()
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
    const rows = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-testid="code-agent-row"], [data-testid="code-project-agent-compact"], [data-testid="code-pinned-agent-compact"], [data-testid="code-agent-rail-item"], [data-testid="code-active-session-row"]') ?? [])
    const activeRow = activeAgentId
      ? rows.find(row => row.dataset.agentId === activeAgentId)
      : null

    const target = activeRow ?? rows[0] ?? projectListRef.current
    if (!target) return false
    target.focus({ preventScroll: true })
    return document.activeElement === target
  }, [])

  const focusProjectListTargetNow = useCallback((target: SearchTarget) => {
    const rows = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-testid="code-agent-row"], [data-testid="code-project-agent-compact"], [data-testid="code-pinned-agent-compact"], [data-testid="code-agent-rail-item"], [data-testid="code-active-session-row"]') ?? [])
    const row = rows.find(candidate => {
      if (target.kind === 'agent') return candidate.dataset.agentId === target.id
      return candidate.dataset.provider === target.provider && candidate.dataset.sessionId === searchTargetHandle(target)
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

  useEffect(() => {
    if (!searchOpen || activeView !== 'search') return undefined

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.code-search-panel, [data-testid="code-nav-search"], [data-testid="code-mobile-menu"]')) return
      closeSearchView()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [activeView, closeSearchView, searchOpen])

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

  useEffect(() => {
    projectWorkspacesRef.current = projectWorkspaces
  }, [projectWorkspaces])

  const persistProjectWorkspaces = useCallback((nextProjects: string[], rollbackProjects: string[]) => {
    const normalized = normalizeProjectWorkspaces(nextProjects)
    const mutationId = projectWorkspacesMutationRef.current += 1
    projectWorkspacesRef.current = normalized
    setProjectWorkspaces(normalized)
    projectWorkspacesSaveChainRef.current = projectWorkspacesSaveChainRef.current
      .catch(() => {})
      .then(async () => {
        const response = await fetch(appPath('/api/settings'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectWorkspaces: normalized }),
        })
        if (!response.ok) throw new Error(`settings request failed (${response.status})`)
        const data = await response.json() as { settings?: GlobalSettings }
        if (mutationId !== projectWorkspacesMutationRef.current) return
        const saved = normalizeProjectWorkspaces(data.settings?.projectWorkspaces)
        projectWorkspacesRef.current = saved
        setProjectWorkspaces(saved)
      })
      .catch(() => {
        if (mutationId !== projectWorkspacesMutationRef.current) return
        const rollback = normalizeProjectWorkspaces(rollbackProjects)
        projectWorkspacesRef.current = rollback
        setProjectWorkspaces(rollback)
        setCopyNotice({ id: Date.now(), kind: 'error', message: copy.copyFailed })
      })
  }, [copy.copyFailed])

  const mountProject = useCallback((workspace: string) => {
    const normalizedWorkspace = workspace.trim().replace(/[\\/]+$/, '')
    if (!normalizedWorkspace) return
    const previous = projectWorkspacesRef.current
    if (!previous.includes(normalizedWorkspace)) {
      persistProjectWorkspaces([normalizedWorkspace, ...previous], previous)
    }
    setCollapsedProjectIds(current => {
      if (!current.has(normalizedWorkspace)) return current
      const next = new Set(current)
      next.delete(normalizedWorkspace)
      return next
    })
  }, [persistProjectWorkspaces])

  useEffect(() => {
    if (!projectWorkspacesLoaded) return
    const previous = projectWorkspacesRef.current
    const missing = projectListProjects
      .filter(project => !project.hasMain && Boolean(project.workspace))
      .map(project => project.workspace)
      .filter(workspace => !previous.includes(workspace))
    if (missing.length === 0) return
    persistProjectWorkspaces([...missing, ...previous], previous)
  }, [persistProjectWorkspaces, projectListProjects, projectWorkspacesLoaded])

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

  const openVisibleTarget = useCallback((target: SearchTarget, options?: { focusTerminal?: boolean }) => {
    setMainPaneMode('terminal')
    onWorkspaceViewChange('projects')
    if (target.kind === 'agent') {
      onOpenTerminal(target.id, { focusTerminal: options?.focusTerminal })
    } else {
      resumeAgentSessionRef.current(target.provider, target.id, target.providerHomeId)
    }
  }, [onOpenTerminal, onWorkspaceViewChange])

  const currentProjectListTargetId = useCallback(() => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement) {
      const row = activeElement.closest<HTMLElement>('[data-testid="code-agent-row"], [data-testid="code-project-agent-compact"], [data-testid="code-pinned-agent-compact"], [data-testid="code-agent-rail-item"], [data-testid="code-active-session-row"]')
      if (row?.dataset.agentId) return workspaceTargetId({ kind: 'agent', id: row.dataset.agentId })
      if (row?.dataset.sessionId && row.dataset.provider) {
        return row.dataset.sessionId
      }
    }

    const activeAgentId = activeTerminalIdRef.current
    return activeAgentId ? workspaceTargetId({ kind: 'agent', id: activeAgentId }) : ''
  }, [])

  const openAdjacentVisibleTarget = useCallback((direction: 1 | -1) => {
    if (visibleProjectListTargets.length === 0) return

    const currentTargetId = currentProjectListTargetId()
    const currentIndex = visibleProjectListTargets.findIndex(target => searchTargetHandle(target) === currentTargetId)
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
    const workspaceRect = workspaceRef.current?.getBoundingClientRect()
    const workspaceLeft = workspaceRect?.left ?? 0
    const rawWidth = clientX - workspaceLeft
    if (rawWidth <= SIDEBAR_DRAG_COLLAPSE_WIDTH) {
      collapseSidebar()
      return
    }

    const availableWidth = workspaceRect?.width ?? window.innerWidth
    const maxWidth = Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, availableWidth - MIN_MAIN_PANE_WIDTH),
    )
    const nextWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, rawWidth))
    expandSidebar()
    setSidebarWidth(nextWidth)
  }, [collapseSidebar, expandSidebar])

  const focusAgentRowNow = useCallback((agentId: string) => {
    const rows = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-testid="code-agent-row"], [data-testid="code-project-agent-compact"], [data-testid="code-pinned-agent-compact"], [data-testid="code-agent-rail-item"]') ?? [])
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

  const focusAgentSessionRow = useCallback((provider: string, sessionHandle: string) => {
    window.requestAnimationFrame(() => {
      const rows = Array.from(workspaceRef.current?.querySelectorAll<HTMLButtonElement>('[data-testid="code-active-session-row"]') ?? [])
      rows.find(row => row.dataset.provider === provider && row.dataset.sessionId === sessionHandle)?.focus({ preventScroll: true })
    })
  }, [])

  const focusProjectTitle = useCallback((projectId: string) => {
    window.requestAnimationFrame(() => {
      const titles = Array.from(workspaceRef.current?.querySelectorAll<HTMLButtonElement>('[data-testid="code-project-title"]') ?? [])
      titles.find(title => title.dataset.projectId === projectId)?.focus()
    })
  }, [])

  const toggleContextMenuAgentSessionPinned = useCallback(async () => {
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
      focusAgentSessionRow(contextMenuAgentSession.provider, sessionId)
    } else {
      window.requestAnimationFrame(() => projectListRef.current?.focus({ preventScroll: true }))
    }
    try {
      const response = await fetch(appPath(`/api/agent-sessions/${encodeURIComponent(contextMenuAgentSession.provider)}/${encodeURIComponent(contextMenuAgentSession.id)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pinned: nextPinned,
          providerHomeId: contextMenuAgentSession.providerHomeId || 'default',
        }),
      })
      if (!response.ok) throw new Error(copy.updateFailed)
      const page = await fetchAgentSessions({ limit: agentSessionLoadedCountRef.current })
      setAgentSessions(page.sessions)
      setAgentSessionNextCursor(page.nextCursor)
      setAgentSessionsHasMore(page.hasMore)
      setAgentSessionPinnedOverrides(previous => {
        const next = { ...previous }
        delete next[sessionId]
        return next
      })
    } catch (error) {
      setAgentSessionPinnedOverrides(previous => ({
        ...previous,
        [sessionId]: !nextPinned,
      }))
      setCopyNotice({
        id: Date.now(),
        kind: 'error',
        message: error instanceof Error ? error.message : copy.updateFailed,
      })
    }
  }, [contextMenuAgentSession, copy.updateFailed, fetchAgentSessions, focusAgentSessionRow, mainPageSessionKeys])

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
    const identity = resolveWorkspaceFileIdentity(agentId, target?.sourceAgentId)
    const globalFile = isGlobalWorkspaceFilesAgentId(identity.filesId)
    const projectWorkspace = projectWorkspaceFromFilesId(identity.filesId)
    if (!globalFile && (projectWorkspace || identity.sourceAgent)) {
      const projectId = projectWorkspace || (identity.sourceAgent?.isMain
        ? MAIN_AGENT_PROJECT_ID
        : projectWorkspaceForAgent(identity.sourceAgent!))
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
      workspaceRoot: identity.workspaceRoot,
      sourceAgentId: identity.sourceAgentId,
    }
    workspaceOpenFiles.openFromRead(identity.filesId, file, openRequest)
    if (shouldRevealSelectedWorkspaceOpenFile(target)) {
      setFileRevealRequest({
        agentId: identity.filesId,
        path: file.path,
        kind: 'file',
        requestId: workspaceFileRevealRequestRef.current += 1,
      })
    }
    if (identity.sourceAgent && identity.sourceAgentId) {
      onOpenTerminal(identity.sourceAgentId, { focusTerminal: false })
    }
    closeSidebarForMobile()
  }, [clearSearch, closeSidebarForMobile, createWorkspaceOpenFileRequest, onOpenTerminal, onWorkspaceViewChange, resolveWorkspaceFileIdentity, workspaceOpenFiles])

  useEffect(() => {
    if (workspaceSurfaceRestoredRef.current || workspaceSurfaceRestoreStartedRef.current) return
    const surface = initialWorkspaceSurface
    if (!surface) {
      workspaceSurfaceRestoredRef.current = true
      return
    }

    if (surface.kind === 'agent') {
      if (activeAgents.length === 0) return
      workspaceSurfaceRestoreStartedRef.current = true
      const targetAgent = activeAgents.find(agent => agent.id === surface.agentId)
        ?? activeAgents.find(agent => Boolean(surface.providerSessionKey) && agent.providerSessionKey === surface.providerSessionKey)
        ?? activeAgents.find(agent => Boolean(surface.workspace) && projectWorkspaceForAgent(agent) === surface.workspace)
      if (targetAgent) {
        openTerminalFromWorkspace(targetAgent.id, { focusTerminal: false })
      } else {
        saveCodeWorkspaceViewState({ surface: undefined })
      }
      workspaceSurfaceRestoredRef.current = true
      return
    }

    if (!projectWorkspacesLoaded) return
    workspaceSurfaceRestoreStartedRef.current = true
    const sourceAgent = activeAgents.find(agent => (
      agent.id === surface.sourceAgentId
      && (
        surface.workspace === GLOBAL_WORKSPACE_FILES_ROOT
        || projectFilesWorkspaceId(projectWorkspaceForAgent(agent)) === projectFilesWorkspaceId(surface.workspace)
      )
    ))
      ?? activeAgents.find(agent => (
        projectFilesWorkspaceId(projectWorkspaceForAgent(agent)) === projectFilesWorkspaceId(surface.workspace)
      ))
    const filesId = surface.workspace === GLOBAL_WORKSPACE_FILES_ROOT
      ? GLOBAL_WORKSPACE_FILES_AGENT_ID
      : projectFilesWorkspaceId(surface.workspace)
    const projectAvailable = surface.workspace === GLOBAL_WORKSPACE_FILES_ROOT
      || projectWorkspaces.some(workspace => projectFilesWorkspaceId(workspace) === filesId)
      || Boolean(sourceAgent)
    if (!projectAvailable) {
      saveCodeWorkspaceViewState({ surface: undefined })
      workspaceSurfaceRestoredRef.current = true
      return
    }
    const identity = resolveWorkspaceFileIdentity(filesId, sourceAgent?.id)

    void fetchWorkspaceFile(identity.filesId, surface.filePath)
      .then(file => {
        openProjectFile(identity.filesId, file, {
          view: surface.view ?? 'editor',
          lineNumber: surface.lineNumber,
          column: surface.column,
          endColumn: surface.endColumn,
          revealInTree: true,
          sourceAgentId: identity.sourceAgentId,
        })
      })
      .catch(() => {
        saveCodeWorkspaceViewState({ surface: undefined })
      })
      .finally(() => {
        workspaceSurfaceRestoredRef.current = true
      })
  }, [activeAgents, initialWorkspaceSurface, openProjectFile, openTerminalFromWorkspace, projectWorkspaces, projectWorkspacesLoaded, resolveWorkspaceFileIdentity])

  useEffect(() => {
    if (!workspaceSurfaceRestoredRef.current || activeView !== 'projects') return
    if (mainPaneMode === 'terminal') {
      const agent = activeAgents.find(candidate => candidate.id === activeTerminalId)
      if (!agent) return
      saveCodeWorkspaceViewState({
        surface: {
          kind: 'agent',
          agentId: agent.id,
          providerSessionKey: agent.providerSessionKey || undefined,
          workspace: projectWorkspaceForAgent(agent),
        },
      })
      return
    }
    if (!openWorkspaceFile) return
    const workspace = openWorkspaceFile.workspaceRoot
      ?? activeAgents.find(agent => agent.id === openWorkspaceFile.agentId)?.projectWorkspace
      ?? activeAgents.find(agent => agent.id === openWorkspaceFile.agentId)?.cwd
      ?? ''
    if (!workspace) return
    saveCodeWorkspaceViewState({
      surface: {
        kind: 'file',
        workspace,
        filePath: openWorkspaceFile.file.path,
        view: openWorkspaceFile.diffRequestId ? 'diff' : 'editor',
        lineNumber: openWorkspaceFile.cursor?.lineNumber,
        column: openWorkspaceFile.cursor?.column,
        endColumn: openWorkspaceFile.cursor?.endColumn,
        sourceAgentId: openWorkspaceFile.sourceAgentId,
      },
    })
  }, [activeAgents, activeTerminalId, activeView, mainPaneMode, openWorkspaceFile])

  const focusWorkspaceFilesSearch = useCallback((agentId: string, query?: string) => {
    const identity = resolveWorkspaceFileIdentity(agentId)
    const projectWorkspace = projectWorkspaceFromFilesId(identity.filesId)
    if (!isGlobalWorkspaceFilesAgentId(identity.filesId) && (projectWorkspace || identity.sourceAgent)) {
      const projectId = projectWorkspace || (identity.sourceAgent?.isMain
        ? MAIN_AGENT_PROJECT_ID
        : projectWorkspaceForAgent(identity.sourceAgent!))
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
      agentId: identity.filesId,
      ...(query ? { query } : {}),
      requestId: workspaceFileSearchFocusRequestRef.current += 1,
    })
  }, [clearSearch, expandSidebar, onWorkspaceViewChange, resolveWorkspaceFileIdentity])

  const revealWorkspaceFileInExplorer = useCallback((agentId: string, filePath: string, kind: 'directory' | 'file') => {
    const identity = resolveWorkspaceFileIdentity(agentId)
    const projectWorkspace = projectWorkspaceFromFilesId(identity.filesId)
    if (!isGlobalWorkspaceFilesAgentId(identity.filesId) && (projectWorkspace || identity.sourceAgent)) {
      const projectId = projectWorkspace || (identity.sourceAgent?.isMain
        ? MAIN_AGENT_PROJECT_ID
        : projectWorkspaceForAgent(identity.sourceAgent!))
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
      agentId: identity.filesId,
      path: filePath,
      kind,
      requestId: workspaceFileRevealRequestRef.current += 1,
    })
  }, [clearSearch, expandSidebar, onWorkspaceViewChange, resolveWorkspaceFileIdentity])

  const resolveTerminalPathTarget = useCallback(async (agentId: string, target: TerminalPathOpenTarget) => {
    const identity = resolveWorkspaceFileIdentity(agentId, agentId)
    const filePath = terminalTargetFilePath(target.path, identity.workspaceRoot ?? '')
    if (!filePath) return null

    try {
      const results = await searchWorkspaceFiles(identity.filesId, filePath, { limit: TERMINAL_PATH_SEARCH_LIMIT })
      const pathMatches = uniqueTerminalPathSearchMatches(results.matches)
      const exactPathMatch = pathMatches.find(match => match.path === filePath)
      const resolvedPath = exactPathMatch?.path ?? (pathMatches.length === 1 ? pathMatches[0]?.path : '')
      return resolvedPath ? { ...target, path: resolvedPath } : null
    } catch {
      return null
    }
  }, [resolveWorkspaceFileIdentity])

  const openTerminalPathTarget = useCallback((agentId: string, target: TerminalPathOpenTarget) => {
    const identity = resolveWorkspaceFileIdentity(agentId, agentId)
    const filePath = terminalTargetFilePath(target.path, identity.workspaceRoot ?? '')
    if (!filePath) return

    const requestId = terminalPathOpenRequestRef.current + 1
    terminalPathOpenRequestRef.current = requestId
    const requestedOpenTarget = openTargetForTerminalPath(target)
    const openTarget: WorkspaceFileOpenTarget = {
      ...(requestedOpenTarget ?? {}),
      sourceAgentId: identity.sourceAgentId,
    }

    const openResolvedFile = async (resolvedPath: string, resolvedTarget = openTarget) => {
      const file = await fetchWorkspaceFile(identity.filesId, resolvedPath)
      if (terminalPathOpenRequestRef.current !== requestId) return
      openProjectFile(identity.filesId, file, resolvedTarget)
    }

    const revealResolvedDirectory = (resolvedPath: string) => {
      if (terminalPathOpenRequestRef.current !== requestId) return
      revealWorkspaceFileInExplorer(identity.filesId, resolvedPath, 'directory')
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
      focusWorkspaceFilesSearch(identity.filesId, filePath)
    }

    void (async () => {
      try {
        await fetchWorkspaceTree(identity.filesId, filePath)
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
        const results = await searchWorkspaceFiles(identity.filesId, filePath, { limit: TERMINAL_PATH_SEARCH_LIMIT })
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
          await openResolvedFile(match.path, !requestedOpenTarget && match.kind === 'content' ? {
            lineNumber: match.lineNumber,
            column: match.ranges[0] ? match.ranges[0].start + 1 : undefined,
            endColumn: match.ranges[0] ? Math.max(match.ranges[0].start + 1, match.ranges[0].end + 1) : undefined,
            sourceAgentId: identity.sourceAgentId,
          } : openTarget)
          return
        }
      } catch {
        // Search failures still leave the user in the Files search UI.
      }

      revealSearch()
    })()
  }, [focusWorkspaceFilesSearch, openProjectFile, resolveWorkspaceFileIdentity, revealWorkspaceFileInExplorer])

  const selectOpenWorkspaceFile = useCallback((agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => {
    const identity = resolveWorkspaceFileIdentity(agentId, target?.sourceAgentId)
    const globalFile = isGlobalWorkspaceFilesAgentId(identity.filesId)
    const projectWorkspace = projectWorkspaceFromFilesId(identity.filesId)
    if (!globalFile && (projectWorkspace || identity.sourceAgent)) {
      const projectId = projectWorkspace || (identity.sourceAgent?.isMain
        ? MAIN_AGENT_PROJECT_ID
        : projectWorkspaceForAgent(identity.sourceAgent!))
      setCollapsedProjectIds(previous => {
        if (!previous.has(projectId)) return previous
        const next = new Set(previous)
        next.delete(projectId)
        return next
      })
    }
    const requestedKey = workspaceOpenFileTargetKey({
      agentId: identity.filesId,
      workspaceRoot: identity.workspaceRoot,
      filePath,
    })
    const hasOpenFile = openWorkspaceFiles.some(file => workspaceOpenFileKey(file) === requestedKey)
    if (!hasOpenFile) return false
    const openRequest = {
      ...createWorkspaceOpenFileRequest(target),
      workspaceRoot: identity.workspaceRoot,
      sourceAgentId: identity.sourceAgentId,
    }
    if (!workspaceOpenFiles.select(identity.filesId, filePath, openRequest)) return false
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    clearSearch()
    onWorkspaceViewChange('projects')
    setMainPaneMode('editor')
    if (shouldRevealSelectedWorkspaceOpenFile(target)) {
      setFileRevealRequest({
        agentId: identity.filesId,
        path: filePath,
        kind: 'file',
        requestId: workspaceFileRevealRequestRef.current += 1,
      })
    }
    if (identity.sourceAgent && identity.sourceAgentId) {
      onOpenTerminal(identity.sourceAgentId, { focusTerminal: false })
    }
    closeSidebarForMobile()
    return true
  }, [clearSearch, closeSidebarForMobile, createWorkspaceOpenFileRequest, onOpenTerminal, onWorkspaceViewChange, openWorkspaceFiles, resolveWorkspaceFileIdentity, workspaceOpenFiles])

  const openWorkspaceFilePath = useCallback(async (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => {
    const requestedFilesId = target?.globalRoot ? GLOBAL_WORKSPACE_FILES_AGENT_ID : agentId
    const identity = resolveWorkspaceFileIdentity(
      requestedFilesId,
      target?.sourceAgentId ?? (target?.globalRoot ? agentId : undefined),
    )
    const filesId = identity.filesId
    const resolvedFilePath = target?.globalRoot ? normalizeGlobalWorkspaceFilePath(filePath) : filePath
    const resolvedTarget = target
      ? { ...target, sourceAgentId: identity.sourceAgentId }
      : identity.sourceAgentId
        ? { sourceAgentId: identity.sourceAgentId }
        : undefined
    if (selectOpenWorkspaceFile(filesId, resolvedFilePath, resolvedTarget)) return
    const openResolvedFile = async (resolvedPath: string, fileTarget = resolvedTarget) => {
      const file = await fetchWorkspaceFile(filesId, resolvedPath)
      openProjectFile(filesId, file, fileTarget)
    }
    try {
      await openResolvedFile(resolvedFilePath, resolvedTarget)
    } catch {
      try {
        await fetchWorkspaceTree(filesId, resolvedFilePath)
        revealWorkspaceFileInExplorer(filesId, resolvedFilePath, 'directory')
      } catch {
        try {
          const results = await searchWorkspaceFiles(filesId, resolvedFilePath, { limit: TERMINAL_PATH_SEARCH_LIMIT })
          const pathMatches = uniqueTerminalPathSearchMatches(results.matches)
          const fileMatches = uniqueTerminalFileSearchMatches(results.matches)
          if (pathMatches.length === 1) {
            const match = pathMatches[0]
            if (match?.entryType === 'directory') {
              revealWorkspaceFileInExplorer(filesId, match.path, 'directory')
              return
            }
            if (match?.path) {
              await openResolvedFile(match.path, resolvedTarget)
              return
            }
          }
          if (pathMatches.length === 0 && fileMatches.length === 1) {
            const match = fileMatches[0]
            if (match?.path) {
              await openResolvedFile(match.path, !target && match.kind === 'content' ? {
                lineNumber: match.lineNumber,
                column: match.ranges[0] ? match.ranges[0].start + 1 : undefined,
                endColumn: match.ranges[0] ? Math.max(match.ranges[0].start + 1, match.ranges[0].end + 1) : undefined,
                sourceAgentId: identity.sourceAgentId,
              } : resolvedTarget)
              return
            }
          }
        } catch {
          // Fall through to a visible Files search when resolution fails.
        }
        if (!resolvedTarget?.suppressSearchOnMiss) {
          focusWorkspaceFilesSearch(filesId, resolvedFilePath)
        }
      }
    }
  }, [focusWorkspaceFilesSearch, openProjectFile, resolveWorkspaceFileIdentity, revealWorkspaceFileInExplorer, selectOpenWorkspaceFile])

  const restoreWorkspaceShareTarget = useCallback(async (target: WorkspaceShareTarget) => {
    if (target.kind === 'agent') {
      if (!workspaceNavigationAgentIds.has(target.agentId)) return false
      setAgentMenu(null)
      setProjectMenu(null)
      setAgentSessionMenu(null)
      setOptionsMenu(null)
      clearSearch()
      onWorkspaceViewChange('projects')
      setMainPaneMode('terminal')
      onOpenTerminal(target.agentId, { focusTerminal: false })
      closeSidebarForMobile()
      return true
    }

    const resolvedPath = resolveWorkspaceSharePath(
      target,
      [
        ...activeAgents
          .filter(agent => !agent.isMain)
          .map(agent => ({ agentId: agent.id, workspace: projectWorkspaceForAgent(agent) })),
        ...projectWorkspaces.map(workspace => ({
          agentId: projectFilesWorkspaceId(workspace),
          workspace,
        })),
      ],
      GLOBAL_WORKSPACE_FILES_AGENT_ID,
    )
    if (!resolvedPath) return false
    const identity = resolveWorkspaceFileIdentity(resolvedPath.agentId, resolvedPath.agentId)

    if (target.kind === 'folder') {
      try {
        const tree = await fetchWorkspaceTree(identity.filesId, resolvedPath.filePath)
        const previewFilePath = workspaceFolderPreviewFilePath(tree.items)
        if (previewFilePath) {
          const file = await fetchWorkspaceFile(identity.filesId, previewFilePath)
          openProjectFile(identity.filesId, file, { sourceAgentId: identity.sourceAgentId })
          return true
        }
        revealWorkspaceFileInExplorer(identity.filesId, resolvedPath.filePath, 'directory')
        return true
      } catch {
        return false
      }
    }

    const openTarget = {
      ...workspaceFileOpenTargetFromShareTarget(target),
      sourceAgentId: identity.sourceAgentId,
    }
    if (selectOpenWorkspaceFile(identity.filesId, resolvedPath.filePath, openTarget)) return true

    try {
      const file = await fetchWorkspaceFile(identity.filesId, resolvedPath.filePath)
      openProjectFile(identity.filesId, file, openTarget)
      return true
    } catch {
      return false
    }
  }, [
    activeAgents,
    clearSearch,
    closeSidebarForMobile,
    onOpenTerminal,
    onWorkspaceViewChange,
    openProjectFile,
    projectWorkspaces,
    revealWorkspaceFileInExplorer,
    resolveWorkspaceFileIdentity,
    selectOpenWorkspaceFile,
    workspaceNavigationAgentIds,
  ])
  const restoreWorkspaceShareTargetRef = useRef(restoreWorkspaceShareTarget)
  restoreWorkspaceShareTargetRef.current = restoreWorkspaceShareTarget

  const clearWorkspaceShareLocation = useCallback(() => {
    if (typeof window === 'undefined') return
    const nextSearch = clearWorkspaceShareTargetSearch(window.location.search)
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${nextSearch}${window.location.hash}`)
  }, [])

  useEffect(() => {
    if (!pendingShareTarget) return undefined
    let cancelled = false
    let retryTimer: number | null = null
    const sharedPath = pendingShareTarget.kind === 'agent'
      ? pendingShareTarget.agentId
      : pendingShareTarget.absolutePath || (pendingShareTarget.kind === 'folder' ? pendingShareTarget.folderPath : pendingShareTarget.filePath)

    void restoreWorkspaceShareTargetRef.current(pendingShareTarget)
      .then(restored => {
        if (cancelled) return
        if (restored) {
          setPendingShareTarget(null)
          clearWorkspaceShareLocation()
          return
        }
        shareTargetRestoreAttemptsRef.current += 1
        if (shareTargetRestoreAttemptsRef.current >= 20) {
          setCopyNotice({ id: Date.now(), kind: 'error', message: copy.sharedLocationUnavailable(sharedPath) })
          setPendingShareTarget(null)
          clearWorkspaceShareLocation()
          return
        }
        retryTimer = window.setTimeout(() => {
          setShareTargetRestoreTick(tick => tick + 1)
        }, 250)
      })
      .catch(() => {
        if (!cancelled) {
          setCopyNotice({ id: Date.now(), kind: 'error', message: copy.sharedLocationUnavailable(sharedPath) })
          setPendingShareTarget(null)
          clearWorkspaceShareLocation()
        }
      })

    return () => {
      cancelled = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
    }
  }, [clearWorkspaceShareLocation, copy.sharedLocationUnavailable, pendingShareTarget, shareTargetRestoreTick])

  const restoreWorkspaceNavigationEntry = useCallback(async (entry: WorkspaceNavigationEntry) => {
    if (entry.kind === 'agent') {
      if (!workspaceNavigationAgentIds.has(entry.agentId)) return false
    } else if (!workspaceNavigationFileIds.has(entry.agentId)) {
      return false
    }

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
      sourceAgentId: entry.sourceAgentId,
    }
    const identity = resolveWorkspaceFileIdentity(entry.agentId, entry.sourceAgentId)

    if (selectOpenWorkspaceFile(identity.filesId, entry.filePath, target)) return true

    try {
      const file = await fetchWorkspaceFile(identity.filesId, entry.filePath)
      openProjectFile(identity.filesId, file, target)
      return true
    } catch {
      return false
    }
  }, [
    clearSearch,
    closeSidebarForMobile,
    onOpenTerminal,
    onWorkspaceViewChange,
    openProjectFile,
    resolveWorkspaceFileIdentity,
    selectOpenWorkspaceFile,
    workspaceNavigationAgentIds,
    workspaceNavigationFileIds,
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
    onOpenTerminal(agentId, { focusTerminal: !isMobileTouchViewport() })
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

  const reopenLastClosedWorkspaceFile = useCallback(() => {
    const nextState = workspaceOpenFiles.reopenLastClosed(file => workspaceNavigationFileIds.has(file.agentId))
    const nextFile = nextState?.activeFile
    if (!nextFile) return false

    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    clearSearch()
    onWorkspaceViewChange('projects')
    setMainPaneMode('editor')
    const sourceAgentId = nextFile.sourceAgentId
    if (sourceAgentId && activeAgents.some(agent => agent.id === sourceAgentId)) {
      onOpenTerminal(sourceAgentId, { focusTerminal: false })
    }
    closeSidebarForMobile()
    return true
  }, [activeAgents, clearSearch, closeSidebarForMobile, onOpenTerminal, onWorkspaceViewChange, workspaceNavigationFileIds, workspaceOpenFiles])

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
    const rect = event.currentTarget.getBoundingClientRect()
    const estimatedHeight = isMobileTouchViewport()
      ? MOBILE_PROJECT_CONTEXT_MENU_HEIGHT
      : estimateContextMenuHeight(3)
    const point = isMobileTouchViewport()
      ? mobileActionMenuPoint(rect, estimatedHeight, undefined, MOBILE_PROJECT_CONTEXT_MENU_WIDTH)
      : outwardContextMenuPoint(rect, estimatedHeight)
    setAgentMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    setProjectMenu({
      projectId,
      x: point.x,
      y: point.y,
    })
  }, [])

  const openProjectKeyboardMenu = useCallback((event: ReactKeyboardEvent<HTMLElement>, projectId: string) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return

    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const estimatedHeight = isMobileTouchViewport()
      ? MOBILE_PROJECT_CONTEXT_MENU_HEIGHT
      : estimateContextMenuHeight(3)
    const point = isMobileTouchViewport()
      ? mobileActionMenuPoint(rect, estimatedHeight, undefined, MOBILE_PROJECT_CONTEXT_MENU_WIDTH)
      : outwardContextMenuPoint(rect, estimatedHeight)
    setAgentMenu(null)
    setAgentSessionMenu(null)
    setOptionsMenu(null)
    setProjectMenu({
      projectId,
      x: point.x,
      y: point.y,
    })
  }, [])

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
    setRenameDialog({ kind: 'agent', agentId: contextMenuAgent.id, title: currentTitle })
  }, [contextMenuAgent])

  const renameContextMenuProject = useCallback(() => {
    if (!contextMenuProject) return

    setProjectMenu(null)
    setOptionsMenu(null)
    setRenameDialog({
      kind: 'project',
      projectId: contextMenuProject.id,
      workspace: contextMenuProject.workspace,
      title: contextMenuProject.name,
    })
  }, [contextMenuProject])

  const closeRenameDialog = useCallback(() => {
    const target = renameDialog
    setRenameDialog(null)
    if (!target) return
    if (target.kind === 'agent') focusAgentRow(target.agentId)
    if (target.kind === 'project') focusProjectTitle(target.projectId)
  }, [focusAgentRow, focusProjectTitle, renameDialog])

  const submitRenameDialog = useCallback(() => {
    if (!renameDialog) return
    const title = renameDialog.title.trim()
    if (renameDialog.kind === 'agent') {
      if (!title) return
      onRenameAgent(renameDialog.agentId, title)
      setRenameDialog(null)
      focusAgentRow(renameDialog.agentId)
      return
    }

    if (!title) return
    const nextProjectNames = {
      ...projectNames,
      [renameDialog.workspace]: title,
    }
    setProjectNames(nextProjectNames)
    fetch(appPath('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectNames: nextProjectNames }),
    })
      .then(response => response.json())
      .then((data: { settings?: GlobalSettings }) => {
        const settings = data.settings ?? {}
        setProjectNames(normalizeProjectNames(settings.projectNames))
      })
      .catch(() => {
        setCopyNotice({ id: Date.now(), kind: 'error', message: copy.copyFailed })
      })
    setRenameDialog(null)
    focusProjectTitle(renameDialog.projectId)
  }, [copy.copyFailed, focusAgentRow, focusProjectTitle, onRenameAgent, projectNames, renameDialog])

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
    if (focusTarget?.kind === 'agent-session') focusAgentSessionRow(focusTarget.provider, agentSessionId(focusTarget))
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

  const reorderSidebarAgent = useCallback(async (
    agentId: string,
    beforeAgentId: string,
    afterAgentId: string,
  ) => {
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/reorder`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beforeAgentId, afterAgentId }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error || copy.reorderAgentFailed)
      }
    } catch (error) {
      setCopyNotice({
        id: Date.now(),
        kind: 'error',
        message: error instanceof Error ? error.message : copy.reorderAgentFailed,
      })
    }
  }, [copy.reorderAgentFailed])

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

  const resumeAgentSession = useCallback(async (provider: string, sessionId: string, providerHomeId = '', customTitle = '') => {
    const sessionHandle = agentSessionId({ provider, id: sessionId, providerHomeId })
    const markSessionResumedLocally = () => {
      setAgentSessions(current => current.map(session => (
        session.provider === provider && session.id === sessionId && ((session.providerHomeId || 'default') === (providerHomeId || 'default'))
          ? { ...session, archived: false }
          : session
      )))
    }
    const existingAgent = activeAgents.find(agent => (
      (
        agent.providerSessionKey === sessionHandle
        || agent.source === resumedAgentSource(provider, sessionId, providerHomeId)
      )
      && agent.archived !== true
      && agent.status !== 'dead'
      && agent.status !== 'stopped'
    ))
    if (existingAgent) {
      markSessionResumedLocally()
      addMainPageAgentSession(provider, sessionId, providerHomeId)
      onOpenTerminal(existingAgent.id)
      closeSidebarForMobile()
      return
    }

    try {
      const response = await fetch(appPath(`/api/agent-sessions/${encodeURIComponent(provider)}/${encodeURIComponent(sessionId)}/resume`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unarchiveArchived: true,
          providerHomeId,
          ...(['codex', 'claude', 'opencode', 'qoder'].includes(provider) ? {
            agentRuntimeMode: 'acp',
            acpHistoryMode: 'load',
          } : {}),
          ...(customTitle ? { customTitle } : {}),
        }),
      })
      const data = await response.json().catch(() => null) as { agentId?: string; error?: string } | null
      if (!response.ok || !data?.agentId) {
        setCopyNotice({ id: Date.now(), kind: 'error', message: data?.error || `Failed to resume agent session (${response.status})` })
        return
      }
      markSessionResumedLocally()
      addMainPageAgentSession(provider, sessionId, providerHomeId)
      onOpenTerminalWhenReady(data.agentId)
      closeSidebarForMobile()
    } catch (error) {
      setCopyNotice({ id: Date.now(), kind: 'error', message: error instanceof Error ? error.message : 'Failed to resume agent session' })
    }
  }, [activeAgents, addMainPageAgentSession, closeSidebarForMobile, onOpenTerminal, onOpenTerminalWhenReady])
  resumeAgentSessionRef.current = resumeAgentSession

  const continueArchivedRun = useCallback((entry: TaskHistoryEntry) => {
    const resumedSession = resumedSessionFromHistoryRunSource(entry.source)
    if (resumedSession) {
      resumeAgentSession(resumedSession.provider, resumedSession.sessionId, resumedSession.providerHomeId, entry.customTitle || '')
      onWorkspaceViewChange('projects')
      return
    }

    onNewAgent(projectWorkspaceForHistoryRun(entry), entry.command || undefined, null, entry.customTitle || undefined)
  }, [onNewAgent, onWorkspaceViewChange, resumeAgentSession])

  const openOptionsMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setAgentMenu(null)
    setProjectMenu(null)
    setAgentSessionMenu(null)
    if (!isMobileTouchViewport()) {
      setOptionsMenu(null)
      setSettingsPanelOpen(true)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setOptionsMenu({
      x: Math.max(8, rect.right - 164),
      y: Math.min(window.innerHeight - 12, rect.bottom + 6),
      returnFocusTarget: event.currentTarget,
    })
  }, [])

  const shareCurrentView = useCallback(async () => {
    setOptionsMenu(null)
    try {
      const response = await fetch(appPath('/api/share/qr-ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shareTarget ? { target: shareTarget } : {}),
      })
      const body = await response.json().catch(() => null) as { longUrl?: string; shortUrl?: string; error?: string } | null
      if (!response.ok || (!body?.longUrl && !body?.shortUrl)) {
        throw new Error(body?.error || copy.shareLinkFailed)
      }
      setMobileShareUrl(body.longUrl || body.shortUrl || '')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setCopyNotice({ id: Date.now(), kind: 'error', message: error instanceof Error ? error.message : copy.shareLinkFailed })
    }
  }, [copy.shareLinkFailed, shareTarget])

  const updateLanguagePreference = useCallback((language: UiPreferences['language']) => {
    setOptionsMenu(null)
    onUpdateUiPreferences({ language })
  }, [onUpdateUiPreferences])

  const updateAppearancePreference = useCallback((appearance: UiPreferences['appearance']) => {
    setOptionsMenu(null)
    onUpdateUiPreferences({ appearance })
  }, [onUpdateUiPreferences])

  const openSettingsPanel = useCallback(() => {
    setOptionsMenu(null)
    setSettingsPanelOpen(true)
  }, [])

  const openSettingsFromSidebar = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setOptionsMenu(null)
    setSettingsPanelOpen(true)
  }, [])

  const optionsMenuEntries = useMemo<ContextMenuEntry[]>(() => {
    if (isMobileTouchViewport()) {
      return compactContextMenuEntries([
        { type: 'separator', id: 'options-mobile-share-separator' },
        {
          type: 'item',
          id: 'options-mobile-share',
          label: copy.sharePage,
          ariaLabel: copy.sharePage,
          onSelect: shareCurrentView,
        },
      ])
    }
    return compactContextMenuEntries([
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
    { type: 'separator', id: 'options-settings-separator' },
    {
      type: 'item',
      id: 'options-open-settings',
      label: copy.openSettings,
      ariaLabel: copy.openSettings,
      onSelect: openSettingsPanel,
    },
    ])
  }, [
    copy.appearanceDark,
    copy.appearanceLight,
    copy.languageChinese,
    copy.languageEnglish,
    copy.openSettings,
    copy.sharePage,
    openSettingsPanel,
    shareCurrentView,
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
    if (permissionSwitchingAgentId) return
    if (composerAgentKind === 'claude') {
      const nextMode = isClaudePermissionMode(mode) ? mode : 'default'
      setClaudePermissionMode(nextMode)
      persistAgentLaunchProfile('claude', { permissionMode: nextMode })
      if (activeAgent) {
        setCopyNotice({ id: Date.now(), kind: 'success', message: copy.permissionProfileRestarting })
        void onUpdateAgentFlags(activeAgent.id, { launchPermissionMode: nextMode })
      }
      closeActiveComposerMenus()
      focusComposerTextarea()
      return
    }

    const nextMode = isCodexApprovalMode(mode) ? mode : 'approve'
    setCodexApprovalMode(nextMode)
    persistAgentLaunchProfile('codex', { approvalMode: nextMode })
    if (activeAgent && composerAgentKind === 'codex') {
      setCopyNotice({
        id: Date.now(),
        kind: 'success',
        message: activeAgent.codexRuntimeMode === 'app-server'
          ? copy.permissionProfileApplying
          : copy.permissionProfileRestarting,
      })
      void onUpdateAgentFlags(activeAgent.id, { launchPermissionMode: nextMode })
    }
    closeActiveComposerMenus()
    focusComposerTextarea()
  }, [activeAgent, closeActiveComposerMenus, composerAgentKind, copy.permissionProfileApplying, copy.permissionProfileRestarting, focusComposerTextarea, onUpdateAgentFlags, permissionSwitchingAgentId, persistAgentLaunchProfile])

  const updateAgentRuntimeMode = useCallback((agentId: string, mode: 'terminal' | 'acp') => {
    if (permissionSwitchingAgentId) return
    setCopyNotice({ id: Date.now(), kind: 'success', message: copy.runtimeModeRestarting })
    void onUpdateAgentFlags(agentId, { agentRuntimeMode: mode })
  }, [copy.runtimeModeRestarting, onUpdateAgentFlags, permissionSwitchingAgentId])

  const commitCodexProfile = useCallback((model: string, effort: string, serviceTier: string) => {
    setCodexModel(model)
    setCodexReasoningEffort(effort)
    setCodexServiceTier(serviceTier)
    setCodexModelPreset(`${model}:${effort}`)
    persistAgentLaunchProfile('codex', {
      model,
      reasoningEffort: effort,
      serviceTier,
    })
  }, [persistAgentLaunchProfile])

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
    const nextEffort = reasoningLevels.some(level => level.value === displayedCodexReasoningEffort)
      ? displayedCodexReasoningEffort
      : (option?.defaultEffort || reasoningLevels[0]?.value || displayedCodexReasoningEffort)
    const nextServiceTier = serviceTiers.some(tier => tier.value === displayedCodexServiceTier)
      ? displayedCodexServiceTier
      : 'default'

    closeActiveComposerMenus()
    focusComposerTextarea()
    if (activeAgent && isCodexTerminalAgent(activeAgent)) {
      void applyCodexTerminalProfile(activeAgent, model, nextEffort, nextServiceTier).then(applied => {
        if (applied) commitCodexProfile(model, nextEffort, nextServiceTier)
      })
      return
    }
    commitCodexProfile(model, nextEffort, nextServiceTier)
  }, [activeAgent, applyCodexTerminalProfile, claudeEffort, closeActiveComposerMenus, codexModelOptions, displayedCodexReasoningEffort, displayedCodexServiceTier, commitCodexProfile, composerAgentKind, focusComposerTextarea, persistAgentLaunchProfile])

  const updateAgentModelProfile = useCallback((model: string, effort: string) => {
    if (composerAgentKind !== 'codex') return
    const option = codexModelOptions.find(item => item.value === model)
    if (!option) return
    const nextEffort = option.reasoningLevels?.some(level => level.value === effort)
      ? effort
      : (option.defaultEffort || option.reasoningLevels?.[0]?.value || effort)
    const nextServiceTier = option.serviceTiers?.some(tier => tier.value === displayedCodexServiceTier)
      ? displayedCodexServiceTier
      : 'default'
    if (activeAgent && isCodexTerminalAgent(activeAgent)) {
      void applyCodexTerminalProfile(activeAgent, model, nextEffort, nextServiceTier).then(applied => {
        if (applied) commitCodexProfile(model, nextEffort, nextServiceTier)
      })
      return
    }
    commitCodexProfile(model, nextEffort, nextServiceTier)
  }, [activeAgent, applyCodexTerminalProfile, codexModelOptions, displayedCodexServiceTier, commitCodexProfile, composerAgentKind])

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

    closeActiveComposerMenus()
    focusComposerTextarea()
    if (activeAgent && isCodexTerminalAgent(activeAgent)) {
      void applyCodexTerminalProfile(activeAgent, displayedCodexModel, effort, displayedCodexServiceTier).then(applied => {
        if (applied) commitCodexProfile(displayedCodexModel, effort, displayedCodexServiceTier)
      })
      return
    }
    commitCodexProfile(displayedCodexModel, effort, displayedCodexServiceTier)
  }, [activeAgent, applyCodexTerminalProfile, claudeModel, closeActiveComposerMenus, displayedCodexModel, displayedCodexServiceTier, commitCodexProfile, composerAgentKind, focusComposerTextarea, persistAgentLaunchProfile])

  const updateAgentServiceTier = useCallback((tier: string) => {
    if (composerAgentKind === 'claude') return

    closeActiveComposerMenus()
    focusComposerTextarea()
    if (activeAgent && isCodexTerminalAgent(activeAgent)) {
      void applyCodexTerminalProfile(activeAgent, displayedCodexModel, displayedCodexReasoningEffort, tier).then(applied => {
        if (applied) commitCodexProfile(displayedCodexModel, displayedCodexReasoningEffort, tier)
      })
      return
    }
    commitCodexProfile(displayedCodexModel, displayedCodexReasoningEffort, tier)
  }, [activeAgent, applyCodexTerminalProfile, closeActiveComposerMenus, displayedCodexModel, displayedCodexReasoningEffort, commitCodexProfile, composerAgentKind, focusComposerTextarea])

  const updateAgentServiceTierInline = useCallback((tier: string) => {
    if (composerAgentKind !== 'codex') return
    if (activeAgent && isCodexTerminalAgent(activeAgent)) {
      void applyCodexTerminalProfile(activeAgent, displayedCodexModel, displayedCodexReasoningEffort, tier).then(applied => {
        if (applied) commitCodexProfile(displayedCodexModel, displayedCodexReasoningEffort, tier)
      })
      return
    }
    commitCodexProfile(displayedCodexModel, displayedCodexReasoningEffort, tier)
  }, [activeAgent, applyCodexTerminalProfile, displayedCodexModel, displayedCodexReasoningEffort, commitCodexProfile, composerAgentKind])

  const toggleSpeechInput = useCallback(() => {
    if (speechListening) {
      recognitionRef.current?.stop()
      recognitionRef.current = null
      setSpeechListening(false)
      return
    }

    const targetComposerKey = activeComposerKey
    if (!targetComposerKey) return

    const mobileComposerFallback = isMobileTouchViewport()
    const nativeMobileDictation = shouldUseNativeMobileDictation()
    const SpeechRecognition = speechSupported && !nativeMobileDictation
      ? (window as WindowWithSpeechRecognition).SpeechRecognition
        || (window as WindowWithSpeechRecognition).webkitSpeechRecognition
      : null
    if (!SpeechRecognition) {
      if (shouldUseNativeMobileDictation() || mobileComposerFallback) focusComposerTextarea()
      setSpeechListening(false)
      return
    }

    const recognition = new SpeechRecognition()
    let recognitionStopTimer: number | null = null
    const clearRecognitionStopTimer = () => {
      if (recognitionStopTimer === null) return
      window.clearTimeout(recognitionStopTimer)
      recognitionStopTimer = null
    }
    const stopRecognitionIfCurrent = () => {
      if (recognitionRef.current !== recognition) return
      try {
        recognition.stop()
      } catch {
        setSpeechListening(false)
        recognitionRef.current = null
      }
    }
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = uiPreferences.language === 'zh' ? 'zh-CN' : (navigator.language || 'en-US')
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
      clearRecognitionStopTimer()
      setSpeechListening(false)
    }
    recognition.onspeechend = stopRecognitionIfCurrent
    recognition.onaudioend = stopRecognitionIfCurrent
    recognition.onend = () => {
      clearRecognitionStopTimer()
      setSpeechListening(false)
      recognitionRef.current = null
    }
    recognitionRef.current = recognition
    setSpeechListening(true)
    try {
      recognition.start()
      recognitionStopTimer = window.setTimeout(stopRecognitionIfCurrent, 60_000)
    } catch {
      clearRecognitionStopTimer()
      recognitionRef.current = null
      setSpeechListening(false)
      if (mobileComposerFallback) focusComposerTextarea()
    }
  }, [activeComposerKey, focusComposerTextarea, speechListening, speechSupported, uiPreferences.language, updateComposerStateForKey])

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

  const removeContextProject = useCallback(() => {
    if (
      !contextMenuProject
      || contextMenuProject.hasMain
      || contextMenuProject.agents.length > 0
      || contextMenuProject.agentSessions.length > 0
      || contextMenuProject.hasOpenFile
    ) return
    const previous = projectWorkspacesRef.current
    persistProjectWorkspaces(
      previous.filter(workspace => workspace !== contextMenuProject.workspace),
      previous,
    )
    setProjectMenu(null)
    setOptionsMenu(null)
    restoreProjectListFocusRef.current = 'list'
  }, [contextMenuProject, persistProjectWorkspaces])

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
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeContextMenuAndRestoreFocus()
      return true
    }
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
        isReopenClosedEditorShortcut(event)
        && !isOverlayShortcutTarget(target)
      ) {
        event.preventDefault()
        event.stopPropagation()
        reopenLastClosedWorkspaceFile()
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
        const targetProjectFileSearchId = projectFileSearchIdForShortcutTarget(target) ?? projectFileSearchId
        if (!targetProjectFileSearchId) return
        event.preventDefault()
        focusWorkspaceFilesSearch(targetProjectFileSearchId)
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
  }, [activeView, agentMenu, approvalMenuOpen, closeActiveComposerMenus, closeDeleteWorktreeDialog, closeKillDialog, closeRenameDialog, agentSessionMenu, deleteWorktreeDialog, dialogOpen, focusAgentRow, focusAgentSessionRow, focusComposerTextarea, focusProjectTitle, focusWorkspaceFilesSearch, handleContextMenuNavigation, killDialog, keyboardShortcutsEnabled, modelMenuOpen, navigateWorkspaceHistory, optionsMenu, plusMenuOpen, projectFileSearchId, projectFileSearchIdForShortcutTarget, projectMenu, renameDialog, reopenLastClosedWorkspaceFile, clearSearch, onWorkspaceViewChange, openSearch, toggleSidebar])

  useEffect(() => {
    if (!renameDialog) return
    const initialTitle = renameDialog.title
    let initializedSelection = false
    const focusRenameInput = () => {
      const input = renameInputRef.current
      if (!input) return
      const activeElement = document.activeElement
      if (activeElement !== input && !renameDialogRef.current?.contains(activeElement)) {
        input.focus()
      }
      if (!initializedSelection && document.activeElement === input && input.value === initialTitle) {
        initializedSelection = true
        if (renameDialog.kind === 'project') {
          const cursorPosition = input.value.length
          input.setSelectionRange(cursorPosition, cursorPosition)
          return
        }
        input.select()
      }
    }
    return scheduleFocusRetries(focusRenameInput, { delays: [0, 80, 180, 360] })
  }, [renameDialogIdentity])

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
    const speechViewportQuery = window.matchMedia('(max-width: 980px)')
    const updateSpeechSupported = () => {
      const SpeechRecognition = (window as WindowWithSpeechRecognition).SpeechRecognition
        || (window as WindowWithSpeechRecognition).webkitSpeechRecognition
      setSpeechSupported(Boolean(SpeechRecognition) && !shouldUseNativeMobileDictation())
    }
    updateSpeechSupported()
    speechViewportQuery.addEventListener('change', updateSpeechSupported)

    return () => {
      speechViewportQuery.removeEventListener('change', updateSpeechSupported)
      recognitionRef.current?.stop()
      recognitionRef.current = null
    }
  }, [])

  useEffect(() => loadGlobalSettings(), [loadGlobalSettings])

  useEffect(() => {
    const handleAgentHomesSaved = () => {
      loadGlobalSettings()
      loadAgentSessions()
    }
    window.addEventListener('farming-agent-homes-saved', handleAgentHomesSaved)
    return () => window.removeEventListener('farming-agent-homes-saved', handleAgentHomesSaved)
  }, [loadAgentSessions, loadGlobalSettings])
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
        setProjectWorkspaces(normalizeProjectWorkspaces(settings.projectWorkspaces))
        setProjectWorkspacesLoaded(true)
        setProjectNames(normalizeProjectNames(settings.projectNames))
        if (loadMutationVersion === mainPageSessionKeysMutationRef.current) {
          setMainPageSessionKeys(new Set(normalizeMainPageSessionKeys(settings.mainPageSessionKeys ?? [])))
        }
        applyLaunchSettings(settings)
        loadAgentSessions(true)
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
      const mobileNavigationViewport = isMobileNavigationViewport()
      if (mobileNavigationViewport) {
        if (!mobileNavigationViewportRef.current) autoCollapseSidebar()
        mobileNavigationViewportRef.current = true
        return
      }
      mobileNavigationViewportRef.current = false

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
        displayedProjects={projects}
        collapsedProjectIds={collapsedProjectIds}
        normalizedSearch=""
        hasProjectListItems={hasProjectListItems}
        hasDisplayedProjectListItems={hasProjectListItems}
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
        shareTarget={shareTarget}
        agentLaunchOptions={agentLaunchOptions}
        agentCreationWorkspace={agentCreationWorkspace}
        openWorkspaceFile={openWorkspaceFile}
        openWorkspaceFiles={openWorkspaceFiles}
        fileRevealRequest={fileRevealRequest}
        fileSearchFocusRequest={fileSearchFocusRequest}
        projectListRef={projectListRef}
        canLoadMoreAgentSessions={agentSessionsHasMore}
        onLoadMoreAgentSessions={loadMoreAgentSessions}
        onNewAgent={startNewAgentFromSidebar}
        onStartAgent={startAgentWithLaunchProfile}
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
        onProjectListKeyDown={handleProjectListKeyDown}
        onToggleProject={toggleProject}
        onToggleProjectSessions={toggleProjectSessions}
        onMountProject={mountProject}
        onOpenProjectContextMenu={openProjectContextMenu}
        onOpenProjectKeyboardMenu={openProjectKeyboardMenu}
        onOpenAgent={openTerminalFromSidebar}
        onUpdateAgentFlags={updateSidebarAgentFlags}
        onReorderAgent={reorderSidebarAgent}
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
        onOpenOptionsMenu={openSettingsFromSidebar}
        copy={copy}
      />

      <AgentHomesSettingsPanel
        open={settingsPanelOpen}
        activeAgentId={activeView === 'projects' ? activeAgent?.id ?? null : null}
        language={uiPreferences.language}
        uiPreferences={uiPreferences}
        agentLaunchOptions={agentLaunchOptions}
        onClose={() => setSettingsPanelOpen(false)}
        onUpdateUiPreferences={onUpdateUiPreferences}
      />

      {mobileShareUrl && (
        <MobileShareSheet
          copy={copy}
          title={mobileHeaderTitle}
          url={mobileShareUrl}
          onClose={() => setMobileShareUrl('')}
        />
      )}

      <div
        className="code-sidebar-resizer"
        data-testid="code-sidebar-resizer"
        role="separator"
        aria-label={copy.resizeNavigation}
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarWidth}
        onPointerDown={beginSidebarResize}
      />

      {!sidebarCollapsed && (
        <button
          type="button"
          className="code-mobile-sidebar-backdrop"
          data-testid="code-mobile-sidebar-backdrop"
          aria-label={copy.closeNavigation}
          onPointerDown={autoCollapseSidebar}
        />
      )}

      <div className="code-mobile-topbar" data-testid="code-mobile-topbar">
        {showMobileBackButton ? (
          <button
            type="button"
            className="code-mobile-topbar-button back"
            data-testid="code-mobile-back"
            aria-label={copy.backToAgent}
            onClick={() => {
              if (mobileBackAgentId) backToAgentFromFile(mobileBackAgentId)
            }}
          >
            <span aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="code-mobile-topbar-button menu"
            data-testid="code-mobile-menu"
            aria-label={copy.openNavigation}
            onClick={openMobileSidebar}
          >
            <span aria-hidden="true" />
          </button>
        )}
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
        permissionSwitchingAgentId={permissionSwitchingAgentId}
        agentSwitchingKind={agentSwitchingKind}
        terminalFocusRequest={terminalFocusRequest}
        agentCreationWorkspace={agentCreationWorkspace}
        displayedProjects={searchResultProjects}
        searchQuery={searchQuery}
        searchHasQuery={hasSearchQuery}
        searchLoading={agentSessionSearchLoading}
        visibleSearchTargetCount={visibleSearchTargets.length}
        selectedSearchAgentId={selectedSearchAgentId}
        selectedSearchSessionHandle={selectedSearchSessionHandle}
        searchInputRef={searchInputRef}
        archivedRuns={visibleArchivedRuns}
        archivedAgents={visibleArchivedAgents}
        historyAgentSessions={visibleHistoryAgentSessions}
        canLoadMoreHistoryAgentSessions={agentSessionsHasMore}
        now={now}
        acpComposerProps={{
          active: Boolean(activeAgent) && !activeAgentPermissionSwitching,
          agentId: activeAgent?.id || '',
          runtimeState: activeAgent?.acpState || '',
          sessionUpdatedAt: activeAgent?.acpSessionUpdatedAt || '',
          runtimeError: activeAgent?.acpError || '',
          draft,
          attachments: composerAttachments,
          composerMode,
          contextWindow: activeAgentContextWindow,
          pendingFollowUp: activePendingFollowUp ?? null,
          submitAction: acpComposerSubmitAction,
          textareaRef: composerTextareaRef,
          attachmentInputRef,
          permissions: activeAgent?.acpPendingPermissions?.length
            ? activeAgent.acpPendingPermissions
            : activeAgent?.acpPendingPermission
              ? [activeAgent.acpPendingPermission]
              : [],
          elicitations: activeAgent?.acpPendingElicitations?.length
            ? activeAgent.acpPendingElicitations
            : activeAgent?.acpPendingElicitation
              ? [activeAgent.acpPendingElicitation]
              : [],
          activeElicitations: activeAgent?.acpActiveElicitations || [],
          speechSupported,
          speechListening,
          onDraftChange: handleDraftChange,
          onNavigateHistory: navigateActiveComposerHistory,
          onRemoveAttachment: removeComposerAttachment,
          onSubmit: submitAcpDraft,
          onInterrupt: interruptActiveAgent,
          onDiscardPendingFollowUp: discardPendingFollowUp,
          onToggleSpeechInput: toggleSpeechInput,
          onPasteAttachment: handlePasteAttachment,
          onAttachmentFiles: handleAttachmentFiles,
          onChooseAttachmentFile: chooseAttachmentFile,
          onActivateComposerMode: activateComposerMode,
          onClearComposerMode: () => {
            updateActiveComposerState(state => ({ ...state, mode: 'default' }))
          },
          onRespondToPermission: respondToActiveAcpPermission,
          onRespondToElicitation: respondToActiveAcpElicitation,
        }}
        composerProps={{
          active: Boolean(activeAgent) && !activeAgentPermissionSwitching,
          agentKind: composerAgentKind,
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
          permissionModeDisabled: Boolean(permissionSwitchingAgentId),
          modelProfileDisabled: activeCodexTerminalProfileApplying || Boolean(
            activeAgent
            && isCodexTerminalAgent(activeAgent)
            && activeAgent.terminalStatus?.activity === 'busy'
          ),
          currentPermissionLabel,
          currentPermissionColor,
          permissionModeHint: activeAgent?.codexRuntimeMode === 'app-server'
            ? copy.permissionAppServerHint
            : copy.permissionRestartHint,
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
          appServerRequest: activeAgent?.codexAppServerPendingRequest || null,
          appServerNotice: activeAgent?.codexAppServerNotice || null,
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
          onRespondToAppServerRequest: respondToActiveAppServerRequest,
          onRejectAppServerRequest: rejectActiveAppServerRequest,
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
          onCloseMenus: closeActiveComposerMenus,
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
          onUpdateModelProfile: updateAgentModelProfile,
          onUpdateServiceTierInline: updateAgentServiceTierInline,
          onToggleSpeechInput: toggleSpeechInput,
        }}
        onNewAgent={onNewAgent}
        onOpenTerminal={onOpenTerminal}
        onOpenTerminalPath={openTerminalPathTarget}
        onResolveTerminalPath={resolveTerminalPathTarget}
        onTerminalFollowOutputChange={handleTerminalFollowOutputChange}
        onAgentReadLatest={markAgentReadLatest}
        onRuntimeModeChange={updateAgentRuntimeMode}
        onSessionOutput={onSessionOutput}
        onOpenSearchAgent={openTerminalFromWorkspace}
        onOpenSearchSession={session => {
          resumeAgentSession(session.provider, session.id, session.providerHomeId)
          clearSearch()
          onWorkspaceViewChange('projects')
        }}
        onSearchQueryChange={setSearchQuery}
        onSearchKeyDown={handleSearchInputKeyDown}
        onCloseSearch={closeSearchView}
        onLoadMoreHistoryAgentSessions={loadMoreAgentSessions}
        onSearchHistoryAgentSessions={searchHistoryAgentSessions}
        onResumeHistorySession={resumeAgentSession}
        onContinueArchivedRun={continueArchivedRun}
        onOpenArchivedAgent={openArchivedAgent}
        onRestoreArchivedAgent={restoreArchivedAgent}
        onChangeWorkspaceFileDraft={updateOpenWorkspaceFileDraft}
        onUpdateOpenWorkspaceFile={updateOpenWorkspaceFile}
        onSelectOpenWorkspaceFile={selectOpenWorkspaceFile}
        onOpenWorkspaceFilePath={openWorkspaceFilePath}
        canNavigateWorkspaceBack={canNavigateWorkspaceBack}
        canNavigateWorkspaceForward={canNavigateWorkspaceForward}
        onNavigateWorkspaceHistory={navigateWorkspaceHistory}
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
        onRenameProject={renameContextMenuProject}
        onCopyAgentWorkingDirectory={() => {
          if (!contextMenuAgent) return
          copyContextMenuValue(projectWorkspaceForAgent(contextMenuAgent), { kind: 'agent', id: contextMenuAgent.id })
        }}
        onForkAgent={forkContextMenuAgent}
        onKillAgent={killContextMenuAgent}
        onOpenSession={(provider, sessionId) => {
          setAgentSessionMenu(null)
          setOptionsMenu(null)
          resumeAgentSession(provider, sessionId, contextMenuAgentSession?.providerHomeId)
          if (contextMenuAgentSession) focusAgentSessionRow(provider, agentSessionId(contextMenuAgentSession))
        }}
        onToggleSessionPinned={toggleContextMenuAgentSessionPinned}
        onArchiveSession={archiveContextMenuAgentSession}
        onCopySessionWorkingDirectory={() => {
          if (!contextMenuAgentSession) return
          copyContextMenuValue(agentSessionWorkingDirectory(contextMenuAgentSession), {
            kind: 'agent-session',
            provider: contextMenuAgentSession.provider,
            id: contextMenuAgentSession.id,
            providerHomeId: contextMenuAgentSession.providerHomeId,
          })
        }}
        onArchiveProject={archiveContextProject}
        onRemoveProject={removeContextProject}
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
              <span className="code-options-menu-check" aria-hidden="true">{entry.checked ? <CheckGlyph /> : null}</span>
            )}
            {entry.icon && (
              <span className="code-context-menu-icon" aria-hidden="true">
                <CodexMenuIcon kind={entry.icon} />
              </span>
            )}
            <span>{entry.label}</span>
          </button>
        )
      })}
    </>
  )
}

function CodexMenuIcon({ kind }: { kind: 'rename' | 'archive' }) {
  if (kind === 'archive') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M6.5 8C6.22386 8 6 8.22386 6 8.5C6 8.77614 6.22386 9 6.5 9H9.5C9.77614 9 10 8.77614 10 8.5C10 8.22386 9.77614 8 9.5 8H6.5ZM1 3.5C1 2.67157 1.67157 2 2.5 2H13.5C14.3284 2 15 2.67157 15 3.5V4.5C15 5.15311 14.5826 5.70873 14 5.91465V11.5C14 12.8807 12.8807 14 11.5 14H4.5C3.11929 14 2 12.8807 2 11.5V5.91465C1.4174 5.70873 1 5.15311 1 4.5V3.5ZM2.5 3C2.22386 3 2 3.22386 2 3.5V4.5C2 4.77614 2.22386 5 2.5 5H13.5C13.7761 5 14 4.77614 14 4.5V3.5C14 3.22386 13.7761 3 13.5 3H2.5ZM3 6V11.5C3 12.3284 3.67157 13 4.5 13H11.5C12.3284 13 13 12.3284 13 11.5V6H3Z" />
      </svg>
    )
  }

  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M11.3536 1.64645C10.963 1.25592 10.3299 1.25592 9.93934 1.64645L3.14645 8.43934C3.05268 8.53311 2.99999 8.66029 2.99999 8.79289V11.5C2.99999 11.7761 3.22385 12 3.49999 12H6.2071C6.33971 12 6.46689 11.9473 6.56066 11.8536L13.3536 5.06066C13.7441 4.67014 13.7441 4.037 13.3536 3.64645L11.3536 1.64645ZM3.99999 9L8.99999 4L11 6L6 11H3.99999V9ZM9.7071 3.29289L10.6464 2.35355L12.6464 4.35355L11.7071 5.29289L9.7071 3.29289ZM2.5 14C2.22386 14 2 14.2239 2 14.5C2 14.7761 2.22386 15 2.5 15H13.5C13.7761 15 14 14.7761 14 14.5C14 14.2239 13.7761 14 13.5 14H2.5Z" />
    </svg>
  )
}
