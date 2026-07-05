const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

function agent(overrides = {}) {
  return {
    id: 'agent-1',
    command: 'bash',
    cwd: '/repo',
    projectWorkspace: '/repo',
    output: '',
    status: 'running',
    isMain: false,
    archived: false,
    source: 'ui',
    startedAt: 100_000,
    lastActivity: 100_000,
    activityLevel: 'warm',
    attentionScore: 0,
    isZombie: false,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    provider: 'codex',
    id: 'session-1',
    title: 'Session 1',
    cwd: '/repo',
    workspace: '/repo',
    updatedAt: new Date(200_000).toISOString(),
    ...overrides,
  };
}

function run() {
  const {
    agentListRowIdentity,
    buildAgentListState,
    claimedAgentSessionKeysForAgents,
    isAgentListLiveAgent,
  } = importTsModule('src/components/code/agent-list-state.ts');

  const agents = [
    agent({ id: 'main', isMain: true, command: 'bash' }),
    agent({ id: 'new-shell', source: 'ui', command: 'bash' }),
    agent({ id: 'fork-shell', source: 'fork', parentAgentId: 'new-shell', command: 'bash' }),
    agent({
      id: 'recovered-codex',
      source: 'native-recovered',
      command: 'codex',
      providerSessionKey: 'agent-session:codex:code-claimed',
      providerSessionProvider: 'codex',
      providerSessionId: 'code-claimed',
      startedAt: 190_000,
    }),
    agent({ id: 'resumed-claude-old', source: 'claude-history:claude-claimed', command: 'claude', cwd: '/repo2', projectWorkspace: '/repo2', startedAt: 80_000 }),
    agent({ id: 'resumed-claude', source: 'claude-history:claude-claimed', command: 'claude', cwd: '/repo2', projectWorkspace: '/repo2', startedAt: 240_000 }),
    agent({ id: 'stopped-resumed-claude', source: 'claude-history:stopped-claude', command: 'claude', status: 'stopped', cwd: '/repo3', projectWorkspace: '/repo3', startedAt: 250_000 }),
    agent({ id: 'archived', archived: true, archivedAt: 300_000 }),
    agent({ id: 'stopped', status: 'stopped' }),
    agent({ id: 'dead', status: 'dead' }),
  ];
  const sessions = [
    session({ id: 'code-claimed', workspace: '/repo', cwd: '/repo', updatedAt: new Date(200_000).toISOString() }),
    session({ id: 'sidebar-open', workspace: '/other', cwd: '/other', updatedAt: new Date(260_000).toISOString() }),
    session({ provider: 'claude', id: 'claude-claimed', workspace: '/repo2', cwd: '/repo2', updatedAt: new Date(240_000).toISOString() }),
    session({ provider: 'claude', id: 'stopped-claude', workspace: '/repo3', cwd: '/repo3', updatedAt: new Date(250_000).toISOString() }),
    session({ id: 'history-open', workspace: '/history', cwd: '/history', updatedAt: new Date(220_000).toISOString() }),
    session({ id: 'older-unclaimed', workspace: '/repo', cwd: '/repo', updatedAt: new Date(10_000).toISOString() }),
  ];

  const liveAgents = agents.filter(isAgentListLiveAgent);
  const state = buildAgentListState({
    allAgents: agents.filter(item => !item.isMain),
    liveAgents,
    sessions,
    mainPageSessionKeys: new Set([
      'agent-session:codex:code-claimed',
      'agent-session:codex:sidebar-open',
      'agent-session:claude:claude-claimed',
      'agent-session:claude:stopped-claude',
    ]),
  });

  assert.deepStrictEqual(
    state.liveAgents.map(item => item.id),
    ['new-shell', 'fork-shell', 'recovered-codex', 'resumed-claude'],
    'new and forked shells stay unique, duplicate Codex/Claude resume ids collapse, and stopped runtime rows leave the agent list'
  );
  assert.strictEqual(
    agentListRowIdentity(state.liveAgents.find(item => item.id === 'recovered-codex'), state.claimedAgentSessionKeyByAgentId),
    'agent-session:codex:code-claimed',
    'Codex/Claude live rows should use provider resume ids once the provider session is claimed'
  );
  assert.deepStrictEqual(state.archivedAgents.map(item => item.id), ['archived']);
  assert.deepStrictEqual(
    Array.from(state.claimedAgentSessionKeys).sort(),
    ['agent-session:claude:claude-claimed', 'agent-session:codex:code-claimed'],
    'live runtime rows should claim matching provider sessions instead of creating duplicate sidebar rows'
  );
  assert.deepStrictEqual(
    state.sidebarAgentSessions.map(item => item.id),
    ['sidebar-open', 'stopped-claude'],
    'unclaimed main-page sessions, including stopped provider sessions, should remain as resumable session rows'
  );
  assert.deepStrictEqual(
    state.historyAgentSessions.map(item => item.id),
    ['history-open', 'older-unclaimed'],
    'history keeps unclaimed non-main-page sessions out of the active agent list'
  );
  assert.deepStrictEqual(
    Array.from(claimedAgentSessionKeysForAgents([
      agent({ id: 'plain-codex', command: 'codex', source: 'ui' }),
      agent({ id: 'main-codex', isMain: true, command: 'codex' }),
      agent({ id: 'dead-codex', status: 'dead', command: 'codex' }),
      agent({ id: 'stopped-codex', status: 'stopped', command: 'codex' }),
      agent({ id: 'archived-codex', archived: true, command: 'codex' }),
    ], sessions)),
    [],
    'stopped agents without a provider session identity should never claim provider sessions'
  );
  assert.deepStrictEqual(
    Array.from(claimedAgentSessionKeysForAgents([
      agent({ id: 'stopped-resumed', status: 'stopped', command: 'claude', source: 'claude-history:stopped-claimed' }),
    ], sessions)),
    [],
    'stopped resumed runtime rows should not claim provider sessions; history/session rows own resume'
  );

  console.log('test-code-agent-list-state passed');
}

run();
