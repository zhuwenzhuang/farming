const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  WorktreeGitService,
  isFarmingForkWorktreePath,
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

  const temporaryExec = async (_executable: string, args: readonly string[]) => {
    const key = commandKey(args);
    if (key.startsWith('worktree add ')) throw timedOut;
    if (key === 'worktree list --porcelain') return { stdout: '', stderr: '' };
    throw new Error(`Unexpected git command: ${key}`);
  };
  const temporaryOne = new WorktreeGitService({
    now: () => new Date(2026, 7, 9, 12, 34, 56),
    identityNonce: () => 'e'.repeat(32),
    pathExists: () => false,
    execFile: temporaryExec,
  });
  const temporaryTwo = new WorktreeGitService({
    now: () => new Date(2026, 7, 9, 12, 34, 56),
    identityNonce: () => 'f'.repeat(32),
    pathExists: () => false,
    execFile: temporaryExec,
  });
  const [temporaryMutationOne, temporaryMutationTwo] = await Promise.all([
    temporaryOne.allocateTemporaryWorktree('/projects/repo').then(identity => (
      temporaryOne.createTemporaryWorktree(identity)
    )),
    temporaryTwo.allocateTemporaryWorktree('/projects/repo').then(identity => (
      temporaryTwo.createTemporaryWorktree(identity)
    )),
  ]);
  assert.notStrictEqual(
    temporaryMutationOne.identity.workspace,
    temporaryMutationTwo.identity.workspace,
    'independent Farming instances must allocate different temporary worktree identities',
  );
  assert.match(
    path.basename(temporaryMutationOne.identity.workspace),
    /^repo-farming-fork-20260809-123456-\d+$/,
    'the nonce-bearing identity must remain compatible with the Farming fork path contract',
  );
  const crossInstanceNumericOne = path.basename(temporaryMutationOne.identity.workspace)
    .match(/20260809-123456-(\d+)$/)?.[1] || '';
  const crossInstanceNumericTwo = path.basename(temporaryMutationTwo.identity.workspace)
    .match(/20260809-123456-(\d+)$/)?.[1] || '';
  assert.strictEqual(crossInstanceNumericOne.length, 42);
  assert.strictEqual(crossInstanceNumericTwo.length, 42);
  assert.notStrictEqual(
    crossInstanceNumericOne.slice(0, 39),
    crossInstanceNumericTwo.slice(0, 39),
    'temporary identities must retain a full 128-bit, 39-digit decimal nonce segment',
  );
  assert.strictEqual(crossInstanceNumericOne.slice(39), '001');
  assert.deepStrictEqual(temporaryMutationOne.postcondition, {
    proven: true,
    exists: false,
    registered: false,
    branchMatches: true,
    branchExists: false,
    worktree: null,
  });

  const deleteUncertainService = new WorktreeGitService({
    pathExists: () => { throw permissionError; },
    execFile: async (_executable, args) => {
      const key = commandKey(args);
      if (key.startsWith('worktree remove ')) throw timedOut;
      if (key === 'worktree list --porcelain') {
        return {
          stdout: `worktree ${identity.sourceWorkspace}\nbranch refs/heads/main\n\nworktree ${identity.workspace}\ndetached\n`,
          stderr: '',
        };
      }
      throw new Error(`Unexpected git command: ${key}`);
    },
  });
  const uncertainDelete = await deleteUncertainService.deleteWorktree(identity, true);
  assert.deepStrictEqual(uncertainDelete.commandFailure, { cause: timedOut, message: 'timed out' });
  assert.strictEqual(uncertainDelete.postcondition.proven, false);
  assert.strictEqual(uncertainDelete.postcondition.registered, true);
  assert.strictEqual(uncertainDelete.postcondition.error, 'permission denied');

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-temporary-worktree-service-'));
  try {
    const sourceWorkspace = path.join(temporaryRoot, 'repo');
    fs.mkdirSync(sourceWorkspace);
    const registered = new Set<string>();
    const concurrentTemporaryService = new WorktreeGitService({
      now: () => new Date(2026, 7, 9, 12, 34, 56),
      identityNonce: () => 'g'.repeat(32),
      execFile: async (_executable, args) => {
        const key = commandKey(args);
        if (key.startsWith('worktree add ')) {
          const target = String(args[4]);
          fs.mkdirSync(target);
          registered.add(path.resolve(target));
          return { stdout: '', stderr: '' };
        }
        if (key === 'worktree list --porcelain') {
          return {
            stdout: [
              `worktree ${sourceWorkspace}`,
              'branch refs/heads/main',
              ...Array.from(registered, workspace => `\nworktree ${workspace}\ndetached`),
              '',
            ].join('\n'),
            stderr: '',
          };
        }
        if (key === 'rev-parse --show-toplevel') {
          return { stdout: `${path.resolve(String(args[1]))}\n`, stderr: '' };
        }
        if (key === 'status --porcelain --untracked-files=all') {
          return { stdout: '', stderr: '' };
        }
        if (key.startsWith('worktree remove ')) {
          const target = path.resolve(String(args.at(-1)));
          registered.delete(target);
          fs.rmSync(target, { recursive: true, force: true });
          return { stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected git command: ${key}`);
      },
    });
    const [firstTemporary, secondTemporary] = await Promise.all([
      concurrentTemporaryService.allocateTemporaryWorktree(sourceWorkspace).then(identity => (
        concurrentTemporaryService.createTemporaryWorktree(identity)
      )),
      concurrentTemporaryService.allocateTemporaryWorktree(sourceWorkspace).then(identity => (
        concurrentTemporaryService.createTemporaryWorktree(identity)
      )),
    ]);
    assert.notStrictEqual(firstTemporary.identity.workspace, secondTemporary.identity.workspace);
    const concurrentNumericSegments = [firstTemporary, secondTemporary].map(mutation => (
      path.basename(mutation.identity.workspace).match(/20260809-123456-(\d+)$/)?.[1] || ''
    ));
    assert.deepStrictEqual(
      new Set(concurrentNumericSegments.map(segment => segment.slice(39))),
      new Set(['001', '002']),
      'same-nonce allocations must use an unambiguous fixed-width suffix',
    );
    assert.strictEqual(concurrentNumericSegments[0].slice(0, 39), concurrentNumericSegments[1].slice(0, 39));
    assert(concurrentNumericSegments.every(segment => segment.length === 42));
    for (const mutation of [firstTemporary, secondTemporary]) {
      assert.strictEqual(isFarmingForkWorktreePath(mutation.identity.workspace), true);
      const inspection = await concurrentTemporaryService.inspectForkWorktree(mutation.identity.workspace);
      assert.strictEqual(inspection.error, undefined);
      const deletion = await concurrentTemporaryService.deleteWorktree(mutation.identity, true);
      assert.strictEqual(deletion.postcondition.proven, true);
      assert.strictEqual(deletion.postcondition.exists, false);
      assert.strictEqual(deletion.postcondition.registered, false);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const realGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-temporary-worktree-rollback-'));
  try {
    const initializeRepository = (repository: string) => {
      fs.mkdirSync(repository);
      execFileSync('git', ['init', '-q', repository]);
      execFileSync('git', ['-C', repository, 'config', 'user.email', 'farming-test@example.invalid']);
      execFileSync('git', ['-C', repository, 'config', 'user.name', 'Farming Test']);
      fs.writeFileSync(path.join(repository, 'README.md'), 'fixture\n');
      execFileSync('git', ['-C', repository, 'add', 'README.md']);
      execFileSync('git', ['-C', repository, 'commit', '-qm', 'fixture']);
    };
    const sourceWorkspace = path.join(realGitRoot, 'repo');
    const otherSourceWorkspace = path.join(realGitRoot, 'other-repo');
    initializeRepository(sourceWorkspace);
    initializeRepository(otherSourceWorkspace);
    const realService = new WorktreeGitService({
      now: () => new Date(2026, 7, 9, 12, 34, 56),
      identityNonce: () => 'h'.repeat(32),
    });

    const cleanIdentity = await realService.allocateTemporaryWorktree(sourceWorkspace);
    const clean = await realService.createTemporaryWorktree(cleanIdentity);
    assert.strictEqual(clean.postcondition.proven, true);
    assert.deepStrictEqual(
      await realService.rollbackTemporaryWorktree(clean.identity),
      { rolledBack: true },
    );
    assert.strictEqual(fs.existsSync(clean.identity.workspace), false);

    const dirtyIdentity = await realService.allocateTemporaryWorktree(sourceWorkspace);
    const dirty = await realService.createTemporaryWorktree(dirtyIdentity);
    fs.writeFileSync(path.join(dirty.identity.workspace, 'uncommitted.txt'), 'retain me\n');
    const retainedDirty = await realService.rollbackTemporaryWorktree(dirty.identity);
    assert.strictEqual(retainedDirty.rolledBack, false);
    assert.strictEqual(retainedDirty.retainedWorkspace, dirty.identity.workspace);
    assert.match(retainedDirty.error || '', /uncommitted changes/);
    assert.strictEqual(fs.existsSync(dirty.identity.workspace), true);
    await realService.deleteWorktree(dirty.identity, true);

    const wrongSourceIdentity = await realService.allocateTemporaryWorktree(sourceWorkspace);
    const wrongSource = await realService.createTemporaryWorktree(wrongSourceIdentity);
    const refusedWrongSource = await realService.rollbackTemporaryWorktree({
      sourceWorkspace: otherSourceWorkspace,
      workspace: wrongSource.identity.workspace,
    });
    assert.strictEqual(refusedWrongSource.rolledBack, false);
    assert.match(refusedWrongSource.error || '', /does not match/);
    assert.strictEqual(fs.existsSync(wrongSource.identity.workspace), true);
    await realService.deleteWorktree(wrongSource.identity, true);
  } finally {
    fs.rmSync(realGitRoot, { recursive: true, force: true });
  }

  console.log('test-worktree-git-service passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
