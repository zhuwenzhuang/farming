const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureMainAgentSkillFiles } = require('./main-agent-skills');
const { normalizeClaudeModelValue } = require('./claude-settings');
const { isTemporaryProviderSessionId } = require('./provider-session-id');
const { FarmingSessionStore, MAX_MAIN_PAGE_SESSION_KEYS } = require('./farming-session-store');
const { RunHistoryStore } = require('./run-history-store');
const { isSupportedHistoryAgent } = require('./cli-agents');
const storageLayout = require('./storage-layout');

function splitCodexModelPreset(preset) {
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

function joinCodexModelPreset(model, effort) {
  if (model === 'config') return 'config';
  return effort ? `${model}:${effort}` : model;
}

const DEFAULT_CODEX_LAUNCH_PROFILE = {
  approvalMode: 'approve',
  model: 'gpt-5.5',
  reasoningEffort: 'xhigh',
  serviceTier: 'default',
  modelPreset: 'gpt-5.5:xhigh',
};

const DEFAULT_CLAUDE_LAUNCH_PROFILE = {
  permissionMode: 'default',
  model: 'config',
  effort: 'config',
};

const DEFAULT_AGENT_LAUNCH_PROFILES = {
  codex: DEFAULT_CODEX_LAUNCH_PROFILE,
  claude: DEFAULT_CLAUDE_LAUNCH_PROFILE,
};

const DEFAULT_LAUNCH_AGENT_NAMES = new Set(['codex', 'claude', 'opencode', 'qoder', 'bash', 'zsh']);

const DEFAULT_AGENT_HOMES = {
  codex: [{ id: 'default', path: '~/.codex' }],
  claude: [{ id: 'default', path: '~/.claude' }],
  opencode: [{ id: 'default', path: '~/.opencode' }],
  qoder: [{ id: 'default', path: '~/.qoder' }],
};

const DEFAULT_UPDATE_URL = 'https://github.com/zhuwenzhuang/farming/releases/latest';
const LEGACY_DEFAULT_UPDATE_URL = 'https://github.com/zhuwenzhuang/farming/releases/latest/download/manifest.json';
const API_DEFAULT_UPDATE_URL = 'https://api.github.com/repos/zhuwenzhuang/farming/releases/latest';
const LEGACY_DEFAULT_WORKSPACE_FILE_SEARCH_TIMEOUT_MS = 3000;
const DEFAULT_SEARCH_TIMEOUT_MS = 15000;
const MIN_SEARCH_TIMEOUT_MS = 3000;
const MAX_SEARCH_TIMEOUT_MS = 180000;
const DEFAULT_CRT_TERMINAL_FONT_SIZE = 15;
const MIN_CRT_TERMINAL_FONT_SIZE = 10;
const MAX_CRT_TERMINAL_FONT_SIZE = 20;
const MAX_INSTANCE_NAME_LENGTH = 80;

const PERSISTED_SETTING_KEYS = new Set([
  'workspace',
  'lastMainWorkspace',
  'workspaceHistory',
  'projectWorkspaces',
  'pinnedProjectWorkspaces',
  'projectNames',
  'instanceName',
  'theme',
  'appearance',
  'language',
  'heartbeatInterval',
  'dangerouslySkipAgentPermissionsByDefault',
  'crtSkinEffectsEnabled',
  'crtDynamicHeatEnabled',
  'crtTerminalFontSize',
  'defaultLaunchAgent',
  'agentLaunchProfiles',
  'agentHomes',
  'updateUrl',
  'searchTimeoutMs',
  'codexApprovalMode',
  'codexModel',
  'codexReasoningEffort',
  'codexServiceTier',
  'codexModelPreset',
  'version',
]);

function cloneLaunchProfile(profile) {
  return { ...profile };
}

function cloneAgentHomes(agentHomes) {
  const cloned = {};
  Object.entries(agentHomes || {}).forEach(([provider, homes]) => {
    cloned[provider] = Array.isArray(homes)
      ? homes.map(home => ({ ...home }))
      : [];
  });
  return cloned;
}

class ConfigManager {
  constructor() {
    this.farmingDir = storageLayout.farmingConfigDir();
    this.settingsFile = storageLayout.settingsFile(this.farmingDir);
    this.sessionStore = new FarmingSessionStore(this.farmingDir, {
      normalizeMainPageSessionKeys: keys => this.normalizeMainPageSessionKeys(keys),
    });
    this.runHistoryStore = new RunHistoryStore(this.farmingDir, {
      normalizeTaskHistory: entries => this.normalizeTaskHistory(entries),
    });
    this.settings = null;
  }

  expandWorkspacePath(workspace) {
    if (typeof workspace !== 'string') return '';
    const value = workspace.trim();
    if (!value) return '';
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    return value;
  }

  isTemporaryWorkspace(workspace) {
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

  isUsableWorkspace(workspace) {
    const expanded = this.expandWorkspacePath(workspace);
    if (!expanded || this.isTemporaryWorkspace(expanded)) return false;

    try {
      return fs.statSync(expanded).isDirectory();
    } catch {
      return false;
    }
  }

  isInternalWorkspace(workspace) {
    const expanded = this.expandWorkspacePath(workspace);
    if (!expanded) return false;

    const resolvedWorkspace = path.resolve(expanded);
    const resolvedFarmingDir = path.resolve(this.farmingDir);
    return resolvedWorkspace === resolvedFarmingDir || path.basename(resolvedWorkspace) === '.farming';
  }

  normalizeMainWorkspace(workspace, fallback = this.farmingDir) {
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

  normalizeInstanceName(value) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_INSTANCE_NAME_LENGTH);
  }

  getInstanceName() {
    return this.settings?.instanceName || this.normalizeInstanceName(os.hostname()) || 'Farming';
  }

  normalizeWorkspaceHistory(history) {
    const entries = Array.isArray(history) ? history : [];
    const result = [];
    const seen = new Set();

    for (const entry of entries) {
      const expanded = this.expandWorkspacePath(entry);
      if (!this.isUsableWorkspace(expanded) || this.isInternalWorkspace(expanded) || seen.has(expanded)) continue;
      seen.add(expanded);
      result.push(expanded);
    }

    return result.slice(0, 5);
  }

  normalizeProjectWorkspaces(projects) {
    const entries = Array.isArray(projects) ? projects : [];
    const result = [];
    const seen = new Set();

    for (const entry of entries) {
      const expanded = this.expandWorkspacePath(entry);
      if (!expanded) continue;
      const resolved = path.resolve(expanded);
      if (resolved === path.parse(resolved).root || this.isInternalWorkspace(resolved)) continue;
      let canonical;
      try {
        canonical = fs.realpathSync(resolved);
        if (!fs.statSync(canonical).isDirectory()) continue;
      } catch {
        continue;
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      result.push(canonical);
    }

    return result.slice(0, 200);
  }

  normalizeMainPageSessionKeys(keys) {
    const entries = Array.isArray(keys) ? keys : [];
    const result = [];
    const seen = new Set();

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

  normalizeTaskHistory(history) {
    const entries = Array.isArray(history) ? history : [];
    const normalized = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string' || !entry.id) continue;
      if (typeof entry.agentId !== 'string' || !entry.agentId) continue;
      if (typeof entry.reason !== 'string' || !entry.reason) continue;
      if (typeof entry.archivedAt !== 'number' || !Number.isFinite(entry.archivedAt)) continue;
      if (!isSupportedHistoryAgent(entry.command)) continue;
      normalized.push({
        id: entry.id,
        agentId: entry.agentId,
        command: typeof entry.command === 'string' ? entry.command : '',
        cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
        projectWorkspace: typeof entry.projectWorkspace === 'string' ? entry.projectWorkspace : '',
        title: typeof entry.title === 'string' ? entry.title : '',
        customTitle: typeof entry.customTitle === 'string' ? entry.customTitle.trim().slice(0, 80) : '',
        task: typeof entry.task === 'string' ? entry.task : '',
        workflowTemplate: typeof entry.workflowTemplate === 'string' ? entry.workflowTemplate : '',
        source: typeof entry.source === 'string' ? entry.source : 'ui',
        reason: entry.reason,
        status: typeof entry.status === 'string' ? entry.status : 'stopped',
        startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : null,
        lastActivity: typeof entry.lastActivity === 'number' ? entry.lastActivity : null,
        archivedAt: entry.archivedAt,
      });
    }
    return normalized
      .sort((a, b) => b.archivedAt - a.archivedAt)
      .slice(0, 200);
  }
  
  init() {
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
        instanceName: '',
        theme: 'terminal',
        appearance: 'light',
        language: 'en',
        heartbeatInterval: 1000,
        dangerouslySkipAgentPermissionsByDefault: false,
        crtSkinEffectsEnabled: true,
        crtDynamicHeatEnabled: false,
        crtTerminalFontSize: DEFAULT_CRT_TERMINAL_FONT_SIZE,
        defaultLaunchAgent: 'codex',
        agentLaunchProfiles: {
          codex: cloneLaunchProfile(DEFAULT_CODEX_LAUNCH_PROFILE),
          claude: cloneLaunchProfile(DEFAULT_CLAUDE_LAUNCH_PROFILE),
        },
        agentHomes: cloneAgentHomes(DEFAULT_AGENT_HOMES),
        updateUrl: DEFAULT_UPDATE_URL,
        searchTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
        codexApprovalMode: 'approve',
        codexModel: 'gpt-5.5',
        codexReasoningEffort: 'xhigh',
        codexServiceTier: 'default',
        codexModelPreset: 'gpt-5.5:xhigh',
        version: '2'
      };
      fs.writeFileSync(this.settingsFile, JSON.stringify(defaultSettings, null, 2));
      console.log('Created default settings:', this.settingsFile);
    }
    
    const rawSettings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
    this.settings = {
      workspace: this.farmingDir,
      lastMainWorkspace: this.farmingDir,
      workspaceHistory: [],
      projectWorkspaces: [],
      pinnedProjectWorkspaces: [],
      projectNames: {},
      instanceName: '',
      theme: 'terminal',
      appearance: 'light',
      language: 'en',
      heartbeatInterval: 1000,
      dangerouslySkipAgentPermissionsByDefault: false,
      crtSkinEffectsEnabled: true,
      crtDynamicHeatEnabled: false,
      crtTerminalFontSize: DEFAULT_CRT_TERMINAL_FONT_SIZE,
      defaultLaunchAgent: 'codex',
      agentLaunchProfiles: {
        codex: cloneLaunchProfile(DEFAULT_CODEX_LAUNCH_PROFILE),
        claude: cloneLaunchProfile(DEFAULT_CLAUDE_LAUNCH_PROFILE),
      },
      agentHomes: cloneAgentHomes(DEFAULT_AGENT_HOMES),
      updateUrl: DEFAULT_UPDATE_URL,
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
    this.settings.instanceName = this.normalizeInstanceName(this.settings.instanceName);
    this.settings.agentHomes = this.normalizeAgentHomes(this.settings.agentHomes);
    if (this.settings.updateUrl === LEGACY_DEFAULT_UPDATE_URL || this.settings.updateUrl === API_DEFAULT_UPDATE_URL) {
      this.settings.updateUrl = DEFAULT_UPDATE_URL;
    }
    this.settings.updateUrl = this.normalizeUpdateUrl(this.settings.updateUrl);
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
    this.settings.crtSkinEffectsEnabled = this.settings.crtSkinEffectsEnabled !== false;
    this.settings.crtDynamicHeatEnabled = this.settings.crtDynamicHeatEnabled === true;
    this.settings.crtTerminalFontSize = this.normalizeCrtTerminalFontSize(this.settings.crtTerminalFontSize);
    this.normalizeAgentLaunchSettings(launchRawSettings);
    this.pruneUnknownSettings();
    ensureMainAgentSkillFiles(this.farmingDir);
    this.writeSettingsFile();
    console.log('Loaded settings:', this.settings);
  }

  pruneUnknownSettings() {
    for (const key of Object.keys(this.settings || {})) {
      if (!PERSISTED_SETTING_KEYS.has(key)) {
        delete this.settings[key];
      }
    }
  }

  normalizeDefaultLaunchAgent(agentName) {
    return DEFAULT_LAUNCH_AGENT_NAMES.has(agentName) ? agentName : 'codex';
  }

  normalizeSearchTimeoutMs(value) {
    const timeoutMs = Number(value);
    if (!Number.isFinite(timeoutMs)) return DEFAULT_SEARCH_TIMEOUT_MS;
    return Math.min(
      MAX_SEARCH_TIMEOUT_MS,
      Math.max(MIN_SEARCH_TIMEOUT_MS, Math.round(timeoutMs))
    );
  }

  normalizeCrtTerminalFontSize(value) {
    const fontSize = Number(value);
    if (!Number.isFinite(fontSize)) return DEFAULT_CRT_TERMINAL_FONT_SIZE;
    return Math.min(
      MAX_CRT_TERMINAL_FONT_SIZE,
      Math.max(MIN_CRT_TERMINAL_FONT_SIZE, Math.round(fontSize))
    );
  }

  normalizeAgentHomes(agentHomes) {
    const source = agentHomes && typeof agentHomes === 'object' && !Array.isArray(agentHomes)
      ? agentHomes
      : {};
    const normalized = {};

    Object.entries(source).forEach(([rawProvider, rawHomes]) => {
      const provider = String(rawProvider || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]+$/.test(provider)) return;
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_AGENT_HOMES, provider)) return;
      if (!Array.isArray(rawHomes)) return;

      const seenIds = new Set();
      const homes = [];
      rawHomes.forEach(rawHome => {
        if (!rawHome || typeof rawHome !== 'object') return;
        const id = String(rawHome.id || '').trim();
        const homePath = String(rawHome.path || '').trim();
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

  normalizeProjectNames(projectNames) {
    if (!projectNames || typeof projectNames !== 'object' || Array.isArray(projectNames)) return {};
    const normalized = {};
    Object.entries(projectNames).forEach(([workspace, name]) => {
      const key = this.expandWorkspacePath(String(workspace || '').trim());
      const value = String(name || '').trim().slice(0, 80);
      if (!key || !value) return;
      normalized[key] = value;
    });
    return normalized;
  }

  normalizeAppearance(appearance) {
    return ['light', 'dark'].includes(appearance) ? appearance : 'light';
  }

  normalizeLanguage(language) {
    return ['en', 'zh'].includes(language) ? language : 'en';
  }

  normalizeUpdateUrl(value) {
    const url = String(value || '').trim();
    if (!url) return DEFAULT_UPDATE_URL;
    return /^https?:\/\//i.test(url) ? url.slice(0, 2000) : DEFAULT_UPDATE_URL;
  }

  normalizeClaudePermissionMode(mode) {
    return ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'].includes(mode)
      ? mode
      : 'default';
  }

  normalizeClaudeModel(model) {
    if (model === 'config') return model;
    return normalizeClaudeModelValue(model) || 'config';
  }

  normalizeClaudeEffort(effort) {
    if (effort === 'config') return effort;
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort;
    return 'config';
  }

  normalizeCodexApprovalMode(mode) {
    return ['ask', 'approve', 'full', 'custom'].includes(mode) ? mode : 'approve';
  }

  normalizeCodexModelPreset(preset) {
    if (preset === 'config') return preset;
    if (typeof preset !== 'string') return 'gpt-5.5:xhigh';
    if (/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(preset)) return preset;
    return 'gpt-5.5:xhigh';
  }

  normalizeCodexModelId(model) {
    if (model === 'config') return model;
    if (typeof model !== 'string') return 'gpt-5.5';
    if (/^[A-Za-z0-9._-]+$/.test(model)) return model;
    return 'gpt-5.5';
  }

  normalizeCodexReasoningEffort(effort) {
    if (effort === 'config') return effort;
    if (typeof effort !== 'string') return 'xhigh';
    if (/^[A-Za-z0-9._-]+$/.test(effort)) return effort;
    return 'xhigh';
  }

  normalizeCodexServiceTier(tier) {
    if (typeof tier !== 'string') return 'default';
    if (/^[A-Za-z0-9._-]+$/.test(tier)) return tier;
    return 'default';
  }

  normalizeCodexModelSettings(rawSettings = {}) {
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

  normalizeCodexLaunchProfile(profile = {}, changed = {}) {
    const next = {
      ...DEFAULT_CODEX_LAUNCH_PROFILE,
      ...(profile && typeof profile === 'object' ? profile : {}),
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
    return next;
  }

  normalizeClaudeLaunchProfile(profile = {}) {
    const next = {
      ...DEFAULT_CLAUDE_LAUNCH_PROFILE,
      ...(profile && typeof profile === 'object' ? profile : {}),
    };
    return {
      permissionMode: this.normalizeClaudePermissionMode(next.permissionMode),
      model: this.normalizeClaudeModel(next.model),
      effort: this.normalizeClaudeEffort(next.effort),
    };
  }

  getChangedAgentLaunchProfiles(rawSettings = {}) {
    const changedProfiles = {};
    if (rawSettings.agentLaunchProfiles && typeof rawSettings.agentLaunchProfiles === 'object') {
      for (const [agentName, profile] of Object.entries(rawSettings.agentLaunchProfiles)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_AGENT_LAUNCH_PROFILES, agentName)) continue;
        if (profile && typeof profile === 'object') changedProfiles[agentName] = profile;
      }
    }

    const codexChanged = {};
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

  mergeAgentLaunchProfiles(existingProfiles = {}, incomingProfiles = {}) {
    const merged = {};
    for (const [agentName, defaultProfile] of Object.entries(DEFAULT_AGENT_LAUNCH_PROFILES)) {
      merged[agentName] = {
        ...defaultProfile,
        ...(existingProfiles && typeof existingProfiles === 'object' ? existingProfiles[agentName] : {}),
        ...(incomingProfiles && typeof incomingProfiles === 'object' ? incomingProfiles[agentName] : {}),
      };
    }
    return merged;
  }

  applyCodexProfileToLegacySettings(codexProfile) {
    this.settings.codexApprovalMode = codexProfile.approvalMode;
    this.settings.codexModel = codexProfile.model;
    this.settings.codexReasoningEffort = codexProfile.reasoningEffort;
    this.settings.codexServiceTier = codexProfile.serviceTier;
    this.settings.codexModelPreset = codexProfile.modelPreset;
  }

  normalizeAgentLaunchSettings(rawSettings = {}) {
    const changedProfiles = this.getChangedAgentLaunchProfiles(rawSettings);
    const mergedProfiles = this.mergeAgentLaunchProfiles(this.settings.agentLaunchProfiles, changedProfiles);
    this.settings.agentLaunchProfiles = {
      codex: this.normalizeCodexLaunchProfile(mergedProfiles.codex, changedProfiles.codex || {}),
      claude: this.normalizeClaudeLaunchProfile(mergedProfiles.claude),
    };
    this.settings.defaultLaunchAgent = this.normalizeDefaultLaunchAgent(this.settings.defaultLaunchAgent);
    this.applyCodexProfileToLegacySettings(this.settings.agentLaunchProfiles.codex);
  }
  
  getWorkspace() {
    return this.settings ? this.settings.workspace : this.farmingDir;
  }
  
  getHeartbeatInterval() {
    return this.settings ? (this.settings.heartbeatInterval || 1000) : 1000;
  }

  getDangerouslySkipAgentPermissionsByDefault() {
    return this.settings ? this.settings.dangerouslySkipAgentPermissionsByDefault === true : false;
  }

  getCodexApprovalMode() {
    if (!this.settings) return 'approve';
    return this.getAgentLaunchProfile('codex').approvalMode;
  }

  getCodexModelPreset() {
    if (!this.settings) return 'gpt-5.5:xhigh';
    return this.getAgentLaunchProfile('codex').modelPreset;
  }

  getCodexModel() {
    if (!this.settings) return 'gpt-5.5';
    return this.getAgentLaunchProfile('codex').model;
  }

  getCodexReasoningEffort() {
    if (!this.settings) return 'xhigh';
    return this.getAgentLaunchProfile('codex').reasoningEffort;
  }

  getCodexServiceTier() {
    if (!this.settings) return 'default';
    return this.getAgentLaunchProfile('codex').serviceTier;
  }


  getAgentHomes(provider) {
    const homes = this.settings && this.settings.agentHomes && this.settings.agentHomes[provider]
      ? this.settings.agentHomes[provider]
      : [];
    return homes.map(home => ({ ...home, path: this.expandWorkspacePath(home.path) }));
  }

  getAgentHome(provider, homeId = 'default') {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const normalizedHomeId = String(homeId || 'default').trim();
    const homes = this.getAgentHomes(normalizedProvider);
    return homes.find(home => home.id === normalizedHomeId) || null;
  }

  getDefaultLaunchAgent() {
    return this.settings ? this.normalizeDefaultLaunchAgent(this.settings.defaultLaunchAgent) : 'codex';
  }

  getAgentLaunchProfiles() {
    const profiles = this.settings && this.settings.agentLaunchProfiles
      ? this.settings.agentLaunchProfiles
      : DEFAULT_AGENT_LAUNCH_PROFILES;
    return {
      codex: { ...profiles.codex },
      claude: { ...profiles.claude },
    };
  }

  getAgentLaunchProfile(agentName) {
    const profiles = this.getAgentLaunchProfiles();
    const profile = profiles[agentName] || DEFAULT_AGENT_LAUNCH_PROFILES[agentName];
    return profile ? { ...profile } : {};
  }

  getSettings() {
    return {
      ...this.settings,
      instanceName: this.getInstanceName(),
      workspace: this.farmingDir,
      mainPageSessionKeys: this.getMainPageSessionKeys(),
      taskHistory: this.getTaskHistory(),
    };
  }

  getMainPageSessionKeys() {
    return this.sessionStore ? this.sessionStore.getMainPageSessionKeys() : [];
  }

  setMainPageSessionKeys(keys) {
    return this.sessionStore ? this.sessionStore.setMainPageSessionKeys(keys) : [];
  }

  rememberMainPageSessionKey(sessionKey, patch = {}) {
    return this.sessionStore ? this.sessionStore.rememberMainPageSessionKey(sessionKey, patch) : [];
  }

  removeMainPageSessionKey(sessionKey) {
    return this.sessionStore ? this.sessionStore.removeMainPageSessionKey(sessionKey) : false;
  }

  removeMainPageSessionKeys(keys) {
    return this.sessionStore ? this.sessionStore.removeMainPageSessionKeys(keys) : [];
  }

  ensureAgentSessionRecord(agent, patch = {}) {
    return this.sessionStore ? this.sessionStore.ensureRecordForAgent(agent, patch) : '';
  }

  setProviderSessionDisplayState(sessionKey, patch = {}) {
    return this.sessionStore ? this.sessionStore.setProviderSessionDisplayState(sessionKey, patch) : '';
  }

  listAgentSessionRecords() {
    return this.sessionStore ? this.sessionStore.listAgentRecords() : [];
  }

  rememberAgentSessionRecord(agent) {
    return this.sessionStore ? this.sessionStore.rememberAgent(agent) : '';
  }

  getTaskHistory() {
    return this.runHistoryStore ? this.runHistoryStore.getEntries() : [];
  }

  writeSettingsFile() {
    fs.mkdirSync(this.farmingDir, { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }

  appendTaskHistory(entry) {
    if (!this.runHistoryStore) return;
    this.runHistoryStore.appendEntry(entry);
  }
  
  updateSettings(newSettings) {
    const incomingMainPageSessionKeys = Object.prototype.hasOwnProperty.call(newSettings || {}, 'mainPageSessionKeys')
      ? newSettings.mainPageSessionKeys
      : undefined;
    const settingsPatch = { ...(newSettings || {}) };
    delete settingsPatch.mainPageSessionKeys;
    const incomingTaskHistory = Object.prototype.hasOwnProperty.call(settingsPatch, 'taskHistory')
      ? settingsPatch.taskHistory
      : undefined;
    delete settingsPatch.taskHistory;
    const previousMainWorkspace = this.settings.lastMainWorkspace || this.farmingDir;
    const previousProfiles = this.settings.agentLaunchProfiles || {};
    const incomingProfiles = settingsPatch.agentLaunchProfiles || {};
    this.settings = {
      ...this.settings,
      ...settingsPatch,
      agentLaunchProfiles: this.mergeAgentLaunchProfiles(previousProfiles, incomingProfiles),
      workspace: this.farmingDir
    };
    this.settings.lastMainWorkspace = this.normalizeMainWorkspace(this.settings.lastMainWorkspace, previousMainWorkspace);
    this.settings.workspaceHistory = this.normalizeWorkspaceHistory(this.settings.workspaceHistory);
    this.settings.projectWorkspaces = this.normalizeProjectWorkspaces(this.settings.projectWorkspaces);
    this.settings.pinnedProjectWorkspaces = this.normalizeProjectWorkspaces(this.settings.pinnedProjectWorkspaces);
    this.settings.projectNames = this.normalizeProjectNames(this.settings.projectNames);
    this.settings.instanceName = this.normalizeInstanceName(this.settings.instanceName);
    this.settings.agentHomes = this.normalizeAgentHomes(this.settings.agentHomes);
    this.settings.updateUrl = this.normalizeUpdateUrl(this.settings.updateUrl);
    this.settings.searchTimeoutMs = this.normalizeSearchTimeoutMs(this.settings.searchTimeoutMs);
    delete this.settings.codexRuntimeMode;
    delete this.settings.mainPageSessionKeys;
    delete this.settings.taskHistory;
    if (incomingMainPageSessionKeys !== undefined) {
      this.setMainPageSessionKeys(incomingMainPageSessionKeys);
    }
    if (incomingTaskHistory !== undefined && this.runHistoryStore) {
      this.runHistoryStore.setEntries(incomingTaskHistory);
    }
    this.settings.appearance = this.normalizeAppearance(this.settings.appearance);
    this.settings.language = this.normalizeLanguage(this.settings.language);
    this.settings.crtSkinEffectsEnabled = this.settings.crtSkinEffectsEnabled !== false;
    this.settings.crtDynamicHeatEnabled = this.settings.crtDynamicHeatEnabled === true;
    this.settings.crtTerminalFontSize = this.normalizeCrtTerminalFontSize(this.settings.crtTerminalFontSize);
    this.normalizeAgentLaunchSettings(settingsPatch);
    this.pruneUnknownSettings();
    this.writeSettingsFile();
  }
}

module.exports = ConfigManager;
module.exports.DEFAULT_UPDATE_URL = DEFAULT_UPDATE_URL;
module.exports.DEFAULT_SEARCH_TIMEOUT_MS = DEFAULT_SEARCH_TIMEOUT_MS;
module.exports.DEFAULT_CRT_TERMINAL_FONT_SIZE = DEFAULT_CRT_TERMINAL_FONT_SIZE;
module.exports.MIN_CRT_TERMINAL_FONT_SIZE = MIN_CRT_TERMINAL_FONT_SIZE;
module.exports.MAX_CRT_TERMINAL_FONT_SIZE = MAX_CRT_TERMINAL_FONT_SIZE;
