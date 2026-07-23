const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  UsageHistoryClient,
  runUsageWorker,
} = require('../usage-history-client');
const {
  usageHistoryCacheFile,
} = require('../storage-layout');

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    records.map(record => (
      typeof record === 'string' ? record : JSON.stringify(record)
    )).join('\n'),
  );
}

function appendJsonl(filePath, records) {
  fs.appendFileSync(
    filePath,
    `\n${records.map(record => JSON.stringify(record)).join('\n')}`,
  );
}

function token(timestamp, total, last, rateLimits = null) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
      ...(rateLimits ? { rate_limits: rateLimits } : {}),
    },
  };
}

function meta(timestamp, id, extra = {}) {
  return {
    timestamp,
    type: 'session_meta',
    payload: { id, timestamp, cwd: '/repo', ...extra },
  };
}

function assistant(timestamp, message = 'done') {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type: 'agent_message', message },
  };
}

function boundary(timestamp) {
  return {
    timestamp,
    type: 'turn_context',
    payload: { model: 'gpt-5' },
  };
}

function taskStarted(timestamp) {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: `turn-${timestamp}` },
  };
}

function sum(events) {
  return events.reduce((total, event) => total + event.totalTokens, 0);
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-usage-history-'));
  const configDir = path.join(root, 'config');
  const codexRoot = path.join(root, 'codex');
  const claudeRoot = path.join(root, 'claude');
  const codexFile = path.join(codexRoot, 'rollout-main.jsonl');
  const claudeFile = path.join(claudeRoot, '-repo', 'claude.jsonl');
  const claudeDuplicate = path.join(
    claudeRoot,
    '-repo',
    'claude',
    'subagents',
    'agent-child.jsonl',
  );
  const now = Date.parse('2026-07-23T12:10:00.000Z');

  writeJsonl(codexFile, [
    meta('2026-07-23T12:00:00.000Z', 'main'),
    assistant('2026-07-23T12:00:30.000Z'),
    token(
      '2026-07-23T12:01:00.000Z',
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
      { limit_id: 'codex', primary: { used_percent: 10 } },
    ),
    token(
      '2026-07-23T12:01:30.000Z',
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
    ),
    JSON.stringify({
      timestamp: '2026-07-23T12:02:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        output: 'x'.repeat(34 * 1024 * 1024) + JSON.stringify(token(
          '2026-07-23T12:01:59.000Z',
          { input_tokens: 999_999_999, output_tokens: 1 },
          { input_tokens: 999_999_999, output_tokens: 1 },
        )),
      },
    }),
  ]);
  writeJsonl(claudeFile, [
    {
      type: 'assistant',
      timestamp: '2026-07-23T12:03:00.000Z',
      sessionId: 'claude',
      message: {
        id: 'message-1',
        usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 5 },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-07-23T12:03:01.000Z',
      sessionId: 'claude',
      message: {
        id: 'message-1',
        usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5 },
      },
    },
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-23T12:04:00.000Z',
      sessionId: 'claude',
      message: {
        id: 'large-message',
        content: [{
          type: 'tool_use',
          input: {
            usage: { input_tokens: 999_999_999, output_tokens: 999_999_999 },
            padding: 'x'.repeat(34 * 1024 * 1024),
          },
        }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    }),
  ]);
  writeJsonl(claudeDuplicate, [{
    type: 'assistant',
    timestamp: '2026-07-23T12:03:02.000Z',
    sessionId: 'child',
    message: {
      id: 'message-1',
      usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 5 },
    },
  }]);

  const client = new UsageHistoryClient({ configDir });
  const request = {
    now,
    codexRoots: [codexRoot],
    claudeRoots: [claudeRoot],
    scanBudgetMs: 30_000,
    fresh: true,
  };
  const cold = await client.collect(request);
  assert.strictEqual(cold.source, 'farming-usage-ts-1-codexbar-v0.45.2');
  assert.strictEqual(cold.schemaVersion, 9);
  assert.strictEqual(cold.cache.scan_complete, true);
  assert.strictEqual(cold.providers.codex.events.length, 1);
  assert.strictEqual(sum(cold.providers.codex.events), 110);
  assert.deepStrictEqual(cold.providers.codex.events[0], {
    timestamp: Date.parse('2026-07-23T12:00:30.000Z'),
    sessionId: 'main',
    totalTokens: 110,
    inputTokens: 60,
    outputTokens: 10,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    unattributedTokens: 0,
  });
  assert.strictEqual(sum(cold.providers.claude.events), 44);
  assert.strictEqual(
    cold.providers.codex.quotaCandidates[0].rateLimits.limit_id,
    'codex',
  );

  if (process.platform !== 'win32') fs.chmodSync(codexFile, 0o000);
  const warm = await new UsageHistoryClient({ configDir }).collect({
    ...request,
    now: now + 3_000,
  });
  if (process.platform !== 'win32') fs.chmodSync(codexFile, 0o600);
  assert.strictEqual(warm.cache.bytes_read, 0);
  assert.strictEqual(warm.cache.reused_files, 3);
  assert.deepStrictEqual(warm.providers, cold.providers);

  appendJsonl(codexFile, [
    assistant('2026-07-23T12:05:00.000Z'),
    token(
      '2026-07-23T12:05:01.000Z',
      { input_tokens: 150, cached_input_tokens: 50, output_tokens: 20 },
      { input_tokens: 50, cached_input_tokens: 10, output_tokens: 10 },
    ),
  ]);
  const appended = await client.collect({ ...request, now: now + 6_000 });
  assert.strictEqual(appended.cache.appended_files, 1);
  assert.strictEqual(sum(appended.providers.codex.events), 170);

  const archivedCodexFile = path.join(codexRoot, 'archived_sessions', 'rollout-main.jsonl');
  fs.mkdirSync(path.dirname(archivedCodexFile), { recursive: true });
  fs.renameSync(codexFile, archivedCodexFile);
  const archived = await client.collect({ ...request, now: now + 7_000 });
  assert.strictEqual(archived.cache.moved_files, 1);
  assert.strictEqual(archived.cache.bytes_read, 0);
  assert.strictEqual(sum(archived.providers.codex.events), 170);
  fs.renameSync(archivedCodexFile, codexFile);
  const restored = await client.collect({ ...request, now: now + 8_000 });
  assert.strictEqual(restored.cache.moved_files, 1);
  assert.strictEqual(restored.cache.bytes_read, 0);
  assert.strictEqual(sum(restored.providers.codex.events), 170);

  const beforeRewrite = fs.readFileSync(codexFile, 'utf8');
  const rewrittenText = beforeRewrite
    .replace('"input_tokens":150', '"input_tokens":140')
    .replace(
      '"input_tokens":50,"cached_input_tokens":10',
      '"input_tokens":40,"cached_input_tokens":10',
    );
  assert.strictEqual(Buffer.byteLength(rewrittenText), Buffer.byteLength(beforeRewrite));
  fs.writeFileSync(codexFile, rewrittenText);
  const rewritten = await client.collect({ ...request, now: now + 8_500 });
  assert.strictEqual(rewritten.cache.codex_cache_rebuilt, true);
  assert.strictEqual(sum(rewritten.providers.codex.events), 160);

  const legacy = path.join(configDir, 'history', 'cc-statistics-usage-v1.sqlite3');
  fs.writeFileSync(legacy, 'old python sqlite cache');
  await client.collect({ ...request, now: now + 9_000 });
  assert.strictEqual(fs.existsSync(legacy), false);
  assert.strictEqual(fs.existsSync(usageHistoryCacheFile(configDir)), true);

  const forkRoot = path.join(root, 'fork');
  const parentFile = path.join(forkRoot, 'parent.jsonl');
  const childFile = path.join(forkRoot, 'child.jsonl');
  const siblingFile = path.join(forkRoot, 'sibling.jsonl');
  const totalOnlyFile = path.join(forkRoot, 'total-only.jsonl');
  const parentMeta = meta('2026-07-22T10:00:00.000Z', 'parent');
  const copiedParentTask = taskStarted('2026-07-22T10:00:30.000Z');
  const parentToken = token(
    '2026-07-22T10:01:00.000Z',
    { input_tokens: 80, output_tokens: 20 },
    { input_tokens: 80, output_tokens: 20 },
  );
  writeJsonl(parentFile, [parentMeta, copiedParentTask, parentToken]);
  for (const [filePath, id, hour] of [
    [childFile, 'child', '10'],
    [siblingFile, 'sibling', '11'],
  ]) {
    writeJsonl(filePath, [
      meta(`2026-07-23T${hour}:00:00.000Z`, id, { forked_from_id: 'parent' }),
      parentMeta,
      copiedParentTask,
      parentToken,
      taskStarted(`2026-07-23T${hour}:01:00.000Z`),
      assistant(`2026-07-23T${hour}:01:30.000Z`, 'branch'),
      token(
        `2026-07-23T${hour}:02:00.000Z`,
        { input_tokens: 130, cached_input_tokens: 10, output_tokens: 30 },
        { input_tokens: 50, cached_input_tokens: 10, output_tokens: 10 },
      ),
    ]);
  }
  writeJsonl(totalOnlyFile, [
    meta('2026-07-23T12:00:00.000Z', 'total-only', { forked_from_id: 'parent' }),
    token(
      '2026-07-23T12:02:00.000Z',
      { input_tokens: 130, cached_input_tokens: 10, output_tokens: 30 },
      null,
    ),
  ]);
  const forked = await new UsageHistoryClient({
    configDir: path.join(root, 'fork-config'),
  }).collect({
    now,
    codexRoots: [forkRoot],
    claudeRoots: [],
    scanBudgetMs: 30_000,
    fresh: true,
  });
  assert.strictEqual(sum(forked.providers.codex.events), 280);
  assert.deepStrictEqual(
    forked.providers.codex.events.map(event => [event.sessionId, event.totalTokens]),
    [['parent', 100], ['child', 60], ['sibling', 60], ['total-only', 60]],
  );

  const subagentRoot = path.join(root, 'subagent');
  writeJsonl(path.join(subagentRoot, 'subagent.jsonl'), [
    {
      ...meta('2026-07-23T09:00:00.000Z', 'subagent'),
      payload: {
        id: 'subagent',
        timestamp: '2026-07-23T09:00:00.000Z',
        cwd: '/repo',
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: 'parent' },
          },
        },
      },
    },
    parentMeta,
    parentToken,
    boundary('2026-07-23T09:01:00.000Z'),
    {
      timestamp: '2026-07-23T09:01:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'inter_agent_communication_metadata',
        trigger_turn: true,
      },
    },
    token(
      '2026-07-23T09:02:00.000Z',
      { input_tokens: 130, cached_input_tokens: 10, output_tokens: 30 },
      { input_tokens: 50, cached_input_tokens: 10, output_tokens: 10 },
    ),
  ]);
  const subagent = await new UsageHistoryClient({
    configDir: path.join(root, 'subagent-config'),
  }).collect({
    now,
    codexRoots: [subagentRoot],
    claudeRoots: [],
    scanBudgetMs: 30_000,
    fresh: true,
  });
  assert.strictEqual(sum(subagent.providers.codex.events), 60,
    'a copied subagent prefix must stay suppressed until its owned-turn boundary');

  const partialRoot = path.join(root, 'partial');
  const partialFile = path.join(partialRoot, 'rollout.jsonl');
  const completePartialToken = JSON.stringify(token(
    '2026-07-23T07:01:00.000Z',
    { input_tokens: 8, output_tokens: 2 },
    { input_tokens: 8, output_tokens: 2 },
  ));
  const partialPrefix = `${JSON.stringify(meta(
    '2026-07-23T07:00:00.000Z',
    'partial',
  ))}\n${completePartialToken.slice(0, -5)}`;
  writeJsonl(partialFile, [partialPrefix]);
  const partialCache = path.join(root, 'partial-config', 'usage.sqlite3');
  const partial = await runUsageWorker({
    cacheFile: partialCache,
    nowMs: now,
    scanBudgetMs: 30_000,
    roots: { codex: [partialRoot], claude: [] },
  });
  assert.strictEqual(partial.cache.scan_complete, false);
  assert.deepStrictEqual(partial.providers.codex.events, []);
  fs.appendFileSync(partialFile, completePartialToken.slice(-5));
  const completedPartial = await runUsageWorker({
    cacheFile: partialCache,
    nowMs: now + 1,
    scanBudgetMs: 30_000,
    roots: { codex: [partialRoot], claude: [] },
  });
  assert.strictEqual(completedPartial.cache.scan_complete, true);
  assert.strictEqual(sum(completedPartial.providers.codex.events), 10,
    'a half-written final JSONL record must be reread from its original offset');

  const interleavedRoot = path.join(root, 'interleaved');
  writeJsonl(path.join(interleavedRoot, 'rollout.jsonl'), [
    meta('2026-07-23T08:00:00.000Z', 'interleaved'),
    token(
      '2026-07-23T08:01:00.000Z',
      { input_tokens: 100, output_tokens: 10 },
      { input_tokens: 100, output_tokens: 10 },
    ),
    token(
      '2026-07-23T08:02:00.000Z',
      { input_tokens: 20, output_tokens: 2 },
      { input_tokens: 20, output_tokens: 2 },
    ),
    token(
      '2026-07-23T08:03:00.000Z',
      { input_tokens: 110, output_tokens: 11 },
      { input_tokens: 90, output_tokens: 9 },
    ),
    token(
      '2026-07-23T08:04:00.000Z',
      { input_tokens: 30, output_tokens: 3 },
      { input_tokens: 10, output_tokens: 1 },
    ),
  ]);
  const interleaved = await new UsageHistoryClient({
    configDir: path.join(root, 'interleaved-config'),
  }).collect({
    now,
    codexRoots: [interleavedRoot],
    claudeRoots: [],
    scanBudgetMs: 30_000,
    fresh: true,
  });
  assert.strictEqual(sum(interleaved.providers.codex.events), 121,
    'a high/low lineage flip must not recount the gap below the watermark');

  const scaleRoot = path.join(root, 'scale');
  writeJsonl(path.join(scaleRoot, 'rollout.jsonl'), [
    meta('2026-07-20T10:00:00.000Z', 'scale'),
    ...Array.from({ length: 20_000 }, (_, index) => token(
      '2026-07-20T10:01:00.000Z',
      { input_tokens: index + 1, output_tokens: index + 1 },
      { input_tokens: 1, output_tokens: 1 },
    )),
  ]);
  const scaled = await new UsageHistoryClient({
    configDir: path.join(root, 'scale-config'),
  }).collect({
    now,
    codexRoots: [scaleRoot],
    claudeRoots: [],
    scanBudgetMs: 30_000,
    fresh: true,
  });
  assert.strictEqual(sum(scaled.providers.codex.events), 40_000);
  assert.strictEqual(scaled.cache.hourly_rows, 1);
  assert.strictEqual(scaled.cache.codex_fingerprint_rows, 0);

  const direct = await runUsageWorker({
    cacheFile: path.join(root, 'direct.sqlite3'),
    nowMs: now,
    scanBudgetMs: 30_000,
    roots: { codex: [codexRoot], claude: [claudeRoot] },
  });
  assert.strictEqual(direct.providers.codex.available, true);

  const db = new DatabaseSync(usageHistoryCacheFile(configDir), { readOnly: true });
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map(row => row.name);
  db.close();
  assert(!tables.includes('codex_event_fingerprints'));
  assert(tables.includes('usage_hourly'));
  assert(tables.includes('claude_messages'));

  let persistentErrorCalls = 0;
  const persistentErrorClient = new UsageHistoryClient({
    configDir: path.join(root, 'persistent-error-config'),
    backgroundDelayMs: 1,
    backgroundErrorDelayMs: 1,
    runner: async requestData => {
      persistentErrorCalls += 1;
      return {
        schemaVersion: 9,
        source: 'test',
        sampledAt: requestData.nowMs,
        providers: {
          codex: { events: [], available: false, fileCount: 1 },
          claude: { events: [], available: false, fileCount: 0 },
        },
        cache: {
          scan_complete: false,
          errors: 1,
          pending_files: 1,
          committed_bytes: 0,
        },
      };
    },
  });
  await persistentErrorClient.collect({
    now,
    codexRoots: [codexRoot],
    claudeRoots: [],
    fresh: true,
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.strictEqual(persistentErrorCalls, 3,
    'a persistent scanner error must stop automatic retries after a bounded audit');

  console.log('✓ TypeScript usage history is incremental, fork-safe, and Python-free');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
