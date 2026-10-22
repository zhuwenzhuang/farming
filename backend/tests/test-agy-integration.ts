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
  didAgyCurrentTurnCompleteCleanly,
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
const {
  AcpRuntime,
} = require('../acp-runtime.cjs');

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

async function testAcpBridgeEndToEnd(tmpRoot: string) {
  const agyHome = path.join(tmpRoot, 'agy-acp-home');
  const workspaceDir = path.join(tmpRoot, 'acp-workspace');
  const configDir = path.join(tmpRoot, 'farming-config');
  fs.mkdirSync(agyHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  const fakeAgyScript = path.join(tmpRoot, 'fake-agy-stream.mjs');
  fs.writeFileSync(
    fakeAgyScript,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('1.3.5');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('Antigravity CLI - AI coding assistant');
  process.exit(0);
}

const convIdx = args.indexOf('--conversation');
const conversationId = convIdx >= 0 ? args[convIdx + 1] : 'missing-id';
const agyHome = process.env.AGY_HOME || '';
const dbPath = path.join(agyHome, 'conversations', conversationId + '.db');
if (!fs.existsSync(dbPath)) {
  console.error('Conversation "' + conversationId + '" not found, starting new conversation.');
}

const text = args[args.indexOf('-p') + 1] || '';
if (text.includes('PEER_RECOVERY')) {
  const logs = path.join(agyHome, 'brain', conversationId, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.appendFileSync(path.join(logs, 'transcript_full.jsonl'), JSON.stringify({ type: 'USER_INPUT', content: text }) + '\\n');
}

if (text.includes('FAIL_PERSISTED')) {
  const logs = path.join(agyHome, 'brain', conversationId, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), JSON.stringify({ type: 'USER_INPUT', content: text }) + '\\n');
  process.exit(7);
}
if (text.includes('CHECK_CONTEXT')) {
  console.log(JSON.stringify({ event: 'result', conversation_id: conversationId, result: { status: 'SUCCESS', response: JSON.stringify({ cwd: process.cwd(), args }) } }));
  process.exit(0);
}
if (text.includes('STREAM_RECONCILE')) {
  const events = [
    { step_index: 1, thinking_delta: 'Considering' },
    { step_index: 1, thinking: 'Considering options' },
    { step_index: 1, text_delta: 'Progress' },
    { step_index: 1, text: 'Progress update' },
    { step_index: 1, text: 'Progress update' },
    { step_index: 2, text: 'Final' },
    { step_index: 2, text: 'Final answer' },
  ];
  for (const update of events) console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', ...update } }));
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Final answer complete' } }));
  process.exit(0);
}
if (text.includes('RESULT_AFTER_PROGRESS')) {
  console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, text_delta: 'Working on it' } }));
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Result-only final answer' } }));
  process.exit(0);
}
if (text.includes('CONFLICTING_SNAPSHOT')) {
  for (const value of ['Original', 'Replacement']) console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, text: value } }));
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }));
  process.exit(0);
}
if (text.startsWith('/model ') || text.startsWith('/effort ')) {
  const [command, value] = text.trim().split(/\\s+/);
  console.log(JSON.stringify({ status: value === 'rejected-model' || value === 'low' ? 'ERROR' : 'SUCCESS',
    data: { [command.slice(1)]: value }, response: 'configuration result' }));
  process.exit(value === 'exit-failure-model' ? 7 : 0);
}
if (text.includes('LONG_RUNNING_TURN')) {
  // Compress the CLI's positive print deadline so a regression cannot wait an hour.
  const timeout = args[args.indexOf('--print-timeout') + 1];
  const deadline = timeout && timeout !== '0'
    ? setTimeout(() => {
        console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'partial work only' } }));
        process.exit(0);
      }, 20)
    : null;
  console.log(JSON.stringify({ event: 'step_update', step_update: {
    conversation_id: conversationId, step_index: 1, step_type: 'tool',
    tool_name: 'run_command', state: 'ACTIVE',
  } }));
  // The quiet tool interval exceeds both compressed former turn limits and the
  // runtime's control-request deadline. Only provider completion ends the turn.
  await new Promise(resolve => setTimeout(resolve, 200));
  console.log(JSON.stringify({ event: 'step_update', step_update: {
    conversation_id: conversationId, step_index: 1, step_type: 'tool',
    tool_name: 'run_command', state: 'DONE',
  } }));
  console.log(JSON.stringify({ event: 'step_update', step_update: {
    conversation_id: conversationId, step_index: 2, step_type: 'agent_response',
    state: 'DONE', text_delta: 'Final answer after long execution',
  } }));
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }));
  if (deadline) clearTimeout(deadline);
  process.exit(0);
}
if (text.includes('STALE_PRIOR_TURN_ERROR') || text.includes('UNCHANGED_PRIOR_TURN_ERROR') || text.includes('MID_TURN_RECOVERED_STREAM_ERROR') || text.includes('INTERRUPTED_AFTER_TOOL')) {
  if (text.includes('STALE_PRIOR_TURN_ERROR')) {
    const db = new DatabaseSync(dbPath);
    db.exec('INSERT INTO steps (idx, step_type, status) VALUES (5, 14, 3), (6, 15, 3)');
    db.close();
  } else if (text.includes('MID_TURN_RECOVERED_STREAM_ERROR')) {
    const db = new DatabaseSync(dbPath);
    db.exec('INSERT INTO steps (idx, step_type, status) VALUES (7, 14, 3), (8, 15, 3), (9, 17, 3), (10, 15, 3)');
    db.close();
  } else if (text.includes('INTERRUPTED_AFTER_TOOL')) {
    const db = new DatabaseSync(dbPath);
    db.exec('INSERT INTO steps (idx, step_type, status) VALUES (11, 14, 3), (12, 15, 3), (13, 132, 3)');
    db.close();
  }
  console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: 5, step_type: 'agent_response', state: 'DONE', text_delta: 'recovered-from-stale-error' } }));
  console.log(JSON.stringify({ event: 'result', conversation_id: conversationId, result: { status: 'ERROR', error: 'The stream was interrupted. Please continue the task you were working on.', response: 'recovered-from-stale-error' } }));
  process.exit(0);
}
if (text.includes('STEERABLE_TURN')) {
  const logs = path.join(agyHome, 'brain', conversationId, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.appendFileSync(path.join(logs, 'transcript_full.jsonl'), JSON.stringify({ type: 'USER_INPUT', content: text }) + '\\n');
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 1,
      step_type: 'agent_response',
      state: 'DONE',
      text_delta: 'Initial steerable work started.',
    },
  }));
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 2,
      step_type: 'tool',
      state: 'ACTIVE',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: {
          toolAction: 'Running long task before steer',
          CommandLine: 'sleep 30',
        },
      },
    },
  }));
  fs.writeFileSync(path.join(agyHome, 'steerable-ready.txt'), String(process.pid));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (text.includes('STEER_FOLLOWUP_INSTRUCTION')) {
  const hasBootstrap = text.includes('FARMING_BOOTSTRAP_MARKER');
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 3,
      step_type: 'agent_response',
      state: 'DONE',
      text_delta: 'Steered continuation completed (bootstrap=' + hasBootstrap + ', text=' + text.trim() + ')',
    },
  }));
  console.log(JSON.stringify({
    event: 'result',
    conversation_id: conversationId,
    result: {
      status: 'SUCCESS',
      response: 'Steered continuation completed (bootstrap=' + hasBootstrap + ', text=' + text.trim() + ')',
      num_turns: 1,
    },
  }));
  process.exit(0);
}
if (text.includes('FAIL_EXIT') || text.includes('FAIL_STATUS') || text.includes('MISSING_RESULT')) {
  console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'partial-before-failure' } }));
  if (text.includes('FAIL_STATUS')) console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', response: 'provider failure' } }));
  console.error('intentional provider failure');
  process.exit(text.includes('FAIL_EXIT') ? 7 : 0);
}
if (text.includes('WRONG_ID')) {
  console.log(JSON.stringify({ event: 'result', conversation_id: 'different-session', result: { status: 'SUCCESS' } }));
  process.exit(0);
}
if (text.includes('HANG_TOOLS')) {
  const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  fs.writeFileSync(path.join(agyHome, 'turn-pids.json'), JSON.stringify([process.pid, tool.pid]));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

console.log(JSON.stringify({
  event: 'init',
  conversation_id: conversationId,
  init: { cwd: process.cwd(), permission_mode: 'auto' },
}));

if (text.trim() === '/quota') {
  console.log(JSON.stringify({
    conversation_id: conversationId,
    status: 'SUCCESS',
    response: 'Gemini Models\\tWeekly Limit Remaining\\t92%',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini 3.1 Pro',
            buckets: [
              { id: 'weekly', name: 'Weekly Limit Remaining', remaining_fraction: 0.92 },
            ],
          },
        ],
      },
    },
  }));
  process.exit(0);
}

