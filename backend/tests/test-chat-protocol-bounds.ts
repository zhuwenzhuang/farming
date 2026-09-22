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
