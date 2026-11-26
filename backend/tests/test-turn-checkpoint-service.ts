import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TurnCheckpointService } from '../turn-checkpoint-service.cjs';
import { createTurnCheckpointRouter } from '../turn-checkpoint-router.cjs';

const express = require('express');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function run(): Promise<void> {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farming-turn-checkpoints-')));
  const repoDir = path.join(tmpRoot, 'repo');
  const storageFile = path.join(tmpRoot, 'config', 'history', 'turn-checkpoints-v1.json');
  fs.mkdirSync(repoDir, { recursive: true });

  const mutatedRoots: string[] = [];
  const service = new TurnCheckpointService({
    storageFile,
    maxCheckpointsPerAgent: 4,
    onWorkspaceMutated: repoRoot => mutatedRoots.push(repoRoot),
  });

  try {
    // Initialize a real git repo with an ignored file that rollback must NEVER delete.
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@farming.local']);
    git(repoDir, ['config', 'user.name', 'Farming Test']);
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '.env\nignored_dir/\n');
    fs.writeFileSync(path.join(repoDir, 'app.ts'), 'export const version = 1;\n');
    fs.writeFileSync(path.join(repoDir, 'keep.ts'), 'export const keep = true;\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'initial']);
    const initialHead = git(repoDir, ['rev-parse', 'HEAD']);

    // Ignored local secret file must survive all captures & rollbacks.
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=keep-me\n');

    // 1. Capture baseline before Turn 1; no-op turn produces no noisy checkpoint.
    assert.strictEqual(await service.captureTurnBaseline('agent-1', repoDir), true);
    const emptyTurn = await service.captureTurnCheckpoint({
      agentId: 'agent-1',
      workspace: repoDir,
      turnHandle: 'turn-0',
      summary: 'Read-only turn',
    });
    assert.strictEqual(emptyTurn, null);

    // 2. Turn 1 modifies app.ts and adds feature.ts.
    fs.writeFileSync(path.join(repoDir, 'app.ts'), 'export const version = 2;\n');
    fs.writeFileSync(path.join(repoDir, 'feature.ts'), 'export const feature = "alpha";\n');
    const cp1 = await service.captureTurnCheckpoint({
      agentId: 'agent-1',
      workspace: repoDir,
      turnHandle: 'turn-1',
      summary: 'Implement alpha feature',
    });
    assert(cp1, 'Turn 1 must produce a hidden Git ref checkpoint');
    assert.strictEqual(cp1.files.length, 2);
    assert(cp1.beforeRef.startsWith('refs/farming/checkpoints/'));
    assert(cp1.afterRef.startsWith('refs/farming/checkpoints/'));
    // Must never pollute HEAD or branches.
    assert.strictEqual(git(repoDir, ['rev-parse', 'HEAD']), initialHead);
    assert.strictEqual(git(repoDir, ['status', '--porcelain']).includes('?? .env'), false);

    // 3. Turn 2 modifies app.ts again and deletes keep.ts.
    fs.writeFileSync(path.join(repoDir, 'app.ts'), 'export const version = 3;\n// broken edit\n');
    fs.unlinkSync(path.join(repoDir, 'keep.ts'));
    const cp2 = await service.captureTurnCheckpoint({
      agentId: 'agent-1',
      workspace: repoDir,
      turnHandle: 'turn-2',
      summary: 'Refactor version 3',
    });
    assert(cp2, 'Turn 2 must capture only Turn 2 delta');
    assert.deepStrictEqual(
      cp2.files.map(f => f.path).sort(),
      ['app.ts', 'keep.ts'],
      'Turn 2 checkpoint must isolate only Turn 2 changes, not feature.ts from Turn 1',
    );

    // 4. Exact per-turn diff shows only Turn 2 changes.
    const diff2 = await service.getCheckpointDiff('agent-1', cp2.id);
    assert(diff2.patch.includes('version = 3'));
    assert(!diff2.patch.includes('feature.ts'));

    // 5. Reject restore while agent is busy (409).
    await assert.rejects(
      () => service.restoreCheckpoint('agent-1', cp2.id, { target: 'before', isAgentBusy: true }),
      (error: { statusCode?: number }) => error?.statusCode === 409,
    );

    // 6. One-click rollback to BEFORE Turn 2 undoes version 3 & restores keep.ts, while keeping feature.ts and .env!
    const restored = await service.restoreCheckpoint('agent-1', cp2.id, { target: 'before' });
    assert.strictEqual(restored.restored, true);
    assert(restored.safetyCheckpoint, 'Rollback must save an automatic pre-restore safety backup');
    assert.strictEqual(fs.readFileSync(path.join(repoDir, 'app.ts'), 'utf8'), 'export const version = 2;\n');
    assert.strictEqual(fs.readFileSync(path.join(repoDir, 'keep.ts'), 'utf8'), 'export const keep = true;\n');
    assert.strictEqual(fs.readFileSync(path.join(repoDir, 'feature.ts'), 'utf8'), 'export const feature = "alpha";\n');
    assert.strictEqual(fs.readFileSync(path.join(repoDir, '.env'), 'utf8'), 'SECRET=keep-me\n');
    assert.strictEqual(mutatedRoots.length, 1);

    // 7. Undo the rollback using the safety checkpoint (restore target: 'after' of safetyCheckpoint)!
    const undone = await service.restoreCheckpoint('agent-1', restored.safetyCheckpoint.id, { target: 'after' });
    assert.strictEqual(undone.restored, true);
    assert.strictEqual(fs.readFileSync(path.join(repoDir, 'app.ts'), 'utf8'), 'export const version = 3;\n// broken edit\n');
    assert.strictEqual(fs.existsSync(path.join(repoDir, 'keep.ts')), false);

    // 8. Rollback all the way to BEFORE Turn 1 removes untracked feature.ts added in Turn 1!
    await service.restoreCheckpoint('agent-1', cp1.id, { target: 'before' });
    assert.strictEqual(fs.readFileSync(path.join(repoDir, 'app.ts'), 'utf8'), 'export const version = 1;\n');
    assert.strictEqual(fs.existsSync(path.join(repoDir, 'feature.ts')), false);
    assert.strictEqual(fs.readFileSync(path.join(repoDir, '.env'), 'utf8'), 'SECRET=keep-me\n');

    // 9. Verify persistence across service reload & router HTTP endpoints.
    const reloaded = new TurnCheckpointService({ storageFile });
    const listed = reloaded.listCheckpoints('agent-1');
    assert(listed.length >= 2);

    const app = express();
    let busy = false;
    app.use('/api/agents/:agentId/turn-checkpoints', createTurnCheckpointRouter(reloaded, {
      getAgent: id => (id === 'agent-1' ? { id, cwd: repoDir } : null),
      isAgentTurnActive: () => busy,
    }));
    const server = await new Promise<import('http').Server>(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    try {
      const listResp = await fetch(`http://127.0.0.1:${port}/api/agents/agent-1/turn-checkpoints`);
      assert.strictEqual(listResp.status, 200);
      const listData = await listResp.json() as { checkpoints: Array<{ id: string }> };
      assert(listData.checkpoints.length >= 2);

      const diffResp = await fetch(`http://127.0.0.1:${port}/api/agents/agent-1/turn-checkpoints/${listData.checkpoints[0].id}/diff`);
      assert.strictEqual(diffResp.status, 200);

      busy = true;
      const busyRestore = await fetch(`http://127.0.0.1:${port}/api/agents/agent-1/turn-checkpoints/${listData.checkpoints[0].id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'before' }),
      });
      assert.strictEqual(busyRestore.status, 409);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }

    // 10. Non-git workspace returns null cleanly without throwing.
    const nonGitDir = path.join(tmpRoot, 'plain-dir');
    fs.mkdirSync(nonGitDir, { recursive: true });
    assert.strictEqual(await service.captureTurnBaseline('agent-2', nonGitDir), false);
    assert.strictEqual(await service.captureTurnCheckpoint({ agentId: 'agent-2', workspace: nonGitDir }), null);

    console.log('✓ TurnCheckpointService hidden Git refs, turn diff isolation, safe rollback, and router passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
