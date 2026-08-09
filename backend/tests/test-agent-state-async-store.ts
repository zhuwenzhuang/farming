const assert = require('assert');
const { encodeProviderSessionKey } = require('../../shared/provider-session-identity.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ConfigManager } = require('../config-manager.cjs');
const { FarmingSessionStore } = require('../farming-session-store.cjs');

interface AgentStateTestRecord extends Record<string, unknown> {
  acpFinalizedTurnHandle: string;
  agentRecordId?: string;
  attentionSeq: number;
  id: string;
  persistentSessionId?: string;
  providerSessionKey: string;
  readAttentionSeq: number;
}

function assertCommitted(
  result: {
    status: string;
    id?: string;
    commit?: { metadataGeneration: number; stateGeneration: number };
  },
  id: string,
) {
  assert.strictEqual(result.status, 'committed');
  assert.strictEqual(result.id, id);
  assert(Number.isInteger(result.commit?.metadataGeneration));
  assert(Number.isInteger(result.commit?.stateGeneration));
  return result.commit as { metadataGeneration: number; stateGeneration: number };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-state-async-'));
  try {
    const store = new FarmingSessionStore(root);
    store.init();
    const agent: AgentStateTestRecord = {
      id: 'runtime-agent-state-async',
      command: 'codex',
      cwd: root,
      projectWorkspace: root,
      providerSessionProvider: 'codex',
      providerSessionId: 'state-async-session',
      providerSessionKey: encodeProviderSessionKey('codex', 'state-async-session', 'default'),
      providerSessionTemporary: false,
      runtimeBinding: {
        kind: 'acp',
        state: 'idle',
        stopReason: 'end_turn',
      },
      acpFinalizedTurnHandle: '',
      attentionSeq: 0,
      readAttentionSeq: 0,
    };
    const recordId = store.ensureRecordForAgent(agent, { archived: false });
    assert(recordId);
    agent.agentRecordId = recordId;
    agent.persistentSessionId = recordId;

    const productionWriteJsonAsync = store.writeJsonAsync.bind(store);
    let releaseFirstWrite: () => void = () => {};
    const firstWriteGate = new Promise<void>(resolve => {
      releaseFirstWrite = resolve;
    });
    let observeFirstWrite: () => void = () => {};
    const firstWriteStarted = new Promise<void>(resolve => {
      observeFirstWrite = resolve;
    });
    let firstWrite = true;
    store.writeJsonAsync = async (file, value, options) => {
      if (firstWrite) {
        firstWrite = false;
        observeFirstWrite();
        await firstWriteGate;
      }
      return productionWriteJsonAsync(file, value, options);
    };

    agent.acpFinalizedTurnHandle = 'binding-1:1';
    agent.attentionSeq = 1;
    const persistence = store.persistAgentStatePatch(agent, {
      acpFinalizedTurnHandle: agent.acpFinalizedTurnHandle,
      attentionSeq: agent.attentionSeq,
    });
    await firstWriteStarted;
    let eventLoopAdvanced = false;
    setImmediate(() => {
      eventLoopAdvanced = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(eventLoopAdvanced, true, 'Agent state fsync must not block the Server event loop');

    const generationBeforeSyncCommit = store.stateWriteGenerations.get(recordId) || 0;
    agent.readAttentionSeq = 1;
    store.ensureRecordForAgent(agent);
    assert(
      (store.stateWriteGenerations.get(recordId) || 0) > generationBeforeSyncCommit,
      'a direct state commit must invalidate an in-flight asynchronous snapshot',
    );
    releaseFirstWrite();
    const firstCommit = assertCommitted(await persistence, recordId);
    assert.strictEqual(store.isAgentStateCommitCurrent(agent, recordId, firstCommit), true);
    assert.strictEqual(store.readRecord(recordId).acpFinalizedTurnHandle, 'binding-1:1');
    assert.strictEqual(store.readRecord(recordId).readAttentionSeq, 1);

    store.writeRecord({
      ...store.readRecord(recordId),
      id: recordId,
      composerCommands: [{ requestId: 'disk-only-command', state: 'accepted' }],
    });
    assertCommitted(await store.persistAgentStatePatch(agent, { attentionSeq: 2 }), recordId);
    assert.strictEqual(
      store.isAgentStateCommitCurrent(agent, recordId, firstCommit),
      false,
      'a newer full state write must invalidate an already returned commit token',
    );
    assert.deepStrictEqual(
      store.readRecord(recordId).composerCommands,
      [{ requestId: 'disk-only-command', state: 'accepted' }],
      'a scoped state patch must preserve fields owned by other persistence paths',
    );

    store.writeJsonAsync = productionWriteJsonAsync;
    const synchronousCalls = { fdatasync: 0, open: 0, read: 0, rename: 0, write: 0 };
    const originalFdatasyncSync = fs.fdatasyncSync;
    const originalOpenSync = fs.openSync;
    const originalReadFileSync = fs.readFileSync;
    const originalRenameSync = fs.renameSync;
    const originalWriteFileSync = fs.writeFileSync;
    fs.fdatasyncSync = (...args) => {
      synchronousCalls.fdatasync += 1;
      return originalFdatasyncSync(...args);
    };
    fs.openSync = (...args) => {
      synchronousCalls.open += 1;
      return originalOpenSync(...args);
    };
    fs.readFileSync = (...args) => {
      synchronousCalls.read += 1;
      return originalReadFileSync(...args);
    };
    fs.renameSync = (...args) => {
      synchronousCalls.rename += 1;
      return originalRenameSync(...args);
    };
    fs.writeFileSync = (...args) => {
      synchronousCalls.write += 1;
      return originalWriteFileSync(...args);
    };
    agent.attentionSeq = 4;
    try {
      assertCommitted(
        await store.persistAgentStatePatch(agent, { attentionSeq: agent.attentionSeq }),
        recordId,
      );
    } finally {
      fs.fdatasyncSync = originalFdatasyncSync;
      fs.openSync = originalOpenSync;
      fs.readFileSync = originalReadFileSync;
      fs.renameSync = originalRenameSync;
      fs.writeFileSync = originalWriteFileSync;
    }
    assert.deepStrictEqual(synchronousCalls, { fdatasync: 0, open: 0, read: 0, rename: 1, write: 0 });

    store.providerSessionRecords.delete(agent.providerSessionKey);
    agent.attentionSeq = 5;
    assert.deepStrictEqual(
      await store.persistAgentStatePatch(agent, { attentionSeq: agent.attentionSeq }),
      { status: 'record-missing' },
    );
    assert.strictEqual(store.readRecord(recordId).attentionSeq, 4);
    store.providerSessionRecords.set(agent.providerSessionKey, 'fsess_legacy_state');
    assert.deepStrictEqual(
      await store.persistAgentStatePatch(agent, { attentionSeq: agent.attentionSeq }),
      { status: 'legacy-record' },
      'only an indexed legacy record may request the synchronous compatibility path',
    );
    store.providerSessionRecords.set(agent.providerSessionKey, recordId);
    assert.deepStrictEqual(
      await store.persistAgentStatePatch(
        agent,
        { attentionSeq: agent.attentionSeq },
        { beforeCommit: () => false },
      ),
      { status: 'fenced' },
      'a caller ownership fence must cancel publication',
    );
    assert.strictEqual(store.readRecord(recordId).attentionSeq, 4);

    const ownedRecord = store.readRecord(recordId);
    store.writeRecord({ ...ownedRecord, id: recordId, runtimeAgentId: 'replacement-runtime-owner' });
    assert.deepStrictEqual(
      await store.persistAgentStatePatch(agent, { attentionSeq: 6 }),
      { status: 'owner-mismatch' },
      'runtime ownership loss must never fall back to another state write',
    );
    store.writeRecord({ ...store.readRecord(recordId), id: recordId, runtimeAgentId: agent.id });

    let conflictAttempts = 0;
    store.writeJsonAsync = async () => {
      conflictAttempts += 1;
      return false;
    };
    await assert.rejects(
      store.persistAgentStatePatch(agent, { attentionSeq: agent.attentionSeq }),
      /state persistence exceeded the conflict retry limit/,
    );
    assert.strictEqual(conflictAttempts, 8);
    store.writeJsonAsync = productionWriteJsonAsync;

    const configRoot = path.join(root, 'config-manager');
    const configManager = new ConfigManager({ configDir: configRoot });
    configManager.init();
    const configAgent = {
      ...agent,
      id: 'runtime-agent-config-state',
      providerSessionId: 'config-state-session',
      providerSessionKey: encodeProviderSessionKey('codex', 'config-state-session', 'default'),
      agentRecordId: '',
      persistentSessionId: '',
    };
    const configRecordId = configManager.ensureAgentSessionRecord(configAgent, { archived: false });
    configAgent.agentRecordId = configRecordId;
    configAgent.persistentSessionId = configRecordId;
    configAgent.attentionSeq = 6;
    const configCommit = assertCommitted(
      await configManager.persistAgentStatePatch(configAgent, { attentionSeq: configAgent.attentionSeq }),
      configRecordId,
    );
    assert.strictEqual(configManager.isAgentStateCommitCurrent(configAgent, configRecordId, configCommit), true);
    assert.strictEqual(
      configManager.getAgentSessionRecordForProviderSessionKey(configAgent.providerSessionKey)?.attentionSeq,
      6,
    );
    assert.deepStrictEqual(
      fs.readdirSync(path.join(root, 'sessions')).filter(name => name.endsWith('.tmp')),
      [],
    );

    console.log('✓ Agent state persistence keeps fsync asynchronous and fences stale commits');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
