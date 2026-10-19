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

// Model: admission, chunk echo and complete snapshot share one message identity.
// Any order must converge to one trusted input; a different ID remains independent.
for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  for (const owner of ['snapshot', 'admission', 'chunk-then-snapshot'] as const) {
    test(`${provider} ${owner} input owns its body over fragmented late echoes`, () => {
      const state = new AcpSessionState({ provider, sessionId: 'fragmented-echo' });
      const chunk = (text: string) => state.applyMessageChunk({
        messageId: 'input-1', content: { type: 'text', text },
      }, 'user_message_chunk');
      if (owner === 'admission') state.recordAcceptedSteer(prompt, { messageId: 'input-1', peerMessage: source });
      else {
        if (owner === 'chunk-then-snapshot') chunk('Please');
        state.applySessionMessage({
          messageId: 'input-1', content: prompt, _meta: { farming: { messageRole: 'user' } },
        }, false);
      }
      // Recovery and interleaved tool output must not affect identity matching.
      const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
      restored.applyToolCall({ toolCallId: 'work', title: 'Work', status: 'in_progress' }, false, null);
      for (const text of ['Please ', 'verify the build.']) restored.applyMessageChunk({
        messageId: 'input-1', content: { type: 'text', text },
      }, 'user_message_chunk');
      const inputs = restored.entries.filter(entry => entry.role === 'user');
      assert.equal(inputs.length, 1);
      assert.deepEqual(inputs[0].content, prompt);
      restored.applyMessageChunk({ messageId: 'input-2', content: prompt[0] }, 'user_message_chunk');
      assert.equal(restored.entries.filter(entry => entry.role === 'user').length, 2);
    });
  }
}

for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  for (const order of ['ack-first', 'snapshot-first', 'chunk-first'] as const) {
    test(`${provider} steer ${order} converges by identity across recovery`, () => {
      const state = new AcpSessionState({ provider, sessionId: 'steer-echo' });
      state.beginPrompt('Keep working');
      const receive = () => state.applySessionMessage({
        _meta: { farming: { messageRole: 'user' } }, messageId: 'steer-1', content: acpPeerPrompt(prompt, source),
      }, false);
      const ack = () => state.recordAcceptedSteer(prompt, { messageId: 'steer-1', turnId: 'turn-1', peerMessage: source });
      const chunk = () => {
        for (const content of acpPeerPrompt(prompt, source)) state.applyMessageChunk({
          content, messageId: 'steer-1', _meta: { codex: { steer: true } },
        }, 'user_message_chunk');
      };
      if (order === 'ack-first') { ack(); chunk(); receive(); }
      if (order === 'snapshot-first') { receive(); chunk(); ack(); }
      if (order === 'chunk-first') { chunk(); receive(); ack(); }
      receive();
      const inputs = state.entries.filter(entry => entry.role === 'user');
      assert.equal(inputs.length, 2);
      assert.deepEqual(inputs[1].content, prompt);
      assert.deepEqual(inputs[1]._meta?.peerMessage, source);
      assert.equal(inputs[1]._meta?.farming?.steer, true);
      assert.ok(inputs[1].createdAt);
      assert.equal(state.recordAcceptedSteer(prompt, { messageId: 'steer-1', peerMessage: source }), false);
      const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
      restored.applySessionMessage({ _meta: { farming: { messageRole: 'user' } }, messageId: 'steer-1', content: prompt }, false);
      assert.equal(restored.entries.filter(entry => entry.role === 'user').length, 2);
      restored.recordAcceptedSteer(prompt, { messageId: 'steer-2', peerMessage: source });
      assert.equal(restored.entries.filter(entry => entry.role === 'user').length, 3, 'equal text with distinct identity is retained');
    });
  }
}

