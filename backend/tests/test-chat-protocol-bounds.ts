import assert from 'node:assert/strict';
import test from 'node:test';
import { Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpSessionState } from '../acp-session-state.cts';
import { AcpRuntimeHostClient } from '../acp-runtime-host-client.cts';
import { ACP_HOST_PENDING_MAX, ACP_HOST_CONTROL_RESERVE, ACP_HOST_FRAME_MAX_BYTES } from '../../shared/chat-capacity.js';
import { projectAcpTranscriptResponse, mergeAcpTranscript } from '../../src/components/code/acp/acp-transcript-envelope';
import { acpTranscriptEntries } from '../acp-transcript.cts';

test('long-turn entry patches are bounded, revision-fenced and all older entries remain pageable', () => {
  const state = new AcpSessionState({ provider: 'claude', sessionId: 'scale-session' });
  state.beginPrompt([{ type: 'text', text: 'Synthetic long task' }]);
  for (let index = 0; index < 4342; index += 1) state.apply({ sessionId: 'scale-session', update: {
    sessionUpdate: 'tool_call', toolCallId: `tool-${index}`, title: `Tool ${index}`, status: 'completed', rawOutput: { stdout: 'x'.repeat(14_000) },
  } });
  const revision = state.revision;
  const checkpoint = state.transcriptSlice({ maxTurns: 5, entryPatches: true });
  assert.equal(checkpoint.entries.length, 257);
  const project = (slice: typeof checkpoint, fromRevision: number | null) => projectAcpTranscriptResponse({
    version: 1, agentId: 'scale-agent', sessionId: 'scale-session', runtimeEpoch: 'scale-epoch',
    fromRevision, toRevision: slice.revision, replace: !slice.delta, settled: true, hasMoreBefore: slice.hasMoreBefore,
    transcript: { ...slice, sessionId: 'scale-session', state: 'working', entries: acpTranscriptEntries(slice.entries) },
  }, 'scale-agent');
  const before = project(checkpoint, null);
  state.apply({ sessionId: 'scale-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-4341', status: 'failed' } });
  const delta = state.transcriptSlice({ maxTurns: 5, entryPatches: true, sinceRevision: revision });
  assert.equal(delta.entries.length, 1, 'one changed entry must not resend the whole turn');
  const merged = mergeAcpTranscript(before, project(delta, revision));
  assert.equal(merged.accepted, true);
  assert.equal(merged.transcript?.turns[0].processItems.at(-1)?.status, 'failed');
  assert.equal(merged.transcript?.entrySnapshot?.entries.length, 257);
  assert.equal(mergeAcpTranscript(before, project(delta, revision - 1)).needsCheckpoint, true);
  const seen = new Set(checkpoint.entryPatch?.order);
  let cursor = checkpoint.nextCursor;
  let pages = 0;
  while (cursor) {
    const older = state.transcriptSlice({ maxTurns: 5, entryPatches: true, cursor });
    assert.ok(older.entries.length <= 257);
    older.entryPatch?.order.forEach(id => seen.add(id));
    assert.notEqual(older.nextCursor, cursor);
    cursor = older.nextCursor;
    assert.ok(++pages < 30);
  }
  assert.equal(seen.size, state.entries.length);
});

