const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AcpCheckpointStore } = require('../acp-checkpoint-store.cjs');
const { AcpSessionState } = require('../acp-session-state.cjs');

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

    // Hold the snapshot lane: an already durable dirty fence must not wait for it.
    await store.markDirty(identity);
    let releaseWrite!: () => void;
    const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const blocked = store.enqueue(store.paths(identity).key, () => gate);
    try {
      let dirtyResolved = false;
      void store.markDirty(identity).then(() => { dirtyResolved = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert(dirtyResolved, 'repeat admission must not queue behind a large inexact snapshot');

      let exported = 0;
      for (let i = 0; i < 4; i++) {
        store.schedule(identity, { exportCheckpoint: () => { exported++; return { latest: i }; } });
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      releaseWrite();
      await blocked;
      await store.flush();
      assert.strictEqual(exported, 1, 'background snapshots coalesce to one latest state while writing');
      assert.strictEqual((await store.load(identity, { allowDirty: true })).state.latest, 3);
    } finally {
      releaseWrite();
      await blocked;
    }

    // An exact rewrite invalidates the old proof at enqueue, before it can clear it.
    let releaseExact!: () => void;
    const exactGate = new Promise<void>(resolve => { releaseExact = resolve; });
    const beforeExact = store.enqueue(store.paths(identity).key, () => exactGate);
    const exactWrite = store.write(identity, restored, { exact: true });
    let fenced = false;
    const newFence = store.markDirty(identity).then(() => { fenced = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(fenced, false, 'a queued exact write requires a new ordered dirty fence');
    } finally {
      releaseExact();
      await Promise.all([beforeExact, exactWrite, newFence]);
    }
    assert.strictEqual(await store.load(identity), null, 'an exact write cannot erase a later admission fence');

    const failedStore = new AcpCheckpointStore(root);
    const blockedDirectory = path.join(root, 'not-a-directory');
    fs.writeFileSync(blockedDirectory, 'block checkpoint creation');
    failedStore.dir = blockedDirectory;
    try {
      await assert.rejects(failedStore.markDirty(identity));
      fs.unlinkSync(blockedDirectory);
      await failedStore.markDirty(identity);
      assert(fs.existsSync(failedStore.paths(identity).dirty), 'failed writes must not cache a successful dirty proof');
    } finally {
      await failedStore.dispose();
    }

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
