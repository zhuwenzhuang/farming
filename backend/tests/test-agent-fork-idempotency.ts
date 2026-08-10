const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentManager } = require('../agent-manager.cjs');
const { ConfigManager } = require('../config-manager.cjs');
const {
  beginLifecycleOperation,
  latestLifecycleOperation,
  transitionLifecycleOperation,
} = require('../agent-lifecycle-journal.cjs');
const { forkRequestSignature } = require('../fork-operation-coordinator.cjs');

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
    const source: {
      id: string;
      command: string;
      forkCommand: string;
      cwd: string;
      projectWorkspace: string;
      status: string;
      engineName: string;
      engineStarted: boolean;
      category: string;
      source: string;
      runtimeBinding: { kind: string };
      wantsMain: boolean;
      persistentSessionId?: string;
      agentRecordId?: string;
    } = {
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
    manager.activityTracker.record(source.id);
    const registerSource = (id: string) => {
      const record = {
        ...source,
        id,
        lifecycleJournal: undefined,
        persistentSessionId: undefined,
        agentRecordId: undefined,
      };
      record.persistentSessionId = configManager.ensureAgentSessionRecord(record, {
        visibleOnMainPage: true,
        archived: false,
      });
      record.agentRecordId = record.persistentSessionId;
      manager.agents.set(id, record);
      manager.activityTracker.record(id);
      return record;
    };

    const first = await manager.forkAgent(source.id, 'same-worktree', { requestId: 'fork-request-1' });
    assert.strictEqual(first.error, undefined);
    assert.strictEqual(createCount, 1);
    const firstChildRecord = configManager.listAgentSessionRecords().find(record => (
      record.runtimeAgentId === first.agentId
    ));
    assert.strictEqual(firstChildRecord?.forkRequestId, 'fork-request-1');
    assert.match(
      String(firstChildRecord?.forkRequestSignature || ''),
      /^[a-f0-9]{64}$/,
      'the child record must retain an exact Fork operation signature separately from requestId',
    );
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
    const originalUncertainChild = manager.agents.get(uncertain.agentId);
    assert.ok(originalUncertainChild);
    manager.agents.set(uncertain.agentId, {
      ...originalUncertainChild,
      agentRecordId: 'record-runtime-id-replacement',
      persistentSessionId: 'record-runtime-id-replacement',
    });
    const refusedReusedRuntimeId = await manager.forkAgent(
      source.id,
      'same-worktree',
      { requestId: 'fork-request-2' },
    );
    assert.strictEqual(refusedReusedRuntimeId.agentId, undefined);
    assert.strictEqual(refusedReusedRuntimeId.uncertain, true);
    assert.match(refusedReusedRuntimeId.error, /readiness cannot be proven/);
    assert.strictEqual(createCount, 3);
    manager.agents.set(uncertain.agentId, originalUncertainChild);
    const reconciled = await manager.forkAgent(source.id, 'same-worktree', { requestId: 'fork-request-2' });
    assert.strictEqual(reconciled.agentId, uncertain.agentId);
    assert.strictEqual(reconciled.reconciled, true);
    assert.strictEqual(reconciled.deduplicated, true);
    assert.strictEqual(createCount, 3, 'reconciliation after a lost result must reuse the persisted child');
    assert.strictEqual(latestLifecycleOperation(source).state, 'succeeded');

    const checkpointFailureSource = registerSource('agent-fork-checkpoint-before-effect-failure');
    const worktreesBeforeCheckpointFailure = execFileSync(
      'git',
      ['-C', repository, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8' },
    );
    const originalCheckpointOperation = manager.checkpointPersistentAgentOperationRequest.bind(manager);
    manager.checkpointPersistentAgentOperationRequest = () => {
      throw new Error('simulated checkpoint persistence failure');
    };
    const checkpointFailure = await manager.forkAgent(
      checkpointFailureSource.id,
      'new-worktree',
      { requestId: 'fork-checkpoint-before-effect-failure' },
    );
    manager.checkpointPersistentAgentOperationRequest = originalCheckpointOperation;
    assert.match(checkpointFailure.error, /simulated checkpoint persistence failure/);
    assert.strictEqual(checkpointFailure.uncertain, undefined);
    assert.strictEqual(latestLifecycleOperation(checkpointFailureSource).state, 'failed');
    assert.strictEqual(
      execFileSync('git', ['-C', repository, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }),
      worktreesBeforeCheckpointFailure,
      'checkpoint persistence failure must happen before git worktree add',
    );

    const unknownCreateSource = registerSource('agent-fork-worktree-create-unknown');
    const originalCreateTemporaryWorktree = manager.worktreeGitService.createTemporaryWorktree
      .bind(manager.worktreeGitService);
    manager.worktreeGitService.createTemporaryWorktree = async identity => {
      const mutation = await originalCreateTemporaryWorktree(identity);
      return {
        ...mutation,
        commandFailure: {
          cause: new Error('simulated git worktree add timeout'),
          message: 'simulated git worktree add timeout',
        },
        postcondition: {
          ...mutation.postcondition,
          error: 'simulated postcondition inspection failure',
          proven: false,
        },
      };
    };
    const unknownCreate = await manager.forkAgent(
      unknownCreateSource.id,
      'new-worktree',
      { requestId: 'fork-worktree-create-unknown' },
    );
    manager.worktreeGitService.createTemporaryWorktree = originalCreateTemporaryWorktree;
    assert.strictEqual(unknownCreate.uncertain, true);
    assert.ok(unknownCreate.retainedWorkspace);
    assert.match(unknownCreate.error, new RegExp(unknownCreate.retainedWorkspace));
    assert.strictEqual(fs.existsSync(unknownCreate.retainedWorkspace), true);
    const unknownCreateOperation = latestLifecycleOperation(unknownCreateSource);
    assert.strictEqual(unknownCreateOperation.state, 'blocked');
    assert.strictEqual(
      unknownCreateOperation.request.forkWorktreeIdentity.workspace,
      unknownCreate.retainedWorkspace,
    );
    const reconciledUnknownCreate = await manager.forkAgent(
      unknownCreateSource.id,
      'new-worktree',
      { requestId: 'fork-worktree-create-unknown' },
    );
    assert.match(reconciledUnknownCreate.error, /rolled back/);
    assert.strictEqual(reconciledUnknownCreate.uncertain, undefined);
    assert.strictEqual(latestLifecycleOperation(unknownCreateSource).state, 'failed');
    assert.strictEqual(fs.existsSync(unknownCreate.retainedWorkspace), false);

    const thrownCreateSource = registerSource('agent-fork-worktree-create-throw');
    const originalInspectPostcondition = manager.worktreeGitService.inspectPostcondition
      .bind(manager.worktreeGitService);
    manager.worktreeGitService.inspectPostcondition = async () => ({
      branchExists: false,
      branchMatches: true,
      error: 'simulated postcondition inspection failure',
      exists: false,
      proven: false,
      registered: false,
      worktree: null,
    });
    manager.worktreeGitService.createTemporaryWorktree = async identity => {
      await originalCreateTemporaryWorktree(identity);
      throw new Error('simulated create port throw after git add');
    };
    const thrownCreate = await manager.forkAgent(
      thrownCreateSource.id,
      'new-worktree',
      { requestId: 'fork-worktree-create-throw' },
    );
    manager.worktreeGitService.createTemporaryWorktree = originalCreateTemporaryWorktree;
    manager.worktreeGitService.inspectPostcondition = originalInspectPostcondition;
    assert.strictEqual(thrownCreate.uncertain, true);
    assert.ok(thrownCreate.retainedWorkspace);
    assert.match(thrownCreate.error, /simulated create port throw after git add/);
    assert.match(thrownCreate.error, new RegExp(thrownCreate.retainedWorkspace));
    assert.strictEqual(fs.existsSync(thrownCreate.retainedWorkspace), true);
    assert.strictEqual(latestLifecycleOperation(thrownCreateSource).state, 'blocked');
    const reconciledThrownCreate = await manager.forkAgent(
      thrownCreateSource.id,
      'new-worktree',
      { requestId: 'fork-worktree-create-throw' },
    );
    assert.match(reconciledThrownCreate.error, /rolled back/);
    assert.strictEqual(reconciledThrownCreate.uncertain, undefined);
    assert.strictEqual(latestLifecycleOperation(thrownCreateSource).state, 'failed');
    assert.strictEqual(fs.existsSync(thrownCreate.retainedWorkspace), false);

    const originalStartAgent = manager.startAgent.bind(manager);
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (error: unknown) => unhandledRejections.push(error);
    process.on('unhandledRejection', onUnhandledRejection);
    const rollbackSource = registerSource('agent-fork-worktree-rollback');
    let cleanRollbackWorkspace = '';
    manager.startAgent = (_command, workspace, callback) => {
      cleanRollbackWorkspace = String(workspace || '');
      callback?.(null, 'simulated proven start failure');
      return Promise.resolve(null);
    };
    const cleanRollback = await manager.forkAgent(
      rollbackSource.id,
      'new-worktree',
      { requestId: 'fork-worktree-clean-rollback' },
    );
    assert.match(cleanRollback.error, /simulated proven start failure/);
    assert.strictEqual(cleanRollback.uncertain, undefined);
    assert.strictEqual(latestLifecycleOperation(rollbackSource).state, 'failed');
    assert.strictEqual(fs.existsSync(cleanRollbackWorkspace), false);

    const noCallbackSource = registerSource('agent-fork-worktree-no-callback');
    let noCallbackWorkspace = '';
    manager.startAgent = (_command, workspace) => {
      noCallbackWorkspace = String(workspace || '');
      return Promise.resolve(null);
    };
    const noCallback = await manager.forkAgent(
      noCallbackSource.id,
      'new-worktree',
      { requestId: 'fork-worktree-no-callback' },
    );
    assert.match(noCallback.error, /Failed to start forked agent/);
    assert.strictEqual(noCallback.uncertain, undefined);
    assert.strictEqual(latestLifecycleOperation(noCallbackSource).state, 'failed');
    assert.strictEqual(fs.existsSync(noCallbackWorkspace), false);

    const rejectedStartSource = registerSource('agent-fork-worktree-rejected-start');
    let rejectedStartWorkspace = '';
    manager.startAgent = (_command, workspace) => {
      rejectedStartWorkspace = String(workspace || '');
      return Promise.reject(new Error('simulated start rejection'));
    };
    const rejectedStart = await manager.forkAgent(
      rejectedStartSource.id,
      'new-worktree',
      { requestId: 'fork-worktree-rejected-start' },
    );
    assert.strictEqual(rejectedStart.uncertain, true);
    assert.strictEqual(rejectedStart.retainedWorkspace, rejectedStartWorkspace);
    assert.match(rejectedStart.error, new RegExp(rejectedStartWorkspace));
    assert.strictEqual(latestLifecycleOperation(rejectedStartSource).state, 'blocked');
    assert.strictEqual(fs.existsSync(rejectedStartWorkspace), true);
    await manager.worktreeGitService.deleteWorktree({
      sourceWorkspace: repository,
      workspace: rejectedStartWorkspace,
    }, true);

    const throwingRollbackSource = registerSource('agent-fork-worktree-throwing-rollback');
    let throwingRollbackWorkspace = '';
    const originalRollbackTemporaryWorktree = manager.worktreeGitService.rollbackTemporaryWorktree
      .bind(manager.worktreeGitService);
    manager.worktreeGitService.rollbackTemporaryWorktree = async () => {
      throw new Error('simulated rollback port throw');
    };
    manager.startAgent = (_command, workspace, callback) => {
      throwingRollbackWorkspace = String(workspace || '');
      callback?.(null, 'simulated start failure before throwing rollback');
      return Promise.resolve(null);
    };
    const throwingRollback = await manager.forkAgent(
      throwingRollbackSource.id,
      'new-worktree',
      { requestId: 'fork-worktree-throwing-rollback' },
    );
    assert.strictEqual(throwingRollback.uncertain, true);
    assert.strictEqual(throwingRollback.retainedWorkspace, throwingRollbackWorkspace);
    assert.match(throwingRollback.error, /simulated rollback port throw/);
    assert.strictEqual(latestLifecycleOperation(throwingRollbackSource).state, 'blocked');
    manager.worktreeGitService.rollbackTemporaryWorktree = originalRollbackTemporaryWorktree;
    await manager.worktreeGitService.deleteWorktree({
      sourceWorkspace: repository,
      workspace: throwingRollbackWorkspace,
    }, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(unhandledRejections, []);
    process.off('unhandledRejection', onUnhandledRejection);

    const dirtySource = registerSource('agent-fork-worktree-dirty');
    let dirtyWorkspace = '';
    manager.startAgent = (_command, workspace, callback) => {
      dirtyWorkspace = String(workspace || '');
      fs.writeFileSync(path.join(dirtyWorkspace, 'uncommitted.txt'), 'retain me\n');
      callback?.(null, 'simulated start failure with dirty worktree');
      return Promise.resolve(null);
    };
    const dirtyRetained = await manager.forkAgent(
      dirtySource.id,
      'new-worktree',
      { requestId: 'fork-worktree-dirty-retained' },
    );
    assert.strictEqual(dirtyRetained.uncertain, true);
    assert.strictEqual(dirtyRetained.retainedWorkspace, dirtyWorkspace);
    assert.match(dirtyRetained.error, new RegExp(dirtyWorkspace));
    assert.strictEqual(latestLifecycleOperation(dirtySource).state, 'blocked');
    assert.strictEqual(fs.existsSync(dirtyWorkspace), true);
    await manager.worktreeGitService.deleteWorktree({
      sourceWorkspace: repository,
      workspace: dirtyWorkspace,
    }, true);

    const retainedChildSource = registerSource('agent-fork-retained-child-source');
    let retainedChildStartCount = 0;
    manager.startAgent = (_command, workspace, callback, options) => {
      retainedChildStartCount += 1;
      const child = {
        ...retainedChildSource,
        id: 'agent-fork-retained-child',
        parentAgentId: options.parentAgentId,
        forkRequestId: options.forkRequestId,
        forkRequestSignature: options.forkRequestSignature,
        cwd: String(workspace || ''),
        projectWorkspace: String(workspace || ''),
        lifecycleJournal: undefined,
        persistentSessionId: undefined,
        agentRecordId: undefined,
      };
      const create = beginLifecycleOperation(child, 'create', 'create', {});
      assert.ok(create.operation);
      assert.ok(transitionLifecycleOperation(child, create.operation.id, 'blocked', 'cleanup uncertain'));
      child.persistentSessionId = configManager.ensureAgentSessionRecord(child, {
        visibleOnMainPage: true,
        archived: false,
      });
      child.agentRecordId = child.persistentSessionId;
      manager.agents.set(child.id, child);
      callback?.(child.id, 'simulated cleanup-uncertain start');
      return Promise.resolve(null);
    };
    const retainedChild = await manager.forkAgent(
      retainedChildSource.id,
      'new-worktree',
      { requestId: 'fork-retained-child' },
    );
    assert.strictEqual(retainedChild.retainedAgentId, 'agent-fork-retained-child');
    assert.strictEqual(retainedChild.uncertain, true);
    const retainedChildReplay = await manager.forkAgent(
      retainedChildSource.id,
      'new-worktree',
      { requestId: 'fork-retained-child' },
    );
    assert.strictEqual(retainedChildReplay.agentId, undefined);
    assert.strictEqual(retainedChildReplay.retainedAgentId, 'agent-fork-retained-child');
    assert.strictEqual(retainedChildReplay.uncertain, true);
    assert.strictEqual(retainedChildStartCount, 1);
    assert.strictEqual(latestLifecycleOperation(retainedChildSource).state, 'blocked');
    await manager.worktreeGitService.deleteWorktree({
      sourceWorkspace: repository,
      workspace: retainedChild.workspace,
    }, true);

    manager.startAgent = originalStartAgent;

    const checkpointSource = registerSource('agent-fork-checkpoint-recovery');
    const checkpointIdentity = await manager.worktreeGitService.allocateTemporaryWorktree(repository);
    manager.worktreeGitService.releaseTemporaryWorktreeReservation(checkpointIdentity);
    const checkpointRequestId = 'fork-checkpoint-recovery';
    const checkpointOptions = { requestId: checkpointRequestId };
    const checkpointSignature = forkRequestSignature(
      checkpointSource,
      'new-worktree',
      checkpointOptions,
    );
    const checkpointAdmission = beginLifecycleOperation(
      checkpointSource,
      'fork',
      `fork-request:${checkpointRequestId}`,
      {
        signature: checkpointSignature,
        mode: 'new-worktree',
        sourceRecordId: checkpointSource.agentRecordId,
        sourceRuntimeKind: 'terminal',
        targetRuntime: '',
        expectedRevision: null,
        forkWorktreeIdentity: checkpointIdentity,
      },
    );
    assert.ok(checkpointAdmission.operation);
    manager.sessionPersistence.persist(checkpointSource);
    const checkpointRecovery = await manager.forkAgent(
      checkpointSource.id,
      'new-worktree',
      checkpointOptions,
    );
    assert.match(checkpointRecovery.error, /rolled back/);
    assert.strictEqual(checkpointRecovery.uncertain, undefined);
    assert.strictEqual(latestLifecycleOperation(checkpointSource).state, 'failed');
    assert.strictEqual(fs.existsSync(checkpointIdentity.workspace), false);

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
