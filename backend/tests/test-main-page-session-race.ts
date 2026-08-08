const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workspaceSource = fs.readFileSync(path.join(__dirname, '../../src/components/CodeWorkspace.tsx'), 'utf8');

async function run() {
  const imported = await import('../../src/lib/main-page-session-mutations.ts');
  const applyPending = imported.applyPendingMainPageSessionKeyMutations;
  assert(
    workspaceSource.includes('const MAIN_PAGE_SESSION_MUTATION_TIMEOUT_MS = 15_000')
      && workspaceSource.includes('fetchMainPageSessionMutation(appPath(\'/api/main-page-agent-sessions\')')
      && workspaceSource.includes('fetchMainPageSessionMutation(appPath(\'/api/settings\'))'),
    'main-page mutation and authoritative reconciliation requests must both have a bounded wait',
  );
  const add = { version: 1, operation: 'add' as const, sessionKeys: ['codex:default:one'] };
  const remove = { version: 2, operation: 'remove' as const, sessionKeys: ['codex:default:one'] };

  assert.deepStrictEqual(applyPending([], [add, remove]), []);

  const pendingAfterAddResponse = [remove];
  assert.deepStrictEqual(
    applyPending(['codex:default:one'], pendingAfterAddResponse),
    [],
    'an old add broadcast must not undo the newer local remove while its HTTP command is pending',
  );

  assert.deepStrictEqual(
    applyPending([], []),
    [],
    'the authoritative remove response should converge once the pending command is released',
  );

  assert.deepStrictEqual(
    applyPending(['codex:default:one'], [
      { version: 3, operation: 'add', sessionKeys: ['codex:default:two'] },
      { version: 4, operation: 'remove', sessionKeys: ['codex:default:one'] },
    ]),
    ['codex:default:two'],
    'pending deltas should replay in local command order over each remote baseline',
  );

  console.log('✓ Main-page pending commands replay over stale WebSocket snapshots in local order');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
