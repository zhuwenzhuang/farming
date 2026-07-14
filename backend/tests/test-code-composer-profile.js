const assert = require('assert');
const {
  buildComposerControlState,
  effectiveClaudePermissionModeForSession,
  effectiveCodexApprovalModeForSession,
} = require('../../src/components/code/composer-profile.ts');
const { FALLBACK_CODEX_MODEL_OPTIONS } = require('../../src/components/code/model.ts');

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
    codexModelOptions: FALLBACK_CODEX_MODEL_OPTIONS,
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

  console.log('test-code-composer-profile passed');
}

run();