test('live entry patches preserve loaded older entries and replace off-window corrections', () => {
  const state = new AcpSessionState({ provider: 'claude', sessionId: 'window-session' });
  state.beginPrompt([{ type: 'text', text: 'Long task' }]);
  for (let index = 0; index < 300; index += 1) state.apply({ sessionId: 'window-session', update: {
    sessionUpdate: 'tool_call', toolCallId: `tool-${index}`, title: `Tool ${index}`, status: 'completed',
  } });
  const project = (slice: ReturnType<typeof state.transcriptSlice>, fromRevision: number | null) => projectAcpTranscriptResponse({
    version: 1, agentId: 'window-agent', sessionId: 'window-session', runtimeEpoch: 'window-epoch',
    fromRevision, toRevision: slice.revision, replace: !slice.delta, settled: true,
    hasMoreBefore: slice.hasMoreBefore,
    transcript: { ...slice, sessionId: 'window-session', state: 'working', entries: acpTranscriptEntries(slice.entries) },
  }, 'window-agent');
  const latest = state.transcriptSlice({ maxTurns: 5, entryPatches: true });
  const older = state.transcriptSlice({ maxTurns: 10, entryPatches: true, cursor: latest.nextCursor });
  const loaded = mergeAcpTranscript(project(latest, null), project(older, null));
  assert.equal(loaded.transcript?.entrySnapshot?.order.length, 301);
  assert.equal(loaded.transcript?.hasMoreBefore, false);

  const beforeRecentUpdate = state.revision;
  state.apply({ sessionId: 'window-session', update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'tool-299', status: 'failed',
  } });
  const recentDelta = state.transcriptSlice({ maxTurns: 5, entryPatches: true, sinceRevision: beforeRecentUpdate });
  assert.equal(recentDelta.delta, true);
  const updated = mergeAcpTranscript(loaded.transcript, project(recentDelta, beforeRecentUpdate));
  assert.equal(updated.transcript?.entrySnapshot?.order.length, 301);
  assert.equal(updated.transcript?.hasMoreBefore, false);
  assert.equal(updated.transcript?.turns[0]?.processItems.at(-1)?.status, 'failed');

  const beforeOldUpdate = state.revision;
  state.apply({ sessionId: 'window-session', update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'tool-0', status: 'failed',
  } });
  const oldCorrection = state.transcriptSlice({ maxTurns: 5, entryPatches: true, sinceRevision: beforeOldUpdate });
  assert.equal(oldCorrection.delta, false, 'off-window changes must invalidate retained pages');
});

test('checkpoint encoding yields under production-shaped history and preserves exact JSON', async () => {
  const state = new AcpSessionState({ provider: 'claude', sessionId: 'snapshot-scale' });
  state.beginPrompt([{ type: 'text', text: 'Scale' }]);
  for (let index = 0; index < 4342; index += 1) state.apply({ sessionId: 'snapshot-scale', update: {
    sessionUpdate: 'tool_call', toolCallId: `tool-${index}`, title: 'Scale tool', status: 'completed', rawOutput: { stdout: 'x'.repeat(14_000) },
  } });
  let yielded = false;
  const tick = new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
  const chunks = await state.exportCheckpointChunks();
  assert.equal(yielded, true, 'input callbacks must get execution opportunities during encoding');
  await tick;
  const restored = AcpSessionState.fromCheckpoint(JSON.parse(chunks.join('')), { provider: 'claude', sessionId: 'snapshot-scale' });
  assert.equal(restored?.revision, state.revision);
  assert.equal(restored?.entries.length, 4343);
  const restoredOutput = restored?.entries.at(-1)?.rawOutput as { stdout?: string } | undefined;
  assert.equal(restoredOutput?.stdout, 'x'.repeat(14_000));
});

test('Host client retains control slots and rejects oversized unsent mutations definitively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'farming-host-budget-'));
  const client = new AcpRuntimeHostClient({ configDir: root });
  const socket = new Socket();
  let writes = 0;
  socket.write = (() => { writes += 1; return true; }) as typeof socket.write;
  client.socket = socket;
  const pending: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < ACP_HOST_PENDING_MAX - ACP_HOST_CONTROL_RESERVE; index += 1) {
      pending.push(client.request('getSession', {}, { timeoutMs: 0 }).catch(() => {}));
    }
    await assert.rejects(client.request('getSession'), /capacity exceeded/);
    const cancel = client.request('cancelTurn', {}, { timeoutMs: 0 });
    assert.equal(writes, ACP_HOST_PENDING_MAX - ACP_HOST_CONTROL_RESERVE + 1);
    client.handleMessage({ id: client.nextRequestId - 1, ok: true, result: {} });
    await cancel;
    // Free bulk capacity so the frame budget itself is exercised.
    client.handleMessage({ id: 1, ok: true, result: {} });
    const before = writes;
    await assert.rejects(client.request('submitPrompt', { prompt: 'x'.repeat(ACP_HOST_FRAME_MAX_BYTES) }), error => {
      assert.notEqual((error as { uncertain?: boolean }).uncertain, true);
      return /exceeded limit/.test(String(error));
    });
    assert.equal(writes, before);
  } finally {
    client.handleDisconnect(new Error('test cleanup'));
    await Promise.all(pending);
    await rm(root, { recursive: true, force: true });
  }
});

