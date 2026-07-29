const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AgentManager = require('../agent-manager.cjs');
const { ConfigManager } = require('../config-manager.cjs');

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
  const manager = new AgentManager(configManager, { skipExecutablePreflight: true });
  try {
    await manager.whenRecovered();
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

    const forkWorkspace = await manager.createForkWorktree(repository);
    configManager.mountProjectWorkspace(forkWorkspace);
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
    const reconciledDelete = await manager.deleteForkWorktreeProject(forkWorkspace, {
      force: true,
      requestId: 'delete-worktree-request-1',
    });
    assert.strictEqual(reconciledDelete.deleted, true);
    assert.strictEqual(reconciledDelete.error, undefined);
    assert.strictEqual(configManager.getSettings().projectWorkspaces.includes(forkWorkspace), false);
    assert.strictEqual(configManager.getProjectOperation('delete-worktree-request-1').state, 'succeeded');

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
