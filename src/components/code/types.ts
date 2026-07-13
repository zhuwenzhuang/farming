import type { Agent } from '@/types/agent'
import type { UiAppearance, UiLanguage } from '@/lib/ui-preferences'

export type { UiAppearance, UiLanguage } from '@/lib/ui-preferences'
export type { WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'

export interface ProjectGroup {
  id: string
  name: string
  workspace: string
  agents: Agent[]
  agentSessions: AgentSessionHistoryItem[]
  hasMain: boolean
  hasProjectAgent: boolean
  hasAgentSession: boolean
  hiddenAgentSessionCount?: number
  agentSessionsExpanded?: boolean
}

export type SearchTarget =
  | { kind: 'agent'; id: string }
  | { kind: 'agent-session'; provider: string; id: string; providerHomeId?: string }

export interface WorkspaceHistorySettings {
  lastMainWorkspace?: string
  workspaceHistory?: string[]
  projectNames?: Record<string, string>
  mainPageSessionKeys?: string[]
}

export type CodexApprovalMode = 'ask' | 'approve' | 'full' | 'custom'
export type CodexRuntimeMode = 'app-server' | 'cli'
export type ClaudePermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan'
export type CodexModelPreset = string
export type MainPaneMode = 'terminal' | 'editor'
export type ComposerMode = 'default' | 'goal' | 'plan'
export type CodeModelPickerPane = 'model' | 'speed' | null

export interface AgentHomeSetting {
  id: string
  path: string
}

export type AgentHomesSettings = Record<string, AgentHomeSetting[]>

export interface GlobalSettings extends WorkspaceHistorySettings {
  appearance?: UiAppearance
  language?: UiLanguage
  dangerouslySkipAgentPermissionsByDefault?: boolean
  updateUrl?: string
  searchTimeoutMs?: number
  codexRuntimeMode?: CodexRuntimeMode
  agentHomes?: AgentHomesSettings
  agentLaunchProfiles?: {
    codex?: {
      approvalMode?: CodexApprovalMode
      modelPreset?: CodexModelPreset
      model?: string
      reasoningEffort?: string
      serviceTier?: string
    }
    claude?: {
      permissionMode?: ClaudePermissionMode
      model?: string
      effort?: string
    }
  }
  codexApprovalMode?: CodexApprovalMode
  codexModelPreset?: CodexModelPreset
  codexModel?: string
  codexReasoningEffort?: string
  codexServiceTier?: string
}

export interface CodexReasoningOption {
  value: string
  label: string
  description?: string
  effort?: string
}

export interface CodexServiceTierOption {
  value: string
  label: string
  description?: string
}

export interface CodexModelOption {
  value: string
  label: string
  displayName?: string
  description?: string
  defaultEffort?: string
  reasoningLevels?: CodexReasoningOption[]
  serviceTiers?: CodexServiceTierOption[]
  source?: string
}

export interface LegacyCodexModelOption {
  value: string
  label: string
  description?: string
  model?: string
  effort?: string
  source?: string
}

export interface AgentSessionHistoryItem {
  provider: string
  providerName?: string
  providerHomeId?: string
  providerHomePath?: string
  id: string
  title: string
  cwd: string
  workspace?: string
  updatedAt: string
  createdAt?: string
  archived?: boolean
  pinned?: boolean
  unread?: boolean
  projectless?: boolean
  model?: string
  effort?: string
  source?: string
  schedule?: AgentSessionSchedule
}

export interface AgentSessionSchedule {
  id?: string
  kind?: string
  name?: string
  status?: string
  rrule?: string
  label?: string
}

export type WorkspaceView = 'projects' | 'search' | 'history'

export type SpeechRecognitionResultLike = {
  isFinal: boolean
  0?: { transcript: string }
}

export type SpeechRecognitionEventLike = Event & {
  resultIndex: number
  results: {
    length: number
    [index: number]: SpeechRecognitionResultLike
  }
}

export type SpeechRecognitionLike = EventTarget & {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: (() => void) | null
  onspeechend?: (() => void) | null
  onaudioend?: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export type WindowWithSpeechRecognition = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}
