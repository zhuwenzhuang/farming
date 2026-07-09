const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { importTsModule } = require('./helpers/import-ts-module');

async function run() {
  const {
    agentSessionId,
    agentSessionWorkingDirectory,
    agentSessionWorkspace,
  } = importTsModule('src/components/code/model.ts');
  const {
    resumedAgentSessionFromSource,
  } = importTsModule('src/components/code/session-display.ts');
  const {
    claimedAgentSessionKeysForAgents,
  } = importTsModule('src/components/code/agent-list-state.ts');
  const {
    findActiveAgentClaimingSession,
    mainPageAgentSessionsToAutoResume,
  } = require('../main-page-session');
  const {
    mainPageSessionProviderForCommand,
  } = importTsModule('src/components/code/main-page-session.ts');

  assert.strictEqual(mainPageSessionProviderForCommand('env FOO=1 /usr/local/bin/codex --model gpt-5.5'), 'codex');
  assert.strictEqual(mainPageSessionProviderForCommand('claude --resume abc'), 'claude');
  assert.strictEqual(mainPageSessionProviderForCommand('opencode --session ses_example'), 'opencode');
  assert.strictEqual(mainPageSessionProviderForCommand('/usr/local/bin/qodercli --resume abc'), 'qoder');
  assert.strictEqual(mainPageSessionProviderForCommand('bash'), null);

  const sessions = [
    {
      provider: 'codex',
      id: 'older',
      title: 'older',
      cwd: '/repo',
      updatedAt: new Date(100_000).toISOString(),
    },
    {
      provider: 'codex',
      id: 'newer',
      title: 'newer',
      cwd: '/repo',
      updatedAt: new Date(200_000).toISOString(),
    },
  ];
  const nestedWorkspaceSession = {
    provider: 'claude',
    id: 'nested',
    title: 'nested',
    cwd: '/repo/packages/api',
    workspace: '/repo',
    updatedAt: new Date(200_000).toISOString(),
  };
  assert.strictEqual(agentSessionWorkspace(nestedWorkspaceSession), '/repo');
  assert.strictEqual(agentSessionWorkingDirectory(nestedWorkspaceSession), '/repo/packages/api');
  assert.strictEqual(
    agentSessionId({ provider: 'codex', providerHomeId: 'zwz', id: 'newer' }),
    'agent-session:codex:home:zwz:newer'
  );
  assert.deepStrictEqual(
    resumedAgentSessionFromSource('codex-history-fork:home:zwz:newer'),
    { provider: 'codex', providerHomeId: 'zwz', sessionId: 'newer' }
  );

  const claimedFromLiveUiAgent = claimedAgentSessionKeysForAgents([
    {
      id: 'agent-live',
      command: 'codex',
      cwd: '/repo',
      projectWorkspace: '/repo',
      source: 'ui',
      isMain: false,
      archived: false,
      startedAt: 190_000,
    },
  ], sessions);
  assert.deepStrictEqual(Array.from(claimedFromLiveUiAgent), []);

  const claimedFromProviderSessionAgent = claimedAgentSessionKeysForAgents([
    {
      id: 'agent-nested',
      command: 'claude',
      cwd: '/repo/packages/api',
      projectWorkspace: '/repo',
      source: 'ui',
      providerSessionKey: 'agent-session:claude:nested',
      isMain: false,
      archived: false,
      startedAt: 190_000,
    },
  ], [nestedWorkspaceSession]);
  assert.deepStrictEqual(Array.from(claimedFromProviderSessionAgent), ['agent-session:claude:nested']);

  const claimedFromResumedAgent = claimedAgentSessionKeysForAgents([
    {
      id: 'agent-resumed',
      command: 'codex',
      cwd: '/repo',
      projectWorkspace: '/repo',
      source: 'codex-history:newer',
      isMain: false,
      archived: false,
      startedAt: 190_000,
    },
  ], sessions);
  assert.deepStrictEqual(Array.from(claimedFromResumedAgent), ['agent-session:codex:newer']);

  assert.deepStrictEqual(
    mainPageAgentSessionsToAutoResume({
      mainPageSessionKeys: [
        'agent-session:codex:newer',
        'agent-session:codex:newer',
        'agent-session:codex:tmp_uuid_11111111-2222-4333-8444-555555555555',
        'agent-session:bash:not-supported',
        'bad-key',
        'agent-session:claude:nested',
        'agent-session:codex:home:zwz:newer',
        'agent-session:opencode:ses_example',
        'agent-session:qoder:insight',
      ],
    }),
    [
      { provider: 'codex', sessionId: 'newer' },
      { provider: 'claude', sessionId: 'nested' },
      { provider: 'codex', providerHomeId: 'zwz', sessionId: 'newer' },
      { provider: 'opencode', sessionId: 'ses_example' },
      { provider: 'qoder', sessionId: 'insight' },
    ],
    'Server auto-resume should normalize, validate, and dedupe persisted main-page session keys'
  );

  const claimingLiveAgent = findActiveAgentClaimingSession([
    {
      id: 'agent-live',
      command: 'codex',
      cwd: '/repo',
      projectWorkspace: '/repo',
      source: 'ui',
      providerSessionKey: 'agent-session:codex:home:zwz:newer',
      providerHomeId: 'zwz',
      providerSessionProvider: 'codex',
      providerSessionId: 'newer',
      status: 'running',
      archived: false,
      startedAt: 190_000,
    },
  ], 'codex', { ...sessions[1], providerHomeId: 'zwz' });
  assert.strictEqual(
    claimingLiveAgent && claimingLiveAgent.id,
    'agent-live',
    'Server auto-resume should treat only explicit providerSessionKey live agents as claiming sessions'
  );
  assert.strictEqual(
    findActiveAgentClaimingSession([claimingLiveAgent], 'codex', { ...sessions[1], providerHomeId: 'other' }),
    null,
    'The same provider session id in another Agent Home must not reuse this live agent'
  );

  assert.strictEqual(
    findActiveAgentClaimingSession([
      {
        id: 'agent-stale',
        command: 'codex',
        cwd: '/repo',
        projectWorkspace: '/repo',
        source: 'ui',
        status: 'running',
        archived: false,
        startedAt: 500_000,
      },
    ], 'codex', sessions[1]),
    null,
    'Server auto-resume should not claim by command/workspace/time-window heuristics'
  );

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mainPageSessionSource = fs.readFileSync(path.join(__dirname, '..', 'main-page-session.js'), 'utf8');
  assert(
    mainPageSessionSource.includes("const AUTO_RESUME_AGENT_SESSION_PROVIDERS = new Set(['codex', 'claude', 'opencode', 'qoder'])") &&
      mainPageSessionSource.includes('function mainPageAgentSessionFromKey(key)') &&
      mainPageSessionSource.includes('AUTO_RESUME_AGENT_SESSION_PROVIDERS.has(normalized)') &&
      serverSource.includes('function autoResumeMainPageAgentSessions()') &&
      serverSource.includes('await agentManager.whenRecovered()') &&
      serverSource.includes('findActiveAgentClaimingSession(agentManager.getState().agents') &&
      mainPageSessionSource.includes("agent.providerSessionKey === sessionKey") &&
      serverSource.includes('claimed: true') &&
      serverSource.includes('rememberMainPageSession: false') &&
      serverSource.includes('autoReadInitialAttention: true') &&
      serverSource.includes('const workingDirectory = session && (session.cwd || session.workspace) ? (session.cwd || session.workspace) : null') &&
      serverSource.includes("projectWorkspace: session ? (session.workspace || session.cwd || '') : ''") &&
      serverSource.includes('void autoResumeMainPageAgentSessions()'),
    'Server restart should auto-resume only supported coding-agent main-page history sessions and leave shell rows out'
  );

  console.log('✓ Main page session promotion helpers preserve launched coding-agent sessions');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
