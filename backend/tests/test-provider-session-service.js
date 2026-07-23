const assert = require('assert');
const { ProviderSessionService } = require('../provider-session-service');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function run() {
  const workspace = '/tmp/provider-session-service';
  const temporaryId = 'tmp_uuid-provider-session';
  const confirmedId = '11111111-2222-4333-8444-555555555555';
  const agents = new Map([[
    'temporary',
    {
      id: 'temporary',
      cwd: workspace,
      projectWorkspace: workspace,
      providerSessionProvider: 'codex',
      providerSessionId: temporaryId,
      providerSessionTemporary: true,
      providerHomeId: 'default',
      startedAt: Date.now(),
    },
  ]]);
  const commits = [];
  const scan = deferred();
  let scanCount = 0;
  const service = new ProviderSessionService({
    agents,
    commit(agent, change) {
      commits.push({ agent: { ...agent }, change });
    },
    listCodexSessionIdentities() {
      scanCount += 1;
      return scan.promise;
    },
    findAgentSession: async () => null,
  });

  const first = service.resolveTemporaryCodex('temporary', { force: true });
  const second = service.resolveTemporaryCodex('temporary', { force: true });
  await Promise.resolve();
  assert.strictEqual(scanCount, 1, 'concurrent observations should share one Codex history scan');
  scan.resolve([{
    id: confirmedId,
    workspace,
    createdAt: new Date().toISOString(),
    title: 'confirmed title',
  }]);
  assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
  assert.strictEqual(agents.get('temporary').providerSessionId, confirmedId);
  assert.strictEqual(agents.get('temporary').providerSessionTemporary, false);
  assert.strictEqual(
    agents.get('temporary').providerSessionKey,
    `agent-session:codex:${confirmedId}`
  );
  assert.strictEqual(commits.length, 1, 'one confirmed identity should commit once');
  assert.strictEqual(commits[0].change.kind, 'session-updated');

  let cooldownScans = 0;
  agents.set('cooldown', {
    id: 'cooldown',
    cwd: workspace,
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid-cooldown',
    providerSessionTemporary: true,
    startedAt: Date.now(),
  });
  const cooldownService = new ProviderSessionService({
    agents,
    listCodexSessionIdentities: async () => {
      cooldownScans += 1;
      return [];
    },
  });
  assert.strictEqual(await cooldownService.resolveTemporaryCodex('cooldown'), false);
  assert.strictEqual(await cooldownService.resolveTemporaryCodex('cooldown'), false);
  assert.strictEqual(cooldownScans, 1, 'unchanged observations should honor the scan cooldown');
  assert.strictEqual(await cooldownService.resolveTemporaryCodex('cooldown', { force: true }), false);
  assert.strictEqual(cooldownScans, 2, 'an explicit lifecycle trigger may bypass the cooldown');

  agents.set('ambiguous', {
    id: 'ambiguous',
    cwd: workspace,
    projectWorkspace: workspace,
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid-ambiguous',
    providerSessionTemporary: true,
    providerHomeId: 'default',
    startedAt: Date.now(),
  });
  const ambiguousService = new ProviderSessionService({
    agents,
    listCodexSessionIdentities: async () => [
      { id: 'codex-a', workspace, createdAt: new Date().toISOString() },
      { id: 'codex-b', workspace, createdAt: new Date().toISOString() },
    ],
  });
  assert.strictEqual(
    await ambiguousService.resolveTemporaryCodex('ambiguous', { force: true }),
    false,
    'multiple matching sessions must remain temporary instead of selecting the nearest timestamp',
  );
  assert.strictEqual(agents.get('ambiguous').providerSessionTemporary, true);

  const raceScan = deferred();
  const raceStartedAt = Date.now();
  for (const id of ['race-a', 'race-b']) {
    agents.set(id, {
      id,
      cwd: workspace,
      projectWorkspace: workspace,
      providerSessionProvider: 'codex',
      providerSessionId: `tmp_uuid-${id}`,
      providerSessionTemporary: true,
      providerHomeId: 'default',
      startedAt: raceStartedAt,
    });
  }
  const raceService = new ProviderSessionService({
    agents,
    listCodexSessionIdentities: () => {
      raceScan.scanCount = (raceScan.scanCount || 0) + 1;
      return raceScan.promise;
    },
  });
  const raceA = raceService.resolveTemporaryCodex('race-a', { force: true });
  const raceB = raceService.resolveTemporaryCodex('race-b', { force: true });
  raceScan.resolve([{
    id: 'codex-race',
    workspace,
    createdAt: new Date(raceStartedAt).toISOString(),
  }]);
  const raceResults = await Promise.all([raceA, raceB]);
  assert.strictEqual(raceScan.scanCount, 1, 'temporary Agents in one Codex Home should share an in-flight identity scan');
  assert.strictEqual(raceResults.filter(Boolean).length, 1, 'one rollout may be claimed by only one live Agent');
  assert.strictEqual(
    [...agents.values()].filter(agent => agent.providerSessionId === 'codex-race').length,
    1,
  );

  const boundedStartedAt = Date.now();
  agents.set('bounded', {
    id: 'bounded',
    cwd: workspace,
    projectWorkspace: workspace,
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid-bounded',
    providerSessionTemporary: true,
    providerHomeId: 'default',
    startedAt: boundedStartedAt,
  });
  const boundedService = new ProviderSessionService({
    agents,
    listCodexSessionIdentities: async () => [
      {
        id: 'codex-future',
        workspace,
        createdAt: new Date(boundedStartedAt + 10 * 60 * 1000).toISOString(),
      },
      {
        id: 'codex-updated-only',
        workspace,
        updatedAt: new Date(boundedStartedAt).toISOString(),
      },
      {
        id: 'codex-linked-worktree',
        workspace: '/tmp/provider-session-linked-worktree',
        createdAt: new Date(boundedStartedAt).toISOString(),
      },
    ],
    isLinkedWorktreeOf: async () => true,
  });
  assert.strictEqual(
    await boundedService.resolveTemporaryCodex('bounded', { force: true }),
    false,
    'future, updated-only, and linked-worktree candidates must not be guessed as the fresh session',
  );

  agents.set('workspace-missing', {
    id: 'workspace-missing',
    cwd: '',
    projectWorkspace: '',
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid-workspace-missing',
    providerSessionTemporary: true,
    providerHomeId: 'default',
    startedAt: boundedStartedAt,
  });
  const missingWorkspaceService = new ProviderSessionService({
    agents,
    listCodexSessionIdentities: async () => [{
      id: 'codex-foreign-workspace',
      workspace: '/definitely/a/different/workspace',
      createdAt: new Date(boundedStartedAt).toISOString(),
    }],
  });
  assert.strictEqual(
    await missingWorkspaceService.resolveTemporaryCodex('workspace-missing', { force: true }),
    false,
    'a missing Agent workspace cannot prove ownership of an otherwise unique rollout',
  );

  let expiredScans = 0;
  const expiredStartedAt = Date.now() - 60 * 1000;
  agents.set('expired', {
    id: 'expired',
    cwd: workspace,
    projectWorkspace: workspace,
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid-expired',
    providerSessionTemporary: true,
    providerHomeId: 'default',
    startedAt: expiredStartedAt,
  });
  const expiredService = new ProviderSessionService({
    agents,
    listCodexSessionIdentities: async () => {
      expiredScans += 1;
      return [{
        id: 'codex-expired-recovery',
        workspace,
        createdAt: new Date(expiredStartedAt).toISOString(),
      }];
    },
  });
  assert.strictEqual(await expiredService.resolveTemporaryCodex('expired'), false);
  assert.strictEqual(expiredScans, 0, 'ordinary output must stop scanning after the bounded launch window');
  assert.strictEqual(
    await expiredService.resolveTemporaryCodex('expired', { force: true }),
    true,
    'a structural recovery trigger may perform one exact late scan',
  );

  const titleLookup = deferred();
  const titleCommits = [];
  agents.set('title', {
    id: 'title',
    cwd: workspace,
    providerSessionProvider: 'claude',
    providerSessionId: 'claude-session-a',
    providerSessionTemporary: false,
    providerSessionTitle: '',
  });
  const titleService = new ProviderSessionService({
    agents,
    findAgentSession: () => titleLookup.promise,
    commit(agent, change) {
      titleCommits.push({ agent, change });
    },
  });
  const titleResolution = titleService.resolveTitle('title', { force: true });
  agents.get('title').providerSessionId = 'claude-session-b';
  titleLookup.resolve({ title: 'stale title' });
  assert.strictEqual(await titleResolution, false);
  assert.strictEqual(agents.get('title').providerSessionTitle, '');
  assert.deepStrictEqual(titleCommits, [], 'a stale title lookup must not mutate a different session');

  service.dispose();
  cooldownService.dispose();
  ambiguousService.dispose();
  raceService.dispose();
  boundedService.dispose();
  missingWorkspaceService.dispose();
  expiredService.dispose();
  titleService.dispose();
  console.log('test-provider-session-service passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
