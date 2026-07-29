const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AgentManager = require('../agent-manager.cjs');
const { ConfigManager } = require('../config-manager.cjs');
const { latestLifecycleOperation } = require('../agent-lifecycle-journal.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-fork-idempotency-'));
  const repository = path.join(root, 'repo');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(repository);
  fs.writeFileSync(path.join(repository, 'README.md'), 'fork idempotency fixture\n');
  execFileSync('git', ['-C', repository, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repository, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', [
    '-C', repository,
    '-c', 'user.name=Farming Test',
    '-c', 'user.email=farming@example.test',
    'commit', '-m', 'init',
  ], { stdio: 'ignore' });

  const configManager = new ConfigManager({ configDir });
  configManager.init();
  const manager = new AgentManager(configManager, { skipExecutablePreflight: true });
  const originalBridge = manager.engineBridge;
  await originalBridge.dispose();
  let createCount = 0;
  manager.engineBridge = {
    resolve() {
      return {
        engineName: 'local',
        engine: {
          async createSession() {
            createCount += 1;
          },
        },
        spec: { category: 'shell' },
      };
    },
    getEngine() {
      return {
        async getSessionState() {
          return { status: 'running' };
        },
        async killSession() {},
        async updateSessionMetadata() {},
      };
    },
    async dispose() {},
  };

  try {
    await manager.whenRecovered();
    const source = {
      id: 'agent-fork-source',
      command: 'bash',
      forkCommand: 'bash',
      cwd: repository,
      projectWorkspace: repository,
      status: 'running',
      engineName: 'local',
      engineStarted: true,
      category: 'shell',
      source: 'ui',
      runtimeBinding: { kind: 'terminal' },
      wantsMain: false,
    };
    source.persistentSessionId = configManager.ensureAgentSessionRecord(source, {
      visibleOnMainPage: true,
      archived: false,
    });
    source.agentRecordId = source.persistentSessionId;
    manager.agents.set(source.id, source);
    manager.lastActivity.set(source.id, Date.now());

    const first = await manager.forkAgent(source.id, 'same-worktree', { requestId: 'fork-request-1' });
    assert.strictEqual(first.error, undefined);
    assert.strictEqual(createCount, 1);
    const replay = await manager.forkAgent(source.id, 'same-worktree', { requestId: 'fork-request-1' });
    assert.strictEqual(replay.agentId, first.agentId);
    assert.strictEqual(replay.deduplicated, true);
    assert.strictEqual(createCount, 1, 'a repeated Fork request must not start another child');
    assert.match(
      (await manager.forkAgent(source.id, 'new-worktree', { requestId: 'fork-request-1' })).error,
      /different parameters/,
    );
    assert.strictEqual(latestLifecycleOperation(source).state, 'succeeded');
    const [concurrentOne, concurrentTwo] = await Promise.all([
      manager.forkAgent(source.id, 'same-worktree', { requestId: 'fork-request-concurrent' }),
      manager.forkAgent(source.id, 'same-worktree', { requestId: 'fork-request-concurrent' }),
    ]);
    assert.strictEqual(concurrentOne.agentId, concurrentTwo.agentId);
    assert.strictEqual(createCount, 2, 'concurrent delivery of one Fork request must join one child start');

    const completePersistentAgentOperation = manager.completePersistentAgentOperation.bind(manager);
    let failResultCommit = true;
    manager.completePersistentAgentOperation = (...args) => {
      if (failResultCommit) throw new Error('simulated Fork result commit failure');
      return completePersistentAgentOperation(...args);
    };
    const uncertain = await manager.forkAgent(source.id, 'same-worktree', { requestId: 'fork-request-2' });
    assert.strictEqual(uncertain.retryable, true);
    assert.match(uncertain.error, /Fork result commit failure/);
    assert.strictEqual(createCount, 3);
    failResultCommit = false;
    const reconciled = await manager.forkAgent(source.id, 'same-worktree', { requestId: 'fork-request-2' });
    assert.strictEqual(reconciled.agentId, uncertain.agentId);
    assert.strictEqual(reconciled.reconciled, true);
    assert.strictEqual(reconciled.deduplicated, true);
    assert.strictEqual(createCount, 3, 'reconciliation after a lost result must reuse the persisted child');
    assert.strictEqual(latestLifecycleOperation(source).state, 'succeeded');

    console.log('test-agent-fork-idempotency passed');
  } finally {
    await manager.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