console.log(JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: conversationId,
    step_index: 1,
    step_type: 'agent_response',
    state: 'DONE',
    thinking_delta: 'Analyzing user request in Antigravity',
  },
}));

console.log(JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: conversationId,
    step_index: 2,
    step_type: 'tool',
    state: 'ACTIVE',
    tool_name: 'run_command',
    tool_info: {
      name: 'run_command',
      parameters: {
        toolAction: 'Checking workspace files',
        CommandLine: 'ls -la',
      },
    },
  },
}));

console.log(JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: conversationId,
    step_index: 2,
    step_type: 'tool',
    state: 'DONE',
    tool_name: 'run_command',
    tool_info: {
      name: 'run_command',
      parameters: {
        toolAction: 'Checking workspace files',
        CommandLine: 'ls -la',
      },
      output: 'total 0',
    },
  },
}));

const hasBootstrap = text.includes('FARMING_BOOTSTRAP_MARKER');
console.log(JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: conversationId,
    step_index: 3,
    step_type: 'agent_response',
    state: 'DONE',
    text_delta: 'Antigravity reply (bootstrap=' + hasBootstrap + ', skipPerms=' + args.includes('--dangerously-skip-permissions') + ')',
  },
}));

console.log(JSON.stringify({
  event: 'result',
  conversation_id: conversationId,
  result: {
    status: 'SUCCESS',
    response: 'Antigravity reply (bootstrap=' + hasBootstrap + ', skipPerms=' + args.includes('--dangerously-skip-permissions') + ')',
    num_turns: 1,
  },
}));
`,
    { mode: 0o755 },
  );

  const runtime = new AcpRuntime({ configDir });
  try {
    const prepared = await runtime.prepareAgent({
      agentId: 'agent-agy-test-1',
      provider: 'agy',
      executable: fakeAgyScript,
      configDir,
      cwd: workspaceDir,
      projectWorkspace: workspaceDir,
      providerHomeId: 'default',
      providerHomePath: agyHome,
      farmingSystemPrompt: 'FARMING_BOOTSTRAP_MARKER',
    });

    assert(prepared.sessionId, 'ACP newSession should return a sessionId');
    const createdDbPath = path.join(agyHome, 'conversations', `${prepared.sessionId}.db`);
    assert(fs.existsSync(createdDbPath), 'ACP newSession should pre-initialize conversation db');
    const initialSnapshot = runtime.getSession('agent-agy-test-1');
    assert.strictEqual(initialSnapshot.currentModeId, 'bypassPermissions');
    assert.deepStrictEqual(
      initialSnapshot.modes.availableModes.map((m: { id: string }) => m.id),
      ['bypassPermissions', 'agent_decides', 'plan'],
    );

    const entrySummary = (entry: {
      type?: string;
      role?: string;
      title?: string;
      content?: Array<{ text?: string }>;
    }) => {
      const text = Array.isArray(entry.content)
        ? entry.content.map(block => block?.text || '').join('')
        : '';
      return `${entry.type}:${entry.role || ''}:${entry.title || ''}:${text}`;
    };

    const firstTurn = await runtime.prompt('agent-agy-test-1', [
      { type: 'text', text: 'Hello Antigravity' },
    ]);
    assert.strictEqual(firstTurn.stopReason, 'end_turn');

    const snapshotAfterFirst = runtime.getSession('agent-agy-test-1');
    const transcriptTexts = snapshotAfterFirst.entries.map(entrySummary);
    assert(
      transcriptTexts.some((line: string) => line.includes('Analyzing user request in Antigravity')),
      'transcript should include agent thought chunk',
    );
    assert(
      transcriptTexts.some((line: string) => line.includes('run_command: Checking workspace files')),
      'transcript should include tool call',
    );
    assert(
      transcriptTexts.some((line: string) => line.includes('Antigravity reply (bootstrap=true, skipPerms=true)')),
      'first turn should include bootstrap and bypassPermissions mode skip permissions',
    );

    const assistantMessagesSince = (start: number) => runtime.getSession('agent-agy-test-1').entries.slice(start)
      .filter((entry: { type: string; role?: string }) => entry.type === 'message' && entry.role === 'assistant')
      .map((entry: { content: Array<{ text?: string }> }) => entry.content.map(block => block.text || '').join(''));
    let start = runtime.getSession('agent-agy-test-1').entries.length;
    await runtime.prompt('agent-agy-test-1', [{ type: 'text', text: 'STREAM_RECONCILE' }]);
    assert.deepStrictEqual(assistantMessagesSince(start), ['Progress update', 'Final answer complete'],
      'snapshots, deltas and final suffix must appear once, with distinct messages for distinct steps');
    const thoughts = runtime.getSession('agent-agy-test-1').entries.slice(start)
      .filter((entry: { type: string }) => entry.type === 'thought').map(entrySummary);
    assert.strictEqual(thoughts.length, 1);
    assert(thoughts[0].endsWith('Considering options'), 'cumulative thinking must not duplicate prior deltas');
    start = runtime.getSession('agent-agy-test-1').entries.length;
    await runtime.prompt('agent-agy-test-1', [{ type: 'text', text: 'RESULT_AFTER_PROGRESS' }]);
    assert.deepStrictEqual(assistantMessagesSince(start), ['Working on it', 'Result-only final answer']);
    await assert.rejects(runtime.prompt('agent-agy-test-1', [{ type: 'text', text: 'CONFLICTING_SNAPSHOT' }]), /snapshot/);

    const configValue = (id: string) => runtime.getSession('agent-agy-test-1').configOptions
      .find((option: { id: string }) => option.id === id)?.currentValue;
    const initialModel = configValue('model');
    const initialEffort = configValue('effort');
    for (const command of ['/model rejected-model', '/model exit-failure-model', '/effort low']) {
      await assert.rejects(runtime.prompt('agent-agy-test-1', [{ type: 'text', text: command }]));
      assert.strictEqual(configValue('model'), initialModel);
      assert.strictEqual(configValue('effort'), initialEffort);
    }
    start = runtime.getSession('agent-agy-test-1').entries.length;
    await runtime.prompt('agent-agy-test-1', [{ type: 'text', text: 'CHECK_CONTEXT' }]);
    const retainedArgs = JSON.parse(assistantMessagesSince(start)[0]).args as string[];
    assert.strictEqual(retainedArgs[retainedArgs.indexOf('--model') + 1], initialModel,
      'failed slash command must not poison subsequent CLI arguments');
    assert.strictEqual(retainedArgs[retainedArgs.indexOf('--effort') + 1], initialEffort);
    await runtime.prompt('agent-agy-test-1', [{ type: 'text', text: '/model test-confirmed-model' }]);
    await runtime.prompt('agent-agy-test-1', [{ type: 'text', text: '/effort xhigh' }]);
    assert.strictEqual(configValue('model'), 'test-confirmed-model');
    assert.strictEqual(configValue('effort'), 'xhigh');
    assert(runtime.getSession('agent-agy-test-1').configOptions.find((option: { id: string }) => option.id === 'effort')
      .options.some((option: { value: string }) => option.value === 'xhigh'));

    // Switch to native planning mode and medium effort.
    await runtime.setSessionMode('agent-agy-test-1', 'plan');
    await runtime.setSessionConfigOption('agent-agy-test-1', 'effort', 'medium');

    // Second turn: bootstrap should NOT be re-injected, and skipPerms should be false.
    await runtime.prompt('agent-agy-test-1', [
      { type: 'text', text: 'Second turn' },
    ]);
    const snapshotAfterSecond = runtime.getSession('agent-agy-test-1');
    assert(
      snapshotAfterSecond.entries.map(entrySummary).some((line: string) => (
        line.includes('Antigravity reply (bootstrap=false, skipPerms=false)')
      )),
      'second turn should not re-inject system prompt and should reflect planning mode',
    );

    // Slash command turn (/quota).
    await runtime.prompt('agent-agy-test-1', [
      { type: 'text', text: '/quota' },
    ]);
    const snapshotAfterSlash = runtime.getSession('agent-agy-test-1');
    assert(
      snapshotAfterSlash.entries.map(entrySummary).some((line: string) => (
        line.includes('Gemini 3.1 Pro') && line.includes('92% remaining')
      )),
      '/quota slash command should render structured model quota output',
    );

    for (const marker of ['FAIL_EXIT', 'FAIL_STATUS', 'MISSING_RESULT', 'WRONG_ID']) {
      await assert.rejects(runtime.prompt('agent-agy-test-1', [{ type: 'text', text: marker }]), /failure|ERROR|missing final result|different conversation identity/);
    }

    // Historical step_type=17 before the latest USER_INPUT (step_type=14) must not fail a clean current turn.
    const staleDb = new DatabaseSync(createdDbPath);
    staleDb.exec(
      "INSERT INTO steps (idx, step_type, status) VALUES (1, 14, 3), (2, 17, 3), (3, 14, 3), (4, 15, 3);"
    );
    staleDb.close();
    assert.strictEqual(didAgyCurrentTurnCompleteCleanly(agyHome, prepared.sessionId, 1), true);
    assert.strictEqual(didAgyCurrentTurnCompleteCleanly(agyHome, prepared.sessionId, 3), false);
    assert.strictEqual(didAgyCurrentTurnCompleteCleanly(agyHome, prepared.sessionId, null), false);
    await assert.rejects(runtime.prompt('agent-agy-test-1', [
      { type: 'text', text: 'UNCHANGED_PRIOR_TURN_ERROR' },
    ]), /stream was interrupted/);
    const recoveredTurn = await runtime.prompt('agent-agy-test-1', [
      { type: 'text', text: 'STALE_PRIOR_TURN_ERROR' },
    ]);
    assert.strictEqual(recoveredTurn.stopReason, 'end_turn');
    assert(
      runtime.getSession('agent-agy-test-1').entries.map(entrySummary).some((line: string) => (
        line.includes('recovered-from-stale-error')
      )),
      'clean current turn must succeed despite historical step_type=17 in conversation db',
    );

    const midTurnRecovered = await runtime.prompt('agent-agy-test-1', [
      { type: 'text', text: 'MID_TURN_RECOVERED_STREAM_ERROR' },
    ]);
    assert.strictEqual(midTurnRecovered.stopReason, 'end_turn');
    assert.strictEqual(didAgyCurrentTurnCompleteCleanly(agyHome, prepared.sessionId, 5), true);

    await assert.rejects(runtime.prompt('agent-agy-test-1', [
      { type: 'text', text: 'INTERRUPTED_AFTER_TOOL' },
    ]), /stream was interrupted/);
    assert.strictEqual(didAgyCurrentTurnCompleteCleanly(agyHome, prepared.sessionId, 7), false);
    assert.strictEqual(runtime.getSession('agent-agy-test-1').chatTurn.status, 'failed',
      'a completed tool followed by provider interruption must not be reported as a completed turn');

    await assert.rejects(runtime.prompt('agent-agy-test-1', [{ type: 'text', text: 'FAIL_STATUS' }]), /ERROR/);

    // Verify steering capability and live mid-turn steering.
    assert.strictEqual(runtime.getSession('agent-agy-test-1').supportsSteer, true);
    assert.strictEqual(runtime.canSteer('agent-agy-test-1'), false);
    const steerableReadyFile = path.join(agyHome, 'steerable-ready.txt');
    fs.rmSync(steerableReadyFile, { force: true });
    const steerableTurn = runtime.prompt('agent-agy-test-1', [
      { type: 'text', text: 'STEERABLE_TURN' },
    ]);
    for (let attempt = 0; !fs.existsSync(steerableReadyFile) && attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(fs.existsSync(steerableReadyFile), 'steerable turn must start before steering');
    assert.strictEqual(runtime.canSteer('agent-agy-test-1'), true);
    const steerAck = await runtime.steer('agent-agy-test-1', [
      { type: 'text', text: 'STEER_FOLLOWUP_INSTRUCTION' },
    ]);
    assert(steerAck.turnId, 'steer should return an active turnId');
    const steerableOutcome = await steerableTurn;
    assert.strictEqual(steerableOutcome.stopReason, 'end_turn');
    const afterSteerEntries = runtime.getSession('agent-agy-test-1').entries.map(entrySummary);
    assert(
      afterSteerEntries.some((line: string) => line.includes('STEER_FOLLOWUP_INSTRUCTION')),
      'transcript should record the steered user message',
    );
    assert(
      afterSteerEntries.some((line: string) => line.includes('Steered continuation completed (bootstrap=false, text=STEER_FOLLOWUP_INSTRUCTION)')),
      'steered continuation should complete inside the same ACP turn without re-injecting bootstrap',
    );

    const interruptedTool = runtime.getSession('agent-agy-test-1').entries.find((entry: { title?: string }) =>
      entry.title?.includes('Running long task before steer'));
    assert.strictEqual(interruptedTool?.status, 'failed', 'steering cannot claim an interrupted tool succeeded');
    assert(JSON.stringify(interruptedTool).includes('interrupted by steering'));

    await runtime.setSessionConfigOption('agent-agy-test-1', 'model', 'claude-opus-5-5');
    await runtime.setSessionConfigOption('agent-agy-test-1', 'effort', 'max');
    await runtime.prompt('agent-agy-test-1', [
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', path: '/tmp/screenshot-1.png', uri: 'file:///tmp/screenshot-1.png' },
      { type: 'text', text: 'CHECK_CONTEXT' },
    ]);
    const afterContextSession = runtime.getSession('agent-agy-test-1');
    assert(
      afterContextSession.entries.map(entrySummary).some((line: string) => (
        line.includes(workspaceDir)
        && line.includes('claude-opus-5-5')
        && line.includes('max')
        && line.includes('Attached image: screenshot-1.png')
      )),
      'later prompts retain workspace, selected model, effort, and flattened image paths',
    );

    const longTurnClock = path.join(tmpRoot, 'long-turn-clock.cjs');
    fs.writeFileSync(longTurnClock, `
