const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentManager } = require('../agent-manager.cjs');
const { ConfigManager } = require('../config-manager.cjs');
const { WorktreeGitService } = require('../worktree-git-service.cjs');

function git(repository, ...args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-worktree-operation-'));
  const repository = path.join(root, 'repo');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(repository);
  fs.writeFileSync(path.join(repository, 'README.md'), 'worktree operation fixture\n');
  git(repository, 'init');
  git(repository, 'add', 'README.md');
  execFileSync('git', [
    '-C', repository,
    '-c', 'user.name=Farming Test',
    '-c', 'user.email=farming@example.test',
    'commit', '-m', 'init',
  ], { stdio: 'ignore' });

  const configManager = new ConfigManager({ configDir });
  configManager.init();
  const manager = new AgentManager(configManager, {
    skipExecutablePreflight: true,
    worktreeGitService: new WorktreeGitService({
      now: () => new Date(2026, 7, 9, 12, 34, 56),
      identityNonce: () => 'd'.repeat(32),
    }),
  });
  try {
    await manager.recoveryGate.wait();
    const initialBranch = git(repository, 'branch', '--show-current');
    const initialHead = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'branch', 'branch-switch-target');

    manager.agents.set('branch-switch-active-agent', {
      id: 'branch-switch-active-agent',
      command: 'codex',
      cwd: repository,
      projectWorkspace: repository,
      isMain: false,
      status: 'running',
    });
    manager.agents.set('branch-switch-ancestor-active-agent', {
      id: 'branch-switch-ancestor-active-agent',
      command: 'codex',
      cwd: root,
      projectWorkspace: root,
      isMain: false,
      status: 'running',
    });
    fs.mkdirSync(path.join(repository, 'nested-agent'));
    manager.agents.set('branch-switch-nested-active-agent', {
      id: 'branch-switch-nested-active-agent',
      command: 'codex',
      cwd: path.join(repository, 'nested-agent'),
      projectWorkspace: path.join(repository, 'nested-agent'),
      isMain: false,
      status: 'pending',
    });
    const activeAgentInventory = await manager.inspectProjectBranches(repository);
    assert.strictEqual(activeAgentInventory.canSwitch, false);
    assert.strictEqual(activeAgentInventory.blockedReasonCode, 'active-agents');
    assert.deepStrictEqual(activeAgentInventory.blockingAgentIds, [
      'branch-switch-active-agent',
      'branch-switch-ancestor-active-agent',
      'branch-switch-nested-active-agent',
    ]);
    const blockedByActiveAgent = await manager.switchProjectBranch(repository, {
      branch: 'branch-switch-target',
      expectedBranch: initialBranch,
      expectedHead: initialHead,
      requestId: 'branch-switch-active-agent-block',
    });
    assert.strictEqual(blockedByActiveAgent.switched, false);
    assert.strictEqual(blockedByActiveAgent.uncertain, false);
    assert.strictEqual(
      configManager.getProjectOperation('branch-switch-active-agent-block').state,
      'failed',
      'deterministic guards must not consume the unresolved operation quota',
    );
    assert.strictEqual(git(repository, 'branch', '--show-current'), initialBranch);
    manager.agents.delete('branch-switch-active-agent');
    manager.agents.delete('branch-switch-ancestor-active-agent');
    manager.agents.delete('branch-switch-nested-active-agent');
    manager.agents.set('branch-switch-stopped-agent', {
      id: 'branch-switch-stopped-agent',
      command: 'codex',
      cwd: repository,
      projectWorkspace: repository,
      isMain: false,
      status: 'stopped',
    });
    const stoppedAgentInventory = await manager.inspectProjectBranches(repository);
    assert.strictEqual(stoppedAgentInventory.canSwitch, true);
    assert.deepStrictEqual(stoppedAgentInventory.blockingAgentIds, []);
    manager.agents.delete('branch-switch-stopped-agent');

    let releasePendingStart: (() => void) | null = null;
    let pendingStartEntered: (() => void) | null = null;
    const pendingStartGate = new Promise<void>(resolve => { releasePendingStart = resolve; });
    const pendingStartReady = new Promise<void>(resolve => { pendingStartEntered = resolve; });
    const pendingStart = manager.startAdmissionCoordinator.start({
      requestId: 'branch-switch-pending-start',
      signature: 'branch-switch-pending-start',
      workspaceKey: root,
      execute: async () => {
        pendingStartEntered?.();
        await pendingStartGate;
        manager.agents.set('branch-switch-pending-agent', {
          id: 'branch-switch-pending-agent',
          command: 'codex',
          cwd: root,
          projectWorkspace: root,
          isMain: false,
          status: 'running',
        });
        return 'branch-switch-pending-agent';
      },
    });
    await pendingStartReady;
    let pendingSwitchSettled = false;
    const blockedByPendingStartPromise = manager.switchProjectBranch(repository, {
      branch: 'branch-switch-target',
      expectedBranch: initialBranch,
      expectedHead: initialHead,
      requestId: 'branch-switch-pending-start-block',
    }).finally(() => { pendingSwitchSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(pendingSwitchSettled, false, 'branch switching must drain an admitted Agent start');
    releasePendingStart?.();
    await pendingStart;
    const blockedByPendingStart = await blockedByPendingStartPromise;
    assert.strictEqual(blockedByPendingStart.switched, false);
    assert.strictEqual(blockedByPendingStart.uncertain, false);
    assert.strictEqual(blockedByPendingStart.inventory?.blockedReasonCode, 'active-agents');
    assert.deepStrictEqual(blockedByPendingStart.inventory?.blockingAgentIds, ['branch-switch-pending-agent']);
    assert.strictEqual(git(repository, 'branch', '--show-current'), initialBranch);
    manager.agents.delete('branch-switch-pending-agent');

    const originalSwitchLocalBranch = manager.worktreeGitService.switchLocalBranch.bind(manager.worktreeGitService);
    let releaseExclusiveSwitch: (() => void) | null = null;
    let exclusiveSwitchEntered: (() => void) | null = null;
    const exclusiveSwitchGate = new Promise<void>(resolve => { releaseExclusiveSwitch = resolve; });
    const exclusiveSwitchReady = new Promise<void>(resolve => { exclusiveSwitchEntered = resolve; });
    manager.worktreeGitService.switchLocalBranch = async () => {
      exclusiveSwitchEntered?.();
      await exclusiveSwitchGate;
      return {
        switched: false,
        uncertain: false,
        error: 'synthetic held branch switch',
      };
    };
    const heldSwitch = manager.switchProjectBranch(repository, {
      branch: 'branch-switch-target',
      expectedBranch: initialBranch,
      expectedHead: initialHead,
      requestId: 'branch-switch-exclusive-start-race',
    });
    await exclusiveSwitchReady;
    let rejectedAncestorStartError = '';
    const rejectedAncestorStart = await manager.startAgent('bash', root, (_agentId, error) => {
      rejectedAncestorStartError = error || '';
    }, { wantsMain: false });
    assert.strictEqual(rejectedAncestorStart, null);
    assert.match(rejectedAncestorStartError, /Project is temporarily unavailable/);
    releaseExclusiveSwitch?.();
    const heldSwitchResult = await heldSwitch;
    assert.strictEqual(heldSwitchResult.switched, false);
    assert.strictEqual(heldSwitchResult.uncertain, false);
    manager.worktreeGitService.switchLocalBranch = originalSwitchLocalBranch;

    let uncertainSwitchCalls = 0;
    manager.worktreeGitService.switchLocalBranch = async () => {
      uncertainSwitchCalls += 1;
      return {
        switched: false,
        uncertain: true,
        error: 'synthetic uncertain branch switch',
      };
    };
    const uncertainSwitchRequest = {
      branch: 'branch-switch-target',
      expectedBranch: initialBranch,
      expectedHead: initialHead,
      requestId: 'branch-switch-uncertain-replay',
    };
    const uncertainBranchSwitch = await manager.switchProjectBranch(repository, uncertainSwitchRequest);
    assert.strictEqual(uncertainBranchSwitch.uncertain, true);
    assert.strictEqual(
      configManager.getProjectOperation(uncertainSwitchRequest.requestId).state,
      'unknown',
      'an uncertain response must remain a non-evictable no-replay tombstone',
    );
    for (let index = 0; index < 40; index += 1) {
      configManager.commitProjectOperation({
        id: `branch-switch-terminal-pressure-${index}`,
        type: 'switch-branch',
        state: 'failed',
        signature: `branch-switch-terminal-pressure-${index}`,
        request: { workspace: repository, branch: initialBranch },
        result: { switched: false, uncertain: false },
        error: 'synthetic terminal pressure',
        startedAt: index + 1,
        updatedAt: index + 1,
        finishedAt: index + 1,
      });
    }
    assert.strictEqual(
      configManager.getProjectOperation(uncertainSwitchRequest.requestId).state,
      'unknown',
      'terminal operation retention pressure must not evict an uncertain no-replay tombstone',
    );
    const replayedUncertainBranchSwitch = await manager.switchProjectBranch(repository, uncertainSwitchRequest);
    assert.deepStrictEqual(replayedUncertainBranchSwitch, uncertainBranchSwitch);
    assert.strictEqual(uncertainSwitchCalls, 1, 'a settled uncertain branch switch must never replay Git mutation');
    await assert.rejects(
      manager.switchProjectBranch(repository, {
        ...uncertainSwitchRequest,
        branch: initialBranch,
      }),
      /different parameters/,
    );
    manager.worktreeGitService.switchLocalBranch = originalSwitchLocalBranch;

    const switchedBranch = await manager.switchProjectBranch(repository, {
      branch: 'branch-switch-target',
      expectedBranch: initialBranch,
      expectedHead: initialHead,
      requestId: 'branch-switch-success',
    });
    assert.strictEqual(switchedBranch.switched, true);
    assert.strictEqual(switchedBranch.uncertain, false);
    assert.strictEqual(switchedBranch.inventory?.currentBranch, 'branch-switch-target');
    assert.strictEqual(switchedBranch.inventory?.head, git(repository, 'rev-parse', 'HEAD'));
    assert.strictEqual(git(repository, 'branch', '--show-current'), 'branch-switch-target');
    assert.strictEqual(configManager.getProjectOperation('branch-switch-success').state, 'succeeded');
    git(repository, 'switch', initialBranch);
    const replayedSwitchedBranch = await manager.switchProjectBranch(repository, {
      branch: 'branch-switch-target',
      expectedBranch: initialBranch,
      expectedHead: initialHead,
      requestId: 'branch-switch-success',
    });
    assert.deepStrictEqual(replayedSwitchedBranch, switchedBranch);
    assert.strictEqual(
      git(repository, 'branch', '--show-current'),
      initialBranch,
      'a settled successful request must return its stored result without another Git mutation',
    );

    const createRequestId = 'create-worktree-request-1';
    const created = await manager.createPermanentWorktree(repository, { requestId: createRequestId });
    assert.strictEqual(fs.existsSync(created.workspace), true);
    assert(configManager.getSettings().projectWorkspaces.includes(created.workspace));
    assert.strictEqual(configManager.getSettings().projectOperations, undefined, 'private operation state must not leak through Settings');
    assert.strictEqual(configManager.getProjectOperation(createRequestId).state, 'succeeded');
    const worktreeCount = git(repository, 'worktree', 'list', '--porcelain')
      .split(/\r?\n/)
      .filter(line => line === `worktree ${created.workspace}`).length;
    const replayedCreate = await manager.createPermanentWorktree(repository, { requestId: createRequestId });
    assert.strictEqual(replayedCreate.workspace, created.workspace);
    assert.strictEqual(replayedCreate.deduplicated, true);
    assert.strictEqual(
      git(repository, 'worktree', 'list', '--porcelain')
        .split(/\r?\n/)
        .filter(line => line === `worktree ${created.workspace}`).length,
      worktreeCount,
      'replaying a completed request must not create another worktree',
    );
    const [concurrentCreateOne, concurrentCreateTwo] = await Promise.all([
      manager.createPermanentWorktree(repository, { requestId: 'create-worktree-concurrent' }),
      manager.createPermanentWorktree(repository, { requestId: 'create-worktree-concurrent' }),
    ]);
    assert.strictEqual(concurrentCreateOne.workspace, concurrentCreateTwo.workspace);
    assert.strictEqual(
      git(repository, 'worktree', 'list', '--porcelain')
        .split(/\r?\n/)
        .filter(line => line === `worktree ${concurrentCreateOne.workspace}`).length,
      1,
      'concurrent delivery of one request id must join one git mutation',
    );
    const [distinctConcurrentOne, distinctConcurrentTwo] = await Promise.all([
      manager.createPermanentWorktree(repository, { requestId: 'create-worktree-distinct-1' }),
      manager.createPermanentWorktree(repository, { requestId: 'create-worktree-distinct-2' }),
    ]);
    assert.notStrictEqual(distinctConcurrentOne.workspace, distinctConcurrentTwo.workspace);
    assert.notStrictEqual(distinctConcurrentOne.branch, distinctConcurrentTwo.branch);
    assert.strictEqual(configManager.getProjectOperation('create-worktree-distinct-1').state, 'succeeded');
    assert.strictEqual(configManager.getProjectOperation('create-worktree-distinct-2').state, 'succeeded');

    const realWorktreeGitService = manager.worktreeGitService;
    const branchMissingIdentity = {
      sourceWorkspace: repository,
      workspace: path.join(root, 'branch-missing-worktree'),
      branch: 'farming/worktree-branch-missing',
    };
    const branchMissingPostcondition = {
      proven: true,
      exists: true,
      registered: true,
      branchMatches: true,
      branchExists: false,
      worktree: {
        workspace: branchMissingIdentity.workspace,
        branch: branchMissingIdentity.branch,
      },
    };
    let branchMissingCreateCalls = 0;
    manager.worktreeGitService = {
      allocatePermanentWorktree: async () => branchMissingIdentity,
      createPermanentWorktree: async () => {
        branchMissingCreateCalls += 1;
        return { commandFailure: null, postcondition: branchMissingPostcondition };
      },
      allocateTemporaryWorktree: sourceWorkspace => realWorktreeGitService.allocateTemporaryWorktree(sourceWorkspace),
      createTemporaryWorktree: identity => realWorktreeGitService.createTemporaryWorktree(identity),
      releaseTemporaryWorktreeReservation: identity => realWorktreeGitService.releaseTemporaryWorktreeReservation(identity),
      deleteWorktree: (identity, force) => realWorktreeGitService.deleteWorktree(identity, force),
      inspectForkWorktree: workspace => realWorktreeGitService.inspectForkWorktree(workspace),
      inspectLocalBranches: workspace => realWorktreeGitService.inspectLocalBranches(workspace),
      inspectPostcondition: async () => branchMissingPostcondition,
      listWorktrees: sourceWorkspace => realWorktreeGitService.listWorktrees(sourceWorkspace),
      releasePermanentWorktreeReservation() {},
      resolveSourceRoot: workspace => realWorktreeGitService.resolveSourceRoot(workspace),
      rollbackPermanentWorktree: identity => realWorktreeGitService.rollbackPermanentWorktree(identity),
      rollbackTemporaryWorktree: identity => realWorktreeGitService.rollbackTemporaryWorktree(identity),
      switchLocalBranch: (workspace, request) => realWorktreeGitService.switchLocalBranch(workspace, request),
    };
    try {
      await assert.rejects(
        () => manager.createPermanentWorktree(repository, { requestId: 'create-worktree-branch-missing' }),
        /could not be proven.*will not be replayed/i,
      );
      assert.strictEqual(configManager.getProjectOperation('create-worktree-branch-missing').state, 'unknown');
      await assert.rejects(
        () => manager.createPermanentWorktree(repository, { requestId: 'create-worktree-branch-missing' }),
        /could not be proven/i,
      );
      assert.strictEqual(branchMissingCreateCalls, 1, 'an unknown partial result must not replay git worktree add');
    } finally {
      manager.worktreeGitService = realWorktreeGitService;
    }

    const originalCommitProjectOperation = configManager.commitProjectOperation.bind(configManager);
    let failCreateResultCommit = true;
    configManager.commitProjectOperation = (operation, membership) => {
      if (
        failCreateResultCommit
        && operation.type === 'create-worktree'
        && operation.state === 'succeeded'
        && operation.id === 'create-worktree-request-2'
      ) {
        throw new Error('simulated create result commit failure');
      }
      return originalCommitProjectOperation(operation, membership);
    };
    await assert.rejects(
      () => manager.createPermanentWorktree(repository, { requestId: 'create-worktree-request-2' }),
      /create result commit failure/,
    );
    const pendingCreate = configManager.getProjectOperation('create-worktree-request-2');
    assert.strictEqual(pendingCreate.state, 'pending');
    assert.strictEqual(fs.existsSync(pendingCreate.request.workspace), true, 'the external side effect may already be complete');
    assert.strictEqual(
      configManager.getSettings().projectWorkspaces.includes(pendingCreate.request.workspace),
      false,
      'membership must not publish before the terminal operation commit',
    );
    failCreateResultCommit = false;
    const reconciledCreate = await manager.createPermanentWorktree(repository, {
      requestId: 'create-worktree-request-2',
    });
    assert.strictEqual(reconciledCreate.workspace, pendingCreate.request.workspace);
    assert(configManager.getSettings().projectWorkspaces.includes(reconciledCreate.workspace));
    assert.strictEqual(configManager.getProjectOperation('create-worktree-request-2').state, 'succeeded');

    const overlapWorkspace = await manager.createForkWorktree(repository);
    configManager.mountProjectWorkspace(overlapWorkspace);
    const dotDotNamedDescendant = path.join(overlapWorkspace, '..foo');
    fs.mkdirSync(dotDotNamedDescendant);
    let releaseOverlappingStart = () => {};
    const overlappingStart = new Promise<void>(resolve => {
      releaseOverlappingStart = resolve;
    });
    const overlappingStartAdmission = manager.startAdmissionCoordinator.start({
      execute: async () => {
        await overlappingStart;
        return null;
      },
      requestId: '',
      signature: 'dot-dot-named-descendant-start',
      workspaceKey: dotDotNamedDescendant,
    });
    let overlapDeleteSettled = false;
    const overlapDelete = manager.deleteForkWorktreeProject(overlapWorkspace, {
      requestId: 'delete-worktree-overlap-dot-dot-name',
    });
    void overlapDelete.finally(() => {
      overlapDeleteSettled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      overlapDeleteSettled,
      false,
      'Project deletion must drain a start admitted under a valid ..foo descendant',
    );
    releaseOverlappingStart();
    const overlapDeleted = await overlapDelete;
    await overlappingStartAdmission;
    assert.strictEqual(overlapDeleted.deleted, true);
    assert.strictEqual(fs.existsSync(overlapWorkspace), false);

    const forkWorkspace = await manager.createForkWorktree(repository);
    configManager.mountProjectWorkspace(forkWorkspace);
    fs.writeFileSync(path.join(forkWorkspace, 'untracked.txt'), 'dirty worktree fixture\n');
    const blockedDirtyDelete = await manager.deleteForkWorktreeProject(forkWorkspace, {
      requestId: 'delete-worktree-dirty-blocked',
    });
    assert.strictEqual(blockedDirtyDelete.requiresForce, true);
    assert.match(blockedDirtyDelete.error, /uncommitted or untracked/i);
    assert.strictEqual(fs.existsSync(forkWorkspace), true, 'a dirty worktree must remain until force is explicit');
    assert.strictEqual(
      configManager.getProjectOperation('delete-worktree-dirty-blocked'),
      null,
      'a dirty precondition blocks before a mutation intent is admitted',
    );
    let failDeleteResultCommit = true;
    configManager.commitProjectOperation = (operation, membership) => {
      if (
        failDeleteResultCommit
        && operation.type === 'delete-worktree'
        && operation.state === 'succeeded'
        && operation.id === 'delete-worktree-request-1'
      ) {
        throw new Error('simulated delete result commit failure');
      }
      return originalCommitProjectOperation(operation, membership);
    };
    const failedDeleteCommit = await manager.deleteForkWorktreeProject(forkWorkspace, {
      force: true,
      requestId: 'delete-worktree-request-1',
    });
    assert.strictEqual(failedDeleteCommit.deleted, true);
    assert.strictEqual(failedDeleteCommit.retryable, true);
    assert.match(failedDeleteCommit.error, /delete result commit failure/);
    assert.strictEqual(fs.existsSync(forkWorkspace), false);
    assert(configManager.getSettings().projectWorkspaces.includes(forkWorkspace));
    assert.strictEqual(configManager.getProjectOperation('delete-worktree-request-1').state, 'pending');
    failDeleteResultCommit = false;
    manager.worktreeGitService = new WorktreeGitService();
    const reconciledDelete = await manager.deleteForkWorktreeProject(forkWorkspace, {
      force: true,
      requestId: 'delete-worktree-request-1',
    });
    assert.strictEqual(reconciledDelete.deleted, true);
    assert.strictEqual(reconciledDelete.error, undefined);
    assert.strictEqual(configManager.getSettings().projectWorkspaces.includes(forkWorkspace), false);
    assert.strictEqual(configManager.getProjectOperation('delete-worktree-request-1').state, 'succeeded');

    const uncertainWorkspace = await manager.createForkWorktree(repository);
    configManager.mountProjectWorkspace(uncertainWorkspace);
    const serviceBeforeTimeout = manager.worktreeGitService;
    const timeoutError = Object.assign(new Error('synthetic delete timeout'), { code: 'ETIMEDOUT' });
    let uncertainDeleteCalls = 0;
    manager.worktreeGitService = {
      allocatePermanentWorktree: sourceWorkspace => serviceBeforeTimeout.allocatePermanentWorktree(sourceWorkspace),
      createPermanentWorktree: identity => serviceBeforeTimeout.createPermanentWorktree(identity),
      allocateTemporaryWorktree: sourceWorkspace => serviceBeforeTimeout.allocateTemporaryWorktree(sourceWorkspace),
      createTemporaryWorktree: identity => serviceBeforeTimeout.createTemporaryWorktree(identity),
      releaseTemporaryWorktreeReservation: identity => serviceBeforeTimeout.releaseTemporaryWorktreeReservation(identity),
      deleteWorktree: async () => {
        uncertainDeleteCalls += 1;
        return {
          commandFailure: { cause: timeoutError, message: timeoutError.message },
          postcondition: {
            proven: false,
            exists: true,
            registered: true,
            branchMatches: true,
            branchExists: false,
            worktree: { workspace: uncertainWorkspace, branch: '' },
            error: 'fresh delete postcondition unavailable',
          },
        };
      },
      inspectForkWorktree: workspace => serviceBeforeTimeout.inspectForkWorktree(workspace),
      inspectLocalBranches: workspace => serviceBeforeTimeout.inspectLocalBranches(workspace),
      inspectPostcondition: (sourceWorkspace, workspace, branch) => (
        serviceBeforeTimeout.inspectPostcondition(sourceWorkspace, workspace, branch)
      ),
      listWorktrees: sourceWorkspace => serviceBeforeTimeout.listWorktrees(sourceWorkspace),
      releasePermanentWorktreeReservation: identity => serviceBeforeTimeout.releasePermanentWorktreeReservation(identity),
      resolveSourceRoot: workspace => serviceBeforeTimeout.resolveSourceRoot(workspace),
      rollbackPermanentWorktree: identity => serviceBeforeTimeout.rollbackPermanentWorktree(identity),
      rollbackTemporaryWorktree: identity => serviceBeforeTimeout.rollbackTemporaryWorktree(identity),
      switchLocalBranch: (workspace, request) => serviceBeforeTimeout.switchLocalBranch(workspace, request),
    };
    const uncertainDelete = await manager.deleteForkWorktreeProject(uncertainWorkspace, {
      force: true,
      requestId: 'delete-worktree-timeout-unknown',
    });
    assert.strictEqual(uncertainDelete.uncertain, true);
    assert.match(uncertainDelete.error, /synthetic delete timeout/);
    assert.strictEqual(configManager.getProjectOperation('delete-worktree-timeout-unknown').state, 'unknown');
    const replayedUncertainDelete = await manager.deleteForkWorktreeProject(uncertainWorkspace, {
      force: true,
      requestId: 'delete-worktree-timeout-unknown',
    });
    assert.strictEqual(replayedUncertainDelete.uncertain, true);
    assert.strictEqual(uncertainDeleteCalls, 1, 'an uncertain delete mutation must not be replayed automatically');
    manager.worktreeGitService = serviceBeforeTimeout;
    const cleanup = await serviceBeforeTimeout.deleteWorktree({
      sourceWorkspace: repository,
      workspace: uncertainWorkspace,
    }, true);
    assert.strictEqual(cleanup.postcondition.proven, true);
    assert.strictEqual(cleanup.postcondition.exists, false);
    assert.strictEqual(cleanup.postcondition.registered, false);

    console.log('test-worktree-project-operations passed');
  } finally {
    await manager.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
