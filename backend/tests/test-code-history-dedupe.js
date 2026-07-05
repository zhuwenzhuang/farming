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
  const { buildHistoryAgentItems } = importTsModule('src/components/code/HistoryPanel.tsx');
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
  assert.strictEqual(
    items.filter(item => item.kind === 'run' && item.entry.source === claudeSource).length,
    1,
    'Repeated Claude process-exit history rows with the same resume id should collapse'
  );

  console.log('test-code-history-dedupe passed');
}

run();
