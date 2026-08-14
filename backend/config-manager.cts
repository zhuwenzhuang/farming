const fs = require('fs');
const path = require('path');
const os = require('os');
import { atomicWriteJson } from './atomic-json-store.cjs';
import { ensureMainAgentSkillFiles } from './main-agent-skills.cjs';
import { ensureFarmingAgentBootstrapFile } from './farming-agent-bootstrap.cjs';
import { normalizeClaudeModelValue } from './claude-settings.cjs';
import { isTemporaryProviderSessionId } from './provider-session-id.cjs';
import {
  decodeProviderSessionKey,
  providerSessionKeyFromIdentity,
} from '../shared/provider-session-identity.js';
import { FarmingSessionStore, MAX_MAIN_PAGE_SESSION_KEYS } from './farming-session-store.cjs';
import { RunHistoryStore } from './run-history-store.cjs';
import { getUserLaunchAgents, isSupportedHistoryAgent } from './cli-agents.cjs';
import { listProviderDescriptors } from './provider-adapters.cjs';
import * as storageLayout from './storage-layout.cjs';
import { COMPUTER_IMAGE } from '../extensions/computer/backend/computer-constants.cjs';
import type {
  AgentDisplayState,
  AgentRecord,
  PersistedAgentPrivateMetadata,
  ProjectMembershipPatch,
  ProjectOperation as AgentProjectOperation,
} from './agent-manager-record-types.js';

type JsonRecord = Record<string, unknown>;

interface ConfigManagerOptions {
  configDir?: string;
  writeJson?: (file: string, value: unknown) => void;
}

export interface AgentHome {
  id: string;
  acpRuntime: {
    mode: 'managed' | 'custom';
    executable: string;
  };
  newAgentDefaults: {
    model: string;
    reasoning: string;
    fast: 'inherit' | 'on' | 'off';
  };
  order: number;
  path: string;
}

type AgentHomes = Record<string, AgentHome[]>;

interface AgentHomeBinding {
  provider: string;
  providerHomeId: string;
  providerHomePath: string;
}

interface CodexLaunchProfile extends JsonRecord {
  approvalMode: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  modelPreset: string;
}

interface ClaudeLaunchProfile extends JsonRecord {
  permissionMode: string;
  model: string;
  effort: string;
}

interface AgentLaunchProfiles {
  [agentName: string]: JsonRecord;
  codex: CodexLaunchProfile;
  claude: ClaudeLaunchProfile;
}

export interface PublicSettings extends JsonRecord {
  agentHomes: AgentHomes;
  agentLaunchProfiles: AgentLaunchProfiles;
  appearance: string;
  browserExecutablePath: string;
  browserExtensionEnabled: boolean;
  browserSource: string;
  computerCompatibilityMode: boolean;
  computerExtensionEnabled: boolean;
  computerImage: string;
  codexApprovalMode: string;
  codexModel: string;
  codexModelPreset: string;
  codexReasoningEffort: string;
  codexServiceTier: string;
  codeContentFontSize: number;
  composerFollowUpBehavior: string;
  crtContentFontSize: number;
  crtDynamicHeatEnabled: boolean;
  crtSkinEffectsEnabled: boolean;
  crtTerminalFontSize: number;
  dangerouslySkipAgentPermissionsByDefault: boolean;
  defaultLaunchAgent: string;
  heartbeatInterval: number;
  instanceName: string;
  language: string;
  lastMainWorkspace: string;
  pinnedProjectWorkspaces: string[];
  projectNames: Record<string, string>;
  projectWorkspaces: string[];
  restReminderIntervalSeconds: number | null;
  searchTimeoutMs: number;
  theme: string;
  version: string;
  workspace: string;
  workspaceHistory: string[];
}

export interface Settings extends PublicSettings {
  projectOperations: Record<string, AgentProjectOperation>;
}

export type PublicSettingsSnapshot = PublicSettings & {
  mainPageSessionKeys: string[];
  projectOperations?: never;
  taskHistory: JsonRecord[];
};

interface SessionStoreLike {
  ensureRecordForAgent(agent: JsonRecord, patch: JsonRecord): string;
  getMainPageSessionKeys(): string[];
  getRecordForProviderSessionKey(sessionKey: string): JsonRecord | null;
  init(options: { legacyMainPageSessionKeys: unknown }): void;
  listAgentRecords(): JsonRecord[];
  rememberAgent(agent: JsonRecord): string;
  rememberMainPageSessionKey(sessionKey: string, patch: JsonRecord): string[];
  removeMainPageSessionKey(sessionKey: string): boolean;
  removeMainPageSessionKeys(keys: unknown): string[];
  persistAgentAdaptiveTitle(agent: JsonRecord, title: unknown): Promise<string>;
  purgeProviderSessionRecords?(keys: unknown): string[];
  persistAgentStatePatch?(
    agent: JsonRecord,
    patch: JsonRecord,
    options?: { beforeCommit?: () => boolean },
  ): Promise<
    | {
      status: 'committed';
      id: string;
      commit: { metadataGeneration: number; stateGeneration: number };
    }
    | { status: 'fenced' }
    | { status: 'legacy-record' }
    | { status: 'record-missing' }
    | { status: 'owner-mismatch' }
  >;
  isAgentStateCommitCurrent?(
    agent: JsonRecord,
    id: string,
    commit: { metadataGeneration: number; stateGeneration: number },
  ): boolean;
  setMainPageSessionKeys(keys: unknown): string[];
  setProviderSessionDisplayState(sessionKey: string, patch: JsonRecord): string;
}

interface RunHistoryStoreLike {
  appendEntry(entry: JsonRecord): void;
  getEntries(): JsonRecord[];
  init(options: { legacyTaskHistory: unknown }): void;
  setEntries(entries: unknown): JsonRecord[];
}

function objectRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function objectProperty(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as JsonRecord)[key]
    : undefined;
}

function spreadableObject(value: unknown): object {
  return value !== null && typeof value === 'object' ? value : {};
}

function validProjectOperationEntry(
  entry: [string, unknown],
): entry is [string, JsonRecord & Pick<AgentProjectOperation, 'state' | 'type'>] {
  const [id, operation] = entry;
  const record = objectRecord(operation);
  return PROJECT_OPERATION_ID_PATTERN.test(id)
    && record !== null
    && (
      record.type === 'create-worktree'
      || record.type === 'delete-worktree'
      || record.type === 'switch-branch'
    )
    && (
      record.state === 'pending'
      || record.state === 'unknown'
      || record.state === 'succeeded'
      || record.state === 'failed'
      || record.state === 'blocked'
    );
}

function splitCodexModelPreset(preset: unknown): { model: string; effort: string } {
  if (preset === 'config') {
    return { model: 'config', effort: 'config' };
  }
  if (typeof preset !== 'string') {
    return { model: 'config', effort: 'config' };
  }

  const [model, effort] = preset.split(':');
  return {
    model: model || 'config',
    effort: effort || 'config',
  };
}

function joinCodexModelPreset(model: string, effort: string): string {
  if (model === 'config') return 'config';
  return effort ? `${model}:${effort}` : model;
}

const DEFAULT_CODEX_LAUNCH_PROFILE: CodexLaunchProfile = {
  approvalMode: 'approve',
  model: 'config',
  reasoningEffort: 'config',
  serviceTier: 'config',
  modelPreset: 'config',
};

const DEFAULT_CLAUDE_LAUNCH_PROFILE: ClaudeLaunchProfile = {
  permissionMode: 'default',
  model: 'config',
  effort: 'config',
};

const DEFAULT_AGENT_LAUNCH_PROFILES: AgentLaunchProfiles = {
  codex: DEFAULT_CODEX_LAUNCH_PROFILE,
  claude: DEFAULT_CLAUDE_LAUNCH_PROFILE,
};

const AGENT_HOME_LAUNCH_PROFILE_OVERRIDES: Record<string, JsonRecord> = {
  codex: {
    model: 'config',
    reasoningEffort: 'config',
    serviceTier: 'config',
    modelPreset: 'config',
  },
  claude: {
    model: 'config',
    effort: 'config',
  },
};

