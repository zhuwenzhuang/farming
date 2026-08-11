const assert = require('assert');
const {
  buildComposerControlState,
  composerAgentStartOptions,
  composerProfileSettingsPatch,
  defaultComposerProviderProfiles,
  effectiveClaudePermissionModeForSession,
  effectiveCodexApprovalModeForSession,
  normalizeLaunchProfiles,
  resolveCodexComposerProfile,
  selectComposerProviderModel,
  selectComposerProviderPermissionMode,
} = require('../../src/components/code/composer-profile.ts');
const { normalizeModelCatalog } = require('../../src/components/code/model.ts');

function run() {
  assert.strictEqual(
    effectiveCodexApprovalModeForSession(false, '', 'full'),
    'full',
    'without an active agent, the composer should show the saved Codex launch default'
  );
  assert.strictEqual(
    effectiveCodexApprovalModeForSession(true, '', 'full'),
    'custom',
    'an active Codex session without launch permission metadata must not inherit the global Full access label'
  );
  assert.strictEqual(
    effectiveCodexApprovalModeForSession(true, 'full', 'approve'),
    'full',
    'an active Codex session may show Full access only when its launch metadata proves it'
  );
  assert.strictEqual(
    effectiveCodexApprovalModeForSession(true, 'approve', 'full'),
    'approve',
    'an active Codex session should display its own launch mode over the global default'
  );

  assert.strictEqual(
    effectiveClaudePermissionModeForSession(false, '', 'bypassPermissions'),
    'bypassPermissions',
    'without an active agent, the composer should show the saved Claude launch default'
  );
  assert.strictEqual(
    effectiveClaudePermissionModeForSession(true, '', 'bypassPermissions'),
    'default',
    'an active Claude session without launch permission metadata should fall back to session default'
  );
  assert.strictEqual(
    effectiveClaudePermissionModeForSession(true, 'bypassPermissions', 'default'),
    'bypassPermissions',
    'an active Claude session may show bypass only when its launch metadata proves it'
  );

  const pendingCatalogState = buildComposerControlState({
    agentKind: 'codex',
    profile: {
      permissionMode: 'approve',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
      serviceTier: 'priority',
    },
    codexModelOptions: [],
    claudeSettings: {},
  });
  assert.strictEqual(pendingCatalogState.currentModelLabel, '5.6-sol');
  assert.strictEqual(pendingCatalogState.currentReasoningLabel, 'Ultra');
  assert.strictEqual(pendingCatalogState.currentSpeedLabel, 'Fast');
  assert.strictEqual(pendingCatalogState.currentModelOption.value, 'gpt-5.6-sol');
  assert.deepStrictEqual(
    normalizeModelCatalog({}),
    [],
    'a missing backend catalog must not turn into a static frontend fallback'
  );
  assert.deepStrictEqual(
    normalizeModelCatalog({
      models: [{ value: 'gpt-legacy:high', label: 'Legacy', model: 'gpt-legacy', effort: 'high' }],
    }),
    [],
    'the frontend must not revive the removed flat models compatibility shape'
  );

  assert.deepStrictEqual(
    resolveCodexComposerProfile(
      { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', serviceTier: 'priority' },
      { model: 'gpt-5.5', reasoningEffort: 'xhigh', serviceTier: 'default' },
    ),
    { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', serviceTier: 'priority' },
    'a backend-confirmed Terminal footer profile should override the saved launch defaults'
  );
  assert.deepStrictEqual(
    resolveCodexComposerProfile(
      null,
      { model: 'gpt-5.5', reasoningEffort: 'xhigh', serviceTier: 'default' },
    ),
    { model: 'gpt-5.5', reasoningEffort: 'xhigh', serviceTier: 'default' },
    'the composer should use launch defaults only when no live Terminal profile exists'
  );

  const profiles = normalizeLaunchProfiles({
    agentLaunchProfiles: {
      codex: {
        approvalMode: 'full',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        serviceTier: 'priority',
      },
      claude: {
        permissionMode: 'plan',
        model: 'opus',
        effort: 'max',
      },
    },
  });
  assert.deepStrictEqual(profiles.codex, {
    permissionMode: 'full',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    serviceTier: 'priority',
  });
  assert.deepStrictEqual(profiles.claude, {
    permissionMode: 'plan',
    model: 'opus',
    reasoningEffort: 'max',
    serviceTier: '',
  });
  assert.deepStrictEqual(composerProfileSettingsPatch('codex', profiles.codex), {
    approvalMode: 'full',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    serviceTier: 'priority',
  });
  assert.deepStrictEqual(composerProfileSettingsPatch('claude', profiles.claude), {
    permissionMode: 'plan',
    model: 'opus',
    effort: 'max',
  });
  assert.deepStrictEqual(
    composerProfileSettingsPatch('codex', profiles.codex, 'model'),
    { model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'priority' },
    'changing a model must not overwrite the saved permission mode with a session projection'
  );
  assert.deepStrictEqual(
    composerProfileSettingsPatch('claude', profiles.claude, 'permission'),
    { permissionMode: 'plan' },
    'changing permissions must not rewrite unrelated provider model settings'
  );
  assert.deepStrictEqual(
    composerAgentStartOptions('codex', profiles, { providerHomeId: 'work' }),
    { providerHomeId: 'work', codexApprovalMode: 'full', dangerouslySkipPermissions: true },
    'Codex launch flags should be emitted by its profile adapter'
  );
  assert.deepStrictEqual(
    composerAgentStartOptions('claude', profiles, { providerHomeId: 'work' }),
    { providerHomeId: 'work' },
    'providers without extra launch flags should preserve common launch options'
  );

  const defaults = defaultComposerProviderProfiles();
  const selectedClaude = selectComposerProviderModel('claude', defaults.claude, ' sonnet ', []);
  assert.strictEqual(selectedClaude.model, 'sonnet');
  assert.strictEqual(
    selectComposerProviderPermissionMode('claude', selectedClaude, 'invalid').permissionMode,
    'default',
    'permission normalization belongs to the selected provider adapter'
  );

  console.log('test-code-composer-profile passed');
}

run();