// Model: an active, unbound local admission may acquire its native identity
// only after the entire ordered body matches. Inline media bytes own content;
// local attachment locators are transport metadata. Bound IDs stay independent.
for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  test(`${provider} image input snapshot reconciles local attachment locators`, () => {
    const content = [
      { type: 'text', text: 'Inspect the timing and icon.' },
      { type: 'image', mimeType: 'image/webp', data: 'Zmlyc3Q=', path: '/example/first.webp', uri: 'file:///example/first.webp' },
      { type: 'image', mimeType: 'image/webp', data: 'c2Vjb25k', path: '/example/second.webp', uri: 'file:///example/second.webp' },
    ];
    const echoed = content.map(({ path: _path, uri: _uri, ...block }) => block);
    const state = new AcpSessionState({ provider, sessionId: 'attachment-echo' });
    const local = state.beginPrompt(content);
    state.applyToolCall({ toolCallId: 'work', title: 'Work', status: 'in_progress' }, false, null);
    const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
    const receive = (messageId: string, body = echoed) => restored.applySessionMessage({
      messageId, content: body, _meta: { farming: { messageRole: 'user' } },
    }, false);
    receive('native-input');
    receive('native-input');
    const inputs = restored.entries.filter(entry => entry.role === 'user');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].id, local.id);
    assert.equal(inputs[0].messageId, 'native-input');
    assert.deepEqual(inputs[0].content, content, 'retain local attachments and admitted body');
    assert.equal(inputs[0]._meta?.farming?.steer, undefined);
    receive('other-input');
    assert.equal(restored.entries.filter(entry => entry.role === 'user').length, 2);
  });
}

test('attachment reconciliation rejects different bytes, order, MIME, text and unverified locators', () => {
  const original = [{ type: 'text', text: 'Inspect.' },
    { type: 'image', mimeType: 'image/png', data: 'Zmlyc3Q=', path: '/example/a.png', uri: 'file:///example/a.png' }];
  for (const content of [
    [{ type: 'text', text: 'Changed.' }, { type: 'image', mimeType: 'image/png', data: 'Zmlyc3Q=' }],
    [{ type: 'text', text: 'Inspect.' }, { type: 'image', mimeType: 'image/png', data: 'b3RoZXI=' }],
    [{ type: 'text', text: 'Inspect.' }, { type: 'image', mimeType: 'image/jpeg', data: 'Zmlyc3Q=' }],
    [{ type: 'image', mimeType: 'image/png', data: 'Zmlyc3Q=' }, { type: 'text', text: 'Inspect.' }],
    [{ type: 'text', text: 'Inspect.' }, { type: 'image', mimeType: 'image/png', uri: 'file:///example/a.png' }],
  ]) {
    const state = new AcpSessionState({ provider: 'codex', sessionId: 'distinct-attachment' });
    state.beginPrompt(original);
    state.applySessionMessage({ messageId: 'different', content, _meta: { farming: { messageRole: 'user' } } }, false);
    assert.equal(state.entries.filter(entry => entry.role === 'user').length, 2);
  }
});

for (const type of ['image', 'audio']) {
  test(`${type}-only echoes and peer history retain trusted input across transport conversion`, () => {
    const content = [{ type, mimeType: type === 'image' ? 'image/png' : 'audio/wav', data: 'bWVkaWE=',
      path: '/example/media', uri: 'file:///example/media' }];
    const echo = [{ type, mimeType: content[0].mimeType, data: content[0].data }];
    const state = new AcpSessionState({ provider: 'codex', sessionId: 'media-only' });
    const local = state.beginPrompt(content);
    state.applyMessageChunk({ messageId: 'native', content: echo[0] }, 'user_message_chunk');
    state.applySessionMessage({ messageId: 'native', content: echo, _meta: { farming: { messageRole: 'user' } } }, false);
    assert.equal(state.entries.length, 1);
    assert.deepEqual(local.content, content);
    const peer = new AcpSessionState({ provider: 'codex', sessionId: 'peer-media' });
    peer.beginPrompt(content, null, source);
    peer.applyToolCall({ toolCallId: 'work', title: 'Work', status: 'in_progress' }, false, null);
    peer.applySessionMessage({ messageId: 'peer-native', content: acpPeerPrompt(echo, source),
      _meta: { farming: { messageRole: 'user' } } }, false);
    assert.equal(peer.entries.filter(entry => entry.role === 'user').length, 1);
    const replay = new AcpSessionState({ provider: 'codex', sessionId: 'peer-media' });
    const replayed = replay.beginPrompt(acpPeerPrompt(echo, source));
    replay.restoreTrustedInputMetadata(peer.exportCheckpoint());
    assert.deepEqual(replayed._meta?.peerMessage, source);
    assert.deepEqual(replayed.content, content);
  });
}

