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

  const blob = buildAgyTrajectoryMetadataBlob(sessionId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.strictEqual(blob.length, 76);
  assert.strictEqual(blob[0], 0x1a);
  assert.strictEqual(blob[1], 0x24);
  assert.strictEqual(blob.subarray(2, 38).toString('utf8'), sessionId);

  const cleaned = cleanAgyUserInputText(
    '<farming-agent-context>\nbootstrap\n</farming-agent-context>\n<USER_REQUEST>\nFix bug #42\n</USER_REQUEST>'
  );
  assert.strictEqual(cleaned, 'Fix bug #42');

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

let stdinData = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  stdinData += chunk;
}
const payload = JSON.parse(stdinData.trim());
const text = payload?.message?.content?.[0]?.text || '';

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
      'first turn should include bootstrap and auto mode skip permissions',
    );

    // Switch mode to ask_every_time and config option effort to medium.
    await runtime.setSessionMode('agent-agy-test-1', 'ask_every_time');
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
      'second turn should not re-inject system prompt and should reflect ask_every_time mode',
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

    // Test loadSession replay from transcript.jsonl.
    const replaySessionId = crypto.randomUUID();
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
    });
    const replaySnapshot = runtime.getSession('agent-agy-test-replay');
    const replayLines = replaySnapshot.entries.map(entrySummary);
    assert(
      replayLines.some((line: string) => line.includes('Replayed user question')),
      'loadSession should replay cleaned user input',
    );
    assert(
      replayLines.some((line: string) => line.includes('Replayed assistant answer')),
      'loadSession should replay assistant message',
    );
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
