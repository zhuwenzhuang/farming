import type {
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexModelOption,
  CodexReasoningOption,
  CodexServiceTierOption,
  GlobalSettings,
} from './types'
import {
  FALLBACK_CODEX_MODEL_OPTIONS,
  codexModelDisplayName,
  effortLabel,
  splitModelPreset,
} from './model'

export type PermissionModeColor = 'blue' | 'orange' | 'muted'

export interface PermissionModeOption {
  value: string
  label: string
  description: string
  color: PermissionModeColor
}

export interface ClaudeSettingsSummary {
  available?: boolean
  effectiveModel?: string
  effectiveEffort?: string
  modelOptions?: CodexModelOption[]
  effortOptions?: CodexReasoningOption[]
}

export interface ComposerLaunchProfileState {
  codexApprovalMode: CodexApprovalMode
  codexModel: string
  codexReasoningEffort: string
  codexServiceTier: string
  codexModelPreset: string
  claudePermissionMode: ClaudePermissionMode
  claudeModel: string
  claudeEffort: string
}

export interface ComposerControlState {
  agentModelOptions: CodexModelOption[]
  agentModel: string
  agentReasoningEffort: string
  agentServiceTier: string
  agentModelPreset: string
  currentModelOption: CodexModelOption | undefined
  currentReasoningOptions: CodexReasoningOption[]
  currentServiceTierOptions: CodexServiceTierOption[]
  currentReasoningOption: CodexReasoningOption | undefined
  currentServiceTierOption: CodexServiceTierOption | undefined
  currentModelLabel: string
  currentReasoningLabel: string
  currentSpeedLabel: string
  permissionModeOptions: PermissionModeOption[]
  currentPermissionMode: string
  currentPermissionOption: PermissionModeOption | undefined
  currentPermissionLabel: string
  currentPermissionColor: PermissionModeColor
}

const CODEX_APPROVAL_MODE_LABELS: Record<CodexApprovalMode, string> = {
  ask: 'Ask for approval',
  approve: 'Approve for me',
  full: 'Full access',
  custom: 'Custom',
}

const CODEX_APPROVAL_MODE_DESCRIPTIONS: Record<CodexApprovalMode, string> = {
  ask: 'Always ask to edit external files and use the internet',
  approve: 'Only ask for actions detected as potentially unsafe',
  full: 'Unrestricted access to the internet and any file on your computer',
  custom: 'Uses permissions defined in config.toml',
}

export const CODEX_PERMISSION_OPTIONS: PermissionModeOption[] = (['ask', 'approve', 'full', 'custom'] as CodexApprovalMode[]).map(mode => ({
  value: mode,
  label: CODEX_APPROVAL_MODE_LABELS[mode],
  description: CODEX_APPROVAL_MODE_DESCRIPTIONS[mode],
  color: mode === 'approve' ? 'blue' : mode === 'full' ? 'orange' : 'muted',
}))

const CLAUDE_PERMISSION_MODE_LABELS: Record<ClaudePermissionMode, string> = {
  default: 'Default',
  auto: 'Auto',
  acceptEdits: 'Accept edits',
  dontAsk: 'Don\'t ask',
  plan: 'Plan',
  bypassPermissions: 'Bypass permissions',
}

const CLAUDE_PERMISSION_MODE_DESCRIPTIONS: Record<ClaudePermissionMode, string> = {
  default: 'Use Claude Code settings',
  auto: 'Let Claude choose when to ask',
  acceptEdits: 'Allow file edits while still asking for other risky actions',
  dontAsk: 'Avoid interactive approval prompts where Claude supports it',
  plan: 'Start Claude Code in plan permission mode',
  bypassPermissions: 'Bypass permission checks for trusted sandboxes only',
}

