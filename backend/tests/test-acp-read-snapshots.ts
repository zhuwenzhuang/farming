import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { AcpRuntimeHostProcess } = require('../acp-runtime-host-process.cts');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-read-snapshots-'));
  let epoch = 'epoch-1';
  let sessionId = 'session-1';
  const runtime = Object.assign(new EventEmitter(), {
    bindingEpoch: () => epoch,
    getSession: () => ({ sessionId }),
    dispose: async () => {},
  });
  const host = new AcpRuntimeHostProcess({ configDir: root, runtime, exitOnShutdown: false });
  const client = { disconnected: false };
  const other = { disconnected: false };
  let content = 'abcdef';
  let projections = 0;
  const create = async () => { projections += 1; return { data: content, metadata: { totalChars: content.length } }; };
  const first = (owner = client, extra = {}) => host.readSnapshotPage(owner, 'detail', { agentId: 'a', offset: 0, ...extra }, 2, 'text', create);
  const next = (readId: string, offset: number, owner = client, extra = {}) => host.readSnapshotPage(owner, 'detail', { agentId: 'a', readId, offset, ...extra }, 2, 'text', create);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const a = await first();
    content = 'uvwxyz';
    const b = await first();
    assert.notEqual(a.readId, b.readId, 'concurrent reads have independent snapshots');
    assert.equal((await next(a.readId, 2)).text, 'cd', 'live mutations cannot change an admitted snapshot');
    assert.equal((await next(b.readId, 2)).text, 'wx');
    await assert.rejects(next(a.readId, 4, other), /unavailable/);
    assert.equal((await next(a.readId, 4)).text, 'ef');
    assert.equal((await next(b.readId, 4)).text, 'yz');
    assert.equal(projections, 2, 'one projection per read regardless of page count');
    assert.equal(host.readSnapshotBytes, 0);
    await assert.rejects(next(a.readId, 4), /unavailable/, 'completed reads cannot be replayed');
    await assert.rejects(next('', 2), /requires a read snapshot/);

    const wrongOffset = await first();
    await assert.rejects(next(wrongOffset.readId, 3), /offset changed/);
    const wrongTool = await first();
    await assert.rejects(next(wrongTool.readId, 2, client, { toolCallId: 'other' }), /identity/);
    const stale = await first();
    epoch = 'epoch-2';
    await assert.rejects(next(stale.readId, 2), /identity/);
    const switched = await first();
    sessionId = 'session-2';
    await assert.rejects(next(switched.readId, 2), /identity/);
    assert.equal(host.readSnapshots.size, 0);

    const expired = await first();
    mock.timers.tick(30_000);
    assert.equal(host.readSnapshotBytes, 0, 'expiration releases memory without another request');
    await assert.rejects(next(expired.readId, 2), /unavailable/);
    for (let i = 0; i < 32; i++) await first();
    await assert.rejects(first(), /capacity/);
    host.removeClient(client);
    assert.equal(host.readSnapshots.size, 0, 'disconnect releases exactly the client reads');
    assert.equal(host.readSnapshotBytes, 0);
    client.disconnected = false;
    host.cancelIdleExit();

    const large = 'x'.repeat(33 * 1024 * 1024);
    const largeRead = () => host.readSnapshotPage(client, 'detail', { agentId: 'a' }, 2, 'text', async () => ({ data: large, metadata: {} }));
    await largeRead();
    await assert.rejects(largeRead(), /capacity/, 'aggregate byte budget is enforced');
    mock.timers.tick(30_000);
    await assert.rejects(host.readSnapshotPage(client, 'detail', { agentId: 'a' }, 2, 'text', async () => {
      epoch = 'epoch-3';
      return { data: 'changed while projecting', metadata: {} };
    }), /identity changed/);
    await first();
    let finishProjection: (() => void) | undefined;
    const projectionBarrier = new Promise<void>(resolve => { finishProjection = resolve; });
    const pendingRead = host.readSnapshotPage(client, 'detail', { agentId: 'a' }, 2, 'text', async () => {
      await projectionBarrier;
      return { data: 'late projection', metadata: {} };
    });
    const rejectedRead = assert.rejects(pendingRead, /identity changed/);
    await host.dispose();
    finishProjection?.();
    await rejectedRead;
    await assert.rejects(first(), /shutting down/);

    assert.equal(host.readSnapshots.size, 0);
    assert.equal(host.readSnapshotBytes, 0);
    console.log('test-acp-read-snapshots passed');
  } finally {
    await host.dispose();
    mock.timers.reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