test('one long Turn remains bounded and every loaded entry agrees with the authoritative snapshot', () => {
  const state = new AcpSessionState({ provider: 'claude', sessionId: 'oracle-session' });
  state.beginPrompt([{ type: 'text', text: 'One long turn' }]);
  const project = (slice: ReturnType<typeof state.transcriptSlice>, fromRevision: number | null) => projectAcpTranscriptResponse({
    version: 1, agentId: 'oracle-agent', sessionId: 'oracle-session', runtimeEpoch: 'oracle-epoch',
    fromRevision, toRevision: slice.revision, replace: !slice.delta, settled: true,
    hasMoreBefore: slice.hasMoreBefore,
    transcript: { ...slice, sessionId: 'oracle-session', state: 'working', entries: acpTranscriptEntries(slice.entries) },
  }, 'oracle-agent');
  let loaded = project(state.transcriptSlice({ entryPatches: true }), null);
  const verify = () => {
    const snapshot = loaded.entrySnapshot!;
    assert.ok(snapshot.order.length <= 2048);
    assert.equal(new Set(snapshot.order).size, snapshot.order.length);
    const authoritative = new Map(acpTranscriptEntries(state.entries.map(({ _revision, ...entry }) => entry)).map(entry => [String(entry.id), entry]));
    assert.deepEqual(snapshot.entries, snapshot.order.map(id => authoritative.get(id)), 'incremental entries equal a fresh authoritative projection');
    const start = String((snapshot.session.entryPatch as { startId: string }).startId);
    const covered = snapshot.order.slice(snapshot.order.indexOf(start));
    const offset = state.entries.findIndex(entry => entry.id === start);
    assert.deepEqual(covered, state.entries.slice(offset, offset + covered.length).map(entry => entry.id), 'only the prompt anchor may precede a contiguous range');
  };
  for (let batch = 0; batch < 45; batch += 1) {
    const revision = state.revision;
    for (let index = batch * 100; index < (batch + 1) * 100; index += 1) state.apply({ sessionId: 'oracle-session', update: {
      sessionUpdate: 'tool_call', toolCallId: `oracle-${index}`, title: `Tool ${index}`, status: 'completed',
    } });
    const result = mergeAcpTranscript(loaded, project(state.transcriptSlice({ entryPatches: true, sinceRevision: revision }), revision));
    assert.equal(result.needsCheckpoint, false);
    loaded = result.transcript!;
    verify();
  }
  assert.equal(loaded.includesLatest, true);
  let pages = 0;
  while (loaded.nextCursor) {
    const previousRevision = loaded.revision;
    const page = state.transcriptSlice({ entryPatches: true, cursor: loaded.nextCursor });
    loaded = mergeAcpTranscript(loaded, project(page, null)).transcript!;
    assert.equal(loaded.revision, previousRevision);
    assert.equal(loaded.includesLatest, false, 'evicting the tail creates an explicit historical window');
    assert.notEqual(loaded.turns.at(-1)?.status, 'missingFinalReply', 'an omitted tail is not evidence of a missing reply');
    verify();
    assert.ok(++pages < 30);
  }
  assert.equal(loaded.entrySnapshot?.order[0], state.entries[0].id);
});

