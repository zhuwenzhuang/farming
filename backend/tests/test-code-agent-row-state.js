const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

function agent(overrides = {}) {
  return {
    id: 'agent-1',
    command: 'codex',
    cwd: '/repo',
    projectWorkspace: '/repo',
    output: '',
    previewText: '',
    status: 'running',
    isMain: false,
    archived: false,
    source: 'ui',
    pinned: false,
    unread: false,
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
    providerName: 'Codex',
    id: 'session-1',
    title: 'Resume me',
    cwd: '/repo',
    workspace: '/repo',
    updatedAt: new Date(100_000).toISOString(),
    ...overrides,
  };
}

function run() {
  const {
    agentRowKey,
    buildAgentRowDisplayState,
    isNewWorktreeForkAgent,
  } = importTsModule('src/components/code/agent-row-state.ts');

  const now = 100_000 + 2 * 24 * 60 * 60 * 1000;
  assert.strictEqual(
    agentRowKey({ kind: 'agent', agent: agent({ id: 'agent-42' }) }),
    'agent:agent-42',
    'shell live AgentRow identity should use the runtime agent id'
  );
  assert.strictEqual(
    agentRowKey({
      kind: 'agent',
      agent: agent({ id: 'agent-42' }),
      claimedSessionKey: 'agent-session:codex:session-42',
    }),
    'agent-session:codex:session-42',
    'Codex/Claude live AgentRow identity should use the provider resume id once claimed'
  );
  assert.strictEqual(
    agentRowKey({ kind: 'history', session: session({ provider: 'claude', id: 'session-42' }) }),
    'agent-session:claude:session-42',
    'history-backed AgentRow identity should use the same provider resume id format'
  );

  const live = buildAgentRowDisplayState({ kind: 'agent', agent: agent({
    customTitle: '值值Debugger',
    source: 'ui-fork-new-worktree',
    parentAgentId: 'parent-1',
    pinned: true,
    unread: true,
    previewText: 'Working (12s • esc to interrupt)',
    shellCommand: 'git status --short',
    shellCommandStartedAt: now - 125_000,
    terminalStatus: {
      kind: 'shell',
      activity: 'busy',
      busy: true,
      cwd: '/repo',
      title: '',
      lastExitCode: null,
      runningCommand: 'git status --short',
      runningCommandStartedAt: now - 125_000,
      source: 'shell-status-marker',
    },
  }) }, now);

  assert.deepStrictEqual(
    {
      kind: live.kind,
      title: live.title,
      rowTitle: live.rowTitle,
      commandTitle: live.commandTitle,
      lifecycleStatus: live.lifecycleStatus,
      turnActive: live.turnActive,
      statusIndicatorVisible: live.statusIndicatorVisible,
      pinned: live.pinned,
      unread: live.unread,
      forkedToNewWorktree: live.forkedToNewWorktree,
      requiresResume: live.requiresResume,
      ageLabel: live.ageLabel,
      ageVisible: live.ageVisible,
    },
    {
      kind: 'agent',
      title: '值值Debugger',
      rowTitle: '值值Debugger · Running 2m: git status --short · /repo',
      commandTitle: 'Running 2m: git status --short',
      lifecycleStatus: 'running',
      turnActive: true,
      statusIndicatorVisible: true,
      pinned: true,
      unread: true,
      forkedToNewWorktree: true,
      requiresResume: false,
      ageLabel: '2d',
      ageVisible: false,
    },
    'live agent row state should centralize title, lifecycle, turn activity, user flags, fork marker, and age visibility'
  );

  const lastCommandState = buildAgentRowDisplayState({ kind: 'agent', agent: agent({
    command: 'bash',
    terminalBusy: false,
    shellLastCommand: 'npm test',
    shellLastCommandDurationMs: 12_400,
    terminalStatus: {
      kind: 'shell',
      activity: 'idle',
      busy: false,
      cwd: '/repo',
      title: '',
      lastExitCode: 1,
      lastCommand: 'npm test',
      lastCommandDurationMs: 12_400,
      source: 'shell-status-marker',
    },
  }) }, now);
  assert.strictEqual(
    lastCommandState.commandTitle,
    'Last command: npm test (12s, exit 1)',
    'idle shell rows should expose the most recent command in row tooltips'
  );

  assert.strictEqual(isNewWorktreeForkAgent(agent({ source: 'ui-fork-same-worktree', parentAgentId: 'parent-1' })), false);
  assert.strictEqual(isNewWorktreeForkAgent(agent({ source: 'ui-fork-new-worktree', parentAgentId: '' })), false);
  assert.strictEqual(
    buildAgentRowDisplayState({ kind: 'agent', agent: agent({ status: 'stopped', previewText: 'Working (1s • esc to interrupt)' }) }, now).turnActive,
    false,
    'stopped agents should not show a turn-active row state'
  );
  assert.strictEqual(
    buildAgentRowDisplayState({ kind: 'agent', agent: agent({ previewText: '' }) }, now).statusIndicatorVisible,
    false,
    'ordinary live agents should not show a status dot just because their shell is alive'
  );
  assert.strictEqual(
    buildAgentRowDisplayState({ kind: 'agent', agent: agent({ status: 'pending' }) }, now).statusIndicatorVisible,
    true,
    'pending agents should keep an explicit status indicator'
  );
  const idleAgentState = buildAgentRowDisplayState({ kind: 'agent', agent: agent({
      startedAt: now - 2 * 24 * 60 * 60 * 1000,
      lastActivity: now - 35 * 60 * 1000,
    }) }, now);
  assert.strictEqual(
    idleAgentState.ageLabel,
    '35m',
    'live agent row age should show time since last activity, not time since process start'
  );
  assert.strictEqual(
    idleAgentState.ageVisible,
    true,
    'idle live agent rows should still show their age when no active-turn spinner is visible'
  );

  const resumeRequired = buildAgentRowDisplayState({ kind: 'history', session: session({
    pinned: true,
    unread: true,
    schedule: {
      id: 'daily-debugger',
      kind: 'heartbeat',
      label: 'Every day',
      rrule: 'FREQ=DAILY',
    },
  }), fallbackTitle: 'Fallback' }, now);

  assert.deepStrictEqual(
    {
      kind: resumeRequired.kind,
      title: resumeRequired.title,
      pinned: resumeRequired.pinned,
      unread: resumeRequired.unread,
      requiresResume: resumeRequired.requiresResume,
      statusIndicatorVisible: resumeRequired.statusIndicatorVisible,
      scheduled: resumeRequired.scheduled,
      scheduleTitle: resumeRequired.scheduleTitle,
      ageLabel: resumeRequired.ageLabel,
      ageVisible: resumeRequired.ageVisible,
    },
    {
      kind: 'history',
      title: 'Resume me',
      pinned: true,
      unread: true,
      requiresResume: true,
      statusIndicatorVisible: false,
      scheduled: true,
      scheduleTitle: 'Every day',
      ageLabel: '2d',
      ageVisible: true,
    },
    'agent row state should treat resume as an activation state, not a separate row concept'
  );

  console.log('test-code-agent-row-state passed');
}

run();
