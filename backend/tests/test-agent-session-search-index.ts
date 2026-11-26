import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSessionSearchIndex,
  buildSearchSnippet,
} from '../agent-session-search-index.cjs';
import type { AgentSession } from '../agent-session-history.cjs';

async function run(): Promise<void> {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farming-session-fts5-')));
  const dbFile = path.join(tmpRoot, 'cache', 'agent-session-search-v1.sqlite3');
  const codexHome = path.join(tmpRoot, 'codex-home');
  const claudeHome = path.join(tmpRoot, 'claude-home');
  const piHome = path.join(tmpRoot, 'pi-home');
  const agyHome = path.join(tmpRoot, 'agy-home');

  const index = new AgentSessionSearchIndex({ dbFile });

  try {
    // 1. Codex session whose title does NOT contain the body keywords.
    const codexId = '11111111-2222-4333-8444-555555555555';
    const codexFile = path.join(codexHome, 'sessions', '2026', '11', '26', `rollout-2026-11-26-${codexId}.jsonl`);
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    fs.writeFileSync(codexFile, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '帮我排查 slx_columnar_serialize_buffer 在宽表导出时的内存 OOM 问题',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'Checked RangeHistoAlgo memory usage and buffer growth strategy.',
        },
      }),
    ].join('\n') + '\n');

    // 2. Claude session with cross-turn multi-token content.
    const claudeId = '22222222-3333-4444-8555-666666666666';
    const claudeFile = path.join(claudeHome, 'projects', '-repo-alpha', `${claudeId}.jsonl`);
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, [
      JSON.stringify({
        type: 'user',
        sessionId: claudeId,
        message: { role: 'user', content: 'Let us inspect the quantum_entanglement_router latency spikes.' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: claudeId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found a deadlock in sapphire_cache_evictor during failover.' }] },
      }),
    ].join('\n') + '\n');

    // 3. Pi session.
    const piId = 'pi-session-alpha';
    const piFile = path.join(piHome, 'sessions', 'workspace-a', `2026-11-26T10-00-00-000Z_${piId}.jsonl`);
    fs.mkdirSync(path.dirname(piFile), { recursive: true });
    fs.writeFileSync(piFile, [
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'Analyze obsidian_telemetry_pipeline throughput.' }] },
      }),
    ].join('\n') + '\n');

    // 4. Agy session.
    const agyId = '33333333-4444-4555-8666-777777777777';
    const agyFile = path.join(agyHome, 'brain', agyId, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(agyFile), { recursive: true });
    fs.writeFileSync(agyFile, [
      JSON.stringify({
        role: 'user',
        text: '请总结 聚簇索引 在分区裁剪上的优化收益',
      }),
    ].join('\n') + '\n');

    const sessions: AgentSession[] = [
      {
        provider: 'codex',
        providerHomeId: 'default',
        providerHomePath: codexHome,
        id: codexId,
        title: 'Investigate build pipeline',
        workspace: '/repo/odps_src',
        cwd: '/repo/odps_src',
        updatedAt: '2026-11-26T12:00:00.000Z',
      },
      {
        provider: 'claude',
        providerHomeId: 'default',
        providerHomePath: claudeHome,
        id: claudeId,
        title: 'Weekly triage',
        workspace: '/repo/alpha',
        cwd: '/repo/alpha',
        updatedAt: '2026-11-26T11:00:00.000Z',
      },
      {
        provider: 'pi',
        providerHomeId: 'default',
        providerHomePath: piHome,
        id: piId,
        title: 'Pi maintenance',
        workspace: '/repo/pi',
        cwd: '/repo/pi',
        updatedAt: '2026-11-26T10:00:00.000Z',
      },
      {
        provider: 'agy',
        providerHomeId: 'default',
        providerHomePath: agyHome,
        id: agyId,
        title: 'Cluster study',
        workspace: '/repo/meta',
        cwd: '/repo/meta',
        updatedAt: '2026-11-26T09:00:00.000Z',
      },
    ];

    // A. Full-text FTS5 match on body-only identifier (not in title).
    const bodyMatch = await index.search(sessions, 'slx_columnar_serialize_buffer');
    assert.strictEqual(bodyMatch.scope, 'id-title-project-content');
    assert.strictEqual(bodyMatch.sessions.length, 1);
    assert.strictEqual(bodyMatch.sessions[0].id, codexId);
    assert.strictEqual(bodyMatch.sessions[0].searchMatchSource, 'content');
    assert(bodyMatch.sessions[0].searchSnippet?.includes('slx_columnar_serialize_buffer'));
    assert((bodyMatch.sessions[0].searchSnippetRanges?.length ?? 0) > 0);
    assert.strictEqual(index.getIndexedSessionCount(), 4);

    // B. 2-char CJK query ("内存") + mixed English+CJK query ("slx_columnar 内存").
    const cjkTwoChar = await index.search(sessions, '内存');
    assert.deepStrictEqual(cjkTwoChar.sessions.map(s => s.id), [codexId]);
    assert(cjkTwoChar.sessions[0].searchSnippet?.includes('内存'));

    const mixedQuery = await index.search(sessions, 'slx_columnar 内存');
    assert.deepStrictEqual(mixedQuery.sessions.map(s => s.id), [codexId]);

    // C. Agy CJK query ("聚簇索引").
    const agyMatch = await index.search(sessions, '聚簇索引');
    assert.deepStrictEqual(agyMatch.sessions.map(s => s.id), [agyId]);

    // D. Pi session full-text search.
    const piMatch = await index.search(sessions, 'obsidian_telemetry');
    assert.deepStrictEqual(piMatch.sessions.map(s => s.id), [piId]);

    // E. Cross-message multi-token match on Claude (turn 1 + turn 2).
    const crossTurn = await index.search(sessions, 'quantum_entanglement sapphire_cache');
    assert.deepStrictEqual(crossTurn.sessions.map(s => s.id), [claudeId]);
    assert.strictEqual(crossTurn.sessions[0].searchMatchSource, 'content');

    // F. Metadata match ranks ahead of content match and supports custom projectNames.
    const projectNameMatch = await index.search(sessions, 'Compiler Core', {
      projectNames: { '/repo/odps_src': 'Compiler Core' },
    });
    assert.deepStrictEqual(projectNameMatch.sessions.map(s => s.id), [codexId]);
    assert.strictEqual(projectNameMatch.sessions[0].searchMatchSource, 'project');

    // G. Incremental re-indexing picks up appended transcript lines after source cache invalidation.
    fs.appendFileSync(
      codexFile,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'Verified emerald_incremental_token after appending new turn.',
        },
      }) + '\n',
    );
    index.invalidateSourceCache();
    const afterAppend = await index.search(sessions, 'emerald_incremental_token');
    assert.deepStrictEqual(afterAppend.sessions.map(s => s.id), [codexId]);
    assert(afterAppend.sessions[0].searchSnippet?.includes('emerald_incremental_token'));

    // H. Pruning removes deleted sessions from SQLite index.
    const reduced = sessions.filter(s => s.id !== piId);
    const afterPrune = await index.search(reduced, 'obsidian_telemetry');
    assert.deepStrictEqual(afterPrune.sessions, []);
    assert.strictEqual(index.getIndexedSessionCount(), 3);

    // I. Snippet builder centers excerpt and produces exact highlight ranges.
    const built = buildSearchSnippet(
      'prefix '.repeat(25) + 'critical_memory_oom_marker' + ' suffix'.repeat(25),
      ['critical_memory_oom_marker'],
      80,
    );
    assert(built.snippet.startsWith('…'));
    assert(built.snippet.endsWith('…'));
    assert.strictEqual(built.ranges.length, 1);
    assert.strictEqual(
      built.snippet.slice(built.ranges[0].start, built.ranges[0].end),
      'critical_memory_oom_marker',
    );

    // J. Corrupt SQLite DB file is cleanly recreated on next open.
    index.dispose();
    fs.writeFileSync(dbFile, 'corrupt-sqlite-header');
    const recoveredIndex = new AgentSessionSearchIndex({ dbFile });
    try {
      const recovered = await recoveredIndex.search(sessions, 'RangeHistoAlgo');
      assert.deepStrictEqual(recovered.sessions.map(s => s.id), [codexId]);
    } finally {
      recoveredIndex.dispose();
    }

    console.log('✓ AgentSessionSearchIndex SQLite FTS5, CJK hybrid, cross-turn, incremental sync, and recovery passed');
  } finally {
    index.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
