import assert from 'node:assert/strict';
import { continuesPeerMessageGroup, peerMessageTimestamp } from '../../src/components/code/acp/peer-message-layout';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AcpSessionState } from '../acp-session-state.cjs';
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection';
import { farmingClaudePeerUpdate } from '../../scripts/vendor/claude-peer-messages.mjs';
import { farmingCodexPeerUpdate, farmingCodexPeerHistory, farmingMergePeerHistory } from '../../scripts/vendor/codex-peer-messages.mjs';

async function run() {
  const source = { kind: 'peer', from: 'peer-task', fromSession: 'peer-session', name: 'Storage acceptance', body: 'Keep the transport unchanged.' };
  const claude = farmingClaudePeerUpdate({ type: 'user', uuid: 'incoming-one', origin: source, message: { content: 'native envelope' } });
  assert.equal(claude.content[0].text, source.body);
  assert.equal(farmingClaudePeerUpdate({ type: 'user', uuid: 'human', message: { content: '<agent-message from="peer">hi</agent-message>' } }), null);
  const coordinator = farmingClaudePeerUpdate({ type: 'user', uuid: 'incoming-two', origin: { kind: 'coordinator' }, parent_tool_use_id: 'child-tool', message: { content: 'Parent message' } });
  assert.equal(coordinator._meta.peerMessage.senderAddress, 'main');
  assert.equal(coordinator._meta.claudeCode.parentToolUseId, 'child-tool');
  const native = { type: 'agent_message', id: 'native-one', author: '/root/peer', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/peer\nPayload:\nHello' }] };
  const codex = farmingCodexPeerUpdate(native);
  assert.equal(codex.content[0].text, 'Hello');
  assert.equal(codex._meta.peerMessage.timestamp, undefined, 'live events without time remain untimed');
  for (const invalidTime of ['', 'invalid', ' '.repeat(81), 123]) {
    assert.equal(farmingCodexPeerUpdate(native, invalidTime)._meta.peerMessage.timestamp, undefined);
  }
  const encrypted = farmingCodexPeerUpdate({ ...native, content: [...native.content, { type: 'encrypted_content', data: 'private-ciphertext' }] });
  assert.equal(encrypted.content[0].text, '');
  assert.equal(encrypted._meta.peerMessage.bodyUnavailable, 'encrypted');
  assert(!JSON.stringify(encrypted).includes('private-ciphertext'));
  assert.equal(farmingCodexPeerUpdate({ ...native, type: 'message' }), null);
  for (const [provider, update] of [['claude', claude], ['codex', codex]] as const) {
    const state = new AcpSessionState({ provider, sessionId: 'recipient' });
    state.apply({ sessionId: 'recipient', update });
    state.apply({ sessionId: 'recipient', update });
    const renamed = { ...update, _meta: { peerMessage: { ...update._meta.peerMessage, senderName: 'New task title' } } };
    state.apply({ sessionId: 'recipient', update: renamed });
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0].role, 'user');
    assert.deepEqual(state.entries[0]._meta.peerMessage, update._meta.peerMessage);
    state.apply({ sessionId: 'recipient', update: { ...renamed, messageId: 'new-message' } });
    assert.equal(state.entries.length, 2, 'identical text with a new ID is a new receive');
    const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint());
    assert(restored);
    restored.apply({ sessionId: 'recipient', update });
    assert.equal(restored.entries.length, 2);
    const turns = projectAcpTranscript({ sessionId: 'recipient', state: 'idle', entries: restored.sanitizedEntries() }).turns;
    assert.equal(turns.length, 2);
    assert.equal(turns[0].userMessage, update.content[0].text);
    assert.equal(turns[1].userSource?.senderName, 'New task title');
    assert.equal(turns[0].status, 'completed', 'receiving does not invent a running turn');
  }
  const state = new AcpSessionState({ provider: 'codex', sessionId: 'recipient' });
  state.apply({ sessionId: 'recipient', update: encrypted });
  assert.equal(projectAcpTranscript({ sessionId: 'recipient', entries: state.sanitizedEntries() }).turns[0].userSource?.bodyUnavailable, 'encrypted');

  const peerTurn = projectAcpTranscript({ sessionId: 'recipient', entries: state.sanitizedEntries() }).turns[0];
  const first = { ...peerTurn, userSource: { ...peerTurn.userSource!, senderSessionId: 'session-a', senderName: 'Shared name' } };
  const second = { ...first, id: 'another-message' };
  assert(continuesPeerMessageGroup(first, second));
  assert(!continuesPeerMessageGroup(undefined, second), 'loaded page starts with a full source');
  assert(!continuesPeerMessageGroup(first, undefined));
  assert(!continuesPeerMessageGroup({ ...first, userSource: undefined }, second), 'human input breaks grouping');
  assert(!continuesPeerMessageGroup({ ...first, finalMessage: 'Reply' }, second), 'a reply breaks grouping');
  assert(!continuesPeerMessageGroup({ ...first, status: 'inProgress' }, second), 'active work is not a peer-only turn');
  assert(!continuesPeerMessageGroup({ ...first, stopReason: 'error' }, second), 'failure breaks grouping');
  assert(!continuesPeerMessageGroup({ ...first, processItems: [{ id: 'tool', type: 'tool', title: 'Read' }] }, second), 'tool output breaks grouping');
  assert(!continuesPeerMessageGroup(first, { ...second, userSource: { ...second.userSource, senderSessionId: 'session-b' } }), 'same name is not the same sender');
  assert(!continuesPeerMessageGroup(first, { ...second, userSource: { ...second.userSource, senderName: 'Renamed' } }), 'preserve new name snapshots');
  assert(!continuesPeerMessageGroup(first, { ...second, userSource: { ...second.userSource, senderSessionId: undefined } }), 'do not bridge known and unknown identity');
  const addressTurn = { ...first, userSource: { ...first.userSource, senderSessionId: undefined } };
  assert(continuesPeerMessageGroup(addressTurn, { ...addressTurn, id: 'next' }));
  assert(!continuesPeerMessageGroup(addressTurn, { ...addressTurn, userSource: { ...addressTurn.userSource, senderAddress: 'other' } }));
  assert(!continuesPeerMessageGroup({ ...addressTurn, userSource: { ...addressTurn.userSource, senderTaskId: 'task-a' } }, { ...addressTurn, userSource: { ...addressTurn.userSource, senderTaskId: 'task-b' } }));
  assert.equal(peerMessageTimestamp({ ...first, startedAt: null, userSource: { ...first.userSource, timestamp: undefined } }), null);
  assert.equal(peerMessageTimestamp({ ...first, startedAt: 123, userSource: { ...first.userSource, timestamp: 'invalid' } }), 123);
  assert.equal(peerMessageTimestamp({ ...first, userSource: { ...first.userSource, timestamp: '2026-01-01T10:31:00Z' } }), Date.parse('2026-01-01T10:31:00Z'));

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-peer-test-'));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await fs.mkdir(path.join(home, 'sessions'));
    const file = path.join(home, 'sessions', 'receiver.jsonl');
    const peer = { ...native, internal_chat_message_metadata_passthrough: { turn_id: 'turn-one' } };
    const receivedAt = '2026-10-11T01:38:42.883Z';
    await fs.writeFile(file, [
      { type: 'session_meta', payload: { id: 'receiver' } },
      { timestamp: receivedAt, type: 'response_item', payload: peer },
      { type: 'event_msg', payload: { type: 'item_completed', item: { id: 'answer' } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const peers = await farmingCodexPeerHistory({ id: 'receiver', path: file });
    assert.equal(peers[0].update._meta.peerMessage.timestamp, receivedAt, 'use the native rollout row time');
    const liveState = new AcpSessionState({ provider: 'codex', sessionId: 'receiver' });
    const liveSource = { ...codex._meta.peerMessage, senderName: 'Original name' };
    liveState.apply({ sessionId: 'receiver', update: { ...codex, _meta: { peerMessage: liveSource } } });
    const applyReplay = (changes = {}) => liveState.apply({ sessionId: 'receiver', update: {
      ...peers[0].update, _meta: { peerMessage: { ...peers[0].update._meta.peerMessage, senderName: 'Changed name', ...changes } },
    } });
    applyReplay({ timestamp: 'invalid' });
    applyReplay({ timestamp: ' '.repeat(81) });
    applyReplay({ senderAddress: '/root/different' });
    applyReplay({ senderSessionId: 'different-session' });
    applyReplay({ senderTaskId: 'different-task' });
    assert.deepEqual(liveState.entries[0]._meta.peerMessage, liveSource, 'invalid or different-source replay cannot enrich provenance');
    liveState.apply({ sessionId: 'receiver', update: {
      ...peers[0].update, sessionUpdate: 'session_message_chunk', content: { type: 'text', text: '' },
    } });
    assert.equal(liveState.entries[0]._meta.peerMessage.timestamp, undefined, 'chunks do not enrich receipt time');
    applyReplay();
    assert.equal(liveState.entries.length, 1);
    assert.deepEqual(liveState.entries[0]._meta.peerMessage, { ...liveSource, timestamp: receivedAt });
    applyReplay({ timestamp: '2026-10-12T01:38:42.883Z' });
    assert.equal(liveState.entries[0]._meta.peerMessage.timestamp, receivedAt, 'recorded receipt time is immutable');
    const restoredTime = AcpSessionState.fromCheckpoint(liveState.exportCheckpoint());
    assert(restoredTime);
    restoredTime.apply({ sessionId: 'receiver', update: codex });
    const restoredTurn = projectAcpTranscript({ sessionId: 'receiver', entries: restoredTime.sanitizedEntries() }).turns[0];
    assert.equal(restoredTurn.userSource?.senderName, 'Original name');
    assert.equal(peerMessageTimestamp(restoredTurn), Date.parse(receivedAt), 'checkpoint and untimed replay retain the group-tail time');
    async function* pages() { yield [{ id: 'human' }]; yield [{ id: 'answer' }]; }
    const merged = [];
    for await (const page of farmingMergePeerHistory(pages(), peers)) merged.push(...page);
    assert.deepEqual(merged.map(item => item.id), ['human', 'native-one', 'answer']);
    assert.deepEqual(await farmingCodexPeerHistory({ id: 'receiver', path: file }, new Set(['other-turn'])), []);
    await assert.rejects(farmingCodexPeerHistory({ id: 'someone-else', path: file }), /identity mismatch/);
    const outside = path.join(home, 'outside.jsonl');
    await fs.copyFile(file, outside);
    await assert.rejects(farmingCodexPeerHistory({ id: 'receiver', path: outside }), /outside/);
    await fs.symlink(outside, path.join(home, 'sessions', 'escape.jsonl'));
    await assert.rejects(farmingCodexPeerHistory({ id: 'receiver', path: path.join(home, 'sessions', 'escape.jsonl') }), /outside/);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  }
  console.log('Receive-side peer messages, attribution, checkpoint recovery and bounded history passed');
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
