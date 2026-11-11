const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  agyHomeCliArgs,
  buildAgyTrajectoryMetadataBlob,
  cleanAgyUserInputText,
  isAgySupersededResultError,
  ensureAgyConversationDatabase,
  readAgyConversationStepCount,
  readAgyConversationSummaries,
} = require('../agy-conversation-store.cjs');
const {
  getAgentSpec,
  resolveLaunchCommand,
} = require('../cli-agents.cjs');
const {
  matchesExecutableIdentity,
  readExecutableCliVersion,
} = require('../executable-discovery.cjs');
const {
  inferProviderTerminalActivity,
  nestedProviderTerminalCommand,
  providerTerminalKindForCommand,
} = require('../provider-terminal-observers.cjs');
const {
  readProviderHomeConfiguration,
} = require('../provider-home-configuration.cjs');
const {
  discoverAgentExtensions,
} = require('../agent-extension-discovery.cjs');
const {
  extensionWatchPaths,
} = require('../agent-extension-inventory.cjs');
const {
  agentSessionHistoryProviders,
  buildAgentSessionResumeCommand,
  listAgySessions,
} = require('../agent-session-history.cjs');
const {
  AgentSessionInventory,
} = require('../agent-session-inventory.cjs');

async function testConversationStore(tmpRoot: string) {
  const agyHome = path.join(tmpRoot, 'agy-home');
  const sessionId = '11111111-2222-4333-8444-555555555555';

  assert.strictEqual(ensureAgyConversationDatabase(agyHome, sessionId), true);
  assert.strictEqual(ensureAgyConversationDatabase(agyHome, '../unsafe'), false);

  const dbPath = path.join(agyHome, 'conversations', `${sessionId}.db`);
  assert(fs.existsSync(dbPath), 'pre-initialized conversation db should exist');
  assert.strictEqual(readAgyConversationStepCount(dbPath), 0);

  const checkDb = new DatabaseSync(dbPath);
  const userVersionRow = checkDb.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  assert.strictEqual(userVersionRow?.user_version, 1, 'pre-initialized db must set PRAGMA user_version = 1 for agy 1.4.0+');
  // Simulate legacy user_version = 0 corruption where agy inserted a duplicate trajectory_type = 0 row.
  checkDb.exec('PRAGMA user_version = 0;');
  checkDb
    .prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)')
    .run('duplicate-zero-row', sessionId, 0, 0);
  checkDb.close();

  assert.strictEqual(ensureAgyConversationDatabase(agyHome, sessionId, '/tmp/workspace'), true);
  const healedDb = new DatabaseSync(dbPath, { readOnly: true });
  const healedVersion = healedDb.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const metaRows = healedDb.prepare('SELECT trajectory_id, trajectory_type FROM trajectory_meta').all() as Array<{ trajectory_id: string; trajectory_type: number }>;
  healedDb.close();
  assert.strictEqual(healedVersion?.user_version, 1, 'ensureAgyConversationDatabase should heal user_version to 1');
  assert.strictEqual(metaRows.length, 1, 'ensureAgyConversationDatabase should remove bogus trajectory_type=0 row');
  assert.strictEqual(metaRows[0]?.trajectory_type, 4);

  const blob = buildAgyTrajectoryMetadataBlob(sessionId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.strictEqual(blob.length, 76);
  assert.strictEqual(blob[0], 0x1a);
  assert.strictEqual(blob[1], 0x24);
  assert.strictEqual(blob.subarray(2, 38).toString('utf8'), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');

  fs.writeFileSync(path.join(agyHome, 'conversations', 'corrupt.db'), 'not sqlite');
  assert.strictEqual(ensureAgyConversationDatabase(agyHome, 'corrupt'), false);
  assert(buildAgyTrajectoryMetadataBlob(sessionId, 'trajectory', '/tmp/project#1?x').includes(Buffer.from('file:///tmp/project%231%3Fx')));

  const cleaned = cleanAgyUserInputText(
    '<farming-agent-context>\nbootstrap\n</farming-agent-context>\n<USER_REQUEST>\nAttached image: pasted-1.webp\n\nImage path: /tmp/pasted-1.webp\n\nFix bug #42\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nmeta\n</ADDITIONAL_METADATA>'
  );
  assert.strictEqual(cleaned, 'Fix bug #42');
  assert.strictEqual(cleanAgyUserInputText('<USER_REQUEST>bootstrap\n\nQuestion</USER_REQUEST>', 'bootstrap'), 'Question');
  assert.strictEqual(cleanAgyUserInputText('Quoted bootstrap\n\nQuestion', 'bootstrap'), 'Quoted bootstrap\n\nQuestion');
  assert.strictEqual(cleanAgyUserInputText('<farming-agent-context>old bootstrap</farming-agent-context>\n\nQuestion', 'new bootstrap'), 'Question');

  const defaultHome = path.join(os.homedir(), '.gemini', 'antigravity');
  assert.deepStrictEqual(agyHomeCliArgs(defaultHome), []);
  assert.deepStrictEqual(agyHomeCliArgs(agyHome), [
    '--gemini_dir',
    path.dirname(path.resolve(agyHome)),
    '--app_data_dir',
    path.basename(path.resolve(agyHome)),
  ]);
}

async function testCliSpecDiscoveryAndTerminalObserver(tmpRoot: string) {
  const spec = getAgentSpec('agy');
  assert(spec, 'agy spec should exist');
  assert.strictEqual(spec.displayName, 'Antigravity');
  assert.strictEqual(spec.category, 'coding');
  assert.deepStrictEqual(spec.permissions, {
    supportsDangerousSkip: true,
    dangerousSkipArgs: ['--dangerously-skip-permissions'],
  });

  const launch = resolveLaunchCommand('agy --conversation 11111111-2222-4333-8444-555555555555', {
    dangerouslySkipPermissions: true,
  });
  assert.strictEqual(launch.program, 'agy');
  assert.deepStrictEqual(launch.args, [
    '--dangerously-skip-permissions',
    '--conversation',
    '11111111-2222-4333-8444-555555555555',
  ]);
  assert.strictEqual(launch.permissionMode, 'full');

  const fakeAgyBin = path.join(tmpRoot, 'fake-agy');
  fs.writeFileSync(
    fakeAgyBin,
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "1.3.5"; exit 0; fi\nif [ "$1" = "--help" ]; then echo "Antigravity CLI - AI coding assistant"; exit 0; fi\n',
    { mode: 0o755 },
  );
  assert.strictEqual(readExecutableCliVersion(fakeAgyBin), '1.3.5');
  assert.strictEqual(matchesExecutableIdentity('agy', fakeAgyBin), true);

  const stderrAgyBin = path.join(tmpRoot, 'stderr-agy');
  fs.writeFileSync(
    stderrAgyBin,
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "1.3.6"; exit 0; fi\nif [ "$1" = "--help" ]; then echo "Usage of agy:" >&2; exit 0; fi\n',
    { mode: 0o755 },
  );
  assert.strictEqual(readExecutableCliVersion(stderrAgyBin), '1.3.6');
  assert.strictEqual(matchesExecutableIdentity('agy', stderrAgyBin), true);

  assert.strictEqual(providerTerminalKindForCommand('agy'), 'process');
  assert.strictEqual(nestedProviderTerminalCommand('Antigravity - Workspace'), 'agy');
  assert.deepStrictEqual(
    inferProviderTerminalActivity('agy', 'process', {
      title: '⠋ Thinking...',
      previewText: 'Working on changes',
    }),
    { activity: 'busy', priority: 'provider-first' },
  );
  assert.deepStrictEqual(
    inferProviderTerminalActivity('agy', 'process', {
      title: 'Antigravity',
      previewText: 'Running tool (Esc to interrupt)',
    }),
    { activity: 'busy', priority: 'provider-first' },
  );
  assert.deepStrictEqual(
    inferProviderTerminalActivity('agy', 'process', {
      title: 'Antigravity',
      previewText: 'Ready for input >',
    }),
    { activity: 'idle', priority: 'provider-first' },
  );
}

async function testHomeConfigurationAndExtensions(tmpRoot: string) {
  const agyHome = path.join(tmpRoot, 'agy-ext-home');
  fs.mkdirSync(path.join(agyHome, 'skills', 'code-audit'), { recursive: true });
  fs.mkdirSync(path.join(agyHome, 'builtin', 'skills', 'antigravity-guide'), { recursive: true });
  fs.writeFileSync(
    path.join(agyHome, 'settings.json'),
    JSON.stringify({
      model: 'gemini-3.1-pro',
      effort: 'high',
      mode: 'auto',
    }),
  );
  fs.writeFileSync(
    path.join(agyHome, 'mcp_config.json'),
    JSON.stringify({
      mcpServers: {
        'agy-docs': {
          command: 'npx',
          args: ['-y', '@example/agy-docs-mcp'],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(agyHome, 'skills', 'code-audit', 'SKILL.md'),
    '---\nname: code-audit\ndescription: Audit repository changes\n---\n# Code Audit\n',
  );
  fs.writeFileSync(
    path.join(agyHome, 'builtin', 'skills', 'antigravity-guide', 'SKILL.md'),
    '---\nname: antigravity-guide\ndescription: Official Antigravity guide\n---\n# Guide\n',
  );

  const config = readProviderHomeConfiguration('agy', agyHome);
  assert.strictEqual(config.exists, true);
  assert.strictEqual(config.filePath, 'settings.json');
  assert.deepStrictEqual(config.summary, [
    { key: 'model', value: 'gemini-3.1-pro' },
    { key: 'reasoning', value: 'high' },
    { key: 'permission', value: 'auto' },
  ]);

  const watchPaths = extensionWatchPaths('agy', agyHome);
  assert(
    watchPaths.includes(path.join(agyHome, 'mcp_config.json')),
    'agy extension watch paths should include mcp_config.json',
  );
  assert(
    watchPaths.includes(path.join(agyHome, 'builtin', 'skills')),
    'agy extension watch paths should include builtin/skills',
  );

  const extensions = discoverAgentExtensions({
    provider: 'agy',
    providerHomePath: agyHome,
  });
  assert(extensions.some((item: { id: string }) => item.id === 'mcp:Home:agy-docs'));
  assert(extensions.some((item: { id: string }) => item.id === 'skill:Home:code-audit'));
  assert(extensions.some((item: { id: string }) => item.id === 'skill:Built-in:antigravity-guide'));
}

async function testSessionHistoryAndInventory(tmpRoot: string) {
  assert(agentSessionHistoryProviders().includes('agy'));
  assert.strictEqual(
    buildAgentSessionResumeCommand('agy', '22222222-3333-4444-8555-666666666666'),
    'agy --conversation 22222222-3333-4444-8555-666666666666',
  );
  assert.strictEqual(
    buildAgentSessionResumeCommand('agy', '22222222-3333-4444-8555-666666666666', { fork: true }),
    '',
  );

  const agyHome = path.join(tmpRoot, 'agy-history-home');
  fs.mkdirSync(agyHome, { recursive: true });

  // 1. Pre-initialized empty DB must NOT appear in session history.
  const emptyId = '00000000-1111-4222-8333-444444444444';
  ensureAgyConversationDatabase(agyHome, emptyId);

  // 2. Active conversation with transcript.jsonl + summary title.
  const activeId = '22222222-3333-4444-8555-666666666666';
  ensureAgyConversationDatabase(agyHome, activeId);
  const transcriptDir = path.join(agyHome, 'brain', activeId, '.system_generated', 'logs');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const workspaceDir = '/repo/agy-project-alpha';

  const transcriptLines = [
    JSON.stringify({
      step_index: 1,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-10-16T01:00:00.000Z',
      content: '<USER_REQUEST>\nImplement Antigravity support\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-10-16T01:02:00.000Z',
      thinking: 'Inspecting workspace files',
      content: 'I will implement Antigravity support now.',
      tool_calls: [
        {
          id: 'call-1',
          name: 'run_command',
          args: {
            Cwd: workspaceDir,
            CommandLine: 'git status',
          },
        },
      ],
    }),
  ];
  fs.writeFileSync(path.join(transcriptDir, 'transcript.jsonl'), `${transcriptLines.join('\n')}\n`);

  const summaryOnlyId = '33333333-4444-4555-8666-777777777777';
  ensureAgyConversationDatabase(agyHome, summaryOnlyId);

  const summaryDb = new DatabaseSync(path.join(agyHome, 'conversation_summaries.db'));
  summaryDb.exec(
    'CREATE TABLE trajectory_summaries (key TEXT PRIMARY KEY, step_count INTEGER, summary_blob BLOB);' +
    'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT);'
  );
  const titleBuf = Buffer.from('Antigravity Integration Summary', 'utf8');
  const summaryBlob = Buffer.concat([Buffer.from([0x0a, titleBuf.length]), titleBuf]);
  summaryDb
    .prepare('INSERT INTO trajectory_summaries (key, step_count, summary_blob) VALUES (?, ?, ?)')
    .run(activeId, 2, summaryBlob);
  summaryDb
    .prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      summaryOnlyId,
      'Real Summary Table Session',
      'Preview fallback line',
      4,
      '2026-10-16T02:00:00Z',
      JSON.stringify(['file:///repo/agy-project-beta']),
    );
  summaryDb.close();

  const summaries = readAgyConversationSummaries(agyHome);
  assert.strictEqual(summaries.get(activeId)?.title, 'Antigravity Integration Summary');
  assert.strictEqual(summaries.get(summaryOnlyId)?.title, 'Real Summary Table Session');
  assert.strictEqual(summaries.get(summaryOnlyId)?.cwd, '/repo/agy-project-beta');

  const directSessions = await listAgySessions({ agyHome });
  assert.strictEqual(directSessions.length, 2);
  type ListedSession = { id: string; title?: string; cwd?: string; capabilities?: string[] };
  const byId = new Map<string, ListedSession>(
    (directSessions as ListedSession[]).map(s => [s.id, s]),
  );
  assert.strictEqual(byId.get(activeId)?.title, 'Antigravity Integration Summary');
  assert.strictEqual(byId.get(activeId)?.cwd, workspaceDir);
  assert.deepStrictEqual(byId.get(activeId)?.capabilities, ['resume']);
  assert.strictEqual(byId.get(summaryOnlyId)?.title, 'Real Summary Table Session');
  assert.strictEqual(byId.get(summaryOnlyId)?.cwd, '/repo/agy-project-beta');

  const inventory = new AgentSessionInventory({
    cacheFile: path.join(tmpRoot, 'session-inventory-cache.json'),
  });
  try {
    const listed = await inventory.list(() => ({
      providerHomes: {
        agy: [{ id: 'default', path: agyHome }],
      },
    }));
    const agyListed = listed.filter((s: { provider: string }) => s.provider === 'agy');
    assert.strictEqual(agyListed.length, 2);
  } finally {
    await inventory.close();
  }
}

async function testHistoricalResultError(tmpRoot: string) {
  const home = path.join(tmpRoot, 'historical-error-home');
  const id = crypto.randomUUID();
  ensureAgyConversationDatabase(home, id);
  const db = new DatabaseSync(path.join(home, 'conversations', `${id}.db`));
  const logs = path.join(home, 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const transcript = path.join(logs, 'transcript_full.jsonl');
  const error = 'API error (attempt 1): request failed: stream idle timeout (5m0s): context deadline exceeded';
  const entries = [
    { step_index: 1, type: 'ERROR_MESSAGE', error },
    { step_index: 3, type: 'USER_INPUT', status: 'DONE', content: 'New request' },
    { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Complete' },
  ];
  const writeTranscript = (value = entries) => fs.writeFileSync(transcript, value.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const check = (reason = error, boundary: number | null = 0) => isAgySupersededResultError(home, id, boundary, reason);
  try {
    db.exec('INSERT INTO steps (idx, step_type, status) VALUES (0,14,3),(1,17,3),(2,15,3),(3,14,3),(4,15,3)');
    writeTranscript();
    assert.strictEqual(await check(), true);
    assert.strictEqual(await check(error, null), false, 'missing admission evidence cannot reconcile');
    assert.strictEqual(await check(error, 3), false, 'a prior completed turn cannot settle an unrecorded request');
    assert.strictEqual(await check('different provider error'), false, 'new errors must not be hidden');
    writeTranscript(entries.filter(entry => entry.type !== 'USER_INPUT'));
    assert.strictEqual(await check(), false, 'transcript must reach the current native input');
    writeTranscript(entries.map(entry => entry.type === 'ERROR_MESSAGE' ? { ...entry, step_index: 2 } : entry));
    assert.strictEqual(await check(), false, 'text must match a native error step, not prose');
    writeTranscript();
    db.exec('INSERT INTO steps (idx, step_type, status) VALUES (5,132,1)');
    assert.strictEqual(await check(), false, 'an unfinished tool cannot complete');
    db.exec('UPDATE steps SET status=3 WHERE idx=5');
    assert.strictEqual(await check(), false, 'a completed tool can still await a response');
    db.exec('INSERT INTO steps (idx, step_type, status) VALUES (6,17,3),(7,15,3)');
    assert.strictEqual(await check(), false, 'a later answer cannot hide an unverified current-turn error');
    db.exec('DELETE FROM steps WHERE idx>=5');
    fs.appendFileSync(transcript, '{partial');
    assert.strictEqual(await check(), false, 'partial native evidence must fail closed');
    fs.unlinkSync(transcript);
    assert.strictEqual(await check(), false, 'missing native evidence must fail closed');
  } finally {
    db.close();
  }
}

async function testRecoveredTransportResultError(tmpRoot: string) {
  const home = path.join(tmpRoot, 'recovered-error-home');
  const id = crypto.randomUUID();
  ensureAgyConversationDatabase(home, id);
  const db = new DatabaseSync(path.join(home, 'conversations', `${id}.db`));
  const logs = path.join(home, 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const transcript = path.join(logs, 'transcript_full.jsonl');
  const error = 'API error (attempt 1): request failed: read: connection reset by peer';
  const entries = [
    { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'Continue work' },
    { step_index: 2, type: 'ERROR_MESSAGE', status: 'DONE', error },
    { step_index: 3, type: 'TOOL', status: 'DONE' },
    { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Work completed' },
  ];
  const writeTranscript = (value: object[] = entries) => fs.writeFileSync(transcript, value.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const check = (reason = error, boundary: number | null = 0) => isAgySupersededResultError(home, id, boundary, reason);
  try {
    db.exec('INSERT INTO steps (idx, step_type, status) VALUES (0,14,3),(1,14,3),(2,17,3),(3,132,3),(4,15,3)');
    writeTranscript();
    assert.strictEqual(await check(), true, 'native recovery after a same-turn reset supersedes the stale result error');
    assert.strictEqual(await check(error, null), false);
    assert.strictEqual(await check(error, 1), false);
    assert.strictEqual(await check('unrelated failure'), false);
    for (const reason of ['tool execution failed', '401 authentication failed: connection reset by peer', '429 quota: connection reset by peer']) {
      writeTranscript(entries.map(entry => entry.type === 'ERROR_MESSAGE' ? { ...entry, error: reason } : entry));
      assert.strictEqual(await check(reason), false, 'account and non-transport errors remain failures');
    }
    for (const missingType of ['USER_INPUT', 'ERROR_MESSAGE', 'PLANNER_RESPONSE']) {
      writeTranscript(entries.filter(entry => entry.type !== missingType));
      assert.strictEqual(await check(), false, `missing ${missingType} cannot establish recovery`);
    }
    writeTranscript(entries.map(entry => entry.type === 'PLANNER_RESPONSE' ? { ...entry, tool_calls: [{ name: 'run_command' }] } : entry));
    assert.strictEqual(await check(), false, 'a planner requesting another tool is not a final answer');
    writeTranscript();
    db.exec('UPDATE steps SET status=1 WHERE idx=3');
    assert.strictEqual(await check(), false, 'an earlier unfinished tool prevents completion');
    db.exec('UPDATE steps SET status=3 WHERE idx=3');
    db.exec('UPDATE steps SET step_type=17 WHERE idx=3');
    assert.strictEqual(await check(), false, 'every current error needs matching recovery evidence');
    db.exec('UPDATE steps SET step_type=132 WHERE idx=3');
    db.exec('INSERT INTO steps (idx, step_type, status) VALUES (5,17,3)');
    assert.strictEqual(await check(), false, 'an error after the answer is terminal');
    db.exec('DELETE FROM steps WHERE idx=5');
    db.exec('UPDATE steps SET step_type=14 WHERE idx=3');
    assert.strictEqual(await check(), false, 'another user input cannot lend its completion to this admission');
    db.exec('UPDATE steps SET step_type=132 WHERE idx=3');
    fs.appendFileSync(transcript, '{partial');
    assert.strictEqual(await check(), false);
  } finally {
    db.close();
  }
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agy-test-'));
  try {
    await testConversationStore(tmpRoot);
    await testHistoricalResultError(tmpRoot);
    await testRecoveredTransportResultError(tmpRoot);
    await testCliSpecDiscoveryAndTerminalObserver(tmpRoot);
    await testHomeConfigurationAndExtensions(tmpRoot);
    await testSessionHistoryAndInventory(tmpRoot);

    console.log('Antigravity integration tests passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
