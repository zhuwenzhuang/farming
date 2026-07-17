const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AcpCheckpointStore } = require('../acp-checkpoint-store');
const { AcpSessionState } = require('../acp-session-state');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-checkpoint-'));
  const identity = {
    provider: 'codex',
    providerHomeId: 'default',
    sessionId: 'checkpoint-session',
    cwd: root,
  };
  const store = new AcpCheckpointStore(root, { writeDelayMs: 0 });
  try {
    const state = new AcpSessionState({ ...identity });
    state.apply({
      sessionId: identity.sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-1',
        content: { type: 'text', text: 'Keep the exact ordered history' },
      },
    });
    state.apply({
      sessionId: identity.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Large tool',
        status: 'completed',
        rawOutput: { stdout: 'x'.repeat(64 * 1024) },
      },
    });
    await store.write(identity, state, { exact: true });
    const saved = await store.load(identity);
    assert(saved?.exact, 'an exact checkpoint should be resumable');
    const restored = AcpSessionState.fromCheckpoint(saved.state, identity);
    assert(restored, 'the reducer checkpoint should restore');
    assert.strictEqual(restored.revision, state.revision);
    assert.strictEqual(restored.entries[0].content[0].text, 'Keep the exact ordered history');
    assert.strictEqual(restored.toolEntries.get('tool-1').rawOutput.stdout.length, 64 * 1024);

    store.schedule(identity, state, { exact: true });
    await store.markDirty(identity);
    assert.strictEqual(await store.load(identity), null, 'dirty checkpoints must never skip ACP history replay');
    const dirty = await store.load(identity, { allowDirty: true });
    assert.strictEqual(dirty?.exact, false);

    await store.write(identity, restored, { exact: true });
    assert.strictEqual((await store.load(identity))?.exact, true, 'an atomic exact rewrite should clear the dirty fence');
    assert.strictEqual(await store.load({ ...identity, providerHomeId: 'other' }), null, 'Agent Home is part of checkpoint identity');

    restored.apply({
      sessionId: identity.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'answer-1',
        content: { type: 'text', text: 'Restored' },
      },
    });
    store.schedule(identity, restored, { exact: true });
    await store.flush();
    const latest = AcpSessionState.fromCheckpoint((await store.load(identity)).state, identity);
    assert.strictEqual(latest.entries.at(-1).content[0].text, 'Restored');
  } finally {
    await store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('ACP checkpoint store tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