test('completion during page eviction preserves the historical window until explicit Return to latest', async () => {
  const pool = await import('../../src/components/code/acp/acp-transcript-session-pool');
  const previousFetch = globalThis.fetch;
  const state = new AcpSessionState({ provider: 'claude', sessionId: 'history-race' });
  state.beginPrompt([{ type: 'text', text: 'Long history' }]);
  for (let index = 0; index < 4000; index++) state.apply({ sessionId: state.sessionId, update: {
    sessionUpdate: 'tool_call', toolCallId: `history-${index}`, title: 'Tool', status: 'completed',
  } });
  const waitFor = async (predicate: () => boolean) => {
    for (let count = 0; count < 300; count++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('history race did not settle');
  };
  const urls: string[] = [];
  let returnStaleCheckpoint = false;
  let finishPage!: () => void;
  const pageGate = new Promise<void>(resolve => { finishPage = resolve; });
  globalThis.fetch = async input => {
    const url = String(input);
    urls.push(url);
    const params = new URL(url, 'http://example.test').searchParams;
    const slice = state.transcriptSlice({ entryPatches: true,
      cursor: params.get('cursor') || undefined,
      sinceRevision: params.has('sinceRevision') ? Number(params.get('sinceRevision')) : undefined,
    });
    if (urls.length === 8) await pageGate;
    if (returnStaleCheckpoint && !params.has('cursor')) slice.revision = 0;
    return new Response(JSON.stringify({
      version: 1, agentId: 'history-race-agent', sessionId: state.sessionId, runtimeEpoch: 'epoch',
      fromRevision: slice.delta ? Number(params.get('sinceRevision')) : null,
      toRevision: slice.revision, replace: !slice.delta, settled: true, hasMoreBefore: slice.hasMoreBefore,
      transcript: { ...slice, sessionId: state.sessionId, state: 'idle', entries: acpTranscriptEntries(slice.entries) },
    }));
  };
  const snapshot = () => pool.getAcpTranscriptSessionSnapshot('history-race-agent');
  try {
    const release = pool.attachAcpTranscriptSession('history-race-agent');
    await waitFor(() => snapshot().transcript !== null);
    for (let page = 1; page <= 6; page++) {
      pool.setAcpTranscriptTurnLimit('history-race-agent', 5 + page * 10);
      await waitFor(() => !snapshot().loadingOlder);
    }
    pool.setAcpTranscriptTurnLimit('history-race-agent', 75);
    await waitFor(() => urls.length === 8);
    state.completePrompt('end_turn');
    pool.observeAcpTranscriptRevision({ agentId: 'history-race-agent', sessionId: state.sessionId,
      runtimeEpoch: 'epoch', revision: state.revision, updatedAt: '' });
    finishPage();
    await waitFor(() => !snapshot().loadingOlder);
    const historical = snapshot().transcript;
    assert.equal(historical?.includesLatest, false);
    assert.equal(historical?.entrySnapshot?.order.length, 2048);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(urls.length, 8, 'a live notification must not displace historical reading');
    pool.reconnectAcpTranscriptSessions();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(snapshot().transcript, historical);
    assert.equal(urls.length, 8);
    returnStaleCheckpoint = true;
    pool.returnToLatestAcpTranscript('history-race-agent');
    await waitFor(() => snapshot().error === 'response');
    assert.equal(snapshot().transcript, historical, 'a stale checkpoint cannot regress the history cache');
    assert.equal(snapshot().loading, false);
    returnStaleCheckpoint = false;
    pool.returnToLatestAcpTranscript('history-race-agent');
    await waitFor(() => snapshot().transcript?.includesLatest === true);
    assert.equal(snapshot().transcript?.revision, state.revision);
    assert.equal(urls.length, 10);
    release();
  } finally {
    finishPage();
    pool.resetAcpTranscriptSessionPoolForTests();
    globalThis.fetch = previousFetch;
  }
});
