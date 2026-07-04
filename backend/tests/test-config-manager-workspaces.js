const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ConfigManager = require('../config-manager');

function run() {
  const previousConfigDir = process.env.FARMING_CONFIG_DIR;
  const tmpBase = path.resolve(__dirname, '..', '..', '.tmp');
  fs.mkdirSync(tmpBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(tmpBase, 'farming-config-manager-'));
  const farmingDir = path.join(tmpRoot, '.farming');
  const projectA = path.join(tmpRoot, 'project-a');
  const projectB = path.join(tmpRoot, 'project-b');
  const projectMain = path.join(tmpRoot, 'main-workspace');

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
    assert.deepStrictEqual(settings.mainPageSessionKeys, []);
    assert.strictEqual(settings.appearance, 'light');
    assert.strictEqual(settings.language, 'en');
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
    assert.strictEqual(settings.removedSetting, undefined);
    assert(fs.existsSync(path.join(farmingDir, 'FARMING_MAIN_AGENT_SKILLS.md')));
    assert(fs.existsSync(path.join(farmingDir, 'CLAUDE.md')));
    assert(fs.existsSync(path.join(farmingDir, 'AGENTS.md')));

    manager.updateSettings({
      removedSetting: 'legacy-value',
      workspaceHistory: [farmingDir, projectA, projectA, projectB, '/tmp', '/var/tmp/farming-e2e'],
      lastMainWorkspace: projectMain,
    });

    settings = manager.getSettings();
    assert.deepStrictEqual(settings.workspaceHistory, [projectA, projectB]);
    assert.strictEqual(settings.lastMainWorkspace, projectMain);
    assert.strictEqual(settings.removedSetting, undefined);

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

    manager.updateSettings({
      mainPageSessionKeys: Array.from({ length: 60 }, (_, index) => `agent-session:codex:bulk-${index}`),
    });
    assert.strictEqual(manager.getSettings().mainPageSessionKeys.length, 50);
    assert.strictEqual(manager.getSettings().mainPageSessionKeys[0], 'agent-session:codex:bulk-0');
    assert.strictEqual(manager.getSettings().mainPageSessionKeys[49], 'agent-session:codex:bulk-49');

    manager.updateSettings({ appearance: 'dark', language: 'zh' });
    assert.strictEqual(manager.getSettings().appearance, 'dark');
    assert.strictEqual(manager.getSettings().language, 'zh');
    manager.updateSettings({ appearance: 'sepia', language: 'jp' });
    assert.strictEqual(manager.getSettings().appearance, 'light');
    assert.strictEqual(manager.getSettings().language, 'en');

    manager.updateSettings({
      lastMainWorkspace: path.join(tmpRoot, 'missing-workspace'),
      workspaceHistory: [farmingDir, projectB],
    });

    settings = manager.getSettings();
    assert.deepStrictEqual(settings.workspaceHistory, [projectB]);
    assert.strictEqual(settings.lastMainWorkspace, projectMain);

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
      reason: 'stopped',
      startedAt: archivedAt - 1000,
      lastActivity: archivedAt - 500,
      archivedAt,
    });
    assert(fs.existsSync(path.join(farmingDir, 'settings.json')));
    assert.strictEqual(manager.getTaskHistory()[0].agentId, 'agent-after-config-dir-prune');

    const legacyDir = path.join(tmpRoot, '.farming-legacy');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'settings.json'), JSON.stringify({
      dangerouslySkipAgentPermissionsByDefault: true,
    }));
    process.env.FARMING_CONFIG_DIR = legacyDir;
    const legacyManager = new ConfigManager();
    legacyManager.init();
    assert.strictEqual(legacyManager.getSettings().codexApprovalMode, 'full');

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
