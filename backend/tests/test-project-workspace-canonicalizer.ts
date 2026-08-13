const assert = require('assert');

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
  const realpathGate = deferred<string>();
  let inspectCalls = 0;
  let realpathCalls = 0;
  const resolveWorkspace = createProjectWorkspaceCanonicalizer({
    async inspectWorkspace() {
      inspectCalls += 1;
      return '/must-not-promote';
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
  assert.strictEqual(realpathCalls, 1, 'same-candidate realpath must be singleflight');
  assert.strictEqual(inspectCalls, 0, 'an existing directory must keep its exact real path without Git-root promotion');
  const third = resolveWorkspace('/candidate');
  assert.strictEqual(realpathCalls, 1);
  realpathGate.resolve('/canonical');
  assert.deepStrictEqual(await Promise.all([first, second, third]), ['/canonical', '/canonical', '/canonical']);

  const afterCompletion = resolveWorkspace('/candidate');
  await Promise.resolve();
  assert.strictEqual(realpathCalls, 2, 'terminal resolution must release its pending entry');
  assert.strictEqual(inspectCalls, 0);
  assert.strictEqual(await afterCompletion, '/canonical');

  let fallbackInspectCalls = 0;
  const inspectFallback = createProjectWorkspaceCanonicalizer({
    inspectWorkspace: async () => {
      fallbackInspectCalls += 1;
      return '/registered-worktree';
    },
    realpath: async () => { throw new Error('realpath unavailable'); },
    warnInspectFailure: () => {},
  });
  assert.strictEqual(await inspectFallback('/candidate'), '/registered-worktree');
  assert.strictEqual(fallbackInspectCalls, 1, 'Git inspection remains a fallback for an unavailable real path');

  const warnings: Array<{ candidate: string; error: unknown }> = [];
  const inspectFailureFallsBack = createProjectWorkspaceCanonicalizer({
    inspectWorkspace: async () => { throw new Error('inspect unavailable'); },
    realpath: async () => { throw new Error('realpath unavailable'); },
    warnInspectFailure: (candidate, error) => warnings.push({ candidate, error }),
  });
  assert.strictEqual(await inspectFailureFallsBack('/candidate'), '/candidate');
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].candidate, '/candidate');

  const unavailableFallback = createProjectWorkspaceCanonicalizer({
    inspectWorkspace: async () => '',
    realpath: async () => { throw new Error('missing'); },
    warnInspectFailure: () => {},
  });
  assert.strictEqual(await unavailableFallback('/candidate'), '/candidate', 'unavailable realpath preserves the original fallback response');
  assert.strictEqual(await unavailableFallback(''), '');

  console.log('Project workspace canonicalizer singleflight passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
