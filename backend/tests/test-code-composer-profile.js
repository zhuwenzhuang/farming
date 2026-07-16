const assert = require('assert');
const {
  buildComposerControlState,
  effectiveClaudePermissionModeForSession,
  effectiveCodexApprovalModeForSession,
  resolveCodexComposerProfile,
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
    codexModel: 'gpt-5.6-sol',
    codexReasoningEffort: 'ultra',
    codexServiceTier: 'priority',
    codexModelPreset: 'gpt-5.6-sol:ultra',
    codexModelOptions: [],
    codexApprovalMode: 'approve',
    claudeModel: 'config',
    claudeEffort: 'config',
    claudeSettings: {},
    claudePermissionMode: 'default',
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

  console.log('test-code-composer-profile passed');
}

run();
