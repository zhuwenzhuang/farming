const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { AcpRuntime } = require('../acp-runtime.cjs');

async function run() {
  const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mts');
  let checkpointWrites = 0;
  const checkpoints = new Map();
  const checkpointKey = identity => JSON.stringify(identity);
  const checkpointStore = {
    async dispose() {},
    async flush() {},
    async load(identity) {
      const state = checkpoints.get(checkpointKey(identity));
      return state ? { state, exact: false } : null;
    },
    async markDirty() {},
    schedule() {},
    async write(identity, checkpoint) {
      checkpointWrites += 1;
      checkpoints.set(checkpointKey(identity), checkpoint.exportCheckpoint());
    },
  };
  const runtime = new AcpRuntime({
    checkpointStore,
    spawn,
    resolveLaunch() {
      return {
        command: process.execPath,
        args: ['--import', require.resolve('tsx'), fixture],
        version: 'test',
      };
    },
  });
  let hibernatedSessionId = '';

  try {
    await runtime.prepareAgent({
      agentId: 'agent-hibernate',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    await runtime.prompt('agent-hibernate', 'before hibernation');

    const binding = runtime.bindings.get('agent-hibernate');
    const originalSessionId = binding.sessionId;
    hibernatedSessionId = originalSessionId;
    const originalRevision = binding.sessionState.revision;
    const originalPid = binding.child.pid;
    const writesBeforeHibernate = checkpointWrites;

    binding.state = 'working';
    assert.strictEqual(runtime.canHibernate(binding), false, 'a working Agent must never be hibernation-eligible');
    assert.deepStrictEqual(
      await runtime.hibernateAgent('agent-hibernate'),
      { hibernated: false, state: 'working', sessionId: originalSessionId },
      'a reclaim attempt must reject a working Agent immediately instead of waiting for it to become idle',
    );
    binding.state = 'idle';

    binding.pendingPermissions.set('permission', { requestId: 'permission' });
    assert.strictEqual(runtime.canHibernate(binding), false, 'pending permission must block hibernation');
    binding.pendingPermissions.clear();

    binding.pendingElicitations.set('elicitation', { requestId: 'elicitation' });
    assert.strictEqual(runtime.canHibernate(binding), false, 'pending elicitation must block hibernation');
    binding.pendingElicitations.clear();

    binding.configMutationTail = Promise.resolve();
    assert.strictEqual(runtime.canHibernate(binding), false, 'configuration mutation must block hibernation');
    binding.configMutationTail = null;

    binding.subagentStates.set('child-session', binding.sessionState);
    assert.strictEqual(runtime.canHibernate(binding), false, 'active subagent must block hibernation');
    binding.subagentStates.clear();
    binding.subagentControls.clear();

    const activeCount = runtime.clientTerminals.activeCount.bind(runtime.clientTerminals);
    runtime.clientTerminals.activeCount = () => 1;
    assert.strictEqual(runtime.canHibernate(binding), false, 'active terminal must block hibernation');
    runtime.clientTerminals.activeCount = activeCount;

    binding.initializeResponse.agentCapabilities.loadSession = false;
    assert.strictEqual(runtime.canHibernate(binding), false, 'loadSession support is required');
    binding.initializeResponse.agentCapabilities.loadSession = true;
    assert.strictEqual(runtime.canHibernate(binding), true);

    const hibernated = await runtime.hibernateAgent('agent-hibernate');
    assert.deepStrictEqual(hibernated, { hibernated: true, sessionId: originalSessionId });
    assert.strictEqual(checkpointWrites, writesBeforeHibernate + 1, 'hibernation must write a checkpoint fence');
    assert.strictEqual(runtime.bindings.get('agent-hibernate'), binding, 'hibernation must retain the logical binding');
    assert.strictEqual(runtime.getSession('agent-hibernate').state, 'hibernated');
    assert.strictEqual(runtime.getSession('agent-hibernate').stopReason, 'hibernated');
    assert.strictEqual(runtime.getTranscriptSession('agent-hibernate').sessionId, originalSessionId);
    assert.throws(
      () => process.kill(originalPid, 0),
      error => error?.code === 'ESRCH',
      'hibernation must verify that the ACP process tree exited',
    );

    const awakened = await runtime.reconnectAgent('agent-hibernate');
    assert.strictEqual(awakened.reconnected, true);
    assert.strictEqual(awakened.sessionId, originalSessionId);
    const awakenedBinding = runtime.bindings.get('agent-hibernate');
    assert.notStrictEqual(awakenedBinding, binding, 'wake must install a fresh process binding');
    assert.notStrictEqual(awakenedBinding.child.pid, originalPid);
    assert.strictEqual(runtime.getSession('agent-hibernate').state, 'idle');
    assert(
      runtime.getSession('agent-hibernate').revision > originalRevision,
      'session/load must advance the transcript revision fence after wake',
    );
    assert.strictEqual(
      (await runtime.prompt('agent-hibernate', 'after wake')).stopReason,
      'end_turn',
      'the awakened session must accept a new prompt',
    );

    let racingReconnect = null;
    const onRuntime = event => {
      if (event.agentId === 'agent-hibernate' && event.state === 'hibernating') {
        racingReconnect = runtime.reconnectAgent('agent-hibernate');
      }
    };
    runtime.on('agent-runtime', onRuntime);
    const racingHibernate = runtime.hibernateAgent('agent-hibernate');
    assert.strictEqual(
      runtime.hibernateAgent('agent-hibernate'),
      racingHibernate,
      'concurrent hibernation requests must join one lifecycle operation',
    );
    assert.strictEqual((await racingHibernate).hibernated, true);
    assert(racingReconnect, 'the test must submit reconnect while hibernation is in progress');
    assert.strictEqual(
      (await racingReconnect).reconnected,
      true,
      'a user action racing hibernation must wait and wake the same session',
    );
    runtime.off('agent-runtime', onRuntime);
    assert.strictEqual(runtime.getSession('agent-hibernate').state, 'idle');
    assert.strictEqual(
      (await runtime.prompt('agent-hibernate', 'after racing wake')).stopReason,
      'end_turn',
      'the raced wake must remain prompt-live',
    );
  } finally {
    await runtime.dispose();
  }

  const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-wake-retry-'));
  const retryMarker = path.join(retryDir, 'failed-once');
  let coldSpawnCount = 0;
  const coldRuntime = new AcpRuntime({
    checkpointStore,
    spawn(...args) {
      coldSpawnCount += 1;
      return spawn(...args);
    },
    resolveLaunch() {
      return {
        command: process.execPath,
        args: ['--import', require.resolve('tsx'), fixture],
        version: 'test',
      };
    },
  });
  try {
    const restored = await coldRuntime.prepareAgent({
      agentId: 'agent-hibernate',
      provider: 'codex',
      cwd: process.cwd(),
      env: {
        ...process.env,
        FARMING_TEST_ACP_FAIL_LOAD_ONCE_FILE: retryMarker,
      },
      sessionId: hibernatedSessionId,
      historyMode: 'checkpoint',
      restoreHibernated: true,
    });
    assert.strictEqual(restored.historyMode, 'hibernated');
    assert.strictEqual(coldSpawnCount, 0, 'cold logical recovery must not start a provider process');
    assert.strictEqual(coldRuntime.getSession('agent-hibernate').state, 'hibernated');
    assert(
      coldRuntime.getTranscriptSession('agent-hibernate').entries.length > 0,
      'cold logical recovery must restore the retained transcript checkpoint',
    );

    await assert.rejects(
      coldRuntime.reconnectAgent('agent-hibernate'),
      /Fake transient session\/load failure/,
    );
    const failedBinding = coldRuntime.bindings.get('agent-hibernate');
    assert.strictEqual(failedBinding.state, 'error');
    assert.strictEqual(
      failedBinding.retryableReconnect,
      true,
      'a verified wake cleanup must retain a structured retry path',
    );
    const retried = await coldRuntime.reconnectAgent('agent-hibernate');
    assert.strictEqual(retried.reconnected, true, 'the next explicit action must retry the exact provider Session');
    assert.strictEqual(coldRuntime.getSession('agent-hibernate').state, 'idle');
    assert.strictEqual(coldSpawnCount, 2, 'one failed wake and one successful retry must start exactly two processes');
  } finally {
    await coldRuntime.dispose();
    fs.rmSync(retryDir, { recursive: true, force: true });
  }

  console.log('ACP runtime hibernation tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
