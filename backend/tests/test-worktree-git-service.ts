const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  WorktreeGitService,
  parseGitWorktreeList,
} = require('../worktree-git-service.cjs');

function commandKey(args: readonly string[]) {
  return args.slice(2).join(' ');
}

async function run() {
  const allocationNonce = 'a'.repeat(32);
  const allocationSlug = `20260809-123456-${allocationNonce}`;
  const parsed = parseGitWorktreeList([
    'worktree /repo',
    'HEAD 0123456',
    'branch refs/heads/main',
    '',
    'worktree /repo-linked',
    'HEAD 7654321',
    'branch refs/heads/feature/test',
    '',
    'worktree /repo-detached',
    'HEAD abcdef0',
    'detached',
  ].join('\n'));
  assert.deepStrictEqual(parsed, [
    { workspace: path.resolve('/repo'), branch: 'main' },
    { workspace: path.resolve('/repo-linked'), branch: 'feature/test' },
    { workspace: path.resolve('/repo-detached'), branch: '' },
  ]);

  const allocationCalls: string[] = [];
  const allocationService = new WorktreeGitService({
    now: () => new Date(2026, 7, 9, 12, 34, 56),
    identityNonce: () => allocationNonce,
    pathExists: workspace => workspace.endsWith(allocationSlug),
    execFile: async (_executable, args) => {
      allocationCalls.push(commandKey(args));
      const missing = Object.assign(new Error('missing'), { code: 1 });
      throw missing;
    },
  });
  const allocated = await allocationService.allocatePermanentWorktree('/projects/repo');
  assert.deepStrictEqual(allocated, {
    sourceWorkspace: '/projects/repo',
    workspace: `/projects/repo-farming-worktree-${allocationSlug}-2`,
    branch: `farming/worktree-${allocationSlug}-2`,
  });
  assert.deepStrictEqual(allocationCalls, [
    `show-ref --verify --quiet refs/heads/farming/worktree-${allocationSlug}-2`,
  ]);
  allocationService.releasePermanentWorktreeReservation(allocated);

  let initialBaseChecks = 0;
  let releaseInitialChecks: (() => void) | null = null;
  const initialChecks = new Promise<void>(resolve => { releaseInitialChecks = resolve; });
  let inspectionStarted: (() => void) | null = null;
  let releaseInspection: (() => void) | null = null;
  const inspectionEntered = new Promise<void>(resolve => { inspectionStarted = resolve; });
  const inspectionGate = new Promise<void>(resolve => { releaseInspection = resolve; });
  const reservationService = new WorktreeGitService({
    now: () => new Date(2026, 7, 9, 12, 34, 56),
    identityNonce: () => allocationNonce,
    pathExists: () => false,
    execFile: async (_executable, args) => {
      const key = commandKey(args);
      if (key === `show-ref --verify --quiet refs/heads/farming/worktree-${allocationSlug}`) {
        initialBaseChecks += 1;
        if (initialBaseChecks <= 2) {
          if (initialBaseChecks === 2) releaseInitialChecks?.();
          await initialChecks;
        }
        throw Object.assign(new Error('missing'), { code: 1 });
      }
      if (key.startsWith('show-ref ')) throw Object.assign(new Error('missing'), { code: 1 });
      if (key.startsWith('worktree add ')) return { stdout: '', stderr: '' };
      if (key === 'worktree list --porcelain') {
        inspectionStarted?.();
        await inspectionGate;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected git command: ${key}`);
    },
  });
  const [concurrentOne, concurrentTwo] = await Promise.all([
    reservationService.allocatePermanentWorktree('/projects/repo'),
    reservationService.allocatePermanentWorktree('/projects/repo'),
  ]);
  assert.deepStrictEqual(
    new Set([concurrentOne.workspace, concurrentTwo.workspace]),
    new Set([
      `/projects/repo-farming-worktree-${allocationSlug}`,
      `/projects/repo-farming-worktree-${allocationSlug}-2`,
    ]),
    'different requests must reserve distinct identities even when allocation checks race',
  );
  const creating = reservationService.createPermanentWorktree(concurrentOne);
  await inspectionEntered;
  const concurrentThree = await reservationService.allocatePermanentWorktree('/projects/repo');
  assert.strictEqual(
    concurrentThree.workspace,
    `/projects/repo-farming-worktree-${allocationSlug}-3`,
    'the identity reservation must remain held through fresh postcondition inspection',
  );
  releaseInspection?.();
  await creating;
  reservationService.releasePermanentWorktreeReservation(concurrentTwo);
  reservationService.releasePermanentWorktreeReservation(concurrentThree);
  const reusableAfterTerminal = await reservationService.allocatePermanentWorktree('/projects/repo');
  assert.strictEqual(reusableAfterTerminal.workspace, `/projects/repo-farming-worktree-${allocationSlug}`);
  reservationService.releasePermanentWorktreeReservation(reusableAfterTerminal);

  const crossInstanceExec = async () => {
    throw Object.assign(new Error('missing'), { code: 1 });
  };
  const crossInstanceOne = new WorktreeGitService({
    now: () => new Date(2026, 7, 9, 12, 34, 56),
    identityNonce: () => 'b'.repeat(32),
    pathExists: () => false,
    execFile: crossInstanceExec,
  });
  const crossInstanceTwo = new WorktreeGitService({
    now: () => new Date(2026, 7, 9, 12, 34, 56),
    identityNonce: () => 'c'.repeat(32),
    pathExists: () => false,
    execFile: crossInstanceExec,
  });
  const [crossIdentityOne, crossIdentityTwo] = await Promise.all([
    crossInstanceOne.allocatePermanentWorktree('/projects/repo'),
    crossInstanceTwo.allocatePermanentWorktree('/projects/repo'),
  ]);
  assert.notStrictEqual(
    crossIdentityOne.workspace,
    crossIdentityTwo.workspace,
    'independent Farming instances must not derive the same identity from a shared timestamp',
  );
  assert.notStrictEqual(crossIdentityOne.branch, crossIdentityTwo.branch);
  crossInstanceOne.releasePermanentWorktreeReservation(crossIdentityOne);
  crossInstanceTwo.releasePermanentWorktreeReservation(crossIdentityTwo);

  const identity = {
    sourceWorkspace: '/projects/repo',
    workspace: '/projects/repo-farming-worktree-20260809-123456',
    branch: 'farming/worktree-20260809-123456',
  };
  const events: string[] = [];
  const timedOut = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  const uncertainService = new WorktreeGitService({
    pathExists: workspace => workspace === identity.workspace,
    invalidateCache: () => events.push('invalidate'),
    execFile: async (_executable, args, options) => {
      const key = commandKey(args);
      events.push(`${key}:${options.timeout}`);
      if (key.startsWith('worktree add ')) throw timedOut;
      if (key === 'worktree list --porcelain') {
        return {
          stdout: `worktree ${identity.sourceWorkspace}\nbranch refs/heads/main\n\nworktree ${identity.workspace}\nbranch refs/heads/${identity.branch}\n`,
          stderr: '',
        };
      }
      if (key === `show-ref --verify --quiet refs/heads/${identity.branch}`) {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected git command: ${key}`);
    },
  });
  const reconciled = await uncertainService.createPermanentWorktree(identity);
  assert.deepStrictEqual(reconciled.commandFailure, { cause: timedOut, message: 'timed out' });
  assert.deepStrictEqual(reconciled.postcondition, {
    proven: true,
    exists: true,
    registered: true,
    branchMatches: true,
    branchExists: true,
    worktree: { workspace: identity.workspace, branch: identity.branch },
  });
  assert.deepStrictEqual(events, [
    `worktree add -b ${identity.branch} ${identity.workspace} HEAD:60000`,
    'invalidate',
    'worktree list --porcelain:15000',
    `show-ref --verify --quiet refs/heads/${identity.branch}:15000`,
  ]);

  const negativeService = new WorktreeGitService({
    pathExists: () => false,
    execFile: async (_executable, args) => {
      const key = commandKey(args);
      if (key.startsWith('worktree add ')) throw timedOut;
      if (key === 'worktree list --porcelain') return { stdout: '', stderr: '' };
      if (key.startsWith('show-ref ')) throw Object.assign(new Error('missing'), { code: 1 });
      throw new Error(`Unexpected git command: ${key}`);
    },
  });
  const exactNegative = await negativeService.createPermanentWorktree(identity);
  assert.deepStrictEqual(exactNegative.commandFailure, { cause: timedOut, message: 'timed out' });
  assert.deepStrictEqual(exactNegative.postcondition, {
    proven: true,
    exists: false,
    registered: false,
    branchMatches: false,
    branchExists: false,
    worktree: null,
  });

  const inspectionFailure = new WorktreeGitService({
    pathExists: () => true,
    execFile: async () => {
      throw new Error('inspection unavailable');
    },
  });
  assert.deepStrictEqual(
    await inspectionFailure.inspectPostcondition(identity.sourceWorkspace, identity.workspace, identity.branch),
    {
      proven: false,
      exists: false,
      registered: false,
      branchMatches: false,
      branchExists: false,
      worktree: null,
      error: 'inspection unavailable',
    },
  );

  const pathProbeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-worktree-path-probe-'));
  try {
    const fileTarget = path.join(pathProbeRoot, 'file-collision');
    const brokenSymlinkTarget = path.join(pathProbeRoot, 'broken-symlink');
    fs.writeFileSync(fileTarget, 'collision');
    fs.symlinkSync(path.join(pathProbeRoot, 'missing-target'), brokenSymlinkTarget);
    const absentBranchExec = async (_executable: string, args: readonly string[]) => {
      const key = commandKey(args);
      if (key === 'worktree list --porcelain') return { stdout: '', stderr: '' };
      if (key.startsWith('show-ref ')) throw Object.assign(new Error('missing'), { code: 1 });
      throw new Error(`Unexpected git command: ${key}`);
    };
    const pathProbeService = new WorktreeGitService({ execFile: absentBranchExec });
    assert.strictEqual(
      (await pathProbeService.inspectPostcondition(identity.sourceWorkspace, fileTarget, identity.branch)).exists,
      true,
      'an ordinary file collision is a present path',
    );
    assert.strictEqual(
      (await pathProbeService.inspectPostcondition(identity.sourceWorkspace, brokenSymlinkTarget, identity.branch)).exists,
      true,
      'a broken symlink is a present path',
    );
  } finally {
    fs.rmSync(pathProbeRoot, { recursive: true, force: true });
  }

  const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const uncertainPathService = new WorktreeGitService({
    pathExists: () => { throw permissionError; },
    execFile: async (_executable, args) => {
      const key = commandKey(args);
      if (key.startsWith('worktree add ')) throw timedOut;
      if (key === 'worktree list --porcelain') return { stdout: '', stderr: '' };
      if (key.startsWith('show-ref ')) throw Object.assign(new Error('missing'), { code: 1 });
      if (key.startsWith('worktree remove ') || key.startsWith('branch -D ')) return { stdout: '', stderr: '' };
      throw new Error(`Unexpected git command: ${key}`);
    },
  });
  assert.deepStrictEqual(
    await uncertainPathService.inspectPostcondition(identity.sourceWorkspace, identity.workspace, identity.branch),
    {
      proven: false,
      exists: false,
      registered: false,
      branchMatches: false,
      branchExists: false,
      worktree: null,
      error: 'permission denied',
    },
    'permission and I/O errors must remain unverifiable rather than becoming exact absence',
  );
  const uncertainPathMutation = await uncertainPathService.createPermanentWorktree(identity);
  assert.strictEqual(uncertainPathMutation.postcondition.proven, false);
  assert.strictEqual(
    (await uncertainPathService.createPermanentWorktree(identity)).postcondition.proven,
    false,
    'an uncertain terminal outcome must still release its in-memory reservation',
  );
  assert.deepStrictEqual(
    await uncertainPathService.rollbackPermanentWorktree(identity),
    { rolledBack: false, error: 'permission denied' },
    'rollback cannot report success when path absence is unverifiable',
  );

  const rollbackCommands: Array<{ key: string; timeout: number }> = [];
  let invalidations = 0;
  const rollbackService = new WorktreeGitService({
    invalidateCache: () => { invalidations += 1; },
    execFile: async (_executable, args, options) => {
      const key = commandKey(args);
      rollbackCommands.push({ key, timeout: options.timeout });
      if (key.startsWith('worktree remove ')) throw timedOut;
      if (key.startsWith('show-ref ')) {
        throw Object.assign(new Error('missing'), { code: 1 });
      }
      return { stdout: '', stderr: '' };
    },
  });
  assert.deepStrictEqual(await rollbackService.rollbackPermanentWorktree(identity), { rolledBack: true });
  assert.deepStrictEqual(rollbackCommands, [
    { key: `worktree remove --force ${identity.workspace}`, timeout: 60_000 },
    { key: `branch -D ${identity.branch}`, timeout: 30_000 },
    { key: 'worktree list --porcelain', timeout: 15_000 },
    { key: `show-ref --verify --quiet refs/heads/${identity.branch}`, timeout: 15_000 },
  ]);
  assert.strictEqual(invalidations, 1);

  console.log('test-worktree-git-service passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
