import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpSessionState, type AcpUpdate } from '../acp-session-state.cts';
import { acpPeerPrompt } from '../acp-peer-prompt.cts';

const text = { type: 'text', text: 'Inspect the issue' };
const image = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' };
const peer = { version: 1, direction: 'incoming', senderAddress: 'peer:reviewer' } as const;
const echo = (state: AcpSessionState, content = text, extra: AcpUpdate = {}) =>
  state.applyMessageChunk({ content, ...extra }, 'user_message_chunk');
const inputs = (state: AcpSessionState) => state.entries.filter(entry => entry.role === 'user');
const interleave = (state: AcpSessionState) => {
  state.applyToolCall({ toolCallId: 'scheduled', title: 'Scheduled work', status: 'completed' }, false, null);
  state.applyMessageChunk({ content: { type: 'text', text: 'Checking' } }, 'agent_thought_chunk');
};

// Only a live admission may consume ordered first echoes. Output/Steer does not
// end that opportunity; another ordinary input, completion or exhaustion does.
for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen', 'agy']) {
  for (const messageId of ['', 'native-input']) {
    test(`${provider} first echo crosses output and Steer (${messageId || 'idless'})`, () => {
      const state = new AcpSessionState({ provider });
      const admitted = state.beginPrompt([text]);
      interleave(state);
      state.recordAcceptedSteer([{ type: 'text', text: 'Also check tests' }], { messageId: 'steer' });
      echo(state, text, { messageId });
      assert.equal(inputs(state).length, 2);
      assert.equal(admitted.messageId, messageId);
      assert.deepEqual(admitted.content, [text]);
      state.completePrompt();
      assert.ok(admitted.turnCompletedAt);
    });
  }

  for (const boundary of ['exhausted', 'different-id', 'completed', 'cancelled', 'restored', 'new-input', 'incoming-steer']) {
    test(`${provider} does not swallow equal text after ${boundary}`, () => {
      let state = new AcpSessionState({ provider });
      state.beginPrompt([text]);
      if (boundary === 'exhausted') echo(state);
      if (boundary === 'different-id') echo(state, text, { messageId: 'first' });
      if (boundary === 'completed') state.completePrompt();
      if (boundary === 'cancelled') state.completePrompt('cancelled');
      if (boundary === 'restored') state = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
      if (boundary === 'new-input') echo(state, { type: 'text', text: 'Different input' });
      const count = inputs(state).length;
      echo(state, text, {
        ...(boundary === 'different-id' ? { messageId: 'second' } : {}),
        ...(boundary === 'incoming-steer' ? { _meta: { farming: { steer: true } } } : {}),
      });
      assert.equal(inputs(state).length, count + 1);
    });
  }

  test(`${provider} consumes ordered media and peer blocks once without changing admitted content`, () => {
    for (const source of [undefined, peer]) {
      const state = new AcpSessionState({ provider });
      const content = [text, { ...image, path: '/example/image.png' }, text];
      const admitted = state.beginPrompt(content, null, source);
      for (const block of acpPeerPrompt([text, image, text], source)) {
        interleave(state);
        state.applyMessageChunk({ content: block }, 'user_message_chunk');
      }
      assert.equal(inputs(state).length, 1);
      assert.deepEqual(admitted.content, content);
      echo(state);
      assert.equal(inputs(state).length, 2, 'exhausted content cannot match again');
    }
  });

  test(`${provider} rejects out-of-order blocks and accepts joined peer text once`, () => {
    const state = new AcpSessionState({ provider });
    state.beginPrompt([image, text]);
    echo(state);
    assert.equal(inputs(state).length, 2, 'must not skip the image to match later text');
    const joined = new AcpSessionState({ provider });
    joined.beginPrompt([text], null, peer);
    const content = { type: 'text', text: acpPeerPrompt([text], peer).map(block => block.text).join('\n') };
    interleave(joined);
    echo(joined, content);
    assert.equal(inputs(joined).length, 1);
    echo(joined, content);
    assert.equal(inputs(joined).length, 2);
  });

  test(`${provider} bound identity survives checkpoint and interleaved partial chunks`, () => {
    const state = new AcpSessionState({ provider });
    state.beginPrompt([text]);
    interleave(state);
    echo(state, text, { messageId: 'bound' });
    const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
    interleave(restored);
    echo(restored, { type: 'text', text: 'partial' }, { messageId: 'bound' });
    assert.equal(inputs(restored).length, 1);
    assert.deepEqual(inputs(restored)[0].content, [text]);
  });
}

test('Antigravity transformed goal echo shares the one-time live admission boundary', () => {
  const state = new AcpSessionState({ provider: 'agy' });
  state.beginPrompt('/goal Inspect the issue');
  interleave(state);
  const transformed = { type: 'text', text: ' Inspect the issue' };
  echo(state, transformed);
  assert.equal(inputs(state).length, 1);
  echo(state, transformed);
  assert.equal(inputs(state).length, 2);
  const pending = new AcpSessionState({ provider: 'agy' });
  pending.beginPrompt('/goal Inspect the issue');
  const restored = AcpSessionState.fromCheckpoint(pending.exportCheckpoint())!;
  echo(restored, transformed);
  assert.equal(inputs(restored).length, 2, 'recovery cannot rearm content matching');
  const wrapped = new AcpSessionState({ provider: 'agy' });
  wrapped.beginPrompt('/goal Inspect the issue', null, peer);
  echo(wrapped, transformed);
  assert.equal(inputs(wrapped).length, 2, 'a command transformation cannot skip a peer envelope');
});

test('Codex attachment presentation mirrors still work independently of prompt echo admission', () => {
  const state = new AcpSessionState({ provider: 'codex' });
  state.beginPrompt([text, image]);
  echo(state, text, { messageId: 'image-input' });
  state.completePrompt();
  echo(state, { type: 'text', text: '<image>image attachment</image>' });
  assert.equal(inputs(state).length, 1);
});
