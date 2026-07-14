const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

function historyEntry(overrides = {}) {
  return {
    id: 'history-1',
    agentId: 'agent-1',
    command: 'claude',
    cwd: '/repo',
    projectWorkspace: '/repo',
    title: '',
    task: '',
    workflowTemplate: '',
    source: 'ui',
    reason: 'process-exit',
    status: 'stopped',
    startedAt: 1_000,
    lastActivity: 1_000,
    archivedAt: 1_000,
    ...overrides,
  };
}

function archivedAgent(overrides = {}) {
  return {
    id: 'agent-1',
    command: 'codex',
    cwd: '/repo',
    projectWorkspace: '/repo',
    output: '',
    status: 'stopped',
    isMain: false,
    activityLevel: 'cold',
    lastActivity: 1_000,
    attentionScore: 0,
    isZombie: false,
    archived: true,
    archivedAt: 1_000,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    provider: 'codex',
    providerName: 'Codex',
    id: 'session-1',
    title: 'Session 1',
    cwd: '/repo',
    workspace: '/repo',
    updatedAt: new Date(1_000).toISOString(),
    ...overrides,
  };
}

function run() {
  const { buildHistoryAgentItems, filterHistoryAgentItems, mergeHistoryAgentSessions } = importTsModule('src/components/code/HistoryPanel.tsx');
  const claudeResumeId = 'd7450fc4-37bd-40b1-8523-02ce5b753082';
  const claudeSource = `claude-history:${claudeResumeId}`;
  const codexResumeId = '019f26d3-7485-76d0-8a64-f5cf5d690129';

  const items = buildHistoryAgentItems(
    [
      historyEntry({ id: 'claude-old', source: claudeSource, archivedAt: 1_000 }),
      historyEntry({ id: 'plain-a', source: 'ui', archivedAt: 2_500 }),
      historyEntry({ id: 'plain-b', source: 'ui', archivedAt: 2_000 }),
      historyEntry({ id: 'claude-new', source: claudeSource, archivedAt: 3_000 }),
    ],
    [
      archivedAgent({
        id: 'codex-archived-agent',
        providerSessionProvider: 'codex',
        providerSessionId: codexResumeId,
        providerSessionTemporary: false,
        archivedAt: 4_000,
      }),
    ],
    [
      session({
        provider: 'claude',
        providerName: 'Claude',
        id: claudeResumeId,
        updatedAt: new Date(1_500).toISOString(),
      }),
      session({
        provider: 'codex',
        providerName: 'Codex',
        id: codexResumeId,
        updatedAt: new Date(5_000).toISOString(),
      }),
    ]
  );

  assert.deepStrictEqual(
    items.map(item => item.historyKey),
    [
      `agent-session:codex:${codexResumeId}`,
      'run:claude-new',
      'run:plain-a',
      'run:plain-b',
    ],
    'History should dedupe Codex/Claude resume ids while preserving ordinary runs'
  );

  const repeatedTitleItems = buildHistoryAgentItems([], [], [
    session({ id: 'session-old', title: 'Same task', updatedAt: new Date(1_000).toISOString() }),
    session({ id: 'session-new', title: 'Same task', updatedAt: new Date(2_000).toISOString() }),
  ]);
  assert.deepStrictEqual(
    repeatedTitleItems.map(item => item.historyKey),
    ['agent-session:codex:session-new'],
    'History should collapse duplicate provider sessions with the same title and workspace'
  );
  assert.strictEqual(
    items.filter(item => item.kind === 'run' && item.entry.source === claudeSource).length,
    1,
    'Repeated Claude process-exit history rows with the same resume id should collapse'
  );

  const sharedId = '019f26d3-7485-76d0-8a64-f5cf5d690130';
  const homeItems = buildHistoryAgentItems([], [], [
    session({ id: sharedId, providerHomeId: 'default' }),
    session({ id: sharedId, providerHomeId: 'work' }),
  ]);
  assert.deepStrictEqual(
    homeItems.map(item => item.historyKey).sort(),
    [`agent-session:codex:${sharedId}`, `agent-session:codex:home:work:${sharedId}`].sort(),
    'Sessions with the same provider id in different Agent Homes must remain distinct'
  );

  const searchableItems = buildHistoryAgentItems(
    [historyEntry({ id: 'run-search', task: 'Repair deployment pipeline', cwd: '/repo/infra' })],
    [archivedAgent({ id: 'agent-search', title: 'Review API changes', projectWorkspace: '/repo/backend' })],
    [session({ id: 'session-search', title: '检查SQLTask Alter clustered支持', workspace: '/repo/odps_src' })]
  );
  assert.deepStrictEqual(
    filterHistoryAgentItems(searchableItems, 'alter').map(item => item.historyKey),
    ['agent-session:codex:session-search'],
    'History search should match Agent titles without case sensitivity'
  );
  assert.deepStrictEqual(
    filterHistoryAgentItems(searchableItems, 'BACKEND').map(item => item.historyKey),
    ['agent:agent-search'],
    'History search should match workspace metadata without case sensitivity'
  );
  assert.strictEqual(
    filterHistoryAgentItems(searchableItems, '  ').length,
    searchableItems.length,
    'Blank History queries should preserve the complete list'
  );

  const mergedSessions = mergeHistoryAgentSessions(
    [session({ id: 'loaded-session', title: 'Loaded session' })],
    [
      session({ id: 'loaded-session', title: 'Fresh loaded session' }),
      session({ id: 'older-search-result', title: '上下游联动替代表测试' }),
    ]
  );
  assert.deepStrictEqual(
    mergedSessions.map(item => [item.id, item.title]),
    [
      ['loaded-session', 'Fresh loaded session'],
      ['older-search-result', '上下游联动替代表测试'],
    ],
    'History should merge full search results beyond the loaded page without duplicating sessions'
  );

  console.log('test-code-history-dedupe passed');
}

run();
