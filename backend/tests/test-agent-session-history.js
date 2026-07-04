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
} = require('../agent-session-history');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-session-history-'));
  const codexHome = path.join(root, 'codex');
  const claudeHome = path.join(root, 'claude');
  const codexSessionsDir = path.join(codexHome, 'sessions', '2026', '06', '28');
  const claudeProjectDir = path.join(claudeHome, 'projects', '-repo-claude');
  const claudeTempProjectDir = path.join(claudeHome, 'projects', '-private-tmp-farming-test');
  const claudeWorktreeProjectDir = path.join(claudeHome, 'projects', '-codex-worktrees-farming-test');
  fs.mkdirSync(codexSessionsDir, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.mkdirSync(claudeTempProjectDir, { recursive: true });
  fs.mkdirSync(claudeWorktreeProjectDir, { recursive: true });

  const codexId = '019f0000-0000-7000-8000-000000000101';
  const tempCodexId = '019f0000-0000-7000-8000-000000000102';
  const tempIndexCodexId = '019f0000-0000-7000-8000-000000000103';
  const claudeId = '11111111-2222-4333-8444-555555555555';
  const tempClaudeId = '11111111-2222-4333-8444-666666666666';
  const tempPromptClaudeId = '11111111-2222-4333-8444-777777777777';
  const defaultClaudeId = '11111111-2222-4333-8444-888888888888';
  const worktreeClaudeId = '11111111-2222-4333-8444-999999999999';

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

  const sessions = await listAgentSessions({
    codexHome,
    claudeHome,
    limit: 10,
    providerLimit: 10,
  });
  assert.strictEqual(sessions.length, 2);
  assert.strictEqual(sessions.some(session => session.id === tempCodexId), false);
  assert.strictEqual(sessions.some(session => session.id === tempIndexCodexId), false);
  assert.strictEqual(sessions.some(session => session.id === tempClaudeId), false);
  assert.strictEqual(sessions.some(session => session.id === tempPromptClaudeId), false);
  assert.strictEqual(sessions.some(session => session.id === defaultClaudeId), false);
  assert.strictEqual(sessions.some(session => session.id === worktreeClaudeId), false);
  assert.deepStrictEqual(sessions.map(session => session.provider), ['claude', 'codex']);
  assert.strictEqual(sessions.find(session => session.provider === 'codex').title, 'Codex title');
  assert.strictEqual(sessions.find(session => session.provider === 'codex').cliVersion, '0.142.3');
  assert.deepStrictEqual(sessions.find(session => session.provider === 'codex').capabilities, ['resume', 'fork']);

  const foundClaude = await findAgentSession('claude', claudeId, { claudeHome, limit: 10 });
  assert.strictEqual(foundClaude.id, claudeId);
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
  assert.strictEqual(buildAgentSessionResumeCommand('codex', 'tmp_uuid_11111111-2222-4333-8444-555555555555'), '');
  assert.strictEqual(buildAgentSessionResumeCommand('unknown', claudeId), '');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✓ Agent session history unifies Codex and Claude metadata');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
