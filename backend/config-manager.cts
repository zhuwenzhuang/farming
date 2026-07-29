const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteJson } = require('./atomic-json-store.cjs');
const { ensureMainAgentSkillFiles } = require('./main-agent-skills.cjs');
const { ensureFarmingAgentBootstrapFile } = require('./farming-agent-bootstrap.cjs');
const { normalizeClaudeModelValue } = require('./claude-settings.cjs');
const { isTemporaryProviderSessionId } = require('./provider-session-id.cjs');
const { FarmingSessionStore, MAX_MAIN_PAGE_SESSION_KEYS } = require('./farming-session-store.cjs');
const { RunHistoryStore } = require('./run-history-store.cjs');
const { isSupportedHistoryAgent } = require('./cli-agents.cjs');
const storageLayout = require('./storage-layout.cjs');

type JsonRecord = Record<string, unknown>;

interface ConfigManagerOptions {
  configDir?: string;
  writeJson?: (file: string, value: unknown) => void;
}

interface AgentHome {
  id: string;
  path: string;
}

type AgentHomes = Record<string, AgentHome[]>;

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

interface ProjectOperation {
  id: string;
  type: string;
  state: string;
  signature: string;
  request: object;
  result: object | null;
  error: string;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

interface ProjectMembership {
  mountWorkspace?: unknown;
  removeWorkspace?: unknown;
}

interface Settings extends JsonRecord {
  agentHomes: AgentHomes;
  agentLaunchProfiles: AgentLaunchProfiles;
  appearance: string;
  browserExecutablePath: string;
  browserExtensionEnabled: boolean;
  browserExternalCdpUrl: string;
  browserSource: string;
  codexApprovalMode: string;
  codexModel: string;
  codexModelPreset: string;
  codexReasoningEffort: string;
  codexServiceTier: string;
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
  projectOperations: Record<string, ProjectOperation>;
  projectWorkspaces: string[];
  restReminderIntervalSeconds: number | null;
  searchTimeoutMs: unknown;
  theme: unknown;
  version: string;
  workspace: string;
  workspaceHistory: string[];
}

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
): entry is [string, JsonRecord] {
  const [id, operation] = entry;
  const record = objectRecord(operation);
  return PROJECT_OPERATION_ID_PATTERN.test(id)
    && record !== null
    && ['create-worktree', 'delete-worktree'].includes(record.type as string)
    && ['pending', 'unknown', 'succeeded', 'failed', 'blocked'].includes(record.state as string);
}

function splitCodexModelPreset(preset: unknown): { model: string; effort: string } {
  if (preset === 'config') {
    return { model: 'config', effort: 'config' };
  }
  if (typeof preset !== 'string') {
    return { model: 'gpt-5.5', effort: 'xhigh' };
  }

  const [model, effort] = preset.split(':');
  return {
    model: model || 'gpt-5.5',
    effort: effort || 'xhigh',
  };
}

function joinCodexModelPreset(model: string, effort: string): string {
  if (model === 'config') return 'config';
  return effort ? `${model}:${effort}` : model;
}

