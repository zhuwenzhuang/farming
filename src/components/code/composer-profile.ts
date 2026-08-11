import type {
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexModelOption,
  CodexReasoningOption,
  CodexServiceTierOption,
  GlobalSettings,
} from './types'
import {
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

export type ComposerProfileProvider = 'codex' | 'claude'

export interface ComposerProviderProfile {
  permissionMode: string
  model: string
  reasoningEffort: string
  serviceTier: string
}

export type ComposerProviderProfiles = Record<ComposerProfileProvider, ComposerProviderProfile>
export type ComposerLaunchProfileState = ComposerProviderProfiles

export type ComposerProfileSettingsPatch = Record<string, string>
export type ComposerProfileSettingsScope = 'all' | 'permission' | 'model'

export interface CodexComposerProfile {
  model: string
  reasoningEffort: string
  serviceTier: string
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

interface ComposerProviderProfileAdapter {
  defaultProfile: ComposerProviderProfile
  fromSettings(settings: GlobalSettings): ComposerProviderProfile
  normalizePermissionMode(mode: string | undefined): string
  effectivePermissionMode(hasActiveAgent: boolean, launchPermissionMode: string | undefined, fallback: string): string
  modelOptions(profile: ComposerProviderProfile, codexOptions: CodexModelOption[], claudeSettings: ClaudeSettingsSummary): CodexModelOption[]
  resolvedModel(profile: ComposerProviderProfile, claudeSettings: ClaudeSettingsSummary): string
  resolvedReasoningEffort(profile: ComposerProviderProfile, claudeSettings: ClaudeSettingsSummary): string
  reasoningOptions(profile: ComposerProviderProfile, model: CodexModelOption | undefined, claudeSettings: ClaudeSettingsSummary): CodexReasoningOption[]
  serviceTierOptions(model: CodexModelOption | undefined): CodexServiceTierOption[]
  permissionOptions: PermissionModeOption[]
  settingsPatch(profile: ComposerProviderProfile, scope: ComposerProfileSettingsScope): ComposerProfileSettingsPatch
  selectModel(profile: ComposerProviderProfile, model: string, options: CodexModelOption[]): ComposerProviderProfile
  selectReasoningEffort(profile: ComposerProviderProfile, effort: string): ComposerProviderProfile
  selectServiceTier(profile: ComposerProviderProfile, tier: string): ComposerProviderProfile | null
  selectModelProfile(profile: ComposerProviderProfile, model: string, effort: string, options: CodexModelOption[]): ComposerProviderProfile | null
  startOptions(profile: ComposerProviderProfile, options: Record<string, unknown>): Record<string, unknown>
  applyLiveProfile(profile: ComposerProviderProfile, liveProfile: CodexComposerProfile | null | undefined): ComposerProviderProfile
}

const CODEX_APPROVAL_MODE_LABELS: Record<CodexApprovalMode, string> = {
  ask: 'Ask for approval',
  approve: 'Approve for me',
  full: 'Full access',
  custom: 'Custom',
}

const CODEX_APPROVAL_MODE_DESCRIPTIONS: Record<CodexApprovalMode, string> = {
  ask: 'Launch Codex with workspace-write sandbox and ask for untrusted actions',
  approve: 'Launch Codex with workspace-write sandbox and ask when Codex requests approval',
  full: 'Launch Codex with approvals and sandbox bypassed; use only in trusted sandboxes',
  custom: 'Launch Codex with permissions defined in config.toml',
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
  default: 'Launch Claude Code with its default settings',
  auto: 'Launch Claude Code in auto permission mode',
  acceptEdits: 'Launch Claude Code allowing file edits while still asking for other risky actions',
  dontAsk: 'Launch Claude Code avoiding interactive approval prompts where supported',
  plan: 'Launch Claude Code in plan permission mode',
  bypassPermissions: 'Launch Claude Code with permission checks bypassed; use only in trusted sandboxes',
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

export function codexModelOptionsWithCurrent(
  model: string,
  effort: string,
  serviceTier: string,
  options: CodexModelOption[],
) {
  if (!model || options.some(option => option.value === model)) return options
  const serviceTiers: CodexServiceTierOption[] = [
    { value: 'default', label: 'Standard', description: 'Default speed' },
  ]
  if (serviceTier && serviceTier !== 'default') {
    serviceTiers.push({
      value: serviceTier,
      label: serviceTier === 'priority' ? 'Fast' : serviceTier,
    })
  }
  return [
    ...options,
    {
      value: model,
      label: codexModelDisplayName(undefined, model),
      displayName: codexModelDisplayName(undefined, model),
      defaultEffort: effort,
      reasoningLevels: [{ value: effort, effort, label: effortLabel(effort) }],
      serviceTiers,
      source: 'pending-catalog',
    },
  ]
}

const DEFAULT_CODEX_PROFILE: ComposerProviderProfile = {
  permissionMode: 'approve',
  model: 'gpt-5.5',
  reasoningEffort: 'xhigh',
  serviceTier: 'default',
}

const DEFAULT_CLAUDE_PROFILE: ComposerProviderProfile = {
  permissionMode: 'default',
  model: 'config',
  reasoningEffort: 'config',
  serviceTier: '',
}

function codexProfileFromSettings(settings: GlobalSettings): ComposerProviderProfile {
  const profile = settings.agentLaunchProfiles?.codex ?? {}
  const mode = profile.approvalMode ?? settings.codexApprovalMode
  const preset = profile.modelPreset ?? settings.codexModelPreset
  const splitPreset = splitModelPreset(preset)
  return {
    permissionMode: isCodexApprovalMode(mode) ? mode : DEFAULT_CODEX_PROFILE.permissionMode,
    model: profile.model || settings.codexModel || splitPreset.model,
    reasoningEffort: profile.reasoningEffort || settings.codexReasoningEffort || splitPreset.effort,
    serviceTier: profile.serviceTier || settings.codexServiceTier || DEFAULT_CODEX_PROFILE.serviceTier,
  }
}

function claudeProfileFromSettings(settings: GlobalSettings): ComposerProviderProfile {
  const profile = settings.agentLaunchProfiles?.claude ?? {}
  return {
    permissionMode: isClaudePermissionMode(profile.permissionMode)
      ? profile.permissionMode
      : DEFAULT_CLAUDE_PROFILE.permissionMode,
    model: normalizeClaudeModel(profile.model),
    reasoningEffort: normalizeClaudeEffort(profile.effort),
    serviceTier: '',
  }
}

function codexReasoningOptions(profile: ComposerProviderProfile, model: CodexModelOption | undefined) {
  if (model?.reasoningLevels?.length) return model.reasoningLevels
  return profile.reasoningEffort
    ? [{
        value: profile.reasoningEffort,
        effort: profile.reasoningEffort,
        label: effortLabel(profile.reasoningEffort),
      }]
    : []
}

function codexServiceTierOptions(model: CodexModelOption | undefined): CodexServiceTierOption[] {
  return model?.serviceTiers?.length
    ? model.serviceTiers
    : [{ value: 'default', label: 'Standard', description: 'Default speed' }]
}

const COMPOSER_PROVIDER_PROFILE_ADAPTERS: Record<ComposerProfileProvider, ComposerProviderProfileAdapter> = {
  codex: {
    defaultProfile: DEFAULT_CODEX_PROFILE,
    fromSettings: codexProfileFromSettings,
    normalizePermissionMode: mode => isCodexApprovalMode(mode) ? mode : DEFAULT_CODEX_PROFILE.permissionMode,
    effectivePermissionMode: (hasActiveAgent, launchPermissionMode, fallback) => effectiveCodexApprovalModeForSession(
      hasActiveAgent,
      launchPermissionMode,
      isCodexApprovalMode(fallback) ? fallback : 'approve',
    ),
    modelOptions: (profile, options) => codexModelOptionsWithCurrent(
      profile.model,
      profile.reasoningEffort,
      profile.serviceTier,
      options,
    ),
    resolvedModel: profile => profile.model,
    resolvedReasoningEffort: profile => profile.reasoningEffort,
    reasoningOptions: (profile, model) => codexReasoningOptions(profile, model),
    serviceTierOptions: codexServiceTierOptions,
    permissionOptions: CODEX_PERMISSION_OPTIONS,
    settingsPatch: (profile, scope) => ({
      ...(scope !== 'model' ? { approvalMode: profile.permissionMode } : {}),
      ...(scope !== 'permission'
        ? {
            model: profile.model,
            reasoningEffort: profile.reasoningEffort,
            serviceTier: profile.serviceTier,
          }
        : {}),
    }),
    selectModel: (profile, model, options) => {
      const option = options.find(item => item.value === model)
      const reasoningLevels = option?.reasoningLevels ?? []
      const serviceTiers = option?.serviceTiers ?? []
      return {
        ...profile,
        model,
        reasoningEffort: reasoningLevels.some(level => level.value === profile.reasoningEffort)
          ? profile.reasoningEffort
          : (option?.defaultEffort || reasoningLevels[0]?.value || profile.reasoningEffort),
        serviceTier: serviceTiers.some(tier => tier.value === profile.serviceTier)
          ? profile.serviceTier
          : 'default',
      }
    },
    selectReasoningEffort: (profile, effort) => ({ ...profile, reasoningEffort: effort }),
    selectServiceTier: (profile, tier) => ({ ...profile, serviceTier: tier }),
    selectModelProfile: (profile, model, effort, options) => {
      const option = options.find(item => item.value === model)
      if (!option) return null
      return {
        ...profile,
        model,
        reasoningEffort: option.reasoningLevels?.some(level => level.value === effort)
          ? effort
          : (option.defaultEffort || option.reasoningLevels?.[0]?.value || effort),
        serviceTier: option.serviceTiers?.some(tier => tier.value === profile.serviceTier)
          ? profile.serviceTier
          : 'default',
      }
    },
    startOptions: (profile, options) => {
      const requestedMode = typeof options.codexApprovalMode === 'string'
        ? options.codexApprovalMode
        : profile.permissionMode
      const approvalMode = isCodexApprovalMode(requestedMode) ? requestedMode : 'approve'
      return {
        ...options,
        codexApprovalMode: approvalMode,
        ...(approvalMode === 'full' ? { dangerouslySkipPermissions: true } : {}),
      }
    },
    applyLiveProfile: (profile, liveProfile) => ({
      ...profile,
      ...resolveCodexComposerProfile(liveProfile, profile),
    }),
  },
  claude: {
    defaultProfile: DEFAULT_CLAUDE_PROFILE,
    fromSettings: claudeProfileFromSettings,
    normalizePermissionMode: mode => isClaudePermissionMode(mode) ? mode : DEFAULT_CLAUDE_PROFILE.permissionMode,
    effectivePermissionMode: (hasActiveAgent, launchPermissionMode, fallback) => effectiveClaudePermissionModeForSession(
      hasActiveAgent,
      launchPermissionMode,
      isClaudePermissionMode(fallback) ? fallback : 'default',
    ),
    modelOptions: (profile, _options, settings) => claudeModelOptionsWithCurrent(profile.model, settings),
    resolvedModel: (profile, settings) => resolveClaudeModel(profile.model, settings),
    resolvedReasoningEffort: (profile, settings) => resolveClaudeEffort(profile.reasoningEffort, settings),
    reasoningOptions: (profile, _model, settings) => claudeReasoningOptionsWithCurrent(
      resolveClaudeEffort(profile.reasoningEffort, settings),
      settings,
    ),
    serviceTierOptions: () => [],
    permissionOptions: CLAUDE_PERMISSION_OPTIONS,
    settingsPatch: (profile, scope) => ({
      ...(scope !== 'model' ? { permissionMode: profile.permissionMode } : {}),
      ...(scope !== 'permission'
        ? { model: profile.model, effort: profile.reasoningEffort }
        : {}),
    }),
    selectModel: (profile, model) => ({ ...profile, model: normalizeClaudeModel(model) }),
    selectReasoningEffort: (profile, effort) => ({
      ...profile,
      reasoningEffort: normalizeClaudeEffort(effort),
    }),
    selectServiceTier: () => null,
    selectModelProfile: () => null,
    startOptions: (_profile, options) => options,
    applyLiveProfile: profile => profile,
  },
}

function providerProfileAdapter(provider: string | null | undefined): ComposerProviderProfileAdapter | undefined {
  return provider ? COMPOSER_PROVIDER_PROFILE_ADAPTERS[provider as ComposerProfileProvider] : undefined
}

export function isComposerProfileProvider(provider: string | null | undefined): provider is ComposerProfileProvider {
  return Boolean(providerProfileAdapter(provider))
}

export function normalizeLaunchProfiles(settings: GlobalSettings): ComposerLaunchProfileState {
  return {
    codex: COMPOSER_PROVIDER_PROFILE_ADAPTERS.codex.fromSettings(settings),
    claude: COMPOSER_PROVIDER_PROFILE_ADAPTERS.claude.fromSettings(settings),
  }
}

export function defaultComposerProviderProfiles(): ComposerProviderProfiles {
  return {
    codex: { ...COMPOSER_PROVIDER_PROFILE_ADAPTERS.codex.defaultProfile },
    claude: { ...COMPOSER_PROVIDER_PROFILE_ADAPTERS.claude.defaultProfile },
  }
}

export function resolveComposerProviderControlProfile({
  provider,
  profiles,
  hasActiveAgent,
  launchPermissionMode,
  liveProfile,
}: {
  provider: ComposerProfileProvider
  profiles: ComposerProviderProfiles
  hasActiveAgent: boolean
  launchPermissionMode?: string
  liveProfile?: CodexComposerProfile | null
}): ComposerProviderProfile {
  const adapter = COMPOSER_PROVIDER_PROFILE_ADAPTERS[provider]
  const profile = adapter.applyLiveProfile(profiles[provider], liveProfile)
  return {
    ...profile,
    permissionMode: adapter.effectivePermissionMode(
      hasActiveAgent,
      launchPermissionMode,
      profile.permissionMode,
    ),
  }
}

export function composerProfileSettingsPatch(
  provider: ComposerProfileProvider,
  profile: ComposerProviderProfile,
  scope: ComposerProfileSettingsScope = 'all',
) {
  return COMPOSER_PROVIDER_PROFILE_ADAPTERS[provider].settingsPatch(profile, scope)
}

export function selectComposerProviderPermissionMode(
  provider: ComposerProfileProvider,
  profile: ComposerProviderProfile,
  mode: string,
) {
  return {
    ...profile,
    permissionMode: COMPOSER_PROVIDER_PROFILE_ADAPTERS[provider].normalizePermissionMode(mode),
  }
}

export function selectComposerProviderModel(
  provider: ComposerProfileProvider,
  profile: ComposerProviderProfile,
  model: string,
  options: CodexModelOption[],
) {
  return COMPOSER_PROVIDER_PROFILE_ADAPTERS[provider].selectModel(profile, model, options)
}

export function selectComposerProviderReasoningEffort(
  provider: ComposerProfileProvider,
  profile: ComposerProviderProfile,
  effort: string,
) {
  return COMPOSER_PROVIDER_PROFILE_ADAPTERS[provider].selectReasoningEffort(profile, effort)
}

export function selectComposerProviderServiceTier(
  provider: ComposerProfileProvider,
  profile: ComposerProviderProfile,
  tier: string,
) {
  return COMPOSER_PROVIDER_PROFILE_ADAPTERS[provider].selectServiceTier(profile, tier)
}

export function selectComposerProviderModelProfile(
  provider: ComposerProfileProvider,
  profile: ComposerProviderProfile,
  model: string,
  effort: string,
  options: CodexModelOption[],
) {
  return COMPOSER_PROVIDER_PROFILE_ADAPTERS[provider].selectModelProfile(profile, model, effort, options)
}

export function composerAgentStartOptions(
  provider: string | null | undefined,
  profiles: ComposerProviderProfiles,
  options?: Record<string, unknown>,
) {
  const adapter = providerProfileAdapter(provider)
  return adapter && isComposerProfileProvider(provider)
    ? adapter.startOptions(profiles[provider], options || {})
    : options
}

export function resolveCodexComposerProfile(
  liveProfile: CodexComposerProfile | null | undefined,
  fallback: CodexComposerProfile,
): CodexComposerProfile {
  if (!liveProfile?.model || !liveProfile.reasoningEffort) return fallback
  return {
    model: liveProfile.model,
    reasoningEffort: liveProfile.reasoningEffort,
    serviceTier: liveProfile.serviceTier || 'default',
  }
}

export function buildComposerControlState({
  agentKind,
  profile,
  codexModelOptions,
  claudeSettings,
}: {
  agentKind: 'codex' | 'claude' | 'shell' | 'agent' | null
  profile: ComposerProviderProfile
  codexModelOptions: CodexModelOption[]
  claudeSettings: ClaudeSettingsSummary
}): ComposerControlState {
  const adapter = providerProfileAdapter(agentKind) ?? COMPOSER_PROVIDER_PROFILE_ADAPTERS.codex
  const agentModelOptions = adapter.modelOptions(profile, codexModelOptions, claudeSettings)
  const agentModel = adapter.resolvedModel(profile, claudeSettings)
  const agentReasoningEffort = adapter.resolvedReasoningEffort(profile, claudeSettings)
  const agentServiceTier = profile.serviceTier
  const agentModelPreset = `${agentModel}:${agentReasoningEffort}`
  const currentModelOption = agentModelOptions.find(option => option.value === agentModel) ?? agentModelOptions[0]
  const resolvedProfile = { ...profile, model: agentModel, reasoningEffort: agentReasoningEffort }
  const currentReasoningOptions = adapter.reasoningOptions(resolvedProfile, currentModelOption, claudeSettings)
  const currentServiceTierOptions = adapter.serviceTierOptions(currentModelOption)
  const currentReasoningOption = currentReasoningOptions.find(option => option.value === agentReasoningEffort)
    ?? currentReasoningOptions[0]
  const currentServiceTierOption = currentServiceTierOptions.find(option => option.value === agentServiceTier)
    ?? currentServiceTierOptions[0]
  const permissionModeOptions = adapter.permissionOptions
  const currentPermissionMode = profile.permissionMode
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
