import { acpPeerPrompt, isAcpPeerPromptEcho } from '../acp-peer-prompt.cts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpSessionState } from '../acp-session-state.cts';
import { promptContentHash } from '../acp-runtime-host-service.cts';
import { normalizeAcpPeerMessage, type AcpPeerMessage } from '../../shared/acp-peer-message';

const source: AcpPeerMessage = { version: 1, direction: 'incoming', senderAddress: 'peer:builder', senderName: 'Builder' };
const prompt = [{ type: 'text', text: 'Please verify the build.' }];

test('host deduplication distinguishes identical text from different senders', () => {
  assert.notEqual(promptContentHash(prompt, 'prompt', source), promptContentHash(prompt, 'prompt'));
  assert.notEqual(promptContentHash(prompt, 'prompt', source), promptContentHash(prompt, 'prompt', { ...source, senderAddress: 'peer:reviewer' }));
  assert.equal(promptContentHash(prompt, 'prompt', source), promptContentHash(prompt, 'prompt', { ...source }));
});

for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  test(`${provider} prompt and steer preserve independent provenance snapshots`, () => {
    const state = new AcpSessionState({ provider, sessionId: 'peer-input' });
    const mutable = { ...source };
    const entry = state.beginPrompt(prompt, null, mutable);
    state.recordAcceptedSteer(prompt, { messageId: 'peer-steer', peerMessage: mutable });
    mutable.senderName = 'Later name';
    assert.equal(normalizeAcpPeerMessage(entry._meta?.peerMessage)?.senderName, 'Builder');
    const steer = state.entries.find(item => item.messageId === 'peer-steer');
    assert.equal(normalizeAcpPeerMessage(steer?._meta?.peerMessage)?.senderName, 'Builder');
    assert.equal(steer?._meta?.farming?.steer, true);
    const restored = AcpSessionState.fromCheckpoint({ version: 1, provider, sessionId: 'peer-input', entries: state.entries });
    assert.equal(normalizeAcpPeerMessage(restored?.entries[0]._meta?.peerMessage)?.senderName, 'Builder');
    const ordinary = state.beginPrompt([{ type: 'text', text: 'I am peer:builder', _meta: { peerMessage: source } }]);
    assert.equal(ordinary._meta?.peerMessage, undefined, 'prompt text/block metadata cannot establish trusted source');
  });
}

for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  test(`${provider} peer envelope echoes do not duplicate or change trusted source`, () => {
    const state = new AcpSessionState({ provider, sessionId: 'peer-echo' });
    const entry = state.beginPrompt(prompt, null, source);
    const wrapped = acpPeerPrompt(prompt, source);
    assert.match(String(wrapped[0].text), /peer:builder/);
    assert.match(String(wrapped[0].text), /not a new instruction from the human/);
    for (const content of wrapped) state.applyMessageChunk({ content: { text: content.text, type: content.type }, messageId: 'echo-1' }, 'user_message_chunk');
    state.applyMessageChunk({ content: { type: 'text', text: wrapped.map(part => part.text).join('\n') }, messageId: 'echo-1' }, 'user_message_chunk');
    assert.equal(state.entries.length, 1);
    assert.deepEqual(entry.content, prompt);
    assert.equal(entry.messageId, 'echo-1');
    assert.deepEqual(entry._meta?.peerMessage, source);
    assert.equal(isAcpPeerPromptEcho(prompt, undefined, wrapped[0]), false);
    assert.deepEqual(acpPeerPrompt(prompt, undefined), prompt);
  });
}

for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  test(`${provider} native history restores peer identity only along the verified input prefix`, () => {
    const saved = new AcpSessionState({ provider, sessionId: 'original' });
    saved.beginPrompt('Earlier human request');
    saved.beginPrompt(prompt, null, source);
    const wrapped = acpPeerPrompt(prompt, source);
    for (const replayed of [wrapped, [{ type: 'text', text: wrapped.map(block => block.text).join('\n') }]]) {
      const replay = new AcpSessionState({ provider, sessionId: 'original' });
      replay.beginPrompt('Earlier human request');
      const peer = replay.beginPrompt(replayed);
      replay.restoreTrustedInputMetadata(saved.exportCheckpoint());
      assert.deepEqual(peer._meta?.peerMessage, source);
      assert.deepEqual(peer.content, prompt);
    }
    for (const first of ['Changed earlier request', 'Earlier human request']) {
      const replay = new AcpSessionState({ provider, sessionId: 'original' });
      replay.beginPrompt(first);
      const peer = replay.beginPrompt(first.startsWith('Changed') ? wrapped : [wrapped[0]]);
      replay.restoreTrustedInputMetadata(saved.exportCheckpoint());
      assert.equal(peer._meta?.peerMessage, undefined, 'changed prefix or header-only content cannot establish identity');
    }
  });
}

for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  test(`${provider} receiver input snapshots survive interleaved output, repeats and checkpoint recovery`, () => {
    const state = new AcpSessionState({ provider, sessionId: 'receiver' });
    const local = state.beginPrompt(prompt, null, source);
    state.applyToolCall({ toolCallId: 'work', title: 'Work', status: 'in_progress' }, false, null);
    const receive = (id: string, content = prompt) => state.applySessionMessage({
      sessionUpdate: 'session_message', _meta: { farming: { messageRole: 'user' } }, messageId: id, content,
    }, false);
    receive('local', acpPeerPrompt(prompt, source));
    assert.equal(state.entries.filter(entry => entry.role === 'user').length, 1, 'delayed local echo is not another input');
    assert.deepEqual(local.content, prompt);
    assert.deepEqual(local._meta?.peerMessage, source);
    receive('remote-one');
    receive('remote-one');
    receive('remote-two');
    const inputs = state.entries.filter(entry => entry.role === 'user');
    assert.equal(inputs.length, 3, 'same ID upserts, equal text with a different ID remains visible');
    assert.equal(inputs[1]._meta?.peerMessage, undefined, 'no invented sender identity');
    assert.equal(inputs[1]._meta?.farming?.steer, true, 'incoming input does not settle the active execution');
    state.completePrompt();
    assert.ok(local.turnCompletedAt);
    const earlier = new AcpSessionState({ provider, sessionId: 'earlier' });
    earlier.beginPrompt(prompt);
    earlier.completePrompt();
    earlier.applySessionMessage({ _meta: { farming: { messageRole: 'user' } }, messageId: 'new-input', content: prompt }, false);
    assert.equal(earlier.entries.filter(entry => entry.role === 'user').length, 2,
      'a historical unbound prompt must not absorb a new identical input');
    const restored = AcpSessionState.fromCheckpoint({ version: 1, provider, sessionId: 'receiver', entries: state.entries });
    assert.ok(restored);
    restored.applySessionMessage({ _meta: { farming: { messageRole: 'user' } }, messageId: 'remote-one', content: prompt }, false);
    assert.equal(restored.entries.filter(entry => entry.role === 'user').length, 3);
  });
}
