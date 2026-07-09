const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildAgentSessionResumeCommand,
  findAgentSession,
  hasTemporaryWorkspaceReference,
  isAgentManagedWorktree,
  isDefaultClaudeSessionTitle,
  isTemporaryWorkspace,
  listAgentSessions,
  listClaudeSessions,
  listOpenCodeSessions,
  listQoderSessions,
} = require('../agent-session-history');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-session-history-'));
  const codexHome = path.join(root, 'codex');
  const codexAltHome = path.join(root, 'codex-alt');
  const claudeHome = path.join(root, 'claude');
  const qoderHome = path.join(root, 'qoder');
  const codexSessionsDir = path.join(codexHome, 'sessions', '2026', '06', '28');
  const codexAltSessionsDir = path.join(codexAltHome, 'sessions', '2026', '06', '28');
  const claudeProjectDir = path.join(claudeHome, 'projects', '-repo-claude');
  const claudeTempProjectDir = path.join(claudeHome, 'projects', '-private-tmp-farming-test');
  const claudeWorktreeProjectDir = path.join(claudeHome, 'projects', '-codex-worktrees-farming-test');
  const qoderProjectDir = path.join(qoderHome, 'projects', '-repo-qoder');
  const qoderTempProjectDir = path.join(qoderHome, 'projects', '-private-tmp-farming-test');
  fs.mkdirSync(codexSessionsDir, { recursive: true });
  fs.mkdirSync(codexAltSessionsDir, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.mkdirSync(claudeTempProjectDir, { recursive: true });
  fs.mkdirSync(claudeWorktreeProjectDir, { recursive: true });
  fs.mkdirSync(qoderProjectDir, { recursive: true });
  fs.mkdirSync(qoderTempProjectDir, { recursive: true });

  const codexId = '019f0000-0000-7000-8000-000000000101';
  const tempCodexId = '019f0000-0000-7000-8000-000000000102';
  const tempIndexCodexId = '019f0000-0000-7000-8000-000000000103';
  const altCodexId = '019f0000-0000-7000-8000-000000000104';
  const claudeId = '11111111-2222-4333-8444-555555555555';
  const tempClaudeId = '11111111-2222-4333-8444-666666666666';
  const tempPromptClaudeId = '11111111-2222-4333-8444-777777777777';
  const defaultClaudeId = '11111111-2222-4333-8444-888888888888';
  const worktreeClaudeId = '11111111-2222-4333-8444-999999999999';
  const qoderId = '22222222-3333-4444-8555-666666666666';
  const tempQoderId = '22222222-3333-4444-8555-777777777777';
  const openCodeId = 'ses_0b5c8bfdbffepm0O5sc1lPLtzK';
  const tempOpenCodeId = 'ses_0b86a0bb9ffe993SjI5ZfY2c0j';
  let openCodeListCalls = 0;
  const runOpenCodeSessionList = async () => {
    openCodeListCalls += 1;
    return JSON.stringify([
    {
      id: openCodeId,
      title: 'OpenCode title',
      directory: '/repo/opencode',
      created: 1782642000000,
      updated: 1782642900000,
    },
    {
      id: tempOpenCodeId,
      title: 'Temporary OpenCode title',
      directory: '/private/tmp/opencode-test',
      created: 1782642000000,
      updated: 1782643000000,
    },
    ]);
  };

  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: codexId, thread_name: 'Codex title', updated_at: '2026-06-28T10:00:00.000Z' }),
    JSON.stringify({ id: tempCodexId, thread_name: 'Temp Codex title', updated_at: '2026-06-28T10:45:00.000Z' }),
    JSON.stringify({
      id: tempIndexCodexId,
      thread_name: 'Temp index Codex title',
      updated_at: '2026-06-28T10:46:00.000Z',
      cwd: '/tmp/codex-index-test',
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(codexSessionsDir, `rollout-2026-06-28T18-00-00-${codexId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-28T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: codexId, cwd: '/repo/codex', source: 'cli', cli_version: '0.142.3' },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(codexSessionsDir, `rollout-2026-06-28T18-00-00-${tempCodexId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-28T10:45:00.000Z',
      type: 'session_meta',
      payload: { id: tempCodexId, cwd: '/private/tmp/codex-test', source: 'cli' },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(codexAltHome, 'session_index.jsonl'), [
    JSON.stringify({ id: altCodexId, thread_name: 'Alt Codex title', updated_at: '2026-06-28T11:00:00.000Z' }),
  ].join('\n'));
  fs.writeFileSync(path.join(codexAltSessionsDir, `rollout-2026-06-28T18-00-00-${altCodexId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-28T11:00:00.000Z',
      type: 'session_meta',
      payload: { id: altCodexId, cwd: '/repo/codex-alt', source: 'cli', cli_version: '0.142.5' },
    }),
  ].join('\n'));

  fs.writeFileSync(path.join(claudeHome, 'history.jsonl'), [
    JSON.stringify({
      sessionId: claudeId,
      display: 'Claude fallback title',
      project: '/repo/claude',
      timestamp: '2026-06-28T10:30:00.000Z',
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(claudeProjectDir, `${claudeId}.jsonl`), [
    JSON.stringify({
      type: 'user',
      sessionId: claudeId,
      cwd: '/repo/claude/packages/api',
      timestamp: '2026-06-28T10:30:00.000Z',
      entrypoint: 'cli',
      model: 'claude-fable-5',
      effort: 'high',
      schedule: {
        id: 'claude-followup',
        kind: 'heartbeat',
        name: 'Claude followup',
        status: 'ACTIVE',
        rrule: 'FREQ=HOURLY;INTERVAL=2',
      },
      message: { role: 'user', content: 'redacted' },
    }),
    JSON.stringify({
      type: 'ai-title',
      sessionId: claudeId,
      timestamp: '2026-06-28T10:30:01.000Z',
      aiTitle: 'Claude title',
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: claudeId,
      cwd: '/repo/claude/packages/api',
      timestamp: '2026-06-28T10:30:02.000Z',
      message: { role: 'assistant', content: [] },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(claudeTempProjectDir, `${tempClaudeId}.jsonl`), [
    JSON.stringify({
      type: 'user',
      sessionId: tempClaudeId,
      cwd: '/private/tmp/claude-test',
      timestamp: '2026-06-28T10:45:00.000Z',
      entrypoint: 'cli',
      message: { role: 'user', content: 'redacted' },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(claudeProjectDir, `${tempPromptClaudeId}.jsonl`), [
    JSON.stringify({
      type: 'user',
      sessionId: tempPromptClaudeId,
      cwd: '/repo/claude',
      timestamp: '2026-06-28T10:46:00.000Z',
      entrypoint: 'cli',
      message: { role: 'user', content: 'redacted' },
    }),
    JSON.stringify({
      type: 'ai-title',
      sessionId: tempPromptClaudeId,
      timestamp: '2026-06-28T10:46:01.000Z',
      aiTitle: 'Evaluate workspace /tmp/sql-insight-lite-eval3/workspace',
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(claudeProjectDir, `${defaultClaudeId}.jsonl`), [
    JSON.stringify({
      type: 'user',
      sessionId: defaultClaudeId,
      cwd: '/repo/claude',
      timestamp: '2026-06-28T10:47:00.000Z',
      entrypoint: 'cli',
      message: { role: 'user', content: 'redacted' },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(claudeWorktreeProjectDir, `${worktreeClaudeId}.jsonl`), [
    JSON.stringify({
      type: 'user',
      sessionId: worktreeClaudeId,
      cwd: '/Users/example/.codex/worktrees/sql-insight-volume-trace/mc_skills/prod_agent/sql/sql-insight',
      timestamp: '2026-06-28T10:48:00.000Z',
      entrypoint: 'cli',
      message: { role: 'user', content: 'redacted' },
    }),
    JSON.stringify({
      type: 'ai-title',
      sessionId: worktreeClaudeId,
      timestamp: '2026-06-28T10:48:01.000Z',
      aiTitle: 'Review worktree task',
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(qoderProjectDir, `${qoderId}.jsonl`), [
    JSON.stringify({
      type: 'runtime-config',
      sessionId: qoderId,
      timestamp: 1782642600000,
      model: 'auto',
      reasoningEffort: 'high',
      version: '1.0.40',
    }),
    JSON.stringify({
      type: 'user',
      sessionId: qoderId,
      cwd: '/repo/qoder/packages/api',
      timestamp: '2026-06-28T10:50:00.000Z',
      entrypoint: 'cli',
      message: 'Inspect qoder history',
    }),
    JSON.stringify({
      type: 'ai-title',
      sessionId: qoderId,
      timestamp: '2026-06-28T10:50:01.000Z',
      aiTitle: 'Qoder title',
    }),
    JSON.stringify({
      type: 'last-prompt',
      sessionId: qoderId,
      timestamp: '2026-06-28T10:50:02.000Z',
      lastPrompt: 'Inspect qoder history again',
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(qoderTempProjectDir, `${tempQoderId}.jsonl`), [
    JSON.stringify({
      type: 'user',
      sessionId: tempQoderId,
      cwd: '/private/tmp/qoder-test',
      timestamp: '2026-06-28T10:51:00.000Z',
      message: 'Temporary qoder task',
    }),
  ].join('\n'));

  assert.strictEqual(isTemporaryWorkspace('/private/tmp/claude-test'), true);
  assert.strictEqual(isTemporaryWorkspace('/tmp/codex-test'), true);
  assert.strictEqual(isTemporaryWorkspace('/var/folders/abc/workspace'), true);
  assert.strictEqual(isTemporaryWorkspace('/repo/codex'), false);
  assert.strictEqual(hasTemporaryWorkspaceReference('Evaluate workspace /tmp/sql-insight-lite-eval3/workspace'), true);
  assert.strictEqual(hasTemporaryWorkspaceReference('Normal project title'), false);
  assert.strictEqual(isDefaultClaudeSessionTitle('Claude session'), true);
  assert.strictEqual(isDefaultClaudeSessionTitle('Claude Code task'), false);
  assert.strictEqual(isAgentManagedWorktree('/Users/example/.codex/worktrees/foo/project'), true);
  assert.strictEqual(isAgentManagedWorktree('/Users/example/.claude/worktrees/foo'), true);
  assert.strictEqual(isAgentManagedWorktree('/Users/example/git/project'), false);


  const claudeSessions = await listClaudeSessions({ claudeHome, limit: 5 });
  assert.strictEqual(claudeSessions.length, 1);
  assert.strictEqual(claudeSessions[0].provider, 'claude');
  assert.strictEqual(claudeSessions[0].title, 'Claude title');
  assert.strictEqual(claudeSessions[0].workspace, '/repo/claude');
  assert.strictEqual(claudeSessions[0].cwd, '/repo/claude/packages/api');
  assert.strictEqual(claudeSessions[0].model, 'claude-fable-5');
  assert.strictEqual(claudeSessions[0].effort, 'high');
  assert.strictEqual(claudeSessions[0].schedule.id, 'claude-followup');
  assert.strictEqual(claudeSessions[0].schedule.label, 'Every 2 hours');

  const qoderSessions = await listQoderSessions({ qoderHome, limit: 5 });
  assert.strictEqual(qoderSessions.length, 1);
  assert.strictEqual(qoderSessions[0].provider, 'qoder');
  assert.strictEqual(qoderSessions[0].providerName, 'Qoder');
  assert.strictEqual(qoderSessions[0].title, 'Qoder title');
  assert.strictEqual(qoderSessions[0].workspace, '/repo/qoder/packages/api');
  assert.strictEqual(qoderSessions[0].model, 'auto');
  assert.strictEqual(qoderSessions[0].effort, 'high');
  assert.strictEqual(qoderSessions[0].cliVersion, '1.0.40');

  const openCodeSessions = await listOpenCodeSessions({ limit: 5, runOpenCodeSessionList });
  assert.strictEqual(openCodeSessions.length, 1);
  assert.strictEqual(openCodeSessions[0].provider, 'opencode');
  assert.strictEqual(openCodeSessions[0].providerName, 'OpenCode');
  assert.strictEqual(openCodeSessions[0].id, openCodeId);
  assert.strictEqual(openCodeSessions[0].title, 'OpenCode title');
  assert.strictEqual(openCodeSessions[0].cwd, '/repo/opencode');
  assert.strictEqual(openCodeSessions[0].source, 'opencode');

  const openCodeCallsBeforeUnifiedList = openCodeListCalls;
  const sessions = await listAgentSessions({
    claudeHome,
    qoderHome,
    limit: 10,
    providerLimit: 10,
    runOpenCodeSessionList,
    providerHomes: {
      codex: [
        { id: 'default', path: codexHome },
        { id: 'zwz', path: codexAltHome },
      ],
      claude: [{ id: 'default', path: claudeHome }],
      qoder: [{ id: 'default', path: qoderHome }],
      opencode: [
        { id: 'default', path: path.join(root, 'opencode') },
        { id: 'work', path: path.join(root, 'opencode-work') },
      ],
    },
  });
  assert(sessions.length >= 4);
  assert.strictEqual(sessions.some(session => session.id === tempCodexId), false);
  assert.strictEqual(sessions.some(session => session.id === tempIndexCodexId), false);
  assert.strictEqual(sessions.some(session => session.id === tempClaudeId), false);
  assert.strictEqual(sessions.some(session => session.id === tempPromptClaudeId), false);
  assert.strictEqual(sessions.some(session => session.id === defaultClaudeId), false);
  assert.strictEqual(sessions.some(session => session.id === worktreeClaudeId), false);
  assert.strictEqual(sessions.some(session => session.id === tempQoderId), false);
  assert.strictEqual(sessions.some(session => session.id === tempOpenCodeId), false);
  assert.strictEqual(openCodeListCalls, openCodeCallsBeforeUnifiedList + 1, 'OpenCode session history is global and should not be duplicated across config homes');
  assert.deepStrictEqual(new Set(sessions.map(session => session.provider)), new Set(['codex', 'claude', 'opencode', 'qoder']));
  assert.strictEqual(sessions.find(session => session.id === codexId).providerHomeId, 'default');
  assert.strictEqual(sessions.find(session => session.id === altCodexId).providerHomeId, 'zwz');
  assert.strictEqual(sessions.find(session => session.id === codexId).title, 'Codex title');
  assert.strictEqual(sessions.find(session => session.id === codexId).cliVersion, '0.142.3');
  assert.deepStrictEqual(sessions.find(session => session.id === codexId).capabilities, ['resume', 'fork']);
  assert.deepStrictEqual(sessions.find(session => session.provider === 'qoder').capabilities, ['resume', 'fork']);
  assert.deepStrictEqual(sessions.find(session => session.provider === 'opencode').capabilities, ['resume', 'fork']);
  assert.strictEqual(sessions.find(session => session.provider === 'opencode').providerHomeId, 'default');

  const foundClaude = await findAgentSession('claude', claudeId, { claudeHome, limit: 10, providerHomes: { claude: [{ id: 'default', path: claudeHome }] } });
  const foundAltCodex = await findAgentSession('codex', altCodexId, { limit: 10, providerHomeId: 'zwz', providerHomes: { codex: [{ id: 'default', path: codexHome }, { id: 'zwz', path: codexAltHome }] } });
  const foundOpenCode = await findAgentSession('opencode', openCodeId, { limit: 10, runOpenCodeSessionList, providerHomes: { opencode: [{ id: 'default', path: path.join(root, 'opencode') }] } });
  assert.strictEqual(foundAltCodex.providerHomeId, 'zwz');
  assert.strictEqual(foundClaude.id, claudeId);
  assert.strictEqual(foundOpenCode.id, openCodeId);
  assert.strictEqual(buildAgentSessionResumeCommand('codex', codexId), `codex resume ${codexId}`);
  assert.strictEqual(
    buildAgentSessionResumeCommand('codex', codexId, { cwd: '/repo/codex with space' }),
    `codex resume -C '/repo/codex with space' ${codexId}`
  );
  assert.strictEqual(buildAgentSessionResumeCommand('codex', codexId, { fork: true }), `codex fork ${codexId}`);
  assert.strictEqual(
    buildAgentSessionResumeCommand('codex', codexId, { fork: true, cwd: '/repo/codex with space' }),
    `codex fork -C '/repo/codex with space' ${codexId}`
  );
  assert.strictEqual(buildAgentSessionResumeCommand('claude', claudeId), `claude --resume ${claudeId}`);
  assert.strictEqual(buildAgentSessionResumeCommand('claude', claudeId, { fork: true }), `claude --resume ${claudeId} --fork-session`);
  assert.strictEqual(buildAgentSessionResumeCommand('qoder', qoderId), `qodercli --resume ${qoderId}`);
  assert.strictEqual(buildAgentSessionResumeCommand('qoder', qoderId, { fork: true }), `qodercli --resume ${qoderId} --fork-session`);
  assert.strictEqual(buildAgentSessionResumeCommand('opencode', openCodeId), `opencode --session ${openCodeId}`);
  assert.strictEqual(buildAgentSessionResumeCommand('opencode', openCodeId, { fork: true }), `opencode --session ${openCodeId} --fork`);
  assert.strictEqual(buildAgentSessionResumeCommand('codex', 'tmp_uuid_11111111-2222-4333-8444-555555555555'), '');
  assert.strictEqual(buildAgentSessionResumeCommand('unknown', claudeId), '');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✓ Agent session history unifies Codex, Claude, OpenCode, and Qoder metadata');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