const DEFAULT_CODEX_LAUNCH_PROFILE: CodexLaunchProfile = {
  approvalMode: 'approve',
  model: 'gpt-5.5',
  reasoningEffort: 'xhigh',
  serviceTier: 'default',
  modelPreset: 'gpt-5.5:xhigh',
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

const DEFAULT_LAUNCH_AGENT_NAMES = new Set(['codex', 'claude', 'opencode', 'qoder', 'qwen', 'bash', 'zsh']);

const DEFAULT_AGENT_HOMES: AgentHomes = {
  codex: [{ id: 'default', path: '~/.codex' }],
  claude: [{ id: 'default', path: '~/.claude' }],
  opencode: [{ id: 'default', path: '~/.opencode' }],
  qoder: [{ id: 'default', path: '~/.qoder' }],
  qwen: [{ id: 'default', path: '~/.qwen' }],
};

const LEGACY_DEFAULT_WORKSPACE_FILE_SEARCH_TIMEOUT_MS = 3000;
const DEFAULT_SEARCH_TIMEOUT_MS = 15000;
const MIN_SEARCH_TIMEOUT_MS = 3000;
const MAX_SEARCH_TIMEOUT_MS = 180000;
const DEFAULT_CRT_TERMINAL_FONT_SIZE = 15;
const MIN_CRT_TERMINAL_FONT_SIZE = 10;
const MAX_CRT_TERMINAL_FONT_SIZE = 20;
const MAX_INSTANCE_NAME_LENGTH = 80;
const MAX_PROJECT_OPERATIONS = 32;
const PROJECT_OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

const PERSISTED_SETTING_KEYS = new Set([
  'workspace',
  'lastMainWorkspace',
  'workspaceHistory',
  'projectWorkspaces',
  'pinnedProjectWorkspaces',
  'projectNames',
  'projectOperations',
  'instanceName',
  'theme',
  'appearance',
  'language',
  'restReminderIntervalSeconds',
  'heartbeatInterval',
  'dangerouslySkipAgentPermissionsByDefault',
  'browserExtensionEnabled',
  'browserSource',
  'browserExecutablePath',
  'browserExternalCdpUrl',
  'crtSkinEffectsEnabled',
  'crtDynamicHeatEnabled',
  'crtTerminalFontSize',
  'defaultLaunchAgent',
  'agentLaunchProfiles',
  'agentHomes',
  'searchTimeoutMs',
  'codexApprovalMode',
  'codexModel',
  'codexReasoningEffort',
  'codexServiceTier',
  'codexModelPreset',
  'version',
]);

function cloneLaunchProfile<T extends object>(profile: T): T {
  return { ...profile };
}

function cloneAgentHomes(agentHomes: AgentHomes): AgentHomes {
  const cloned: AgentHomes = {};
  Object.entries(agentHomes || {}).forEach(([provider, homes]) => {
    cloned[provider] = Array.isArray(homes)
      ? homes.map(home => ({ ...home }))
      : [];
  });
  return cloned;
}

class ConfigManager {
  farmingDir: string;
  settings: Settings;
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
    this.settings = null as unknown as Settings;
  }

  expandWorkspacePath(workspace: unknown): string {
    if (typeof workspace !== 'string') return '';
    const value = workspace.trim();
    if (!value) return '';
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    return value;
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
      const value = entry.trim();
      if (!/^agent-session:[a-z][a-z0-9_-]*:.+$/i.test(value)) continue;
      const sessionId = value.replace(/^agent-session:[^:]+:/i, '');
      if (sessionId.startsWith('-')) continue;
      if (isTemporaryProviderSessionId(sessionId)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      result.push(value);
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
  
  init(): void {
    if (!fs.existsSync(this.farmingDir)) {
      fs.mkdirSync(this.farmingDir, { recursive: true });
      console.log('Created farming directory:', this.farmingDir);
    }
    
    if (!fs.existsSync(this.settingsFile)) {
      const defaultSettings = {
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
        browserExtensionEnabled: false,
        browserSource: process.env.FARMING_BROWSER_CDP_URL ? 'external-cdp' : 'system',
        browserExecutablePath: process.env.FARMING_BROWSER_EXECUTABLE || '',
        browserExternalCdpUrl: process.env.FARMING_BROWSER_CDP_URL || 'http://127.0.0.1:9222',
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
        codexModel: 'gpt-5.5',
        codexReasoningEffort: 'xhigh',
        codexServiceTier: 'default',
        codexModelPreset: 'gpt-5.5:xhigh',
        version: '2'
      };
      this.writeSettingsFile(defaultSettings);
      console.log('Created default settings:', this.settingsFile);
    }
    
    const rawSettings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) as JsonRecord;
    this.settings = {
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
      browserExtensionEnabled: false,
      browserSource: process.env.FARMING_BROWSER_CDP_URL ? 'external-cdp' : 'system',
      browserExecutablePath: process.env.FARMING_BROWSER_EXECUTABLE || '',
      browserExternalCdpUrl: process.env.FARMING_BROWSER_CDP_URL || 'http://127.0.0.1:9222',
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
      codexModel: 'gpt-5.5',
      codexReasoningEffort: 'xhigh',
      codexServiceTier: 'default',
      codexModelPreset: 'gpt-5.5:xhigh',
      version: '2',
      ...rawSettings
    };
    if (rawSettings.searchTimeoutMs === undefined && rawSettings.workspaceFileSearchTimeoutMs !== undefined) {
      const legacyTimeoutMs = Number(rawSettings.workspaceFileSearchTimeoutMs);
      this.settings.searchTimeoutMs = legacyTimeoutMs === LEGACY_DEFAULT_WORKSPACE_FILE_SEARCH_TIMEOUT_MS
        ? DEFAULT_SEARCH_TIMEOUT_MS
        : rawSettings.workspaceFileSearchTimeoutMs;
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
    this.settings.workspace = this.farmingDir;
    this.settings.lastMainWorkspace = this.normalizeMainWorkspace(this.settings.lastMainWorkspace, this.farmingDir);
    this.settings.workspaceHistory = this.normalizeWorkspaceHistory(this.settings.workspaceHistory);
    this.settings.projectWorkspaces = this.normalizeProjectWorkspaces(this.settings.projectWorkspaces);
    this.settings.pinnedProjectWorkspaces = this.normalizeProjectWorkspaces(this.settings.pinnedProjectWorkspaces);
    this.settings.projectNames = this.normalizeProjectNames(this.settings.projectNames);
    this.settings.projectOperations = this.normalizeProjectOperations(this.settings.projectOperations);
    this.settings.instanceName = this.normalizeInstanceName(this.settings.instanceName);
    this.settings.agentHomes = this.normalizeAgentHomes(this.settings.agentHomes);
    delete this.settings.updateUrl;
    this.settings.searchTimeoutMs = this.normalizeSearchTimeoutMs(this.settings.searchTimeoutMs);
    delete this.settings.codexRuntimeMode;
    const legacyMainPageSessionKeys = this.normalizeMainPageSessionKeys(this.settings.mainPageSessionKeys);
    delete this.settings.mainPageSessionKeys;
    this.sessionStore.init({ legacyMainPageSessionKeys });
    const legacyTaskHistory = this.normalizeTaskHistory(this.settings.taskHistory);
    delete this.settings.taskHistory;
    this.runHistoryStore.init({ legacyTaskHistory });
    this.settings.appearance = this.normalizeAppearance(this.settings.appearance);
    this.settings.language = this.normalizeLanguage(this.settings.language);
    this.settings.restReminderIntervalSeconds = this.normalizeRestReminderIntervalSeconds(
      this.settings.restReminderIntervalSeconds,
    );
    this.settings.browserExtensionEnabled = this.settings.browserExtensionEnabled === true;
    this.settings.browserSource = this.normalizeBrowserSource(this.settings.browserSource);
    this.settings.browserExecutablePath = this.normalizeBrowserSetting(this.settings.browserExecutablePath);
    this.settings.browserExternalCdpUrl = this.normalizeBrowserSetting(this.settings.browserExternalCdpUrl)
      || 'http://127.0.0.1:9222';
    this.settings.crtSkinEffectsEnabled = this.settings.crtSkinEffectsEnabled !== false;
    this.settings.crtDynamicHeatEnabled = this.settings.crtDynamicHeatEnabled === true;
    this.settings.crtTerminalFontSize = this.normalizeCrtTerminalFontSize(this.settings.crtTerminalFontSize);
    this.normalizeAgentLaunchSettings(launchRawSettings);
    this.pruneUnknownSettings();
    ensureMainAgentSkillFiles(this.farmingDir);
    ensureFarmingAgentBootstrapFile(this.farmingDir);
    this.writeSettingsFile();
    console.log('Loaded settings:', this.settings);
  }

  pruneUnknownSettings(settings: Settings = this.settings): void {
    for (const key of Object.keys(settings || {})) {
      if (!PERSISTED_SETTING_KEYS.has(key)) {
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
      const homes: AgentHome[] = [];
      rawHomes.forEach(rawHome => {
        const record = objectRecord(rawHome);
        if (!record) return;
        const id = String(record.id || '').trim();
        const homePath = String(record.path || '').trim();
        if (!id || !homePath) return;
        if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
        const idKey = id.toLowerCase();
        if (seenIds.has(idKey)) return;
        seenIds.add(idKey);
        homes.push({ id, path: homePath });
      });
      if (homes.length > 0) normalized[provider] = homes;
    });

    for (const [provider, homes] of Object.entries(DEFAULT_AGENT_HOMES)) {
      const defaultHome = homes[0];
      const providerHomes = normalized[provider] || [];
      if (!providerHomes.some(home => String(home.id || '').toLowerCase() === 'default')) {
        normalized[provider] = [{ ...defaultHome }, ...providerHomes];
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

  normalizeProjectOperations(projectOperations: unknown): Record<string, ProjectOperation> {
    const source = objectRecord(projectOperations);
    if (!source) return {};
    const entries: Array<[string, ProjectOperation]> = Object.entries(source)
      .filter(validProjectOperationEntry)
      .sort((left, right) => (Number(right[1].updatedAt) || 0) - (Number(left[1].updatedAt) || 0))
      .map(([id, operation]) => {
        return [id, {
          id,
          type: operation.type as string,
          state: operation.state as string,
          signature: typeof operation.signature === 'string' ? operation.signature.slice(0, 128) : '',
          request: operation.request && typeof operation.request === 'object'
            ? JSON.parse(JSON.stringify(operation.request))
            : {},
          result: operation.result && typeof operation.result === 'object'
            ? JSON.parse(JSON.stringify(operation.result))
            : null,
          error: typeof operation.error === 'string' ? operation.error.slice(0, 2000) : '',
          startedAt: Number(operation.startedAt) || 0,
          updatedAt: Number(operation.updatedAt) || 0,
          finishedAt: Number(operation.finishedAt) || null,
        }];
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
    return typeof appearance === 'string' && ['system', 'light', 'dark'].includes(appearance)
      ? appearance
      : 'system';
  }

  normalizeLanguage(language: unknown): string {
    return typeof language === 'string' && ['en', 'zh'].includes(language) ? language : 'en';
  }

  normalizeBrowserSource(source: unknown): string {
    return typeof source === 'string' && ['external-cdp', 'managed'].includes(source) ? source : 'system';
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
    if (typeof preset !== 'string') return 'gpt-5.5:xhigh';
    if (/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(preset)) return preset;
    return 'gpt-5.5:xhigh';
  }

  normalizeCodexModelId(model: unknown): string {
    if (model === 'config') return model;
    if (typeof model !== 'string') return 'gpt-5.5';
    if (/^[A-Za-z0-9._-]+$/.test(model)) return model;
    return 'gpt-5.5';
  }

  normalizeCodexReasoningEffort(effort: unknown): string {
    if (effort === 'config') return effort;
    if (typeof effort !== 'string') return 'xhigh';
    if (/^[A-Za-z0-9._-]+$/.test(effort)) return effort;
    return 'xhigh';
  }

  normalizeCodexServiceTier(tier: unknown): string {
    if (typeof tier !== 'string') return 'default';
    if (/^[A-Za-z0-9._-]+$/.test(tier)) return tier;
    return 'default';
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
    const merged: Record<string, JsonRecord> = {};
    for (const [agentName, defaultProfile] of Object.entries(DEFAULT_AGENT_LAUNCH_PROFILES)) {
      merged[agentName] = {
        ...defaultProfile,
        ...spreadableObject(objectProperty(existingProfiles, agentName)),
        ...spreadableObject(objectProperty(incomingProfiles, agentName)),
      };
    }
    return merged as unknown as AgentLaunchProfiles;
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

  getCodexApprovalMode(): unknown {
    if (!this.settings) return 'approve';
    return this.getAgentLaunchProfile('codex').approvalMode;
  }

  getCodexModelPreset(): unknown {
    if (!this.settings) return 'gpt-5.5:xhigh';
    return this.getAgentLaunchProfile('codex').modelPreset;
  }

  getCodexModel(): unknown {
    if (!this.settings) return 'gpt-5.5';
    return this.getAgentLaunchProfile('codex').model;
  }

  getCodexReasoningEffort(): unknown {
    if (!this.settings) return 'xhigh';
    return this.getAgentLaunchProfile('codex').reasoningEffort;
  }

  getCodexServiceTier(): unknown {
    if (!this.settings) return 'default';
    return this.getAgentLaunchProfile('codex').serviceTier;
  }


  getAgentHomes(provider: unknown): AgentHome[] {
    const providerKey = String(provider);
    const homes = this.settings && this.settings.agentHomes && this.settings.agentHomes[providerKey]
      ? this.settings.agentHomes[providerKey]
      : [];
    return homes.map(home => ({ ...home, path: this.expandWorkspacePath(home.path) }));
  }

  getAgentHome(provider: unknown, homeId: unknown = 'default'): AgentHome | null {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const normalizedHomeId = String(homeId || 'default').trim();
    const homes = this.getAgentHomes(normalizedProvider);
    return homes.find(home => home.id === normalizedHomeId) || null;
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

  getAgentLaunchProfile(agentName: unknown): JsonRecord {
    const profiles = this.getAgentLaunchProfiles();
    const profileName = String(agentName);
    const profile = profiles[profileName] || DEFAULT_AGENT_LAUNCH_PROFILES[profileName];
    return profile ? { ...profile } : {};
  }

  getSettings(): JsonRecord {
    const publicSettings: JsonRecord = { ...this.settings };
    delete publicSettings.projectOperations;
    return {
      ...publicSettings,
      instanceName: this.getInstanceName(),
      workspace: this.farmingDir,
      mainPageSessionKeys: this.getMainPageSessionKeys(),
      taskHistory: this.getTaskHistory(),
    };
  }

  mountProjectWorkspace(workspace: unknown): JsonRecord {
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

  commitProjectMembership(settingsPatch: JsonRecord): void {
    const previousSettings = this.settings;
    try {
      this.updateSettings(settingsPatch);
    } catch (error: unknown) {
      this.settings = previousSettings;
      throw error;
    }
  }

  getProjectOperation(requestId: unknown): ProjectOperation | null {
    const id = String(requestId || '').trim();
    if (!PROJECT_OPERATION_ID_PATTERN.test(id)) return null;
    const operation = this.settings.projectOperations?.[id];
    return operation ? JSON.parse(JSON.stringify(operation)) : null;
  }

  commitProjectOperation(operation: unknown, membership: ProjectMembership = {}): JsonRecord {
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

  ensureAgentSessionRecord(agent: JsonRecord, patch: JsonRecord = {}): string {
    return this.sessionStore ? this.sessionStore.ensureRecordForAgent(agent, patch) : '';
  }

  getAgentSessionRecordForProviderSessionKey(sessionKey: string): JsonRecord | null {
    return this.sessionStore ? this.sessionStore.getRecordForProviderSessionKey(sessionKey) : null;
  }

  setProviderSessionDisplayState(sessionKey: string, patch: JsonRecord = {}): string {
    return this.sessionStore ? this.sessionStore.setProviderSessionDisplayState(sessionKey, patch) : '';
  }

  listAgentSessionRecords(): JsonRecord[] {
    return this.sessionStore ? this.sessionStore.listAgentRecords() : [];
  }

  rememberAgentSessionRecord(agent: JsonRecord): string {
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
    nextSettings.lastMainWorkspace = this.normalizeMainWorkspace(nextSettings.lastMainWorkspace, previousMainWorkspace);
    nextSettings.workspaceHistory = this.normalizeWorkspaceHistory(nextSettings.workspaceHistory);
    nextSettings.projectWorkspaces = this.normalizeProjectWorkspaces(nextSettings.projectWorkspaces);
    nextSettings.pinnedProjectWorkspaces = this.normalizeProjectWorkspaces(nextSettings.pinnedProjectWorkspaces);
    nextSettings.projectNames = this.normalizeProjectNames(nextSettings.projectNames);
    nextSettings.projectOperations = this.normalizeProjectOperations(nextSettings.projectOperations);
    nextSettings.instanceName = this.normalizeInstanceName(nextSettings.instanceName);
    nextSettings.agentHomes = this.normalizeAgentHomes(nextSettings.agentHomes);
    delete nextSettings.updateUrl;
    nextSettings.searchTimeoutMs = this.normalizeSearchTimeoutMs(nextSettings.searchTimeoutMs);
    delete nextSettings.codexRuntimeMode;
    delete nextSettings.mainPageSessionKeys;
    delete nextSettings.taskHistory;
    if (incomingMainPageSessionKeys !== undefined) {
      this.setMainPageSessionKeys(incomingMainPageSessionKeys);
    }
    if (incomingTaskHistory !== undefined && this.runHistoryStore) {
      this.runHistoryStore.setEntries(incomingTaskHistory);
    }
    nextSettings.appearance = this.normalizeAppearance(nextSettings.appearance);
    nextSettings.language = this.normalizeLanguage(nextSettings.language);
    nextSettings.restReminderIntervalSeconds = this.normalizeRestReminderIntervalSeconds(
      nextSettings.restReminderIntervalSeconds,
    );
    nextSettings.browserExtensionEnabled = nextSettings.browserExtensionEnabled === true;
    nextSettings.browserSource = this.normalizeBrowserSource(nextSettings.browserSource);
    nextSettings.browserExecutablePath = this.normalizeBrowserSetting(nextSettings.browserExecutablePath);
    nextSettings.browserExternalCdpUrl = this.normalizeBrowserSetting(nextSettings.browserExternalCdpUrl)
      || 'http://127.0.0.1:9222';
    nextSettings.crtSkinEffectsEnabled = nextSettings.crtSkinEffectsEnabled !== false;
    nextSettings.crtDynamicHeatEnabled = nextSettings.crtDynamicHeatEnabled === true;
    nextSettings.crtTerminalFontSize = this.normalizeCrtTerminalFontSize(nextSettings.crtTerminalFontSize);
    this.normalizeAgentLaunchSettings(settingsPatch, nextSettings);
    this.pruneUnknownSettings(nextSettings);
    this.writeSettingsFile(nextSettings);
    this.settings = nextSettings;
  }
}

export {
  ConfigManager,
  DEFAULT_CRT_TERMINAL_FONT_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_CRT_TERMINAL_FONT_SIZE,
  MIN_CRT_TERMINAL_FONT_SIZE,
};
