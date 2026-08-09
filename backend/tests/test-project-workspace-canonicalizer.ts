const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createProjectWorkspaceCanonicalizer } = require('../project-workspace-canonicalizer.cjs') as typeof import('../project-workspace-canonicalizer.cjs');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

async function run(): Promise<void> {
  const inspectGate = deferred<string>();
  const realpathGate = deferred<string>();
  let inspectCalls = 0;
  let realpathCalls = 0;
  const resolveWorkspace = createProjectWorkspaceCanonicalizer({
    async inspectWorkspace() {
      inspectCalls += 1;
      return inspectGate.promise;
    },
    async realpath() {
      realpathCalls += 1;
      return realpathGate.promise;
    },
    warnInspectFailure: () => {},
  });

  const first = resolveWorkspace('/candidate');
  const second = resolveWorkspace('/candidate');
  await Promise.resolve();
  assert.strictEqual(inspectCalls, 1, 'same-candidate inspect must be singleflight');
  inspectGate.resolve('');
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(realpathCalls, 1, 'fallback realpath remains inside the same singleflight');
  const third = resolveWorkspace('/candidate');
  assert.strictEqual(realpathCalls, 1);
  realpathGate.resolve('/canonical');
  assert.deepStrictEqual(await Promise.all([first, second, third]), ['/canonical', '/canonical', '/canonical']);

  const afterCompletion = resolveWorkspace('/candidate');
  await Promise.resolve();
  assert.strictEqual(inspectCalls, 2, 'terminal resolution must release its pending entry');
  assert.strictEqual(await afterCompletion, '/canonical');

  let successfulRealpathCalls = 0;
  const inspectWins = createProjectWorkspaceCanonicalizer({
    inspectWorkspace: async () => '/registered-worktree',
    realpath: async () => {
      successfulRealpathCalls += 1;
      return '/must-not-run';
    },
    warnInspectFailure: () => {},
  });
  assert.strictEqual(await inspectWins('/candidate'), '/registered-worktree');
  assert.strictEqual(successfulRealpathCalls, 0, 'authoritative worktree identity keeps precedence');

  const warnings: Array<{ candidate: string; error: unknown }> = [];
  const inspectFailureFallsBack = createProjectWorkspaceCanonicalizer({
    inspectWorkspace: async () => { throw new Error('inspect unavailable'); },
    realpath: async () => '/realpath-fallback',
    warnInspectFailure: (candidate, error) => warnings.push({ candidate, error }),
  });
  assert.strictEqual(await inspectFailureFallsBack('/candidate'), '/realpath-fallback');
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].candidate, '/candidate');

  const unavailableFallback = createProjectWorkspaceCanonicalizer({
    inspectWorkspace: async () => '',
    realpath: async () => { throw new Error('missing'); },
    warnInspectFailure: () => {},
  });
  assert.strictEqual(await unavailableFallback('/candidate'), '/candidate', 'unavailable realpath preserves the original fallback response');
  assert.strictEqual(await unavailableFallback(''), '');

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.cts'), 'utf8');
  assert(
    serverSource.includes('const canonicalProjectWorkspaceCandidate = createProjectWorkspaceCanonicalizer({')
      && serverSource.includes('realpath: candidate => fs.promises.realpath(path.resolve(candidate))')
      && !serverSource.includes('return fs.realpathSync(path.resolve(candidate))'),
    'the production fallback must use the async realpath port without reintroducing event-loop blocking',
  );

  console.log('Project workspace canonicalizer singleflight passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
