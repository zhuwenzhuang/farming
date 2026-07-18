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
    listCodexSessions() {
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
    listCodexSessions: async () => {
      cooldownScans += 1;
      return [];
    },
  });
  assert.strictEqual(await cooldownService.resolveTemporaryCodex('cooldown'), false);
  assert.strictEqual(await cooldownService.resolveTemporaryCodex('cooldown'), false);
  assert.strictEqual(cooldownScans, 1, 'unchanged observations should honor the scan cooldown');
  assert.strictEqual(await cooldownService.resolveTemporaryCodex('cooldown', { force: true }), false);
  assert.strictEqual(cooldownScans, 2, 'an explicit lifecycle trigger may bypass the cooldown');

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
  titleService.dispose();
  console.log('test-provider-session-service passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