if (process.argv.some(arg => arg.endsWith('/agy-acp-bridge.cjs'))) {
  require('node:fs').writeFileSync(__filename + '.ready', 'ready');
  const schedule = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) =>
    schedule(callback, ms >= 60 * 60 * 1000 ? 20 : ms, ...args);
}
`);
    const longHome = path.join(tmpRoot, 'long-turn-home');
    fs.mkdirSync(longHome);
    const longRuntime = new AcpRuntime({ configDir, requestTimeoutMs: 50 });
    try {
      await longRuntime.prepareAgent({
        agentId: 'agent-agy-long', provider: 'agy', executable: fakeAgyScript,
        configDir, cwd: workspaceDir, providerHomePath: longHome,
        env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(longTurnClock)}` },
      });
      assert(fs.existsSync(longTurnClock + '.ready'), 'the adapter must run under the accelerated turn clock');
      const outcome = await longRuntime.prompt('agent-agy-long', [{ type: 'text', text: 'LONG_RUNNING_TURN' }]);
      assert.strictEqual(outcome.stopReason, 'end_turn');
      assert(longRuntime.getSession('agent-agy-long').entries.map(entrySummary)
        .some((line: string) => line.includes('Final answer after long execution')),
      'a silent long-running tool must finish and deliver its final answer past both former turn deadlines');

      const longPending = longRuntime.prompt('agent-agy-long', [{ type: 'text', text: 'HANG_TOOLS' }]);
      const longPids = path.join(longHome, 'turn-pids.json');
      for (let attempt = 0; !fs.existsSync(longPids) && attempt < 100; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert(fs.existsSync(longPids), 'long turn must start its tool before cancellation');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.strictEqual(longRuntime.getSession('agent-agy-long').state, 'working');
      await longRuntime.cancel('agent-agy-long');
      assert.strictEqual((await longPending).stopReason, 'cancelled');
      for (const pid of JSON.parse(fs.readFileSync(longPids, 'utf8')) as number[]) {
        assert.throws(() => process.kill(pid, 0), /ESRCH/, 'long-turn cancellation must kill provider and tool descendants');
      }
    } finally {
      await longRuntime.dispose();
    }

    const pendingTurn = runtime.prompt('agent-agy-test-1', [{ type: 'text', text: 'HANG_TOOLS' }]);
    const pidsFile = path.join(agyHome, 'turn-pids.json');
    for (let attempt = 0; !fs.existsSync(pidsFile) && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 20));
    assert(fs.existsSync(pidsFile), 'fake provider must start its tool');
    await assert.rejects(runtime.prompt('agent-agy-test-1', [{ type: 'text', text: 'overlap' }]));
    await runtime.cancel('agent-agy-test-1');
    assert.strictEqual((await pendingTurn).stopReason, 'cancelled');
    for (const pid of JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as number[]) {
      assert.throws(() => process.kill(pid, 0), /ESRCH/, 'cancel must kill provider and tool descendants');
    }

    const missingSession = crypto.randomUUID();
    await assert.rejects(runtime.prepareAgent({
      agentId: 'agent-agy-missing', provider: 'agy', executable: fakeAgyScript,
      configDir, cwd: workspaceDir, projectWorkspace: workspaceDir,
      providerHomeId: 'default', providerHomePath: agyHome,
      sessionId: missingSession, historyMode: 'load',
    }), /not found/);
    assert(!fs.existsSync(path.join(agyHome, 'conversations', `${missingSession}.db`)), 'load must never manufacture missing history');

    // Test loadSession replay from transcript.jsonl.
    const replaySessionId = crypto.randomUUID();
    assert(ensureAgyConversationDatabase(agyHome, replaySessionId, workspaceDir));
    const replayTranscriptDir = path.join(
      agyHome,
      'brain',
      replaySessionId,
      '.system_generated',
      'logs',
    );
    fs.mkdirSync(replayTranscriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(replayTranscriptDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 1,
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-10-16T01:10:00.000Z',
          content: '<USER_REQUEST>\nReplayed user question\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-10-16T01:10:05.000Z',
          thinking: 'Replayed thought',
          content: 'Replayed assistant answer',
          tool_calls: [
            {
              id: 'replay-tc-1',
              name: 'view_file',
              args: { AbsolutePath: '/tmp/example.ts' },
            },
          ],
        }),
        JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE', content: 'Replayed file contents' }),
        JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [
          { name: 'run_command', args: { CommandLine: 'failed command' } },
          { name: 'run_command', args: { CommandLine: 'interrupted command' } },
        ] }),
        JSON.stringify({ step_index: 5, type: 'GENERIC', status: 'ERROR', content: 'Replayed command error' }),
        JSON.stringify({ step_index: 6, type: 'GENERIC', status: 'RUNNING', content: 'Partial command output' }),
        JSON.stringify({ step_index: 7, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [
          { name: 'run_command', args: { CommandLine: 'no result command' } },
        ] }),
      ].join('\n') + '\n',
    );

    await runtime.prepareAgent({
      agentId: 'agent-agy-test-replay',
      provider: 'agy',
      executable: fakeAgyScript,
      configDir,
      cwd: workspaceDir,
      projectWorkspace: workspaceDir,
      providerHomeId: 'default',
      providerHomePath: agyHome,
      sessionId: replaySessionId,
      historyMode: 'load',
      farmingSystemPrompt: 'FARMING_BOOTSTRAP_MARKER',
    });
    const replaySnapshot = runtime.getSession('agent-agy-test-replay');
    const replayLines = replaySnapshot.entries.map(entrySummary);
    const replayTools = replaySnapshot.entries.filter((entry: { type: string }) => entry.type === 'tool');
    assert.deepStrictEqual(replayTools.map((entry: { status: string }) => entry.status),
      ['completed', 'failed', 'failed', 'failed'], 'only native DONE results prove historical tool completion');
    assert(JSON.stringify(replayTools[0]).includes('Replayed file contents'));
    assert(JSON.stringify(replayTools[1]).includes('Replayed command error'));
    assert(JSON.stringify(replayTools[2]).includes('Partial command output'));

    assert(
      replayLines.some((line: string) => line.includes('Replayed user question')),
      'loadSession should replay cleaned user input',
    );
    assert(
      replayLines.some((line: string) => line.includes('Replayed assistant answer')),
      'loadSession should replay assistant message',
    );
    await runtime.prompt('agent-agy-test-replay', [{ type: 'text', text: 'Continue imported history' }]);
    assert(runtime.getSession('agent-agy-test-replay').entries.map(entrySummary)
      .some((line: string) => line.includes('bootstrap=true')),
    'native user history does not prove that Farming instructions were injected');
    await runtime.unregisterAgentAndWait('agent-agy-test-replay');

    const fullTranscriptPath = path.join(replayTranscriptDir, 'transcript_full.jsonl');
    fs.writeFileSync(fullTranscriptPath, '{broken transcript');
    await assert.rejects(runtime.prepareAgent({
      agentId: 'agent-agy-invalid-history', provider: 'agy', executable: fakeAgyScript, configDir,
      cwd: workspaceDir, projectWorkspace: workspaceDir, providerHomeId: 'default', providerHomePath: agyHome,
      sessionId: replaySessionId, historyMode: 'load',
    }), /malformed Antigravity transcript/);
    fs.rmSync(fullTranscriptPath);
    fs.mkdirSync(fullTranscriptPath);
    await assert.rejects(runtime.prepareAgent({
      agentId: 'agent-agy-unreadable-history', provider: 'agy', executable: fakeAgyScript, configDir,
      cwd: workspaceDir, projectWorkspace: workspaceDir, providerHomeId: 'default', providerHomePath: agyHome,
      sessionId: replaySessionId, historyMode: 'load',
    }), /EISDIR|directory/i);
    fs.rmdirSync(fullTranscriptPath);

    for (const historyMode of ['load', 'resume'] as const) {
      for (const priorPrompt of ['', 'Native user input', 'OLD_FARMING_BOOTSTRAP', 'FARMING_BOOTSTRAP_MARKER']) {
        fs.writeFileSync(path.join(replayTranscriptDir, 'transcript_full.jsonl'), priorPrompt
          ? JSON.stringify({ type: 'USER_INPUT', content: `<USER_REQUEST>\n${priorPrompt}\nQuestion\n</USER_REQUEST>` }) + '\n'
          : '');
        const agentId = 'agent-agy-bootstrap-recovery';
        await runtime.prepareAgent({
          agentId, provider: 'agy', executable: fakeAgyScript, configDir,
          cwd: workspaceDir, projectWorkspace: workspaceDir,
          providerHomeId: 'default', providerHomePath: agyHome,
          sessionId: replaySessionId, historyMode,
          farmingSystemPrompt: 'FARMING_BOOTSTRAP_MARKER',
        });
        await runtime.prompt(agentId, [{ type: 'text', text: 'Continue' }]);
        const expected = priorPrompt !== 'FARMING_BOOTSTRAP_MARKER';
        assert(runtime.getSession(agentId).entries.map(entrySummary)
          .some((line: string) => line.includes(`bootstrap=${expected}`)),
        `${historyMode} must use current instruction content as injection evidence (${priorPrompt || 'empty log'})`);
        await runtime.unregisterAgentAndWait(agentId);
      }
    }

    const peerAgent = 'agent-agy-peer-recovery';
    const peerOptions = { agentId: peerAgent, provider: 'agy', executable: fakeAgyScript, configDir,
      cwd: workspaceDir, projectWorkspace: workspaceDir, providerHomeId: 'default', providerHomePath: agyHome,
      farmingSystemPrompt: 'FARMING_BOOTSTRAP_MARKER' };
    const peerSession = await runtime.prepareAgent(peerOptions);
    await runtime.prompt(peerAgent, [{ type: 'text', text: 'PEER_RECOVERY human request' }]);
    const peerSource = { version: 1, direction: 'incoming', senderAddress: 'peer:reviewer', senderName: 'Reviewer' };
    await runtime.prompt(peerAgent, [{ type: 'text', text: 'PEER_RECOVERY review result' }], { peerMessage: peerSource });
    await runtime.checkpointStore.flush();
    await runtime.unregisterAgentAndWait(peerAgent);
    for (let replay = 0; replay < 2; replay += 1) {
      await runtime.prepareAgent({ ...peerOptions, sessionId: peerSession.sessionId, historyMode: 'load',
        farmingSystemPrompt: 'UPDATED_FARMING_BOOTSTRAP_MARKER' });
      const inputs = runtime.getSession(peerAgent).entries.filter((entry: { role?: string }) => entry.role === 'user');
      assert.strictEqual(inputs.length, 2);
      assert.deepStrictEqual(inputs[0].content, [{ type: 'text', text: 'PEER_RECOVERY human request' }]);
      assert.deepStrictEqual(inputs[1].content, [{ type: 'text', text: 'PEER_RECOVERY review result' }]);
      assert.deepStrictEqual(inputs[1]._meta.peerMessage, peerSource, 'peer provenance survives native replay and subsequent checkpoint');
      await runtime.checkpointStore.flush();
      await runtime.unregisterAgentAndWait(peerAgent);
    }

    for (const failure of ['FAIL_EXIT', 'FAIL_PERSISTED']) {
      fs.writeFileSync(path.join(replayTranscriptDir, 'transcript_full.jsonl'), '');
      await runtime.prepareAgent({
        agentId: 'agent-agy-bootstrap-failure', provider: 'agy', executable: fakeAgyScript, configDir,
        cwd: workspaceDir, projectWorkspace: workspaceDir,
        providerHomeId: 'default', providerHomePath: agyHome,
        sessionId: replaySessionId, historyMode: 'load', farmingSystemPrompt: 'FARMING_BOOTSTRAP_MARKER',
      });
      await assert.rejects(runtime.prompt('agent-agy-bootstrap-failure', [{ type: 'text', text: failure }]));
      await runtime.prompt('agent-agy-bootstrap-failure', [{ type: 'text', text: 'Retry after provider failure' }]);
      assert(runtime.getSession('agent-agy-bootstrap-failure').entries.map(entrySummary)
        .some((line: string) => line.includes(`bootstrap=${failure === 'FAIL_EXIT'}`)),
      'a failed first turn must reconcile persisted input before consuming the bootstrap');
      await runtime.unregisterAgentAndWait('agent-agy-bootstrap-failure');
    }
  } finally {
    await runtime.dispose();
  }
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agy-test-'));
  try {
    await testConversationStore(tmpRoot);
    await testCliSpecDiscoveryAndTerminalObserver(tmpRoot);
    await testHomeConfigurationAndExtensions(tmpRoot);
    await testSessionHistoryAndInventory(tmpRoot);
    await testAcpBridgeEndToEnd(tmpRoot);
    console.log('Antigravity integration tests passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
