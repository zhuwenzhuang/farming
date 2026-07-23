const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CCStatisticsClient, resolveRuntimeRoot } = require('../cc-statistics-client');
const { ccStatisticsUsageCacheFile } = require('../storage-layout');

function codexToken(timestamp, total, last, rateLimits = null) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: last,
      },
      ...(rateLimits ? { rate_limits: rateLimits } : {}),
    },
  };
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map(record => (
    typeof record === 'string' ? record : JSON.stringify(record)
  )).join('\n'));
}

function sumTokens(events) {
  return events.reduce((sum, event) => sum + event.totalTokens, 0);
}

async function run() {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-cc-statistics-'));
  const configDir = path.join(root, 'config');
  const codexRoot = path.join(root, 'codex', 'sessions');
  const claudeRoot = path.join(root, 'claude', 'projects');
  const codexFile = path.join(codexRoot, '2026', '07', '23', 'rollout-codex-session.jsonl');
  const lateCodexFile = path.join(codexRoot, '2026', '07', '23', 'rollout-late-marker.jsonl');
  const timezoneCodexFile = path.join(codexRoot, '2026', '07', '20', 'rollout-timezone.jsonl');
  const claudeFile = path.join(claudeRoot, '-repo', 'claude-session.jsonl');
  const claudeParentFile = path.join(claudeRoot, '-repo', 'parent.jsonl');
  const claudeSubagentFile = path.join(
    claudeRoot,
    '-repo',
    'parent',
    'subagents',
    'agent-child.jsonl',
  );
  const now = Date.parse('2026-07-23T12:10:00.000Z');

  writeJsonl(codexFile, [
    codexToken(
      '2025-01-01T00:00:00.000Z',
      50,
      { input_tokens: 40, output_tokens: 10 },
    ),
    {
      timestamp: '2026-07-23T12:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-session', cwd: '/repo' },
    },
    {
      timestamp: '2026-07-23T11:59:30.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'done' },
    },
    codexToken(
      '2026-07-23T12:01:00.000Z',
      150,
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 50 },
      { limit_id: 'codex', plan_type: 'pro', primary: { used_percent: 10 } },
    ),
    codexToken(
      '2026-07-23T12:01:30.000Z',
      150,
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 50 },
    ),
    JSON.stringify({
      timestamp: '2026-07-23T12:01:45.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'x'.repeat(8 * 1024 * 1024) },
    }),
  ]);
  writeJsonl(timezoneCodexFile, [
    {
      timestamp: '2026-07-19T18:39:00.000Z',
      type: 'session_meta',
      payload: { id: 'timezone-session', cwd: '/repo' },
    },
    {
      timestamp: '2026-07-19T18:40:00.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'done' },
    },
    codexToken(
      '2026-07-19T18:41:00.000Z',
      20,
      { input_tokens: 15, output_tokens: 5 },
    ),
  ]);
  writeJsonl(lateCodexFile, [{
    padding: 'x'.repeat(12 * 1024 * 1024),
    timestamp: '2026-07-23T12:01:50.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: 11 },
        last_token_usage: { input_tokens: 8, output_tokens: 3 },
      },
    },
  }]);
  writeJsonl(claudeFile, [
    {
      type: 'assistant',
      timestamp: '2026-07-23T12:02:00.000Z',
      sessionId: 'claude-session',
      message: {
        id: 'message-1',
        usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 5 },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-07-23T12:02:01.000Z',
      sessionId: 'claude-session',
      message: {
        id: 'message-1',
        usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5 },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-07-23T12:03:00.000Z',
      sessionId: 'claude-session',
      message: {
        id: 'message-large',
        content: [{ type: 'text', text: 'x'.repeat(12 * 1024 * 1024) }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-07-23T12:03:30.000Z',
      sessionId: 'claude-session',
      message: {
        id: 'message-large-usage-first',
        usage: { input_tokens: 8, output_tokens: 5 },
        content: [{ type: 'text', text: 'x'.repeat(12 * 1024 * 1024) }],
      },
    },
  ]);
  writeJsonl(claudeParentFile, [{
    type: 'assistant',
    timestamp: '2026-07-23T12:04:00.000Z',
    sessionId: 'parent',
    message: {
      id: 'shared-message',
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  }]);
  writeJsonl(claudeSubagentFile, [{
    type: 'assistant',
    timestamp: '2026-07-23T12:04:01.000Z',
    sessionId: 'child',
    message: {
      id: 'shared-message',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }]);

  const client = new CCStatisticsClient({ configDir });
  const request = {
    now,
    codexRoots: [codexRoot],
    claudeRoots: [claudeRoot],
    fresh: true,
  };
  const cold = await client.collect(request);
  assert.strictEqual(cold.source, 'cc-statistics-1.3.0-codex-fork-dedup');
  assert.strictEqual(cold.cache.rebuilt_files, 6);
  assert.strictEqual(cold.cache.scanned_files, 6);
  assert(cold.cache.pruned_events >= 1,
    'events outside the bounded retention window must be reclaimed');
  assert(cold.cache.bytes_read > 8 * 1024 * 1024);
  assert.strictEqual(cold.providers.codex.events.length, 3,
    'cc-statistics must discard repeated Codex cumulative telemetry');
  assert.strictEqual(sumTokens(cold.providers.codex.events), 181);
  const mainCodexEvent = cold.providers.codex.events.find(
    event => event.sessionId === 'codex-session',
  );
  assert.deepStrictEqual(mainCodexEvent, {
    timestamp: Date.parse('2026-07-23T11:59:30.000Z'),
    sessionId: 'codex-session',
    totalTokens: 150,
    inputTokens: 60,
    outputTokens: 50,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    unattributedTokens: 0,
  });
  const timezoneEvent = cold.providers.codex.events.find(
    event => event.sessionId === 'timezone-session',
  );
  assert.strictEqual(
    timezoneEvent.timestamp,
    Date.parse('2026-07-19T18:30:00.000Z'),
    'old hourly aggregation must align to local midnight in a half-hour timezone',
  );
  assert.strictEqual(sumTokens(cold.providers.claude.events), 72,
    'Claude streaming duplicates must deduplicate across parent and subagent files');
  assert.strictEqual(cold.providers.codex.quotaCandidates[0].rateLimits.limit_id, 'codex');

  if (process.platform !== 'win32') fs.chmodSync(codexFile, 0o000);
  const warm = await client.collect({ ...request, now: now + 3_000, fresh: true });
  if (process.platform !== 'win32') fs.chmodSync(codexFile, 0o600);
  assert.strictEqual(warm.cache.reused_files, 6);
  assert.strictEqual(warm.cache.scanned_files, 0);
  assert.strictEqual(warm.cache.bytes_read, 0);
  assert.deepStrictEqual(warm.providers, cold.providers);

  const appendedRecord = `\n${JSON.stringify(codexToken(
    '2026-07-23T12:09:00.000Z',
    200,
    { input_tokens: 30, cached_input_tokens: 10, output_tokens: 20 },
  ))}`;
  fs.appendFileSync(codexFile, appendedRecord);
  const appended = await client.collect({ ...request, now: now + 6_000, fresh: true });
  assert.strictEqual(appended.cache.appended_files, 1);
  assert.strictEqual(appended.cache.bytes_read, Buffer.byteLength(appendedRecord));
  assert.strictEqual(sumTokens(appended.providers.codex.events), 231);

  const restarted = await new CCStatisticsClient({ configDir }).collect({
    ...request,
    now: now + 9_000,
    fresh: true,
  });
  assert.strictEqual(restarted.cache.bytes_read, 0);
  assert.strictEqual(restarted.cache.reused_files, 6);
  assert.deepStrictEqual(restarted.providers, appended.providers);
  assert(fs.existsSync(ccStatisticsUsageCacheFile(configDir)));

  const legacyConfigDir = path.join(root, 'legacy-config');
  const legacyCacheFile = ccStatisticsUsageCacheFile(legacyConfigDir);
  fs.mkdirSync(path.dirname(legacyCacheFile), { recursive: true });
  const legacySchemaCode = [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'db.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")',
    'db.execute("INSERT INTO metadata VALUES (?, ?)", ("schema_version", "2"))',
    'db.execute("INSERT INTO metadata VALUES (?, ?)", ("source_version", "old-source"))',
    'db.execute("CREATE TABLE usage_events (source_path TEXT, event_key TEXT, provider TEXT, session_id TEXT, timestamp_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER)")',
    'db.commit()',
  ].join(';');
  const legacySchemaArgs = client.python.toLowerCase().endsWith('py.exe')
    ? ['-3', '-c', legacySchemaCode, legacyCacheFile]
    : ['-c', legacySchemaCode, legacyCacheFile];
  const legacySchema = spawnSync(client.python, legacySchemaArgs, { encoding: 'utf8' });
  assert.strictEqual(legacySchema.status, 0, legacySchema.stderr);
  const legacyMigrated = await new CCStatisticsClient({
    configDir: legacyConfigDir,
  }).collect({
    now,
    codexRoots: [],
    claudeRoots: [],
    fresh: true,
  });
  assert.strictEqual(legacyMigrated.schemaVersion, 6,
    'a real v2 table layout must migrate before indexes reference new columns');
  assert.strictEqual(legacyMigrated.cache.cache_rebuilt, true,
    'an incompatible derived cache must be deleted and rebuilt automatically');
  const rebuiltSchemaCode = [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    `names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]`,
    'print(",".join(names))',
  ].join(';');
  const rebuiltSchemaArgs = client.python.toLowerCase().endsWith('py.exe')
    ? ['-3', '-c', rebuiltSchemaCode, legacyCacheFile]
    : ['-c', rebuiltSchemaCode, legacyCacheFile];
  const rebuiltSchema = spawnSync(client.python, rebuiltSchemaArgs, { encoding: 'utf8' });
  assert.strictEqual(rebuiltSchema.status, 0, rebuiltSchema.stderr);
  const rebuiltTableNames = rebuiltSchema.stdout.trim().split(',');
  assert(!rebuiltTableNames.includes('usage_events'),
    'the incompatible raw-event table must not survive cache recreation');
  assert.deepStrictEqual(
    [
      'codex_event_fingerprints',
      'codex_recent_events',
      'codex_usage_hourly',
      'dedupe_events',
      'metadata',
      'recent_events',
      'source_files',
      'usage_hourly',
    ]
      .filter(name => !rebuiltTableNames.includes(name)),
    [],
  );

  const migrationCode = [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'db.execute("UPDATE metadata SET value = ? WHERE key = ?", ("old-source", "source_version"))',
    'db.commit()',
  ].join(';');
  const migrationArgs = client.python.toLowerCase().endsWith('py.exe')
    ? ['-3', '-c', migrationCode, ccStatisticsUsageCacheFile(configDir)]
    : ['-c', migrationCode, ccStatisticsUsageCacheFile(configDir)];
  const migration = spawnSync(client.python, migrationArgs, { encoding: 'utf8' });
  assert.strictEqual(migration.status, 0, migration.stderr);
  const migrated = await client.collect({ ...request, now: now + 10_000, fresh: true });
  assert.strictEqual(migrated.cache.rebuilt_files, 6,
    'a cc-statistics source-version change must invalidate old normalized events');

  const scaleRoot = path.join(root, 'scale-codex');
  const scaleFile = path.join(scaleRoot, 'rollout-scale.jsonl');
  const scaleRecords = [
    {
      timestamp: '2026-07-20T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'scale-session', cwd: '/scale' },
    },
    {
      timestamp: '2026-07-20T10:01:00.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'done' },
    },
    ...Array.from({ length: 20_000 }, (_, index) => codexToken(
      `2026-07-20T10:${String(1 + Math.floor(index / 1000)).padStart(2, '0')}:00.000Z`,
      index + 1,
      { input_tokens: 1, output_tokens: 1 },
    )),
  ];
  writeJsonl(scaleFile, scaleRecords);
  const scaleConfigDir = path.join(root, 'scale-config');
  const scaled = await new CCStatisticsClient({
    configDir: scaleConfigDir,
    timeoutMs: 30_000,
  }).collect({
    now,
    codexRoots: [scaleRoot],
    claudeRoots: [],
    scanBudgetMs: 30_000,
    fresh: true,
  });
  assert.strictEqual(scaled.cache.scan_complete, true);
  assert.strictEqual(scaled.providers.codex.events.length, 1);
  assert.strictEqual(sumTokens(scaled.providers.codex.events), 40_000);
  assert.strictEqual(scaled.cache.hourly_rows, 1,
    'long-term Codex storage must grow by active session-hours, not token events');
  assert.strictEqual(scaled.cache.recent_rows, 0);
  assert.strictEqual(scaled.cache.dedupe_rows, 0);
  assert.strictEqual(scaled.cache.codex_fingerprint_rows, 20_000,
    'Codex keeps one compact fingerprint per unique response for fork de-duplication');

  const forkRoot = path.join(root, 'fork-codex');
  const parentForkFile = path.join(forkRoot, '2026', '07', '22', 'rollout-parent.jsonl');
  const childForkFile = path.join(forkRoot, '2026', '07', '23', 'rollout-child.jsonl');
  const siblingForkFile = path.join(forkRoot, '2026', '07', '23', 'rollout-sibling.jsonl');
  const parentMeta = {
    timestamp: '2026-07-22T10:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'fork-parent', cwd: '/fork' },
  };
  const parentUsage = codexToken(
    '2026-07-22T10:02:00.000Z',
    100,
    { input_tokens: 80, output_tokens: 20 },
  );
  writeJsonl(parentForkFile, [
    parentMeta,
    {
      timestamp: '2026-07-22T10:01:00.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'parent response' },
    },
    parentUsage,
  ]);
  writeJsonl(childForkFile, [
    {
      timestamp: '2026-07-23T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'fork-child',
        cwd: '/fork',
        forked_from_id: 'fork-parent',
      },
    },
    {
      ...parentMeta,
      timestamp: '2026-07-23T10:00:01.000Z',
    },
    {
      timestamp: '2026-07-23T10:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'parent response' },
    },
    {
      ...parentUsage,
      timestamp: '2026-07-23T10:00:03.000Z',
    },
    {
      timestamp: '2026-07-23T10:01:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call', id: 'child-response', name: 'exec_command' },
    },
    codexToken(
      '2026-07-23T10:02:00.000Z',
      160,
      { input_tokens: 50, cached_input_tokens: 10, output_tokens: 10 },
    ),
  ]);
  writeJsonl(siblingForkFile, [
    {
      timestamp: '2026-07-23T11:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'fork-sibling',
        cwd: '/fork',
        forked_from_id: 'fork-parent',
      },
    },
    {
      ...parentMeta,
      timestamp: '2026-07-23T11:00:01.000Z',
    },
    {
      timestamp: '2026-07-23T11:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'parent response' },
    },
    {
      ...parentUsage,
      timestamp: '2026-07-23T11:00:03.000Z',
    },
    {
      timestamp: '2026-07-23T11:01:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call', id: 'sibling-response', name: 'exec_command' },
    },
    codexToken(
      '2026-07-23T11:02:00.000Z',
      160,
      { input_tokens: 50, cached_input_tokens: 10, output_tokens: 10 },
    ),
  ]);
  const forked = await new CCStatisticsClient({
    configDir: path.join(root, 'fork-config'),
  }).collect({
    now,
    codexRoots: [forkRoot],
    claudeRoots: [],
    fresh: true,
  });
  assert.strictEqual(sumTokens(forked.providers.codex.events), 220,
    'a fork must count inherited token telemetry only once');
  assert.deepStrictEqual(
    forked.providers.codex.events.map(event => ({
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      totalTokens: event.totalTokens,
    })),
    [
      {
        sessionId: 'fork-parent',
        timestamp: Date.parse('2026-07-22T09:30:00.000Z'),
        totalTokens: 100,
      },
      {
        sessionId: 'fork-child',
        timestamp: Date.parse('2026-07-23T10:01:00.000Z'),
        totalTokens: 60,
      },
      {
        sessionId: 'fork-sibling',
        timestamp: Date.parse('2026-07-23T11:01:00.000Z'),
        totalTokens: 60,
      },
    ],
    'copied history de-duplicates while sibling responses remain distinct',
  );
  assert.strictEqual(forked.cache.codex_fingerprint_rows, 3);

  let backgroundCalls = 0;
  const backgroundClient = new CCStatisticsClient({
    configDir: path.join(root, 'background-config'),
    async probe() {},
    async runner() {
      backgroundCalls += 1;
      return {
        ...cold,
        cache: {
          ...cold.cache,
          scan_complete: backgroundCalls >= 2,
          pending_files: backgroundCalls >= 2 ? 0 : 1,
        },
      };
    },
  });
  const partial = await backgroundClient.collect({
    now,
    codexRoots: [],
    claudeRoots: [],
    fresh: true,
  });
  assert.strictEqual(partial.cache.scan_complete, false);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.strictEqual(backgroundCalls, 2,
    'a bounded first result must continue rebuilding in one background scanner');
  assert.strictEqual(backgroundClient.cached.cache.scan_complete, true);

  writeJsonl(codexFile, [
    {
      timestamp: '2026-07-23T12:05:00.000Z',
      type: 'session_meta',
      payload: { id: 'replacement-session', cwd: '/replacement' },
    },
    codexToken(
      '2026-07-23T12:06:00.000Z',
      12,
      { input_tokens: 9, output_tokens: 3 },
    ),
  ]);
  const replaced = await client.collect({ ...request, now: now + 12_000, fresh: true });
  assert.strictEqual(replaced.cache.rebuilt_files, 3,
    'a destructive Codex rewrite must rebuild the provider ledger');
  assert.strictEqual(replaced.cache.codex_cache_rebuilt, true);
  assert.strictEqual(sumTokens(replaced.providers.codex.events), 43);
  assert(replaced.providers.codex.events.some(
    event => event.sessionId === 'replacement-session' && event.totalTokens === 12,
  ));

  const partialFile = path.join(codexRoot, '2026', '07', '23', 'rollout-partial.jsonl');
  const partialRecord = JSON.stringify(codexToken(
    '2026-07-23T12:07:00.000Z',
    10,
    { input_tokens: 8, output_tokens: 2 },
  ));
  const partialSplit = partialRecord.indexOf('"token_count"') - 2;
  fs.writeFileSync(partialFile, partialRecord.slice(0, partialSplit));
  const incomplete = await client.collect({ ...request, now: now + 15_000, fresh: true });
  assert.strictEqual(sumTokens(incomplete.providers.codex.events), 43);
  fs.appendFileSync(partialFile, partialRecord.slice(partialSplit));
  const completed = await client.collect({ ...request, now: now + 18_000, fresh: true });
  assert.strictEqual(sumTokens(completed.providers.codex.events), 53,
    'an incomplete line must be recoverable when its token marker arrives later');
  assert.strictEqual(completed.cache.bytes_read, Buffer.byteLength(partialRecord),
    'recovering an incomplete line rereads exactly that line from its safe checkpoint');

  const adversarialFile = path.join(codexRoot, '2026', '07', '23', 'rollout-adversarial.jsonl');
  const hugeKey = `ignored-${'k'.repeat(12 * 1024 * 1024)}`;
  writeJsonl(adversarialFile, [
    {
      timestamp: '2026-07-23T12:07:30.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'x'.repeat(16 * 1024 * 1024),
      },
    },
    {
      [hugeKey]: true,
      timestamp: '2026-07-23T12:07:31.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 6 },
          last_token_usage: { input_tokens: 4, output_tokens: 2 },
        },
      },
    },
  ]);
  const invalidFile = path.join(codexRoot, '2026', '07', '23', 'rollout-invalid.jsonl');
  fs.writeFileSync(
    invalidFile,
    `{"padding":"${'x'.repeat(9 * 1024 * 1024)}","timestamp":"2026-07-23T12:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":99},"last_token_usage":{"input_tokens":90,"output_tokens":9}}},,"invalid":true}`,
  );
  const adversarial = await client.collect({ ...request, now: now + 19_000, fresh: true });
  assert.strictEqual(sumTokens(adversarial.providers.codex.events), 59,
    'large captured strings and keys stay bounded while valid tokens remain exact');
  assert(adversarial.providers.codex.events.some(event => (
    event.sessionId === 'rollout-adversarial'
    && event.timestamp === Date.parse('2026-07-23T12:07:30.000Z')
    && event.totalTokens === 6
  )));
  assert(!adversarial.providers.codex.events.some(event => (
    event.sessionId === 'rollout-invalid'
  )), 'invalid large JSON must follow json.loads semantics and never emit token usage');

  const originalPackaged = process.env.FARMING_PACKAGED_RUNTIME;
  process.env.FARMING_PACKAGED_RUNTIME = '1';
  const extractedRoot = await resolveRuntimeRoot(configDir);
  const concurrentPackagedConfig = path.join(root, 'concurrent-packaged');
  const concurrentRoots = await Promise.all(
    Array.from({ length: 6 }, () => resolveRuntimeRoot(concurrentPackagedConfig)),
  );
  if (originalPackaged === undefined) delete process.env.FARMING_PACKAGED_RUNTIME;
  else process.env.FARMING_PACKAGED_RUNTIME = originalPackaged;
  assert(fs.existsSync(path.join(extractedRoot, 'farming_usage_cli.py')));
  assert(fs.existsSync(path.join(extractedRoot, 'cc_stats', 'parser.py')));
  assert.strictEqual(new Set(concurrentRoots).size, 1,
    'concurrent packaged extraction must converge without sharing a temporary directory');

  const probeCalls = [];
  const runnerCalls = [];
  const fallbackClient = new CCStatisticsClient({
    configDir: path.join(root, 'fallback-config'),
    async probe(candidate) {
      probeCalls.push(candidate);
      if (probeCalls.length === 1) {
        const error = new Error('old Python');
        error.code = 'EPYTHONVERSION';
        throw error;
      }
    },
    async runner(candidate) {
      runnerCalls.push(candidate);
      return cold;
    },
  });
  await fallbackClient.collect({
    ...request,
    codexRoots: [],
    claudeRoots: [],
    fresh: true,
  });
  assert(probeCalls.length >= 2, 'an unusable Python candidate must not block a later one');
  assert.deepStrictEqual(runnerCalls, [probeCalls[1]]);

  const runnerFailure = new Error('sqlite cache corrupt');
  runnerFailure.code = 'ECCSTATISTICS';
  let businessProbeCount = 0;
  let businessRunCount = 0;
  const businessFailureClient = new CCStatisticsClient({
    configDir: path.join(root, 'business-failure-config'),
    async probe() {
      businessProbeCount += 1;
    },
    async runner() {
      businessRunCount += 1;
      throw runnerFailure;
    },
  });
  await assert.rejects(
    businessFailureClient.collect({
      ...request,
      codexRoots: [],
      claudeRoots: [],
      fresh: true,
    }),
    error => error === runnerFailure,
    'adapter and cache failures must not be rewritten as a missing Python runtime',
  );
  assert.strictEqual(businessProbeCount, 1);
  assert.strictEqual(businessRunCount, 1);

  const codexOnlyRoot = path.join(root, 'codex-only');
  writeJsonl(path.join(codexOnlyRoot, 'one.jsonl'), [
    codexToken(
      '2026-07-23T12:08:00.000Z',
      5,
      { input_tokens: 4, output_tokens: 1 },
    ),
  ]);
  const isolated = await new CCStatisticsClient({
    configDir: path.join(root, 'isolated-config'),
  }).collect({
    now,
    codexRoots: [codexOnlyRoot],
    claudeRoots: [path.join(root, 'missing-claude')],
    fresh: true,
  });
  assert.strictEqual(isolated.providers.codex.available, true);
  assert.strictEqual(isolated.providers.claude.available, false,
    'a missing Claude source must not mark valid Codex data unavailable');

  fs.rmSync(root, { recursive: true, force: true });
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
  console.log('✓ cc-statistics uses exact normalization and persistent incremental cache');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