for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  test(`${provider} failed replay retains trusted provenance through checkpoint replacement`, async () => {
    const original = new AcpSessionState({ provider, sessionId: 'durable-peer' });
    original.beginPrompt('Original human prefix');
    original.beginPrompt(prompt, null, source);
    const wrapped = acpPeerPrompt(prompt, source);
    const failed = new AcpSessionState({ provider, sessionId: 'durable-peer' });
    failed.beginPrompt('Provider changed prefix');
    const unresolved = failed.beginPrompt(wrapped);
    failed.restoreTrustedInputMetadata(original.exportCheckpoint());
    assert.equal(unresolved._meta?.peerMessage, undefined);
    const checkpoint = JSON.parse((await failed.exportCheckpointChunks()).join(''));
    assert.equal(checkpoint.trustedInputPrefixes.length, 1);
    const restarted = AcpSessionState.fromCheckpoint(checkpoint)!;
    const failedAgain = new AcpSessionState({ provider, sessionId: 'durable-peer' });
    failedAgain.beginPrompt('Provider changed prefix');
    failedAgain.beginPrompt(wrapped);
    failedAgain.restoreTrustedInputMetadata(restarted.exportCheckpoint());
    assert.equal(failedAgain.exportCheckpoint().trustedInputPrefixes?.length, 1);
    const repaired = new AcpSessionState({ provider, sessionId: 'durable-peer' });
    repaired.beginPrompt('Original human prefix');
    const recovered = repaired.beginPrompt(wrapped);
    repaired.restoreTrustedInputMetadata(failedAgain.exportCheckpoint());
    assert.deepEqual(recovered._meta?.peerMessage, source);
    assert.deepEqual(recovered.content, prompt);
    assert.equal(repaired.exportCheckpoint().trustedInputPrefixes, undefined);
  });
}

test('partial replay does not retain duplicate histories as provider entry identities change', () => {
  const original = new AcpSessionState({ provider: 'agy', sessionId: 'partial-peer' });
  original.beginPrompt('first human');
  original.beginPrompt(prompt, null, source);
  original.beginPrompt('second human');
  original.beginPrompt([{ type: 'text', text: 'Second peer input' }], null, source);
  let checkpoint = original.exportCheckpoint();
  let retainedBytes = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const replay = new AcpSessionState({ provider: 'agy', sessionId: 'partial-peer' });
    replay.beginPrompt('first human');
    const firstPeer = replay.beginPrompt(acpPeerPrompt(prompt, source));
    replay.beginPrompt('Changed second human');
    replay.beginPrompt(acpPeerPrompt([{ type: 'text', text: 'Second peer input' }], source));
    for (const entry of replay.entries) entry.id = `${attempt}-${entry.id}`;
    replay.restoreTrustedInputMetadata(checkpoint);
    assert.deepEqual(firstPeer._meta?.peerMessage, source);
    checkpoint = replay.exportCheckpoint();
    assert.equal(checkpoint.trustedInputPrefixes?.length, 1);
    const bytes = JSON.stringify(checkpoint.trustedInputPrefixes).length;
    if (attempt === 0) retainedBytes = bytes;
    else assert.equal(bytes, retainedBytes, 'replay generations must not accumulate retained evidence');
  }
});
