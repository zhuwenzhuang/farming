const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ConfigManager = require('../config-manager');
const {
  DEFAULT_CRT_TERMINAL_FONT_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_UPDATE_URL,
  MAX_CRT_TERMINAL_FONT_SIZE,
  MIN_CRT_TERMINAL_FONT_SIZE,
} = ConfigManager;

function run() {
  const previousConfigDir = process.env.FARMING_CONFIG_DIR;
  const tmpBase = path.resolve(__dirname, '..', '..', '.tmp');
  fs.mkdirSync(tmpBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(tmpBase, 'farming-config-manager-'));
  const farmingDir = path.join(tmpRoot, '.farming');
  const projectA = path.join(tmpRoot, 'project-a');
  const projectB = path.join(tmpRoot, 'project-b');
  const projectMain = path.join(tmpRoot, 'main-workspace');
  const missingProject = path.join(tmpRoot, 'missing');

  try {
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    fs.mkdirSync(projectMain, { recursive: true });
    process.env.FARMING_CONFIG_DIR = farmingDir;

    const manager = new ConfigManager();
    manager.init();

    let settings = manager.getSettings();
    assert.strictEqual(settings.workspace, farmingDir);
    assert.strictEqual(settings.lastMainWorkspace, farmingDir);
    assert.deepStrictEqual(settings.workspaceHistory, []);
    assert.deepStrictEqual(settings.projectWorkspaces, []);
    assert.deepStrictEqual(settings.pinnedProjectWorkspaces, []);
    assert.deepStrictEqual(settings.projectNames, {});
    assert.strictEqual(settings.instanceName, os.hostname());
    assert.deepStrictEqual(settings.mainPageSessionKeys, []);
    assert.strictEqual(settings.appearance, 'system');
    assert.strictEqual(settings.language, 'en');
    assert.strictEqual(settings.crtSkinEffectsEnabled, true);
    assert.strictEqual(settings.crtDynamicHeatEnabled, false);
    assert.strictEqual(DEFAULT_CRT_TERMINAL_FONT_SIZE, 15);
    assert.strictEqual(settings.crtTerminalFontSize, DEFAULT_CRT_TERMINAL_FONT_SIZE);
    assert.strictEqual(settings.defaultLaunchAgent, 'codex');
    assert.strictEqual(settings.agentLaunchProfiles.codex.approvalMode, 'approve');
    assert.strictEqual(settings.agentLaunchProfiles.codex.modelPreset, 'gpt-5.5:xhigh');
    assert.strictEqual(settings.agentLaunchProfiles.claude.permissionMode, 'default');
    assert.strictEqual(settings.agentLaunchProfiles.claude.model, 'config');
    assert.strictEqual(settings.agentLaunchProfiles.claude.effort, 'config');
    assert.strictEqual(settings.codexApprovalMode, 'approve');
    assert.strictEqual(settings.codexModelPreset, 'gpt-5.5:xhigh');
    assert.strictEqual(settings.codexModel, 'gpt-5.5');
    assert.strictEqual(settings.codexReasoningEffort, 'xhigh');
    assert.strictEqual(settings.codexServiceTier, 'default');
    assert.strictEqual(settings.codexRuntimeMode, undefined);
    assert.strictEqual(settings.updateUrl, DEFAULT_UPDATE_URL);
    assert.strictEqual(DEFAULT_SEARCH_TIMEOUT_MS, 15000);
    assert.strictEqual(settings.searchTimeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
    assert.strictEqual(settings.removedSetting, undefined);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(farmingDir, 'settings.json'), 'utf8')).mainPageSessionKeys, undefined);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(farmingDir, 'settings.json'), 'utf8')).taskHistory, undefined);
    assert(fs.existsSync(path.join(farmingDir, 'FARMING_MAIN_AGENT_SKILLS.md')));
    assert(fs.existsSync(path.join(farmingDir, 'CLAUDE.md')));
    assert(fs.existsSync(path.join(farmingDir, 'AGENTS.md')));

    manager.updateSettings({
      crtSkinEffectsEnabled: false,
      crtDynamicHeatEnabled: true,
      crtTerminalFontSize: 16,
      removedSetting: 'legacy-value',
      workspaceHistory: [farmingDir, projectA, projectA, projectB, '/tmp', '/var/tmp/farming-e2e'],
      projectWorkspaces: [projectA, projectA, projectB, farmingDir, '/', missingProject],
      pinnedProjectWorkspaces: [projectB, projectA, projectB, missingProject],
      projectNames: {
        [projectA]: 'Project A',
        [projectB]: '',
        '': 'ignored',
      },
      instanceName: '  Build\nMachine  ',
      lastMainWorkspace: projectMain,
    });

    settings = manager.getSettings();
    assert.strictEqual(settings.crtSkinEffectsEnabled, false);
    assert.strictEqual(settings.crtDynamicHeatEnabled, true);
    assert.strictEqual(settings.crtTerminalFontSize, 16);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(farmingDir, 'settings.json'), 'utf8')).crtSkinEffectsEnabled, false);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(farmingDir, 'settings.json'), 'utf8')).crtDynamicHeatEnabled, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(farmingDir, 'settings.json'), 'utf8')).crtTerminalFontSize, 16);
    assert.deepStrictEqual(settings.workspaceHistory, [projectA, projectB]);
    assert.deepStrictEqual(settings.projectWorkspaces, [projectA, projectB, missingProject]);
    assert.deepStrictEqual(settings.pinnedProjectWorkspaces, [projectB, projectA, missingProject]);
    assert.deepStrictEqual(settings.projectNames, { [projectA]: 'Project A' });
    assert.strictEqual(settings.instanceName, 'Build Machine');
    assert.strictEqual(settings.lastMainWorkspace, projectMain);
    assert.strictEqual(settings.removedSetting, undefined);

    let projectMembership = manager.removeProjectWorkspace(missingProject);
    assert.deepStrictEqual(projectMembership.projectWorkspaces, [projectA, projectB]);
    assert.deepStrictEqual(projectMembership.pinnedProjectWorkspaces, [projectB, projectA]);
    projectMembership = manager.mountProjectWorkspace(projectA);
    assert.deepStrictEqual(projectMembership.projectWorkspaces, [projectA, projectB]);
    projectMembership = manager.mountProjectWorkspace(projectB);
    assert.deepStrictEqual(projectMembership.projectWorkspaces, [projectA, projectB]);
    manager.updateSettings({ pinnedProjectWorkspaces: [projectA, projectB] });
    projectMembership = manager.removeProjectWorkspace(projectA);
    assert.deepStrictEqual(projectMembership.projectWorkspaces, [projectB]);
    assert.deepStrictEqual(projectMembership.pinnedProjectWorkspaces, [projectB]);
    projectMembership = manager.mountProjectWorkspace(projectA);
    assert.deepStrictEqual(projectMembership.projectWorkspaces, [projectA, projectB]);
    projectMembership = manager.setProjectWorkspacePinned(projectA, true);
    assert.deepStrictEqual(projectMembership.pinnedProjectWorkspaces, [projectB, projectA]);
    projectMembership = manager.setProjectWorkspacePinned(projectA, false);
    assert.deepStrictEqual(projectMembership.pinnedProjectWorkspaces, [projectB]);
    assert.throws(
      () => manager.mountProjectWorkspace(missingProject),
      /invalid or unavailable/,
    );
    const settingsFile = path.join(farmingDir, 'settings.json');
    const settingsBeforeFailedCommit = fs.readFileSync(settingsFile, 'utf8');
    const renameSync = fs.renameSync;
    fs.renameSync = () => {
      throw new Error('simulated rename failure');
    };
    try {
      assert.throws(() => manager.mountProjectWorkspace(projectMain), /simulated rename failure/);
    } finally {
      fs.renameSync = renameSync;
    }
    assert.deepStrictEqual(manager.getSettings().projectWorkspaces, [projectA, projectB]);
    assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), settingsBeforeFailedCommit);
    assert.deepStrictEqual(
      fs.readdirSync(farmingDir).filter(name => name.startsWith('settings.json.') && name.endsWith('.tmp')),
      [],
    );

    manager.updateSettings({ instanceName: '   ' });
    assert.strictEqual(manager.getSettings().instanceName, os.hostname(), 'a blank name should restore the hostname label');

    manager.updateSettings({
      mainPageSessionKeys: [
        'agent-session:codex:abc-123',
        'bad-key',
        'agent-session:claude:chat:with-colon',
        'agent-session:claude:--resume',
        'agent-session:codex:tmp_uuid_11111111-2222-4333-8444-555555555555',
        'agent-session:codex:abc-123',
      ],
    });
    assert.deepStrictEqual(manager.getSettings().mainPageSessionKeys, [
      'agent-session:codex:abc-123',
      'agent-session:claude:chat:with-colon',
    ]);
    const sessionIndex = JSON.parse(fs.readFileSync(path.join(farmingDir, 'sessions', 'index.json'), 'utf8'));
    assert.deepStrictEqual(sessionIndex.mainPageSessionKeys, [
      'agent-session:codex:abc-123',
      'agent-session:claude:chat:with-colon',
    ]);
    const codexSessionRecord = sessionIndex.providerSessionRecords['agent-session:codex:abc-123'];
    assert(/^fsess_/.test(codexSessionRecord), 'provider session should map to a stable Farming session id');
    assert(fs.existsSync(path.join(farmingDir, 'sessions', `${codexSessionRecord}.json`)));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(farmingDir, 'settings.json'), 'utf8')).mainPageSessionKeys, undefined);

    manager.updateSettings({
      mainPageSessionKeys: Array.from({ length: 60 }, (_, index) => `agent-session:codex:bulk-${index}`),
    });
    assert.strictEqual(manager.getSettings().mainPageSessionKeys.length, 50);
    assert.strictEqual(manager.getSettings().mainPageSessionKeys[0], 'agent-session:codex:bulk-0');
    assert.strictEqual(manager.getSettings().mainPageSessionKeys[49], 'agent-session:codex:bulk-49');

    manager.updateSettings({ appearance: 'dark', language: 'zh' });
    assert.strictEqual(manager.getSettings().appearance, 'dark');
    assert.strictEqual(manager.getSettings().language, 'zh');
    manager.updateSettings({ appearance: 'system' });
    assert.strictEqual(manager.getSettings().appearance, 'system');
    manager.updateSettings({ appearance: 'sepia', language: 'jp' });
    assert.strictEqual(manager.getSettings().appearance, 'system');
    assert.strictEqual(manager.getSettings().language, 'en');
    manager.updateSettings({ updateUrl: 'https://updates.example.test/farming/' });
    assert.strictEqual(manager.getSettings().updateUrl, 'https://updates.example.test/farming/');
    manager.updateSettings({ updateUrl: 'file:///tmp/farming/' });
    assert.strictEqual(manager.getSettings().updateUrl, DEFAULT_UPDATE_URL);
    manager.updateSettings({ updateUrl: '' });
    assert.strictEqual(manager.getSettings().updateUrl, DEFAULT_UPDATE_URL);
    manager.updateSettings({ searchTimeoutMs: 12000 });
    assert.strictEqual(manager.getSettings().searchTimeoutMs, 12000);
    manager.updateSettings({ searchTimeoutMs: 999999 });
    assert.strictEqual(manager.getSettings().searchTimeoutMs, 180000);
    manager.updateSettings({ searchTimeoutMs: 'invalid' });
    assert.strictEqual(manager.getSettings().searchTimeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
    manager.updateSettings({ crtTerminalFontSize: 1 });
    assert.strictEqual(manager.getSettings().crtTerminalFontSize, MIN_CRT_TERMINAL_FONT_SIZE);
    manager.updateSettings({ crtTerminalFontSize: 99 });
    assert.strictEqual(manager.getSettings().crtTerminalFontSize, MAX_CRT_TERMINAL_FONT_SIZE);
    manager.updateSettings({ crtTerminalFontSize: 'invalid' });
    assert.strictEqual(manager.getSettings().crtTerminalFontSize, DEFAULT_CRT_TERMINAL_FONT_SIZE);

    manager.updateSettings({
      lastMainWorkspace: path.join(tmpRoot, 'missing-workspace'),
      workspaceHistory: [farmingDir, projectB],
    });

    settings = manager.getSettings();
    assert.deepStrictEqual(settings.workspaceHistory, [projectB]);
    assert.strictEqual(settings.lastMainWorkspace, projectMain);

    manager.updateSettings({ dangerouslySkipAgentPermissionsByDefault: true });
    assert.strictEqual(manager.getDangerouslySkipAgentPermissionsByDefault(), true);
    assert.strictEqual(manager.getSettings().dangerouslySkipAgentPermissionsByDefault, true);
    manager.updateSettings({ dangerouslySkipAgentPermissionsByDefault: false });
    assert.strictEqual(manager.getDangerouslySkipAgentPermissionsByDefault(), false);

    manager.updateSettings({ codexRuntimeMode: 'app-server' });
    assert.strictEqual(manager.getSettings().codexRuntimeMode, undefined);
    manager.updateSettings({ codexRuntimeMode: 'not-a-runtime' });
    assert.strictEqual(manager.getSettings().codexRuntimeMode, undefined);

    manager.updateSettings({ codexApprovalMode: 'full' });
    assert.strictEqual(manager.getSettings().codexApprovalMode, 'full');
    assert.strictEqual(manager.getSettings().agentLaunchProfiles.codex.approvalMode, 'full');
    manager.updateSettings({ codexApprovalMode: 'invalid-mode' });
    assert.strictEqual(manager.getSettings().codexApprovalMode, 'approve');
    manager.updateSettings({ codexModelPreset: 'gpt-5.4-mini:medium' });
    assert.strictEqual(manager.getSettings().codexModelPreset, 'gpt-5.4-mini:medium');
    assert.strictEqual(manager.getSettings().codexModel, 'gpt-5.4-mini');
    assert.strictEqual(manager.getSettings().codexReasoningEffort, 'medium');
    assert.strictEqual(manager.getSettings().agentLaunchProfiles.codex.model, 'gpt-5.4-mini');
    assert.strictEqual(manager.getSettings().agentLaunchProfiles.codex.reasoningEffort, 'medium');
    manager.updateSettings({ codexModel: 'gpt-5.5', codexReasoningEffort: 'high', codexServiceTier: 'priority' });
    assert.strictEqual(manager.getSettings().codexModelPreset, 'gpt-5.5:high');
    assert.strictEqual(manager.getCodexServiceTier(), 'priority');
    manager.updateSettings({ codexModelPreset: 'invalid model with spaces' });
    assert.strictEqual(manager.getSettings().codexModelPreset, 'gpt-5.5:xhigh');
    manager.updateSettings({
      defaultLaunchAgent: 'claude',
      agentLaunchProfiles: {
        claude: { permissionMode: 'auto', model: 'sonnet', effort: 'high' },
      },
    });
    assert.strictEqual(manager.getDefaultLaunchAgent(), 'claude');
    manager.updateSettings({ defaultLaunchAgent: 'opencode' });
    assert.strictEqual(manager.getDefaultLaunchAgent(), 'opencode');
    manager.updateSettings({ defaultLaunchAgent: 'qoder' });
    assert.strictEqual(manager.getDefaultLaunchAgent(), 'qoder');
    assert.deepStrictEqual(manager.getAgentLaunchProfile('claude'), {
      permissionMode: 'auto',
      model: 'sonnet',
      effort: 'high',
    });
    manager.updateSettings({
      agentLaunchProfiles: {
        claude: { permissionMode: 'auto', model: 'claude-opus-4-8[1m]', effort: 'high' },
      },
    });
    assert.deepStrictEqual(manager.getAgentLaunchProfile('claude'), {
      permissionMode: 'auto',
      model: 'claude-opus-4-8[1m]',
      effort: 'high',
    });
    assert.strictEqual(manager.getSettings().agentLaunchProfiles.codex.modelPreset, 'gpt-5.5:xhigh');
    manager.updateSettings({
      defaultLaunchAgent: 'missing-agent',
      agentLaunchProfiles: {
        claude: { permissionMode: 'bad-mode', model: 'bad model', effort: 'huge' },
      },
    });
    assert.strictEqual(manager.getDefaultLaunchAgent(), 'codex');
    assert.deepStrictEqual(manager.getAgentLaunchProfile('claude'), {
      permissionMode: 'default',
      model: 'config',
      effort: 'config',
    });

    fs.rmSync(farmingDir, { recursive: true, force: true });
    const archivedAt = Date.now();
    manager.appendTaskHistory({
      id: 'history-after-config-dir-prune',
      agentId: 'agent-after-config-dir-prune',
      command: 'codex',
      cwd: projectA,
      projectWorkspace: projectA,
      title: 'config dir prune recovery',
      customTitle: '  Renamed archived Agent  ',
      reason: 'stopped',
      startedAt: archivedAt - 1000,
      lastActivity: archivedAt - 500,
      archivedAt,
    });
    assert.strictEqual(manager.getTaskHistory()[0].agentId, 'agent-after-config-dir-prune');
    const runHistory = JSON.parse(fs.readFileSync(path.join(farmingDir, 'history', 'runs.json'), 'utf8'));
    assert.strictEqual(runHistory[0].agentId, 'agent-after-config-dir-prune');
    assert.strictEqual(runHistory[0].customTitle, 'Renamed archived Agent');

    const legacyDir = path.join(tmpRoot, '.farming-legacy');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'settings.json'), JSON.stringify({
      dangerouslySkipAgentPermissionsByDefault: true,
      workspaceFileSearchTimeoutMs: 3000,
      taskHistory: [{
        id: 'legacy-history-entry',
        agentId: 'legacy-agent',
        command: 'codex',
        reason: 'manual-kill',
        archivedAt: Date.now(),
      }, {
        id: 'legacy-shell-history-entry',
        agentId: 'legacy-shell-agent',
        command: 'env TERM=xterm-256color /bin/bash',
        reason: 'process-exit',
        archivedAt: Date.now() + 1,
      }, {
        id: 'legacy-unsupported-history-entry',
        agentId: 'legacy-unsupported-agent',
        command: 'unknown-agent',
        reason: 'process-exit',
        archivedAt: Date.now() + 2,
      }],
    }));
    process.env.FARMING_CONFIG_DIR = legacyDir;
    const legacyManager = new ConfigManager();
    legacyManager.init();
    assert.strictEqual(legacyManager.getSettings().codexApprovalMode, 'full');
    assert.strictEqual(legacyManager.getSettings().searchTimeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
    assert.strictEqual(legacyManager.getTaskHistory()[0].agentId, 'legacy-agent');
    assert.strictEqual(legacyManager.getTaskHistory().length, 1, 'unsupported legacy runs should be removed during history normalization');
    assert.strictEqual(legacyManager.getTaskHistory()[0].customTitle, '');
    const migratedLegacySettings = JSON.parse(fs.readFileSync(path.join(legacyDir, 'settings.json'), 'utf8'));
    assert.strictEqual(migratedLegacySettings.taskHistory, undefined);
    assert.strictEqual(migratedLegacySettings.workspaceFileSearchTimeoutMs, undefined);
    assert.strictEqual(migratedLegacySettings.searchTimeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(legacyDir, 'history', 'runs.json'), 'utf8'))[0].agentId, 'legacy-agent');

    const legacyCustomTimeoutDir = path.join(tmpRoot, '.farming-legacy-custom-timeout');
    fs.mkdirSync(legacyCustomTimeoutDir, { recursive: true });
    fs.writeFileSync(path.join(legacyCustomTimeoutDir, 'settings.json'), JSON.stringify({
      workspaceFileSearchTimeoutMs: 12000,
    }));
    process.env.FARMING_CONFIG_DIR = legacyCustomTimeoutDir;
    const legacyCustomTimeoutManager = new ConfigManager();
    legacyCustomTimeoutManager.init();
    assert.strictEqual(legacyCustomTimeoutManager.getSettings().searchTimeoutMs, 12000);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(legacyCustomTimeoutDir, 'settings.json'), 'utf8')).workspaceFileSearchTimeoutMs,
      undefined
    );

    console.log('test-config-manager-workspaces passed');
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.FARMING_CONFIG_DIR;
    } else {
      process.env.FARMING_CONFIG_DIR = previousConfigDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run();
