const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ConfigManager } = require('../config-manager.cjs');
const { FarmingSessionStore } = require('../farming-session-store.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-adaptive-title-async-'));
  try {
    const store = new FarmingSessionStore(root);
    store.init();
    const agent = {
      id: 'runtime-agent-async-title',
      command: 'codex',
      cwd: root,
      projectWorkspace: root,
      providerSessionProvider: 'codex',
      providerSessionId: 'async-title-session',
      providerSessionKey: 'agent-session:codex:async-title-session',
      providerSessionTemporary: false,
      agentRecordId: '',
      persistentSessionId: '',
      adaptiveTitle: '',
      task: 'Initial durable task',
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

    const persistence = store.persistAgentAdaptiveTitle(agent, 'Asynchronous durable title');
    await firstWriteStarted;
    let eventLoopAdvanced = false;
    setImmediate(() => {
      eventLoopAdvanced = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(eventLoopAdvanced, true, 'title fsync must not block the Server event loop');

    const generationBeforeConcurrentCommit = store.metadataWriteGenerations.get(recordId) || 0;
    store.writeRecord({
      ...store.readRecord(recordId),
      id: recordId,
      task: 'Concurrent durable task',
    });
    assert(
      (store.metadataWriteGenerations.get(recordId) || 0) > generationBeforeConcurrentCommit,
      'every direct metadata write must advance the adaptive-title generation guard',
    );
    releaseFirstWrite();
    assert.strictEqual(await persistence, recordId);

    const record = store.readRecord(recordId);
    assert.strictEqual(record.adaptiveTitle, 'Asynchronous durable title');
    assert.strictEqual(record.task, 'Concurrent durable task');

    const restarted = new FarmingSessionStore(root);
    restarted.init();
    const recovered = restarted.readRecord(recordId);
    assert.strictEqual(recovered.adaptiveTitle, 'Asynchronous durable title');
    assert.strictEqual(recovered.task, 'Concurrent durable task');

    let releaseRebindWrite: () => void = () => {};
    const rebindWriteGate = new Promise<void>(resolve => {
      releaseRebindWrite = resolve;
    });
    let observeRebindWrite: () => void = () => {};
    const rebindWriteStarted = new Promise<void>(resolve => {
      observeRebindWrite = resolve;
    });
    let rebindWrite = true;
    store.writeJsonAsync = async (file, value, options) => {
      if (rebindWrite) {
        rebindWrite = false;
        observeRebindWrite();
        await rebindWriteGate;
      }
      return productionWriteJsonAsync(file, value, options);
    };
    const reboundPersistence = store.persistAgentAdaptiveTitle(agent, 'Canonical rebound title');
    await rebindWriteStarted;
    const replacementId = 'agent_rebound_async_title';
    store.writeRecord({
      ...store.readRecord(recordId),
      id: replacementId,
      agentRecordId: replacementId,
    });
    store.providerSessionRecords.set(agent.providerSessionKey, replacementId);
    releaseRebindWrite();
    assert.strictEqual(await reboundPersistence, replacementId);
    assert.strictEqual(store.readRecord(recordId).adaptiveTitle, 'Asynchronous durable title');
    assert.strictEqual(store.readRecord(replacementId).adaptiveTitle, 'Canonical rebound title');

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
    try {
      assert.strictEqual(
        await store.persistAgentAdaptiveTitle(agent, 'Only atomic publication stays synchronous'),
        replacementId,
      );
    } finally {
      fs.fdatasyncSync = originalFdatasyncSync;
      fs.openSync = originalOpenSync;
      fs.readFileSync = originalReadFileSync;
      fs.renameSync = originalRenameSync;
      fs.writeFileSync = originalWriteFileSync;
    }
    assert.deepStrictEqual(synchronousCalls, { fdatasync: 0, open: 0, read: 0, rename: 1, write: 0 });
    assert.deepStrictEqual(
      fs.readdirSync(path.join(root, 'sessions')).filter(name => name.endsWith('.tmp')),
      [],
    );

    let releaseOwnershipWrite: () => void = () => {};
    const ownershipWriteGate = new Promise<void>(resolve => {
      releaseOwnershipWrite = resolve;
    });
    let observeOwnershipWrite: () => void = () => {};
    const ownershipWriteStarted = new Promise<void>(resolve => {
      observeOwnershipWrite = resolve;
    });
    store.writeJsonAsync = async (file, value, options) => {
      observeOwnershipWrite();
      await ownershipWriteGate;
      return productionWriteJsonAsync(file, value, options);
    };
    const unboundPersistence = store.persistAgentAdaptiveTitle(agent, 'Must not write after ownership loss');
    await ownershipWriteStarted;
    store.providerSessionRecords.delete(agent.providerSessionKey);
    releaseOwnershipWrite();
    assert.strictEqual(await unboundPersistence, '');
    assert.strictEqual(
      store.readRecord(replacementId).adaptiveTitle,
      'Only atomic publication stays synchronous',
    );

    store.providerSessionRecords.set(agent.providerSessionKey, replacementId);
    let conflictAttempts = 0;
    store.writeJsonAsync = async () => {
      conflictAttempts += 1;
      return false;
    };
    await assert.rejects(
      store.persistAgentAdaptiveTitle(agent, 'Bounded conflict title'),
      /metadata conflict retry limit/,
    );
    assert.strictEqual(conflictAttempts, 8);
    store.writeJsonAsync = productionWriteJsonAsync;

    const replacementRecord = store.readRecord(replacementId);
    store.writeRecord({
      ...replacementRecord,
      id: replacementId,
      runtimeAgentId: 'replacement-runtime-owner',
    });
    assert.strictEqual(
      await store.persistAgentAdaptiveTitle(agent, 'Must not write for a replacement runtime'),
      '',
    );
    assert.strictEqual(
      store.readRecord(replacementId).adaptiveTitle,
      'Only atomic publication stays synchronous',
    );

    const configRoot = path.join(root, 'config-manager');
    const configManager = new ConfigManager({ configDir: configRoot });
    configManager.init();
    const configAgent = {
      ...agent,
      id: 'runtime-agent-config-title',
      providerSessionId: 'config-title-session',
      providerSessionKey: 'agent-session:codex:config-title-session',
      agentRecordId: '',
      persistentSessionId: '',
    };
    const configRecordId = configManager.ensureAgentSessionRecord(configAgent, { archived: false });
    configAgent.agentRecordId = configRecordId;
    configAgent.persistentSessionId = configRecordId;
    assert.strictEqual(
      await configManager.persistAgentAdaptiveTitle(configAgent, 'ConfigManager durable title'),
      configRecordId,
    );
    assert.strictEqual(
      configManager.getAgentSessionRecordForProviderSessionKey(configAgent.providerSessionKey)?.adaptiveTitle,
      'ConfigManager durable title',
    );

    console.log('✓ adaptive title persistence stays async and retries across concurrent metadata commits');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
