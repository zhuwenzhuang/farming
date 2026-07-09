const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  hasTemporaryWorkspaceReference,
  isTemporaryWorkspace,
  listCodexSessions,
} = require('../codex-session-history');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-codex-history-'));
  const sessionsDir = path.join(root, 'sessions', '2026', '06', '27');
  const archivedDir = path.join(root, 'archived_sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(archivedDir, { recursive: true });

  const activeId = '019f0000-0000-7000-8000-000000000001';
  const archivedId = '019f0000-0000-7000-8000-000000000002';
  const parentId = '019f0000-0000-7000-8000-000000000003';
  const indexOnlyId = '019f0000-0000-7000-8000-000000000004';
  const tempId = '019f0000-0000-7000-8000-000000000005';
  const tempIndexOnlyId = '019f0000-0000-7000-8000-000000000006';
  const tempTitleId = '019f0000-0000-7000-8000-000000000007';
  const previewOnlyId = '019f0000-0000-7000-8000-000000000008';
  const automationsDir = path.join(root, 'automations');
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), [
    JSON.stringify({ id: activeId, thread_name: 'Active title', updated_at: '2026-06-27T10:00:00.000Z' }),
    JSON.stringify({ id: archivedId, thread_name: 'Archived title', updated_at: '2026-06-26T10:00:00.000Z' }),
    JSON.stringify({
      id: indexOnlyId,
      thread_name: 'Index only title',
      updated_at: '2026-06-25T10:00:00.000Z',
      cwd: '/repo/index-only/subdir',
      workspace_root: '/repo/index-only',
    }),
    JSON.stringify({
      id: tempId,
      thread_name: 'Temp title',
      updated_at: '2026-06-28T10:00:00.000Z',
    }),
    JSON.stringify({
      id: tempIndexOnlyId,
      thread_name: 'Temp index only title',
      updated_at: '2026-06-28T10:01:00.000Z',
      cwd: '/tmp/codex-index-only',
    }),
    JSON.stringify({
      id: tempTitleId,
      thread_name: 'Evaluation workspace /tmp/codex-eval/workspace',
      updated_at: '2026-06-28T10:02:00.000Z',
      cwd: '/repo/active',
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(root, '.codex-global-state.json'), JSON.stringify({
    'pinned-thread-ids': [activeId],
    'projectless-thread-ids': [archivedId],
    'thread-workspace-root-hints': {
      [activeId]: '/repo/active',
    },
    'electron-saved-workspace-roots': [
      '/repo/archive',
      '/repo/archive/deeper-root',
      '/repo/index-only',
    ],
    'electron-persisted-atom-state': {
      'unread-thread-ids-by-host-v1': {
        local: [archivedId],
      },
    },
  }));
  fs.mkdirSync(path.join(automationsDir, 'active-heartbeat'), { recursive: true });
  fs.writeFileSync(path.join(automationsDir, 'active-heartbeat', 'automation.toml'), [
    'version = 1',
    'id = "sql-dev-loop-hash-delta-61"',
    'kind = "heartbeat"',
    'name = "sql-dev-loop hash_delta_61"',
    'status = "ACTIVE"',
    'rrule = "FREQ=MINUTELY;INTERVAL=20"',
    `target_thread_id = "${activeId}"`,
  ].join('\n'));
  fs.mkdirSync(path.join(automationsDir, 'inactive-heartbeat'), { recursive: true });
  fs.writeFileSync(path.join(automationsDir, 'inactive-heartbeat', 'automation.toml'), [
    'version = 1',
    'id = "inactive-loop"',
    'kind = "heartbeat"',
    'name = "inactive loop"',
    'status = "PAUSED"',
    'rrule = "FREQ=MINUTELY;INTERVAL=5"',
    `target_thread_id = "${previewOnlyId}"`,
  ].join('\n'));

  fs.writeFileSync(path.join(sessionsDir, `rollout-2026-06-27T18-00-00-${activeId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-27T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: activeId, cwd: '/repo/active', source: 'cli', cli_version: '0.133.0' },
    }),
    JSON.stringify({
      timestamp: '2026-06-27T10:00:00.001Z',
      type: 'session_meta',
      payload: { id: parentId, cwd: '/repo/parent', source: 'cli', cli_version: '0.132.0' },
    }),
    JSON.stringify({
      timestamp: '2026-06-27T10:00:01.000Z',
      type: 'turn_context',
      payload: { cwd: '/repo/active', model: 'gpt-5.5', effort: 'xhigh' },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(archivedDir, `rollout-2026-06-26T18-00-00-${archivedId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-26T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: archivedId, cwd: '/repo/archive/deeper-root/task', source: 'cli' },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(sessionsDir, `rollout-2026-06-28T18-00-00-${tempId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-28T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: tempId, cwd: '/private/tmp/codex-playwright', source: 'cli' },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(sessionsDir, `rollout-2026-06-24T18-00-00-${previewOnlyId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-24T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: previewOnlyId, cwd: '/repo/preview-only', source: 'cli' },
    }),
    JSON.stringify({
      timestamp: '2026-06-24T10:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'ignored replay message' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-24T10:00:00.200Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: [
          '## My request for Codex:   Build a focused session title',
          'with whitespace',
          '<codex_internal_context source="goal">',
          'Continue working toward the active thread goal.',
          '</codex_internal_context>',
        ].join('\n'),
        kind: 'plain',
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-24T10:00:01.000Z',
      type: 'turn_context',
      payload: { cwd: '/repo/preview-only', model: 'gpt-5.5', effort: 'medium' },
    }),
  ].join('\n'));

  assert.strictEqual(isTemporaryWorkspace('/private/tmp/codex-playwright'), true);
  assert.strictEqual(isTemporaryWorkspace('/var/folders/abc/workspace'), true);
  assert.strictEqual(isTemporaryWorkspace('/repo/active'), false);
  assert.strictEqual(hasTemporaryWorkspaceReference('Evaluation workspace /tmp/codex-eval/workspace'), true);
  assert.strictEqual(hasTemporaryWorkspaceReference('Active title'), false);

  const sessions = await listCodexSessions({ codexHome: root, limit: 10, scanLimit: 10 });
  assert.strictEqual(sessions.length, 4);
  assert.strictEqual(sessions.some(session => session.id === tempId), false);
  assert.strictEqual(sessions.some(session => session.id === tempIndexOnlyId), false);
  assert.strictEqual(sessions.some(session => session.id === tempTitleId), false);
  assert.strictEqual(sessions[0].id, activeId);
  assert.strictEqual(sessions[0].title, 'Active title');
  assert.strictEqual(sessions[0].cwd, '/repo/active');
  assert.strictEqual(sessions[0].workspace, '/repo/active');
  assert.strictEqual(sessions[0].pinned, true);
  assert.strictEqual(sessions[0].schedule.id, 'sql-dev-loop-hash-delta-61');
  assert.strictEqual(sessions[0].schedule.kind, 'heartbeat');
  assert.strictEqual(sessions[0].schedule.label, 'Every 20 minutes');
  assert.strictEqual(sessions[0].model, 'gpt-5.5');
  assert.strictEqual(sessions[0].effort, 'xhigh');
  assert.strictEqual(sessions[1].archived, true);
  assert.strictEqual(sessions[1].unread, true);
  assert.strictEqual(sessions[1].projectless, true);
  assert.strictEqual(sessions[1].cwd, '/repo/archive/deeper-root/task');
  assert.strictEqual(sessions[1].workspace, '/repo/archive/deeper-root');
  assert.strictEqual(sessions[2].id, indexOnlyId);
  assert.strictEqual(sessions[2].cwd, '/repo/index-only/subdir');
  assert.strictEqual(sessions[2].workspace, '/repo/index-only');
  assert.strictEqual(sessions[3].id, previewOnlyId);
  assert.strictEqual(sessions[3].title, 'Build a focused session title with whitespace');
  assert.strictEqual(sessions[3].preview, 'Build a focused session title with whitespace');
  assert.strictEqual(sessions[3].firstUserMessage, 'Build a focused session title with whitespace');
  assert.strictEqual(sessions[3].model, 'gpt-5.5');
  assert.strictEqual(sessions[3].effort, 'medium');
  assert.strictEqual(sessions[3].schedule, undefined);

  const manyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-codex-history-many-'));
  const manySessionsDir = path.join(manyRoot, 'sessions', '2026', '07', '01');
  fs.mkdirSync(manySessionsDir, { recursive: true });
  const manyCount = 260;
  for (let index = 0; index < manyCount; index += 1) {
    const suffix = String(index + 1).padStart(12, '0');
    const sessionId = `019f0000-0000-7000-8000-${suffix}`;
    fs.writeFileSync(path.join(manySessionsDir, `rollout-2026-07-01T00-00-00-${sessionId}.jsonl`), [
      JSON.stringify({
        timestamp: `2026-07-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        type: 'session_meta',
        payload: { id: sessionId, cwd: '/repo/many', source: 'cli' },
      }),
    ].join('\n'));
  }
  const manySessions = await listCodexSessions({ codexHome: manyRoot, limit: manyCount, scanLimit: manyCount });
  assert.strictEqual(manySessions.length, manyCount);
  fs.rmSync(manyRoot, { recursive: true, force: true });

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✓ Codex session history metadata is merged read-only');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