export const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = ['default', 'auto', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions']

export const CLAUDE_PERMISSION_OPTIONS: PermissionModeOption[] = CLAUDE_PERMISSION_MODES.map(mode => ({
  value: mode,
  label: CLAUDE_PERMISSION_MODE_LABELS[mode],
  description: CLAUDE_PERMISSION_MODE_DESCRIPTIONS[mode],
  color: mode === 'bypassPermissions' ? 'orange' : ['auto', 'acceptEdits', 'plan'].includes(mode) ? 'blue' : 'muted',
}))

export const CLAUDE_EFFORT_OPTIONS = [
  { value: 'low', effort: 'low', label: 'Low' },
  { value: 'medium', effort: 'medium', label: 'Medium' },
  { value: 'high', effort: 'high', label: 'High' },
  { value: 'xhigh', effort: 'xhigh', label: 'Extra High' },
  { value: 'max', effort: 'max', label: 'Max' },
]

const CLAUDE_SETTINGS_LABEL = 'Claude settings'

export const CLAUDE_SETTINGS_EFFORT_OPTION: CodexReasoningOption = {
  value: 'config',
  effort: 'config',
  label: CLAUDE_SETTINGS_LABEL,
}

export const FALLBACK_CLAUDE_MODEL_OPTIONS: CodexModelOption[] = [
  {
    value: 'config',
    label: CLAUDE_SETTINGS_LABEL,
    displayName: CLAUDE_SETTINGS_LABEL,
    defaultEffort: 'config',
    reasoningLevels: [CLAUDE_SETTINGS_EFFORT_OPTION, ...CLAUDE_EFFORT_OPTIONS],
    source: 'settings',
  },
]

export const DEFAULT_CLAUDE_SETTINGS: ClaudeSettingsSummary = {
  available: false,
  effectiveModel: '',
  effectiveEffort: '',
  modelOptions: [],
  effortOptions: CLAUDE_EFFORT_OPTIONS,
}

export function isCodexApprovalMode(mode: string | undefined): mode is CodexApprovalMode {
  return Boolean(mode && mode in CODEX_APPROVAL_MODE_LABELS)
}

export function isClaudePermissionMode(mode: string | undefined): mode is ClaudePermissionMode {
  return Boolean(mode && mode in CLAUDE_PERMISSION_MODE_LABELS)
}

export function effectiveCodexApprovalModeForSession(
  hasActiveAgent: boolean,
  launchPermissionMode: string | undefined,
  fallback: CodexApprovalMode,
): CodexApprovalMode {
  if (!hasActiveAgent) return fallback
  return isCodexApprovalMode(launchPermissionMode) ? launchPermissionMode : 'custom'
}

export function effectiveClaudePermissionModeForSession(
  hasActiveAgent: boolean,
  launchPermissionMode: string | undefined,
  fallback: ClaudePermissionMode,
): ClaudePermissionMode {
  if (!hasActiveAgent) return fallback
  return isClaudePermissionMode(launchPermissionMode) ? launchPermissionMode : 'default'
}

function normalizeClaudeModelValue(model: string | undefined) {
  if (typeof model !== 'string') return ''
  const value = model.trim()
  if (!value || /[\s\x00-\x1f\x7f]/.test(value) || value.startsWith('-')) return ''
  return value
}

export function normalizeClaudeModel(model: string | undefined) {
  if (model === 'config') return model
  return normalizeClaudeModelValue(model) || 'config'
}

function normalizeClaudeEffortValue(effort: string | undefined) {
  return effort && CLAUDE_EFFORT_OPTIONS.some(option => option.value === effort) ? effort : ''
}

export function normalizeClaudeEffort(effort: string | undefined) {
  if (effort === 'config') return effort
  return normalizeClaudeEffortValue(effort) || 'config'
}

function normalizeClaudeEffortOptions(options: CodexReasoningOption[] | undefined) {
  const normalized: CodexReasoningOption[] = []
  if (Array.isArray(options)) {
    options.forEach(option => {
      const value = normalizeClaudeEffortValue(option?.value)
      if (!value) return
      normalized.push({
        value,
        effort: value,
        label: option.label || effortLabel(value),
        description: option.description,
      })
    })
  }

  return normalized.length > 0 ? normalized : CLAUDE_EFFORT_OPTIONS
}

export function normalizeClaudeSettingsSummary(settings: ClaudeSettingsSummary | undefined): ClaudeSettingsSummary {
  const effortOptions = normalizeClaudeEffortOptions(settings?.effortOptions)
  const effectiveModel = normalizeClaudeModelValue(settings?.effectiveModel)
  const effectiveEffort = normalizeClaudeEffortValue(settings?.effectiveEffort)
  const modelOptions: CodexModelOption[] = []

  if (Array.isArray(settings?.modelOptions)) {
    settings.modelOptions.forEach(option => {
      const value = normalizeClaudeModelValue(option?.value)
      if (!value) return
      modelOptions.push({
        ...option,
        value,
        label: option.label || value,
        displayName: option.displayName || value,
        defaultEffort: normalizeClaudeEffortValue(option.defaultEffort) || effectiveEffort || 'medium',
        reasoningLevels: effortOptions,
        source: option.source || 'settings',
      })
    })
  }

  if (effectiveModel && !modelOptions.some(option => option.value === effectiveModel)) {
    modelOptions.unshift({
      value: effectiveModel,
      label: effectiveModel,
      displayName: effectiveModel,
      defaultEffort: effectiveEffort || 'medium',
      reasoningLevels: effortOptions,
      source: 'settings',
    })
  }

  return {
    available: settings?.available === true,
    effectiveModel,
    effectiveEffort,
    modelOptions,
    effortOptions,
  }
}

export function claudeModelOptionsWithCurrent(model: string, settings: ClaudeSettingsSummary): CodexModelOption[] {
  const reasoningLevels = settings.effortOptions?.length ? settings.effortOptions : CLAUDE_EFFORT_OPTIONS
  const options = settings.modelOptions?.length
    ? settings.modelOptions
    : FALLBACK_CLAUDE_MODEL_OPTIONS.map(option => ({ ...option }))
  const normalizedModel = normalizeClaudeModel(model)

  if (!normalizedModel || normalizedModel === 'config' || options.some(option => option.value === normalizedModel)) {
    return options.map(option => ({ ...option, reasoningLevels: option.reasoningLevels?.length ? option.reasoningLevels : reasoningLevels }))
  }

  return [
    ...options.map(option => ({ ...option, reasoningLevels: option.reasoningLevels?.length ? option.reasoningLevels : reasoningLevels })),
    {
      value: normalizedModel,
      label: normalizedModel,
      displayName: normalizedModel,
      defaultEffort: settings.effectiveEffort || 'medium',
      reasoningLevels,
      source: 'settings',
    },
  ]
}

export function resolveClaudeModel(model: string, settings: ClaudeSettingsSummary) {
  if (model !== 'config') return normalizeClaudeModel(model)
  return settings.effectiveModel || settings.modelOptions?.[0]?.value || 'config'
}

export function resolveClaudeEffort(effort: string, settings: ClaudeSettingsSummary) {
  if (effort !== 'config') return normalizeClaudeEffort(effort)
  return settings.effectiveEffort || 'config'
}

export function claudeReasoningOptionsWithCurrent(effort: string, settings: ClaudeSettingsSummary) {
  const options = settings.effortOptions?.length ? settings.effortOptions : CLAUDE_EFFORT_OPTIONS
  if (effort === 'config') return [CLAUDE_SETTINGS_EFFORT_OPTION, ...options]
  if (options.some(option => option.value === effort)) return options

  return [
    ...options,
    {
      value: effort,
      effort,
      label: effortLabel(effort),
    },
  ]
}

export function normalizeLaunchProfiles(settings: GlobalSettings): ComposerLaunchProfileState {
  const codexProfile = settings.agentLaunchProfiles?.codex ?? {}
  const mode = codexProfile.approvalMode ?? settings.codexApprovalMode
  const preset = codexProfile.modelPreset ?? settings.codexModelPreset
  const splitPreset = splitModelPreset(preset)
  const codexModel = codexProfile.model || settings.codexModel || splitPreset.model
  const codexReasoningEffort = codexProfile.reasoningEffort || settings.codexReasoningEffort || splitPreset.effort

  const claudeProfile = settings.agentLaunchProfiles?.claude ?? {}
  return {
    codexApprovalMode: isCodexApprovalMode(mode) ? mode : 'approve',
    codexModel,
    codexReasoningEffort,
    codexServiceTier: codexProfile.serviceTier || settings.codexServiceTier || 'default',
    codexModelPreset: `${codexModel}:${codexReasoningEffort}`,
    claudePermissionMode: isClaudePermissionMode(claudeProfile.permissionMode) ? claudeProfile.permissionMode : 'default',
    claudeModel: normalizeClaudeModel(claudeProfile.model),
    claudeEffort: normalizeClaudeEffort(claudeProfile.effort),
  }
}

export function buildComposerControlState({
  agentKind,
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
}: {
  agentKind: 'codex' | 'claude' | 'shell' | 'agent' | null
  codexModel: string
  codexReasoningEffort: string
  codexServiceTier: string
  codexModelPreset: string
  codexModelOptions: CodexModelOption[]
  codexApprovalMode: CodexApprovalMode
  claudeModel: string
  claudeEffort: string
  claudeSettings: ClaudeSettingsSummary
  claudePermissionMode: ClaudePermissionMode
}): ComposerControlState {
  const resolvedClaudeModel = resolveClaudeModel(claudeModel, claudeSettings)
  const resolvedClaudeEffort = resolveClaudeEffort(claudeEffort, claudeSettings)
  const agentModelOptions = agentKind === 'claude'
    ? claudeModelOptionsWithCurrent(claudeModel, claudeSettings)
    : codexModelOptions
  const agentModel = agentKind === 'claude' ? resolvedClaudeModel : codexModel
  const agentReasoningEffort = agentKind === 'claude' ? resolvedClaudeEffort : codexReasoningEffort
  const agentServiceTier = agentKind === 'claude' ? '' : codexServiceTier
  const agentModelPreset = agentKind === 'claude'
    ? `${agentModel}:${agentReasoningEffort}`
    : codexModelPreset
  const currentModelOption = agentModelOptions.find(option => option.value === agentModel) ?? agentModelOptions[0]
  const currentReasoningOptions = agentKind === 'claude'
    ? claudeReasoningOptionsWithCurrent(agentReasoningEffort, claudeSettings)
    : (currentModelOption?.reasoningLevels?.length
      ? currentModelOption.reasoningLevels
      : FALLBACK_CODEX_MODEL_OPTIONS[0]?.reasoningLevels ?? [])
  const currentServiceTierOptions = agentKind === 'claude'
    ? []
    : currentModelOption?.serviceTiers?.length
      ? currentModelOption.serviceTiers
      : [{ value: 'default', label: 'Standard', description: 'Default speed' }]
  const currentReasoningOption = currentReasoningOptions.find(option => option.value === agentReasoningEffort)
    ?? currentReasoningOptions[0]
  const currentServiceTierOption = currentServiceTierOptions.find(option => option.value === agentServiceTier)
    ?? currentServiceTierOptions[0]
  const permissionModeOptions = agentKind === 'claude' ? CLAUDE_PERMISSION_OPTIONS : CODEX_PERMISSION_OPTIONS
  const currentPermissionMode = agentKind === 'claude' ? claudePermissionMode : codexApprovalMode
  const currentPermissionOption = permissionModeOptions.find(option => option.value === currentPermissionMode)
    ?? permissionModeOptions[0]

  return {
    agentModelOptions,
    agentModel,
    agentReasoningEffort,
    agentServiceTier,
    agentModelPreset,
    currentModelOption,
    currentReasoningOptions,
    currentServiceTierOptions,
    currentReasoningOption,
    currentServiceTierOption,
    currentModelLabel: codexModelDisplayName(currentModelOption, agentModel),
    currentReasoningLabel: currentReasoningOption?.label ?? effortLabel(agentReasoningEffort),
    currentSpeedLabel: currentServiceTierOption?.label ?? '',
    permissionModeOptions,
    currentPermissionMode,
    currentPermissionOption,
    currentPermissionLabel: currentPermissionOption?.label ?? currentPermissionMode,
    currentPermissionColor: currentPermissionOption?.color ?? 'muted',
  }
}
