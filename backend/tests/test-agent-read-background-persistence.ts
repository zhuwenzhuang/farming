import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../config-manager.cjs';
import { AgentManager } from '../agent-manager.cjs';
import { FarmingSessionStore } from '../farming-session-store.cjs';
import { createTestAgentManager } from './helpers/test-acp-runtime.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { resolve, promise };
}

test('read transitions stay responsive and ordered across blocked writes, structural commits and recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-read-state-'));
  const store = new FarmingSessionStore(root);
  store.init();
  const disk = deferred();
  const entered = deferred();
  let synchronousWrites = 0;
  let failStructural = false;
  const config = new ConfigManager({ configDir: root });
  config.init();
  config.getWorkspace = () => root;
  config.ensureAgentSessionRecord = (agent, patch) => {
    synchronousWrites += 1;
    if (failStructural) throw new Error('disk unavailable');
    return store.ensureRecordForAgent(agent, patch);
  };
  config.persistAgentStatePatch = (agent, patch, options) => store.persistAgentStatePatch(agent, patch, options);
  const manager = createTestAgentManager(AgentManager, config);
  const originalWrite = store.writeJsonAsync.bind(store);
  store.writeJsonAsync = async (file, value, options) => {
    entered.resolve();
    await disk.promise;
    return originalWrite(file, value, options);
  };
  const agent = { id: 'read-owner', command: 'codex', category: 'coding', status: 'running', cwd: root,
    runtimeEpoch: 'epoch-one', attentionSeq: 3, readAttentionSeq: 2, unread: true,
    lastOutputSeq: 9, readOutputEpoch: 'epoch-one', readOutputSeq: 8, agentRecordId: '' };
  manager.agents.set(agent.id, agent);
  agent.agentRecordId = store.ensureRecordForAgent(agent);
  const deltas: unknown[] = [];
  manager.on('agent-read', delta => deltas.push(delta));
  let flush: Promise<void> | undefined;
  try {
    assert.equal(manager.updateAgentFlags(agent.id, { readAttentionSeq: 3,
      readOutputEpoch: 'epoch-one', readOutputSeq: 9 }).changed, true);
    assert.equal(synchronousWrites, 0);
    assert.equal(agent.unread, false);
    assert.equal(deltas.length, 1, 'read acknowledgement precedes persistence');
    flush = manager.sessionPersistence.flushState();
    await entered.promise;
    agent.lastOutputSeq = 10;
    manager.attentionTracker.recordAgentAttentionEvent(agent, 'turn-complete');
    manager.updateAgentFlags(agent.id, { readAttentionSeq: 3, readOutputEpoch: 'old-epoch', readOutputSeq: 100 });
    assert.equal(agent.attentionSeq, 4);
    assert.equal(agent.readAttentionSeq, 3, 'old read cannot consume new attention');
    assert.equal(agent.readOutputSeq, 9, 'wrong epoch cannot advance the output cursor');
    assert.equal(agent.unread, true);
    assert.equal(synchronousWrites, 0, 'new attention also uses the background writer');
    failStructural = true;
    assert.match(String(manager.updateAgentFlags(agent.id, { followUp: true }).error), /disk unavailable/);
    assert.equal(manager.agents.get(agent.id)?.followUp, undefined, 'failed structural change preserves live state');
    disk.resolve();
    await flush;
    await manager.sessionPersistence.flushState();
    assert.equal(store.readRecord(agent.agentRecordId)?.attentionSeq, 4);
    assert.equal(store.readRecord(agent.agentRecordId)?.unread, true);

    // A structural commit must invalidate a snapshot already waiting to publish.
    const blocked = deferred();
    const started = deferred();
    store.writeJsonAsync = async (file, value, options) => {
      started.resolve();
      await blocked.promise;
      return originalWrite(file, value, options);
    };
    manager.updateAgentFlags(agent.id, { unread: false });
    flush = manager.sessionPersistence.flushState();
    try {
      await started.promise;
      failStructural = false;
      assert.equal(manager.updateAgentFlags(agent.id, { followUp: true, unread: true }).changed, true);
    } finally {
      blocked.resolve();
      await flush;
    }
    const recovered = new FarmingSessionStore(root);
    recovered.init();
    const record = recovered.readRecord(agent.agentRecordId);
    assert.equal(record?.followUp, true);
    assert.equal(record?.unread, true, 'old read snapshot must not overwrite the structural commit');
    assert.equal(record?.readAttentionSeq, 3, 'manual unread is allowed to lower the read cursor');
    assert.equal(record?.attentionSeq, 4);

    manager.updateAgentFlags(agent.id, { unread: false });
    manager.agents.set(agent.id, { ...agent, readAttentionSeq: 0 });
    await manager.sessionPersistence.flushState();
    assert.equal(store.readRecord(agent.agentRecordId)?.unread, true, 'replaced owner cannot flush');
  } finally {
    disk.resolve();
    await flush;
    await manager.sessionPersistence.flushState();
    manager.heartbeatScheduler.stop();
    await manager.engineBridge.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