const DEFAULT_LAUNCH_AGENT_NAMES = new Set(
  getUserLaunchAgents().filter(agent => agent.interactive).map(agent => agent.name),
);

const DEFAULT_AGENT_HOMES: AgentHomes = Object.fromEntries(
  listProviderDescriptors().map((provider, order) => [provider.id, [{
    id: 'default',
    path: `~/${provider.defaultHomeDirectory}`,
    order,
    acpRuntime: { mode: 'managed', executable: '' },
    newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
  }]]),
);

const LEGACY_DEFAULT_WORKSPACE_FILE_SEARCH_TIMEOUT_MS = 3000;
const DEFAULT_SEARCH_TIMEOUT_MS = 15000;
const MIN_SEARCH_TIMEOUT_MS = 3000;
const MAX_SEARCH_TIMEOUT_MS = 180000;
const DEFAULT_CODE_CONTENT_FONT_SIZE = 14;
const DEFAULT_CRT_CONTENT_FONT_SIZE = 14;
const MIN_CONTENT_FONT_SIZE = 10;
const MAX_CONTENT_FONT_SIZE = 20;
const DEFAULT_CRT_TERMINAL_FONT_SIZE = 15;
const MIN_CRT_TERMINAL_FONT_SIZE = 10;
const MAX_CRT_TERMINAL_FONT_SIZE = 20;
const MAX_INSTANCE_NAME_LENGTH = 80;
const MAX_PROJECT_OPERATIONS = 32;
const PROJECT_OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function cloneLaunchProfile<T extends object>(profile: T): T {
  return { ...profile };
}

function cloneAgentHomes(agentHomes: AgentHomes): AgentHomes {
  const cloned: AgentHomes = {};
  Object.entries(agentHomes || {}).forEach(([provider, homes]) => {
    cloned[provider] = Array.isArray(homes)
      ? homes.map(home => ({
          ...home,
          acpRuntime: { ...home.acpRuntime },
          newAgentDefaults: { ...home.newAgentDefaults },
        }))
      : [];
  });
  return cloned;
}

class ConfigManager {
  farmingDir: string;
  settings!: Settings;
  settingsFile: string;
  sessionStore: SessionStoreLike;
  runHistoryStore: RunHistoryStoreLike;
  writeJson: (file: string, value: unknown) => void;

  constructor(options: ConfigManagerOptions = {}) {
    this.farmingDir = options.configDir || storageLayout.farmingConfigDir();
    this.settingsFile = storageLayout.settingsFile(this.farmingDir);
    this.sessionStore = new FarmingSessionStore(this.farmingDir, {
      normalizeMainPageSessionKeys: (keys: unknown) => this.normalizeMainPageSessionKeys(keys),
    });
    this.runHistoryStore = new RunHistoryStore(this.farmingDir, {
      normalizeTaskHistory: (entries: unknown) => this.normalizeTaskHistory(entries),
    });
    this.writeJson = typeof options.writeJson === 'function' ? options.writeJson : atomicWriteJson;
  }

  expandWorkspacePath(workspace: unknown): string {
    if (typeof workspace !== 'string') return '';
    const value = workspace.trim();
    if (!value) return '';
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    return value;
  }

  canonicalAgentHomePath(homePath: unknown): string {
    const expanded = this.expandWorkspacePath(homePath);
    if (!expanded) return '';
    const resolved = path.resolve(expanded);
    let canonical = resolved;
    try {
      canonical = fs.realpathSync.native(resolved);
    } catch {
      // A Home may be configured before its provider creates the directory.
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }

  agentHomeBindings(records: PersistedAgentPrivateMetadata[] = this.listAgentSessionRecords()): AgentHomeBinding[] {
    const bindings = new Map<string, AgentHomeBinding>();
    for (const record of records) {
      const provider = String(record.provider || '').trim().toLowerCase();
      const providerHomeId = String(record.providerHomeId || 'default').trim() || 'default';
      const providerHomePath = this.expandWorkspacePath(record.providerHomePath);
      if (!provider || !providerHomePath) continue;
      const key = `${provider}\0${providerHomeId}`;
      const existing = bindings.get(key);
      if (
        existing
        && this.canonicalAgentHomePath(existing.providerHomePath) !== this.canonicalAgentHomePath(providerHomePath)
      ) {
        const error = new Error(
          `${provider} Agent Home "${providerHomeId}" has persisted sessions in more than one path`,
        ) as Error & { code?: string; status?: number };
        error.code = 'AGENT_HOME_BINDING_CONFLICT';
        error.status = 409;
        throw error;
      }
      bindings.set(key, { provider, providerHomeId, providerHomePath });
    }
    return [...bindings.values()];
  }

  assertAgentHomeBindings(nextHomes: AgentHomes): void {
    for (const binding of this.agentHomeBindings()) {
      const configured = (nextHomes[binding.provider] || [])
        .find(home => home.id === binding.providerHomeId);
      if (
        configured
        && this.canonicalAgentHomePath(configured.path) !== this.canonicalAgentHomePath(binding.providerHomePath)
      ) {
        const error = new Error(
          `${binding.provider} Agent Home "${binding.providerHomeId}" already owns persisted Agent sessions at ${binding.providerHomePath}`,
        ) as Error & { code?: string; status?: number };
        error.code = 'AGENT_HOME_REFERENCED';
        error.status = 409;
        throw error;
      }
    }
  }

  isTemporaryWorkspace(workspace: unknown): boolean {
    const resolved = path.resolve(this.expandWorkspacePath(workspace));
    return resolved === '/tmp'
      || resolved.startsWith('/tmp/')
      || resolved === '/private/tmp'
      || resolved.startsWith('/private/tmp/')
      || resolved === '/var/tmp'
      || resolved.startsWith('/var/tmp/')
      || resolved === '/private/var/tmp'
      || resolved.startsWith('/private/var/tmp/')
      || resolved === '/var/folders'
      || resolved.startsWith('/var/folders/')
      || resolved === '/private/var/folders'
      || resolved.startsWith('/private/var/folders/');
  }

  isUsableWorkspace(workspace: unknown): boolean {
    const expanded = this.expandWorkspacePath(workspace);
    if (!expanded || this.isTemporaryWorkspace(expanded)) return false;

    try {
      return fs.statSync(expanded).isDirectory();
    } catch {
      return false;
    }
  }

  isInternalWorkspace(workspace: unknown): boolean {
    const expanded = this.expandWorkspacePath(workspace);
    if (!expanded) return false;

    const resolvedWorkspace = path.resolve(expanded);
    const resolvedFarmingDir = path.resolve(this.farmingDir);
    return resolvedWorkspace === resolvedFarmingDir || path.basename(resolvedWorkspace) === '.farming';
  }

  normalizeMainWorkspace(workspace: unknown, fallback: unknown = this.farmingDir): string {
    const expanded = this.expandWorkspacePath(workspace);
    if (this.isUsableWorkspace(expanded)) {
      return expanded;
    }

    const expandedFallback = this.expandWorkspacePath(fallback);
    if (this.isUsableWorkspace(expandedFallback)) {
      return expandedFallback;
    }

    return this.farmingDir;
  }

  normalizeInstanceName(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_INSTANCE_NAME_LENGTH);
  }

  getInstanceName(): string {
    return this.settings?.instanceName || this.normalizeInstanceName(os.hostname()) || 'Farming';
  }

  normalizeWorkspaceHistory(history: unknown): string[] {
    const entries = Array.isArray(history) ? history : [];
    const result: string[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      const expanded = this.expandWorkspacePath(entry);
      if (!this.isUsableWorkspace(expanded) || this.isInternalWorkspace(expanded) || seen.has(expanded)) continue;
      seen.add(expanded);
      result.push(expanded);
    }

    return result.slice(0, 5);
  }

