const assert = require('assert');
const {
  effectiveClaudePermissionModeForSession,
  effectiveCodexApprovalModeForSession,
} = require('../../src/components/code/composer-profile.ts');

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

  console.log('test-code-composer-profile passed');
}

run();
