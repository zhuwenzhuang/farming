const assert = require('assert');
const { encodeProviderSessionKey } = require('../../shared/provider-session-identity.js');
const { ProviderSessionService } = require('../provider-session-service.cjs');

interface ProviderTestAgent {
  id: string;
  providerSessionProvider: string;
  providerSessionId: string;
  providerSessionTemporary: boolean;
  providerHomeId?: string;
  providerSessionKey?: string;
  providerSessionTitle?: string;
}

function deferred() {
  let resolve: (_value: unknown) => void = () => {};
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}

async function run() {
  const temporaryId = 'tmp_uuid-provider-session';
  const confirmedId = '11111111-2222-4333-8444-555555555555';
  const agents = new Map<string, ProviderTestAgent>([[
    'temporary',
    {
      id: 'temporary',
      providerSessionProvider: 'codex',
      providerSessionId: temporaryId,
      providerSessionTemporary: true,
      providerHomeId: 'default',
    },
  ]]);
  const commits = [];
  let historyReads = 0;
  const service = new ProviderSessionService({
    agents,
    commit(agent, change) {
      commits.push({ agent: { ...agent }, change });
    },
    findAgentSession: async () => {
      historyReads += 1;
      return null;
    },
  });

  service.activate('temporary');
  service.observe('temporary', { force: true });
  await Promise.resolve();
  assert.strictEqual(
    historyReads,
    0,
    'temporary Codex identities must never be resolved through provider History',
  );
  assert.strictEqual(service.confirm('temporary', {
    provider: 'codex',
    sessionId: confirmedId,
    source: 'codex-terminal-status',
  }), true);
  assert.strictEqual(agents.get('temporary').providerSessionId, confirmedId);
  assert.strictEqual(agents.get('temporary').providerSessionTemporary, false);
  assert.strictEqual(
    agents.get('temporary').providerSessionKey,
    encodeProviderSessionKey('codex', confirmedId, 'default'),
  );
  assert.strictEqual(commits.length, 1, 'one confirmed identity should commit once');
  assert.strictEqual(commits[0].change.kind, 'session-updated');

  agents.set('temporary-opencode', {
    id: 'temporary-opencode',
    providerSessionProvider: 'opencode',
    providerSessionId: 'tmp_uuid-opencode-fork',
    providerSessionTemporary: true,
    providerHomeId: 'default',
  });
  service.activate('temporary-opencode');
  service.observe('temporary-opencode', { force: true });
  await Promise.resolve();
  assert.strictEqual(
    historyReads,
    0,
    'temporary OpenCode identities must receive the same pre-confirmation History guard',
  );

  agents.set('claimed', {
    id: 'claimed',
    providerSessionProvider: 'codex',
    providerSessionId: '22222222-3333-4444-8555-666666666666',
    providerSessionTemporary: false,
    providerHomeId: 'default',
  });
  agents.set('collision', {
    id: 'collision',
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid-collision',
    providerSessionTemporary: true,
    providerHomeId: 'default',
  });
  assert.strictEqual(service.confirm('collision', {
    provider: 'codex',
    sessionId: agents.get('claimed').providerSessionId,
    source: 'codex-terminal-status',
  }), false, 'one exact provider identity cannot be claimed by two live Agents');
  assert.strictEqual(agents.get('collision').providerSessionTemporary, true);

  const titleLookup = deferred();
  const titleCommits = [];
  agents.set('title', {
    id: 'title',
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

  const firstTitleLookup = deferred();
  const secondTitleLookup = deferred();
  let queuedTitleLookupCount = 0;
  agents.set('queued-title', {
    id: 'queued-title',
    providerSessionProvider: 'qwen',
    providerSessionId: 'qwen-session-a',
    providerSessionTemporary: false,
    providerSessionTitle: '',
  });
  const queuedTitleService = new ProviderSessionService({
    agents,
    findAgentSession() {
      queuedTitleLookupCount += 1;
      return queuedTitleLookupCount === 1
        ? firstTitleLookup.promise
        : secondTitleLookup.promise;
    },
  });
  const earlyTitleResolution = queuedTitleService.resolveTitle('queued-title');
  const turnCompletionRefresh = queuedTitleService.resolveTitle('queued-title', { force: true });
  firstTitleLookup.resolve(null);
  await earlyTitleResolution;
  await Promise.resolve();
  assert.strictEqual(
    queuedTitleLookupCount,
    2,
    'a turn-completion refresh must rerun after joining an earlier empty title lookup',
  );
  secondTitleLookup.resolve({ title: 'Analyze the Agent naming regression' });
  assert.strictEqual(await turnCompletionRefresh, true);
  assert.strictEqual(
    agents.get('queued-title').providerSessionTitle,
    'Analyze the Agent naming regression',
  );

  let refreshedProviderTitle = 'first prompt fallback';
  const refreshedTitleCommits = [];
  agents.set('refresh-title', {
    id: 'refresh-title',
    providerSessionProvider: 'codex',
    providerSessionId: 'codex-session-a',
    providerSessionTemporary: false,
    providerSessionTitle: '',
  });
  const refreshedTitleService = new ProviderSessionService({
    agents,
    findAgentSession: async () => ({ title: refreshedProviderTitle }),
    commit(agent, change) {
      refreshedTitleCommits.push({ agent, change });
    },
  });
  assert.strictEqual(await refreshedTitleService.resolveTitle('refresh-title', { force: true }), true);
  assert.strictEqual(agents.get('refresh-title').providerSessionTitle, 'first prompt fallback');
  refreshedProviderTitle = 'Summarize the title sync fix';
  assert.strictEqual(await refreshedTitleService.resolveTitle('refresh-title', { force: true }), true);
  assert.strictEqual(
    agents.get('refresh-title').providerSessionTitle,
    'Summarize the title sync fix',
    'a later provider title must replace an earlier first-prompt fallback',
  );
  assert.strictEqual(refreshedTitleCommits.length, 2);
  assert.strictEqual(await refreshedTitleService.resolveTitle('refresh-title', { force: true }), true);
  assert.strictEqual(refreshedTitleCommits.length, 2, 'an unchanged title must not emit another update');

  service.dispose();
  titleService.dispose();
  queuedTitleService.dispose();
  refreshedTitleService.dispose();
  console.log('test-provider-session-service passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
