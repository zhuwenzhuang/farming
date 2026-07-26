const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const workspaceSource = fs.readFileSync(path.join(__dirname, '../../src/components/CodeWorkspace.tsx'), 'utf8');

function loadMutationHelper() {
  const start = workspaceSource.indexOf('export type MainPageSessionKeyMutation =');
  const end = workspaceSource.indexOf('\nexport function CodeWorkspace', start);
  assert(start >= 0 && end > start, 'main-page mutation helper should remain directly testable');
  const compiled = ts.transpileModule(workspaceSource.slice(start, end), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const testModule = { exports: {} };
  Function('module', 'exports', compiled)(testModule, testModule.exports);
  return testModule.exports.applyPendingMainPageSessionKeyMutations;
}

function run() {
  const applyPending = loadMutationHelper();
  assert(
    workspaceSource.includes('const MAIN_PAGE_SESSION_MUTATION_TIMEOUT_MS = 15_000')
      && workspaceSource.includes('fetchMainPageSessionMutation(appPath(\'/api/main-page-agent-sessions\')')
      && workspaceSource.includes('fetchMainPageSessionMutation(appPath(\'/api/settings\'))'),
    'main-page mutation and authoritative reconciliation requests must both have a bounded wait',
  );
  const add = { version: 1, operation: 'add', sessionKeys: ['codex:default:one'] };
  const remove = { version: 2, operation: 'remove', sessionKeys: ['codex:default:one'] };

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

run();