  rememberWorkspace(workspace: unknown): string[] {
    const expanded = this.expandWorkspacePath(workspace);
    if (!this.isUsableWorkspace(expanded) || this.isInternalWorkspace(expanded)) {
      throw new TypeError('Recent workspace must be an existing non-Farming directory');
    }
    const current = this.normalizeWorkspaceHistory(this.settings.workspaceHistory);
    const next = this.normalizeWorkspaceHistory([
      expanded,
      ...current.filter(entry => entry !== expanded),
    ]);
    if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
      return current;
    }
    this.updateSettings({ workspaceHistory: next });
    return [...this.settings.workspaceHistory];
  }

  normalizeProjectWorkspaces(projects: unknown): string[] {
    const entries = Array.isArray(projects) ? projects : [];
    const result: string[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      const expanded = this.expandWorkspacePath(entry);
      if (!expanded) continue;
      const resolved = path.resolve(expanded);
      if (this.isInternalWorkspace(resolved)) continue;
      let canonical = resolved;
      try {
        canonical = fs.realpathSync(resolved);
      } catch {
        // Project membership is durable. A temporarily unavailable path remains
        // until the user explicitly removes it.
      }
      if (this.isInternalWorkspace(canonical)) continue;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      result.push(canonical);
    }

    return result.slice(0, 200);
  }

  normalizeMainPageSessionKeys(keys: unknown): string[] {
    const entries = Array.isArray(keys) ? keys : [];
    const result: string[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      const identity = decodeProviderSessionKey(entry.trim());
      if (!identity) continue;
      if (identity.sessionId.startsWith('-')) continue;
      if (isTemporaryProviderSessionId(identity.sessionId)) continue;
      const canonicalKey = providerSessionKeyFromIdentity(identity);
      if (seen.has(canonicalKey)) continue;
      seen.add(canonicalKey);
      result.push(canonicalKey);
    }

    return result.slice(0, MAX_MAIN_PAGE_SESSION_KEYS);
  }

  normalizeTaskHistory(history: unknown): JsonRecord[] {
    const entries = Array.isArray(history) ? history : [];
    const normalized: Array<JsonRecord & { archivedAt: number }> = [];
    for (const entry of entries) {
      const record = objectRecord(entry);
      if (!record) continue;
      if (typeof record.id !== 'string' || !record.id) continue;
      if (typeof record.agentId !== 'string' || !record.agentId) continue;
      if (typeof record.reason !== 'string' || !record.reason) continue;
      if (typeof record.archivedAt !== 'number' || !Number.isFinite(record.archivedAt)) continue;
      if (!isSupportedHistoryAgent(record.command)) continue;
      normalized.push({
        id: record.id,
        agentId: record.agentId,
        command: typeof record.command === 'string' ? record.command : '',
        cwd: typeof record.cwd === 'string' ? record.cwd : '',
        projectWorkspace: typeof record.projectWorkspace === 'string' ? record.projectWorkspace : '',
        title: typeof record.title === 'string' ? record.title : '',
        customTitle: typeof record.customTitle === 'string' ? record.customTitle.trim().slice(0, 80) : '',
        task: typeof record.task === 'string' ? record.task : '',
        workflowTemplate: typeof record.workflowTemplate === 'string' ? record.workflowTemplate : '',
        source: typeof record.source === 'string' ? record.source : 'ui',
        reason: record.reason,
        status: typeof record.status === 'string' ? record.status : 'stopped',
        startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
        lastActivity: typeof record.lastActivity === 'number' ? record.lastActivity : null,
        archivedAt: record.archivedAt,
      });
    }
    return normalized
      .sort((a, b) => b.archivedAt - a.archivedAt)
      .slice(0, 200);
  }
  
  buildDefaultSettings(): Settings {
    return {
      workspace: this.farmingDir,
      lastMainWorkspace: this.farmingDir,
      workspaceHistory: [],
      projectWorkspaces: [],
      pinnedProjectWorkspaces: [],
      projectNames: {},
      projectOperations: {},
      instanceName: '',
      theme: 'terminal',
      appearance: 'system',
      language: 'en',
      restReminderIntervalSeconds: null,
      heartbeatInterval: 1000,
      dangerouslySkipAgentPermissionsByDefault: false,
      browserExtensionEnabled: true,
      browserSource: 'system',
      browserExecutablePath: process.env.FARMING_BROWSER_EXECUTABLE || '',
      computerExtensionEnabled: false,
      computerCompatibilityMode: false,
      computerImage: COMPUTER_IMAGE,
      codeContentFontSize: DEFAULT_CODE_CONTENT_FONT_SIZE,
      composerFollowUpBehavior: 'queue',
      crtContentFontSize: DEFAULT_CRT_CONTENT_FONT_SIZE,
      crtSkinEffectsEnabled: true,
      crtDynamicHeatEnabled: false,
      crtTerminalFontSize: DEFAULT_CRT_TERMINAL_FONT_SIZE,
      defaultLaunchAgent: 'codex',
      agentLaunchProfiles: {
        codex: cloneLaunchProfile(DEFAULT_CODEX_LAUNCH_PROFILE),
        claude: cloneLaunchProfile(DEFAULT_CLAUDE_LAUNCH_PROFILE),
      },
      agentHomes: cloneAgentHomes(DEFAULT_AGENT_HOMES),
      searchTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
      codexApprovalMode: 'approve',
      codexModel: 'config',
      codexReasoningEffort: 'config',
      codexServiceTier: 'config',
      codexModelPreset: 'config',
      version: '2'
    };
  }

  normalizePersistedSettings(
    settings: Settings,
    rawSettings: JsonRecord,
    previousMainWorkspace: string,
  ): void {
    settings.workspace = this.farmingDir;
    settings.lastMainWorkspace = this.normalizeMainWorkspace(settings.lastMainWorkspace, previousMainWorkspace);
    settings.workspaceHistory = this.normalizeWorkspaceHistory(settings.workspaceHistory);
    settings.projectWorkspaces = this.normalizeProjectWorkspaces(settings.projectWorkspaces);
    settings.pinnedProjectWorkspaces = this.normalizeProjectWorkspaces(settings.pinnedProjectWorkspaces);
    settings.projectNames = this.normalizeProjectNames(settings.projectNames);
    settings.projectOperations = this.normalizeProjectOperations(settings.projectOperations);
    settings.instanceName = this.normalizeInstanceName(settings.instanceName);
    settings.agentHomes = this.normalizeAgentHomes(settings.agentHomes);
    this.assertAgentHomeBindings(settings.agentHomes);
    settings.searchTimeoutMs = this.normalizeSearchTimeoutMs(settings.searchTimeoutMs);
    settings.appearance = this.normalizeAppearance(settings.appearance);
    settings.language = this.normalizeLanguage(settings.language);
    settings.restReminderIntervalSeconds = this.normalizeRestReminderIntervalSeconds(
      settings.restReminderIntervalSeconds,
    );
    settings.browserExtensionEnabled = settings.browserExtensionEnabled !== false;
    settings.browserSource = this.normalizeBrowserSource(settings.browserSource);
    settings.browserExecutablePath = this.normalizeBrowserSetting(settings.browserExecutablePath);
    settings.computerExtensionEnabled = settings.computerExtensionEnabled === true;
    if (settings.browserExtensionEnabled && settings.browserSource === 'isolated') {
      settings.computerExtensionEnabled = true;
    }
    settings.computerCompatibilityMode = settings.computerCompatibilityMode === true;
    settings.computerImage = this.normalizeBrowserSetting(settings.computerImage) || COMPUTER_IMAGE;
    settings.codeContentFontSize = this.normalizeContentFontSize(
      settings.codeContentFontSize,
      DEFAULT_CODE_CONTENT_FONT_SIZE,
    );
    settings.composerFollowUpBehavior = this.normalizeComposerFollowUpBehavior(
      settings.composerFollowUpBehavior,
    );
    const crtContentFontSize = Object.prototype.hasOwnProperty.call(rawSettings, 'crtContentFontSize')
      ? rawSettings.crtContentFontSize
      : Object.prototype.hasOwnProperty.call(rawSettings, 'crtTerminalFontSize')
        ? Number(rawSettings.crtTerminalFontSize) - 1
        : settings.crtContentFontSize;
    settings.crtContentFontSize = this.normalizeContentFontSize(
      crtContentFontSize,
      DEFAULT_CRT_CONTENT_FONT_SIZE,
    );
    settings.crtSkinEffectsEnabled = settings.crtSkinEffectsEnabled !== false;
    settings.crtDynamicHeatEnabled = settings.crtDynamicHeatEnabled === true;
    settings.crtTerminalFontSize = this.crtTerminalFontSizeFromContent(settings.crtContentFontSize);
    delete settings.updateUrl;
    delete settings.codexRuntimeMode;
    delete settings.mainPageSessionKeys;
    delete settings.taskHistory;
    this.normalizeAgentLaunchSettings(rawSettings, settings);
    this.pruneUnknownSettings(settings);
  }

  init(): void {
    if (!fs.existsSync(this.farmingDir)) {
      fs.mkdirSync(this.farmingDir, { recursive: true });
      console.log('Created farming directory:', this.farmingDir);
    }

    if (!fs.existsSync(this.settingsFile)) {
      this.writeSettingsFile(this.buildDefaultSettings());
      console.log('Created default settings:', this.settingsFile);
    }

    const rawSettings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) as JsonRecord;
    this.settings = {
      ...this.buildDefaultSettings(),
      ...rawSettings
    };
    if (rawSettings.searchTimeoutMs === undefined && rawSettings.workspaceFileSearchTimeoutMs !== undefined) {
      const legacyTimeoutMs = Number(rawSettings.workspaceFileSearchTimeoutMs);
      this.settings.searchTimeoutMs = legacyTimeoutMs === LEGACY_DEFAULT_WORKSPACE_FILE_SEARCH_TIMEOUT_MS
        ? DEFAULT_SEARCH_TIMEOUT_MS
        : legacyTimeoutMs;
    }
    delete this.settings.workspaceFileSearchTimeoutMs;
    if (
      this.settings.dangerouslySkipAgentPermissionsByDefault === undefined
      && this.settings.skipPermissionCheckByDefault !== undefined
    ) {
      this.settings.dangerouslySkipAgentPermissionsByDefault = this.settings.skipPermissionCheckByDefault === true;
    }
    delete this.settings.skipPermissionCheckByDefault;
    const launchRawSettings = { ...rawSettings };
    if (rawSettings.codexApprovalMode === undefined && this.settings.dangerouslySkipAgentPermissionsByDefault === true) {
      this.settings.codexApprovalMode = 'full';
      launchRawSettings.codexApprovalMode = 'full';
    }
    const legacyMainPageSessionKeys = this.normalizeMainPageSessionKeys(this.settings.mainPageSessionKeys);
    this.sessionStore.init({ legacyMainPageSessionKeys });
    const legacyTaskHistory = this.normalizeTaskHistory(this.settings.taskHistory);
    this.runHistoryStore.init({ legacyTaskHistory });
    this.normalizePersistedSettings(this.settings, launchRawSettings, this.farmingDir);
    ensureMainAgentSkillFiles(this.farmingDir);
    ensureFarmingAgentBootstrapFile(this.farmingDir);
    this.writeSettingsFile();
    console.log('Loaded settings:', this.settings);
  }

  pruneUnknownSettings(settings: Settings = this.settings): void {
    const persistedSettingKeys = new Set(Object.keys(this.buildDefaultSettings()));
    for (const key of Object.keys(settings || {})) {
      if (!persistedSettingKeys.has(key)) {
        delete settings[key];
      }
    }
  }

  normalizeDefaultLaunchAgent(agentName: unknown): string {
    return typeof agentName === 'string' && DEFAULT_LAUNCH_AGENT_NAMES.has(agentName) ? agentName : 'codex';
  }

  normalizeSearchTimeoutMs(value: unknown): number {
    const timeoutMs = Number(value);
    if (!Number.isFinite(timeoutMs)) return DEFAULT_SEARCH_TIMEOUT_MS;
    return Math.min(
      MAX_SEARCH_TIMEOUT_MS,
      Math.max(MIN_SEARCH_TIMEOUT_MS, Math.round(timeoutMs))
    );
  }

  normalizeContentFontSize(value: unknown, fallback: number): number {
    const fontSize = Number(value);
    if (!Number.isFinite(fontSize)) return fallback;
    return Math.min(MAX_CONTENT_FONT_SIZE, Math.max(MIN_CONTENT_FONT_SIZE, Math.round(fontSize)));
  }

  normalizeComposerFollowUpBehavior(value: unknown): 'queue' | 'steer' {
    return value === 'steer' ? 'steer' : 'queue';
  }

  crtTerminalFontSizeFromContent(value: unknown): number {
    return this.normalizeCrtTerminalFontSize(
      this.normalizeContentFontSize(value, DEFAULT_CRT_CONTENT_FONT_SIZE) + 1,
    );
  }

  normalizeRestReminderIntervalSeconds(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const seconds = Number(value);
    if (!Number.isInteger(seconds)) return null;
    if (seconds === 0 || seconds === 5) return seconds;
    return seconds >= 60 && seconds <= 240 * 60 && seconds % 60 === 0
      ? seconds
      : null;
  }

  normalizeCrtTerminalFontSize(value: unknown): number {
    const fontSize = Number(value);
    if (!Number.isFinite(fontSize)) return DEFAULT_CRT_TERMINAL_FONT_SIZE;
    return Math.min(
      MAX_CRT_TERMINAL_FONT_SIZE,
      Math.max(MIN_CRT_TERMINAL_FONT_SIZE, Math.round(fontSize))
    );
  }

  normalizeAgentHomes(agentHomes: unknown): AgentHomes {
    const source = objectRecord(agentHomes) || {};
    const normalized: AgentHomes = {};

    Object.entries(source).forEach(([rawProvider, rawHomes]) => {
      const provider = String(rawProvider || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]+$/.test(provider)) return;
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_AGENT_HOMES, provider)) return;
      if (!Array.isArray(rawHomes)) return;

      const seenIds = new Set<string>();
      const seenPaths = new Map<string, string>();
      const homes: AgentHome[] = [];
      rawHomes.forEach((rawHome, homeIndex) => {
        const record = objectRecord(rawHome);
        if (!record) return;
        const id = String(record.id || '').trim();
        const homePath = String(record.path || '').trim();
        if (!id || !homePath) return;
        if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
        const idKey = id.toLowerCase();
        if (seenIds.has(idKey)) {
          const error = new Error(`${provider} contains more than one Agent Home named "${id}"`) as Error & { code?: string; status?: number };
          error.code = 'AGENT_HOME_DUPLICATE_ID';
          error.status = 409;
          throw error;
        }
        seenIds.add(idKey);
        const canonicalPath = this.canonicalAgentHomePath(homePath);
        const existingPathHomeId = seenPaths.get(canonicalPath);
        if (existingPathHomeId) {
          const error = new Error(
            `${provider} Agent Homes "${existingPathHomeId}" and "${id}" use the same Home path`,
          ) as Error & { code?: string; status?: number };
          error.code = 'AGENT_HOME_DUPLICATE_PATH';
          error.status = 409;
          throw error;
        }
        seenPaths.set(canonicalPath, id);
        const rawDefaults = objectRecord(record.newAgentDefaults) || {};
        const model = String(rawDefaults.model || 'inherit').trim();
        const reasoning = String(rawDefaults.reasoning || 'inherit').trim();
        const fast = String(rawDefaults.fast || 'inherit').trim();
        const providerRank = Object.keys(DEFAULT_AGENT_HOMES).indexOf(provider);
        const requestedOrder = Number(record.order);
        homes.push({
          id,
          path: homePath,
          order: Number.isFinite(requestedOrder) && requestedOrder >= 0
            ? requestedOrder
            : (providerRank * 1000) + homeIndex,
          acpRuntime: { mode: 'managed', executable: '' },
          newAgentDefaults: {
            model: model && model.length <= 200 && !/[\r\n\0]/.test(model) ? model : 'inherit',
            reasoning: /^[A-Za-z0-9._-]{1,80}$/.test(reasoning) ? reasoning : 'inherit',
            fast: fast === 'on' || fast === 'off' ? fast : 'inherit',
          },
        });
      });
      if (homes.length > 0) normalized[provider] = homes;
    });

    for (const [provider, homes] of Object.entries(DEFAULT_AGENT_HOMES)) {
      const defaultHome = homes[0];
      const providerHomes = normalized[provider] || [];
      if (!providerHomes.some(home => String(home.id || '').toLowerCase() === 'default')) {
        normalized[provider] = [{
          ...defaultHome,
          acpRuntime: { ...defaultHome.acpRuntime },
          newAgentDefaults: { ...defaultHome.newAgentDefaults },
        }, ...providerHomes];
      }
    }

    for (const [provider, homes] of Object.entries(normalized)) {
      const ownersByPath = new Map<string, string>();
      for (const home of homes) {
        const canonicalPath = this.canonicalAgentHomePath(home.path);
        const existingHomeId = ownersByPath.get(canonicalPath);
        if (existingHomeId && existingHomeId !== home.id) {
          const error = new Error(
            `${provider} Agent Homes "${existingHomeId}" and "${home.id}" use the same Home path`,
          ) as Error & { code?: string; status?: number };
          error.code = 'AGENT_HOME_DUPLICATE_PATH';
          error.status = 409;
          throw error;
        }
        ownersByPath.set(canonicalPath, home.id);
      }
    }

    return normalized;
  }

  normalizeProjectNames(projectNames: unknown): Record<string, string> {
    const source = objectRecord(projectNames);
    if (!source) return {};
    const normalized: Record<string, string> = {};
    Object.entries(source).forEach(([workspace, name]) => {
      const key = this.expandWorkspacePath(String(workspace || '').trim());
      const value = String(name || '').trim().slice(0, 80);
      if (!key || !value) return;
      normalized[key] = value;
    });
    return normalized;
  }

  normalizeProjectOperations(projectOperations: unknown): Record<string, AgentProjectOperation> {
    const source = objectRecord(projectOperations);
    if (!source) return {};
    const entries: Array<[string, AgentProjectOperation]> = Object.entries(source)
      .filter(validProjectOperationEntry)
      .sort((left, right) => (Number(right[1].updatedAt) || 0) - (Number(left[1].updatedAt) || 0))
      .map(([id, operation]) => {
        const normalizedOperation: AgentProjectOperation = {
          id,
          type: operation.type,
          state: operation.state,
          signature: typeof operation.signature === 'string' ? operation.signature.slice(0, 128) : '',
          request: objectRecord(operation.request)
            ? objectRecord(JSON.parse(JSON.stringify(operation.request))) || {}
            : {},
          result: objectRecord(operation.result)
            ? objectRecord(JSON.parse(JSON.stringify(operation.result)))
            : null,
          error: typeof operation.error === 'string' ? operation.error.slice(0, 2000) : '',
          startedAt: Number(operation.startedAt) || 0,
          updatedAt: Number(operation.updatedAt) || 0,
          finishedAt: Number(operation.finishedAt) || null,
        };
        return [id, normalizedOperation];
      });
    const unresolved = entries.filter(([, operation]) => (
      ['pending', 'unknown', 'blocked'].includes(operation.state)
    ));
    const terminal = entries.filter(([, operation]) => (
      !['pending', 'unknown', 'blocked'].includes(operation.state)
    ));
    return Object.fromEntries([
      ...unresolved,
      ...terminal.slice(0, Math.max(0, MAX_PROJECT_OPERATIONS - unresolved.length)),
    ]);
  }

  setProjectName(workspace: unknown, name: unknown): { workspace: string; name: string } {
    const normalized = this.normalizeProjectNames({ [String(workspace)]: name });
    const entry = Object.entries(normalized)[0];
    if (!entry) throw new Error('Project workspace and name are required');
    const [normalizedWorkspace, normalizedName] = entry;
    const nextSettings = {
      ...this.settings,
      projectNames: {
        ...this.settings.projectNames,
        [normalizedWorkspace]: normalizedName,
      },
    };
    this.writeSettingsFile(nextSettings);
    this.settings = nextSettings;
    return {
      workspace: normalizedWorkspace,
      name: normalizedName,
    };
  }

  normalizeAppearance(appearance: unknown): string {
    return typeof appearance === 'string' && ['system', 'light', 'dark', 'paper'].includes(appearance)
      ? appearance
      : 'system';
  }

  normalizeLanguage(language: unknown): string {
    return typeof language === 'string' && ['en', 'zh'].includes(language) ? language : 'en';
  }

  normalizeBrowserSource(source: unknown): string {
    return typeof source === 'string' && ['extension', 'isolated'].includes(source)
      ? source
      : 'system';
  }

  normalizeBrowserSetting(value: unknown): string {
    return String(value || '').trim().slice(0, 2000);
  }

  normalizeClaudePermissionMode(mode: unknown): string {
    return typeof mode === 'string'
      && ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'].includes(mode)
      ? mode
      : 'default';
  }

  normalizeClaudeModel(model: unknown): string {
    if (model === 'config') return model;
    return normalizeClaudeModelValue(model) || 'config';
  }

  normalizeClaudeEffort(effort: unknown): string {
    if (effort === 'config') return effort;
    if (typeof effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort;
    return 'config';
  }

  normalizeCodexApprovalMode(mode: unknown): string {
    return typeof mode === 'string' && ['ask', 'approve', 'full', 'custom'].includes(mode) ? mode : 'approve';
  }

  normalizeCodexModelPreset(preset: unknown): string {
    if (preset === 'config') return preset;
    if (typeof preset !== 'string') return 'config';
    if (/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(preset)) return preset;
    return 'config';
  }

  normalizeCodexModelId(model: unknown): string {
    if (model === 'config') return model;
    if (typeof model !== 'string') return 'config';
    if (/^[A-Za-z0-9._-]+$/.test(model)) return model;
    return 'config';
  }

  normalizeCodexReasoningEffort(effort: unknown): string {
    if (effort === 'config') return effort;
    if (typeof effort !== 'string') return 'config';
    if (/^[A-Za-z0-9._-]+$/.test(effort)) return effort;
    return 'config';
  }

  normalizeCodexServiceTier(tier: unknown): string {
    if (typeof tier !== 'string') return 'config';
    if (/^[A-Za-z0-9._-]+$/.test(tier)) return tier;
    return 'config';
  }

  normalizeCodexModelSettings(rawSettings: JsonRecord = {}): void {
    const codexProfile = this.normalizeCodexLaunchProfile({
      approvalMode: this.settings.codexApprovalMode,
      model: this.settings.codexModel,
      reasoningEffort: this.settings.codexReasoningEffort,
      serviceTier: this.settings.codexServiceTier,
      modelPreset: this.settings.codexModelPreset,
    }, {
      approvalMode: rawSettings.codexApprovalMode,
      model: rawSettings.codexModel,
      reasoningEffort: rawSettings.codexReasoningEffort,
      serviceTier: rawSettings.codexServiceTier,
      modelPreset: rawSettings.codexModelPreset,
    });
    this.applyCodexProfileToLegacySettings(codexProfile);
  }

  normalizeCodexLaunchProfile(
    profile: unknown = {},
    changed: JsonRecord = {},
  ): CodexLaunchProfile {
    const next = {
      ...DEFAULT_CODEX_LAUNCH_PROFILE,
      ...spreadableObject(profile),
    };
    next.approvalMode = this.normalizeCodexApprovalMode(next.approvalMode);

    const hasDirectModelChange = changed.model !== undefined || changed.reasoningEffort !== undefined;
    const hasPresetChange = changed.modelPreset !== undefined;
    const normalizedPreset = this.normalizeCodexModelPreset(next.modelPreset);
    if (hasPresetChange && !hasDirectModelChange) {
      const fromPreset = splitCodexModelPreset(normalizedPreset);
      next.model = fromPreset.model;
      next.reasoningEffort = fromPreset.effort;
    } else {
      next.model = this.normalizeCodexModelId(next.model);
      next.reasoningEffort = this.normalizeCodexReasoningEffort(next.reasoningEffort);
    }
    next.serviceTier = this.normalizeCodexServiceTier(next.serviceTier);
    next.modelPreset = joinCodexModelPreset(
      next.model,
      next.reasoningEffort === 'config' ? '' : next.reasoningEffort
    );
    return next as CodexLaunchProfile;
  }

  normalizeClaudeLaunchProfile(profile: unknown = {}): ClaudeLaunchProfile {
    const next = {
      ...DEFAULT_CLAUDE_LAUNCH_PROFILE,
      ...spreadableObject(profile),
    };
    return {
      permissionMode: this.normalizeClaudePermissionMode(next.permissionMode),
      model: this.normalizeClaudeModel(next.model),
      effort: this.normalizeClaudeEffort(next.effort),
    };
  }

  getChangedAgentLaunchProfiles(rawSettings: JsonRecord = {}): Record<string, JsonRecord> {
    const changedProfiles: Record<string, JsonRecord> = {};
    if (rawSettings.agentLaunchProfiles && typeof rawSettings.agentLaunchProfiles === 'object') {
      for (const [agentName, profile] of Object.entries(rawSettings.agentLaunchProfiles)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_AGENT_LAUNCH_PROFILES, agentName)) continue;
        if (profile && typeof profile === 'object') changedProfiles[agentName] = profile as JsonRecord;
      }
    }

    const codexChanged: JsonRecord = {};
    if (rawSettings.codexApprovalMode !== undefined) codexChanged.approvalMode = rawSettings.codexApprovalMode;
    if (rawSettings.codexModel !== undefined) codexChanged.model = rawSettings.codexModel;
    if (rawSettings.codexReasoningEffort !== undefined) codexChanged.reasoningEffort = rawSettings.codexReasoningEffort;
    if (rawSettings.codexServiceTier !== undefined) codexChanged.serviceTier = rawSettings.codexServiceTier;
    if (rawSettings.codexModelPreset !== undefined) codexChanged.modelPreset = rawSettings.codexModelPreset;
    if (Object.keys(codexChanged).length > 0) {
      changedProfiles.codex = {
        ...(changedProfiles.codex || {}),
        ...codexChanged,
      };
    }

    return changedProfiles;
  }

  mergeAgentLaunchProfiles(
    existingProfiles: unknown = {},
    incomingProfiles: unknown = {},
  ): AgentLaunchProfiles {
    const merged: AgentLaunchProfiles = {
      codex: cloneLaunchProfile(DEFAULT_CODEX_LAUNCH_PROFILE),
      claude: cloneLaunchProfile(DEFAULT_CLAUDE_LAUNCH_PROFILE),
    };
    for (const [agentName, defaultProfile] of Object.entries(DEFAULT_AGENT_LAUNCH_PROFILES)) {
      merged[agentName] = {
        ...defaultProfile,
        ...spreadableObject(objectProperty(existingProfiles, agentName)),
        ...spreadableObject(objectProperty(incomingProfiles, agentName)),
      };
    }
    return merged;
  }

  applyCodexProfileToLegacySettings(
    codexProfile: CodexLaunchProfile,
    settings: Settings = this.settings,
  ): void {
    settings.codexApprovalMode = codexProfile.approvalMode;
    settings.codexModel = codexProfile.model;
    settings.codexReasoningEffort = codexProfile.reasoningEffort;
    settings.codexServiceTier = codexProfile.serviceTier;
    settings.codexModelPreset = codexProfile.modelPreset;
  }

  normalizeAgentLaunchSettings(
    rawSettings: JsonRecord = {},
    settings: Settings = this.settings,
  ): void {
    const changedProfiles = this.getChangedAgentLaunchProfiles(rawSettings);
    const mergedProfiles = this.mergeAgentLaunchProfiles(settings.agentLaunchProfiles, changedProfiles);
    settings.agentLaunchProfiles = {
      codex: this.normalizeCodexLaunchProfile(mergedProfiles.codex, changedProfiles.codex || {}),
      claude: this.normalizeClaudeLaunchProfile(mergedProfiles.claude),
    };
    settings.defaultLaunchAgent = this.normalizeDefaultLaunchAgent(settings.defaultLaunchAgent);
    this.applyCodexProfileToLegacySettings(settings.agentLaunchProfiles.codex, settings);
  }
  
  getWorkspace(): string {
    return this.settings ? this.settings.workspace : this.farmingDir;
  }
  
  getHeartbeatInterval(): number {
    return this.settings ? (this.settings.heartbeatInterval || 1000) : 1000;
  }

  getDangerouslySkipAgentPermissionsByDefault(): boolean {
    return this.settings ? this.settings.dangerouslySkipAgentPermissionsByDefault === true : false;
  }

  getCodexApprovalMode(): string {
    if (!this.settings) return 'approve';
    return this.getAgentLaunchProfile('codex').approvalMode;
  }

  getCodexModelPreset(): string {
    if (!this.settings) return 'config';
    return this.getAgentLaunchProfile('codex').modelPreset;
  }

  getCodexModel(): string {
    if (!this.settings) return 'config';
    return this.getAgentLaunchProfile('codex').model;
  }

  getCodexReasoningEffort(): string {
    if (!this.settings) return 'config';
    return this.getAgentLaunchProfile('codex').reasoningEffort;
  }

  getCodexServiceTier(): string {
    if (!this.settings) return 'config';
    return this.getAgentLaunchProfile('codex').serviceTier;
  }


  getAgentHomes(provider: unknown): AgentHome[] {
    const providerKey = String(provider);
    const homes = this.settings && this.settings.agentHomes && this.settings.agentHomes[providerKey]
      ? this.settings.agentHomes[providerKey]
      : [];
    return homes.map(home => ({
      ...home,
      acpRuntime: { ...home.acpRuntime },
      newAgentDefaults: { ...home.newAgentDefaults },
      path: this.expandWorkspacePath(home.path),
    }));
  }

  getAgentHome(provider: unknown, homeId: unknown = 'default'): AgentHome | null {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const normalizedHomeId = String(homeId || 'default').trim();
    const homes = this.getAgentHomes(normalizedProvider);
    return homes.find(home => home.id === normalizedHomeId) || null;
  }

  getKnownAgentHomes(
    provider: unknown,
    bindings: AgentHomeBinding[] = this.agentHomeBindings(),
  ): AgentHome[] {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const homes = this.getAgentHomes(normalizedProvider);
    const knownIds = new Set(homes.map(home => home.id));
    for (const binding of bindings) {
      if (binding.provider !== normalizedProvider || knownIds.has(binding.providerHomeId)) continue;
      knownIds.add(binding.providerHomeId);
      homes.push({
        id: binding.providerHomeId,
        path: binding.providerHomePath,
        order: Number.MAX_SAFE_INTEGER,
        acpRuntime: { mode: 'managed', executable: '' },
        newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
      });
    }
    return homes;
  }

  getKnownAgentHome(provider: unknown, homeId: unknown = 'default'): AgentHome | null {
    const normalizedHomeId = String(homeId || 'default').trim();
    return this.getKnownAgentHomes(provider).find(home => home.id === normalizedHomeId) || null;
  }

  getDefaultLaunchAgent(): string {
    return this.settings ? this.normalizeDefaultLaunchAgent(this.settings.defaultLaunchAgent) : 'codex';
  }

  getAgentLaunchProfiles(): AgentLaunchProfiles {
    const profiles = this.settings && this.settings.agentLaunchProfiles
      ? this.settings.agentLaunchProfiles
      : DEFAULT_AGENT_LAUNCH_PROFILES;
    return {
      codex: { ...profiles.codex },
      claude: { ...profiles.claude },
    };
  }

  getAgentLaunchProfile(agentName: 'codex'): CodexLaunchProfile;
  getAgentLaunchProfile(agentName: 'claude'): ClaudeLaunchProfile;
  getAgentLaunchProfile(agentName: unknown): JsonRecord;
  getAgentLaunchProfile(agentName: unknown): JsonRecord {
    const profiles = this.getAgentLaunchProfiles();
    const profileName = String(agentName);
    const profile = profiles[profileName] || DEFAULT_AGENT_LAUNCH_PROFILES[profileName];
    return profile ? { ...profile } : {};
  }

  getAgentLaunchProfileForHome(agentName: unknown, homeId: unknown = 'default'): JsonRecord {
    const provider = String(agentName || '').trim().toLowerCase();
    const profile = this.getAgentLaunchProfile(provider);
    const home = this.getAgentHome(provider, homeId);
    if (!home) return profile;
    return {
      ...profile,
      ...(AGENT_HOME_LAUNCH_PROFILE_OVERRIDES[provider] || {}),
    };
  }

  getSettings(): PublicSettingsSnapshot {
    const {
      projectOperations: _privateProjectOperations,
      ...publicSettings
    } = this.settings;
    return {
      ...publicSettings,
      instanceName: this.getInstanceName(),
      workspace: this.farmingDir,
      mainPageSessionKeys: this.getMainPageSessionKeys(),
      taskHistory: this.getTaskHistory(),
    };
  }

  mountProjectWorkspace(workspace: unknown): {
    workspace: string;
    projectWorkspaces: string[];
    pinnedProjectWorkspaces: string[];
  } {
    const expanded = this.expandWorkspacePath(workspace);
    const resolved = expanded ? path.resolve(expanded) : '';
    let canonicalWorkspace = '';
    if (resolved) {
      try {
        canonicalWorkspace = fs.realpathSync(resolved);
        if (!fs.statSync(canonicalWorkspace).isDirectory()) canonicalWorkspace = '';
      } catch {
        canonicalWorkspace = '';
      }
    }
    if (
      !canonicalWorkspace
      || this.isInternalWorkspace(canonicalWorkspace)
    ) {
      throw new Error('Project workspace is invalid or unavailable');
    }
    const current = this.settings.projectWorkspaces || [];
    if (!current.includes(canonicalWorkspace)) {
      this.commitProjectMembership({
        projectWorkspaces: [canonicalWorkspace, ...current],
      });
    }
    return {
      workspace: canonicalWorkspace,
      projectWorkspaces: [...(this.settings.projectWorkspaces || [])],
      pinnedProjectWorkspaces: [...(this.settings.pinnedProjectWorkspaces || [])],
    };
  }

  removeProjectWorkspace(workspace: unknown): JsonRecord {
    const expanded = this.expandWorkspacePath(workspace);
    if (!expanded) throw new Error('Project workspace is required');
    const resolved = path.resolve(expanded);
    const candidates = new Set([expanded, resolved]);
    try {
      candidates.add(fs.realpathSync(resolved));
    } catch {
      // A deleted worktree can still be removed by its last canonical path.
    }
    const current = this.settings.projectWorkspaces || [];
    const nextProjects = current.filter(entry => !candidates.has(entry));
    const currentPinned = this.settings.pinnedProjectWorkspaces || [];
    const nextPinned = currentPinned.filter(entry => !candidates.has(entry));
    if (nextProjects.length !== current.length || nextPinned.length !== currentPinned.length) {
      this.commitProjectMembership({
        projectWorkspaces: nextProjects,
        pinnedProjectWorkspaces: nextPinned,
      });
    }
    return {
      workspace: current.find(entry => candidates.has(entry)) || resolved,
      projectWorkspaces: [...(this.settings.projectWorkspaces || [])],
      pinnedProjectWorkspaces: [...(this.settings.pinnedProjectWorkspaces || [])],
    };
  }

  setProjectWorkspacePinned(workspace: unknown, pinned: unknown): JsonRecord {
    const [canonicalWorkspace] = this.normalizeProjectWorkspaces([workspace]);
    if (!canonicalWorkspace || !(this.settings.projectWorkspaces || []).includes(canonicalWorkspace)) {
      throw new Error('Project does not exist');
    }
    const current = this.settings.pinnedProjectWorkspaces || [];
    const nextPinned = pinned
      ? [...current.filter(entry => entry !== canonicalWorkspace), canonicalWorkspace]
      : current.filter(entry => entry !== canonicalWorkspace);
    if (
      nextPinned.length !== current.length
      || nextPinned.some((entry, index) => entry !== current[index])
    ) {
      this.commitProjectMembership({ pinnedProjectWorkspaces: nextPinned });
    }
    return {
      workspace: canonicalWorkspace,
      projectWorkspaces: [...(this.settings.projectWorkspaces || [])],
      pinnedProjectWorkspaces: [...(this.settings.pinnedProjectWorkspaces || [])],
    };
  }

  reorderProjectWorkspace(
    workspace: unknown,
    {
      beforeWorkspace = '',
      afterWorkspace = '',
    }: { beforeWorkspace?: unknown; afterWorkspace?: unknown } = {},
  ): JsonRecord {
    const [canonicalWorkspace] = this.normalizeProjectWorkspaces([workspace]);
    const currentProjects = this.settings.projectWorkspaces || [];
    if (!canonicalWorkspace || !currentProjects.includes(canonicalWorkspace)) {
      throw new Error('Project does not exist');
    }

    const normalizeNeighbor = (value: unknown): string => {
      if (typeof value !== 'string' || !value.trim()) return '';
      return this.normalizeProjectWorkspaces([value])[0] || '';
    };
    const canonicalBefore = normalizeNeighbor(beforeWorkspace);
    const canonicalAfter = normalizeNeighbor(afterWorkspace);
    if (
      (typeof beforeWorkspace === 'string' && beforeWorkspace.trim() && !canonicalBefore)
      || (typeof afterWorkspace === 'string' && afterWorkspace.trim() && !canonicalAfter)
    ) {
      throw new Error('Reorder neighbors are invalid');
    }
    const pinnedProjects = this.settings.pinnedProjectWorkspaces || [];
    const projectIsPinned = pinnedProjects.includes(canonicalWorkspace);
    const cohort = (projectIsPinned
      ? pinnedProjects
      : currentProjects.filter(project => !pinnedProjects.includes(project)))
      .filter(project => project !== canonicalWorkspace);
    const beforeIndex = canonicalBefore ? cohort.indexOf(canonicalBefore) : -1;
    const afterIndex = canonicalAfter ? cohort.indexOf(canonicalAfter) : -1;
    if (
      (canonicalBefore && beforeIndex < 0)
      || (canonicalAfter && afterIndex < 0)
    ) {
      throw new Error('Reorder neighbors must belong to the same Project group');
    }

    const insertIndex = canonicalAfter ? afterIndex : canonicalBefore ? beforeIndex + 1 : 0;
    const expectedBefore = insertIndex > 0 ? cohort[insertIndex - 1] || '' : '';
    const expectedAfter = insertIndex < cohort.length ? cohort[insertIndex] || '' : '';
    if (expectedBefore !== canonicalBefore || expectedAfter !== canonicalAfter) {
      throw new Error('Reorder neighbors are stale');
    }

    const reorderedCohort = [...cohort];
    reorderedCohort.splice(insertIndex, 0, canonicalWorkspace);
    const nextPinned = projectIsPinned ? reorderedCohort : [...pinnedProjects];
    const nextUnpinned = projectIsPinned
      ? currentProjects.filter(project => !pinnedProjects.includes(project))
      : reorderedCohort;
    const nextProjects = [...nextPinned, ...nextUnpinned];
    if (
      nextProjects.some((project, index) => project !== currentProjects[index])
      || nextPinned.some((project, index) => project !== pinnedProjects[index])
    ) {
      this.commitProjectMembership({
        projectWorkspaces: nextProjects,
        pinnedProjectWorkspaces: nextPinned,
      });
    }
    return {
      workspace: canonicalWorkspace,
      projectWorkspaces: [...(this.settings.projectWorkspaces || [])],
      pinnedProjectWorkspaces: [...(this.settings.pinnedProjectWorkspaces || [])],
    };
  }

  commitProjectMembership(settingsPatch: JsonRecord): void {
    const previousSettings = this.settings;
    try {
      this.updateSettings(settingsPatch);
    } catch (error: unknown) {
      this.settings = previousSettings;
      throw error;
    }
  }

  getProjectOperation(requestId: unknown): AgentProjectOperation | null {
    const id = String(requestId || '').trim();
    if (!PROJECT_OPERATION_ID_PATTERN.test(id)) return null;
    const operation = this.settings.projectOperations?.[id];
    return operation ? JSON.parse(JSON.stringify(operation)) : null;
  }

  commitProjectOperation(
    operation: AgentProjectOperation,
    membership: ProjectMembershipPatch = {},
  ): {
    operation: AgentProjectOperation;
    pinnedProjectWorkspaces: string[];
    projectWorkspaces: string[];
  } {
    const operationId = String(objectProperty(operation, 'id'));
    const normalized = this.normalizeProjectOperations({ [operationId]: operation });
    const nextOperation = normalized[operationId];
    if (!nextOperation) throw new Error('Project operation is invalid');
    const existingOperation = this.settings.projectOperations?.[nextOperation.id];
    const unresolvedCount = Object.values(this.settings.projectOperations || {})
      .filter(candidate => ['pending', 'unknown', 'blocked'].includes(candidate.state)).length;
    if (!existingOperation && nextOperation.state === 'pending' && unresolvedCount >= MAX_PROJECT_OPERATIONS) {
      throw new Error('Too many unresolved Project operations require reconciliation');
    }
    const nextOperations = this.normalizeProjectOperations({
      ...this.settings.projectOperations,
      [nextOperation.id]: nextOperation,
    });
    const nextSettings = {
      ...this.settings,
      projectOperations: nextOperations,
    };
    if (membership.mountWorkspace) {
      const mounted = this.normalizeProjectWorkspaces([
        membership.mountWorkspace,
        ...(this.settings.projectWorkspaces || []),
      ]);
      nextSettings.projectWorkspaces = mounted;
      nextSettings.pinnedProjectWorkspaces = this.normalizeProjectWorkspaces(
        this.settings.pinnedProjectWorkspaces,
      );
    }
    if (membership.removeWorkspace) {
      const expanded = this.expandWorkspacePath(membership.removeWorkspace);
      const resolved = expanded ? path.resolve(expanded) : '';
      const candidates = new Set([expanded, resolved].filter(Boolean));
      try {
        candidates.add(fs.realpathSync(resolved));
      } catch {
        // A deleted worktree is removed by its last canonical path.
      }
      nextSettings.projectWorkspaces = (this.settings.projectWorkspaces || [])
        .filter(workspace => !candidates.has(workspace));
      nextSettings.pinnedProjectWorkspaces = (this.settings.pinnedProjectWorkspaces || [])
        .filter(workspace => !candidates.has(workspace));
    }
    this.writeSettingsFile(nextSettings);
    this.settings = nextSettings;
    return {
      operation: JSON.parse(JSON.stringify(nextOperation)),
      projectWorkspaces: [...(nextSettings.projectWorkspaces || [])],
      pinnedProjectWorkspaces: [...(nextSettings.pinnedProjectWorkspaces || [])],
    };
  }

  getMainPageSessionKeys(): string[] {
    return this.sessionStore ? this.sessionStore.getMainPageSessionKeys() : [];
  }

  setMainPageSessionKeys(keys: unknown): string[] {
    return this.sessionStore ? this.sessionStore.setMainPageSessionKeys(keys) : [];
  }

  rememberMainPageSessionKey(sessionKey: string, patch: JsonRecord = {}): string[] {
    return this.sessionStore ? this.sessionStore.rememberMainPageSessionKey(sessionKey, patch) : [];
  }

  removeMainPageSessionKey(sessionKey: string): boolean {
    return this.sessionStore ? this.sessionStore.removeMainPageSessionKey(sessionKey) : false;
  }

  removeMainPageSessionKeys(keys: unknown): string[] {
    return this.sessionStore ? this.sessionStore.removeMainPageSessionKeys(keys) : [];
  }

  purgeProviderSessionRecords(keys: unknown): string[] {
    return this.sessionStore?.purgeProviderSessionRecords?.(keys) || [];
  }

  ensureAgentSessionRecord(
    agent: AgentRecord,
    patch: Partial<PersistedAgentPrivateMetadata> = {},
  ): string {
    return this.sessionStore ? this.sessionStore.ensureRecordForAgent(agent, { ...patch }) : '';
  }

  async persistAgentAdaptiveTitle(agent: AgentRecord, title: string): Promise<string> {
    return this.sessionStore ? this.sessionStore.persistAgentAdaptiveTitle(agent, title) : '';
  }

  async persistAgentStatePatch(
    agent: AgentRecord,
    patch: JsonRecord,
    options: { beforeCommit?: () => boolean } = {},
  ): Promise<
    | {
      status: 'committed';
      id: string;
      commit: { metadataGeneration: number; stateGeneration: number };
    }
    | { status: 'fenced' }
    | { status: 'legacy-record' }
    | { status: 'record-missing' }
    | { status: 'owner-mismatch' }
  > {
    return this.sessionStore?.persistAgentStatePatch
      ? this.sessionStore.persistAgentStatePatch(agent, patch, options)
      : { status: 'record-missing' };
  }

  isAgentStateCommitCurrent(
    agent: AgentRecord,
    id: string,
    commit: { metadataGeneration: number; stateGeneration: number },
  ): boolean {
    return this.sessionStore?.isAgentStateCommitCurrent?.(agent, id, commit) === true;
  }

  getAgentSessionRecordForProviderSessionKey(sessionKey: string): PersistedAgentPrivateMetadata | null {
    const record = this.sessionStore
      ? this.sessionStore.getRecordForProviderSessionKey(sessionKey)
      : null;
    return record && typeof record.id === 'string'
      ? { ...record, id: record.id }
      : null;
  }

  setProviderSessionDisplayState(
    sessionKey: string,
    patch: Partial<AgentDisplayState> = {},
  ): string {
    return this.sessionStore
      ? this.sessionStore.setProviderSessionDisplayState(sessionKey, { ...patch })
      : '';
  }

  listAgentSessionRecords(): PersistedAgentPrivateMetadata[] {
    const records = this.sessionStore ? this.sessionStore.listAgentRecords() : [];
    return records.flatMap(record => (
      typeof record.id === 'string'
        ? [{ ...record, id: record.id }]
        : []
    ));
  }

  rememberAgentSessionRecord(agent: AgentRecord): string {
    return this.sessionStore ? this.sessionStore.rememberAgent(agent) : '';
  }

  getTaskHistory(): JsonRecord[] {
    return this.runHistoryStore ? this.runHistoryStore.getEntries() : [];
  }

  writeSettingsFile(settings: Settings = this.settings): void {
    this.writeJson(this.settingsFile, settings);
  }

  appendTaskHistory(entry: JsonRecord): void {
    if (!this.runHistoryStore) return;
    this.runHistoryStore.appendEntry(entry);
  }
  
  updateSettings(newSettings: JsonRecord): void {
    const incomingMainPageSessionKeys = Object.prototype.hasOwnProperty.call(newSettings || {}, 'mainPageSessionKeys')
      ? newSettings.mainPageSessionKeys
      : undefined;
    const settingsPatch = { ...(newSettings || {}) };
    delete settingsPatch.mainPageSessionKeys;
    delete settingsPatch.projectOperations;
    const incomingTaskHistory = Object.prototype.hasOwnProperty.call(settingsPatch, 'taskHistory')
      ? settingsPatch.taskHistory
      : undefined;
    delete settingsPatch.taskHistory;
    const previousMainWorkspace = this.settings.lastMainWorkspace || this.farmingDir;
    const previousProfiles = this.settings.agentLaunchProfiles || {};
    const incomingProfiles = settingsPatch.agentLaunchProfiles || {};
    const nextSettings = {
      ...this.settings,
      ...settingsPatch,
      agentLaunchProfiles: this.mergeAgentLaunchProfiles(previousProfiles, incomingProfiles),
      workspace: this.farmingDir
    } as Settings;
    if (incomingMainPageSessionKeys !== undefined) {
      this.setMainPageSessionKeys(incomingMainPageSessionKeys);
    }
    if (incomingTaskHistory !== undefined && this.runHistoryStore) {
      this.runHistoryStore.setEntries(incomingTaskHistory);
    }
    this.normalizePersistedSettings(nextSettings, settingsPatch, previousMainWorkspace);
    this.writeSettingsFile(nextSettings);
    this.settings = nextSettings;
  }
}

export {
  ConfigManager,
  DEFAULT_CODE_CONTENT_FONT_SIZE,
  DEFAULT_CRT_CONTENT_FONT_SIZE,
  DEFAULT_CRT_TERMINAL_FONT_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_CONTENT_FONT_SIZE,
  MAX_CRT_TERMINAL_FONT_SIZE,
  MIN_CONTENT_FONT_SIZE,
  MIN_CRT_TERMINAL_FONT_SIZE,
};
