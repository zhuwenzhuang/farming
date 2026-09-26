import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceFileService } from '../workspace-file-service.cjs';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farming-diff-blame-')));
const root = path.join(workspace, 'nested');
const service = new WorkspaceFileService({ gitStatusCacheTtlMs: 0 });
const small = new WorkspaceFileService({ maxFileSize: 1 });
function git(...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function run() {
  try {
    fs.mkdirSync(root);
    git('init');
    git('config', 'user.email', 'author@example.test');
    git('config', 'user.name', 'Original Author');
    git('config', 'core.hooksPath', '/dev/null');
    fs.writeFileSync(path.join(root, 'file.txt'), 'original\ncontext\n');
    git('add', '.'); git('commit', '-qm', 'Original commit');
    const originalRevision = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'file.txt'), 'inserted\noriginal\ncontext\n');
    const diff = await service.diff(workspace, 'nested/file.txt');
    assert.ok('originalRevision' in diff && 'originalPath' in diff);
    assert.equal(diff.originalRevision, originalRevision);
    assert.equal(diff.originalPath, 'nested/file.txt');
    git('-c', 'user.name=New Author', 'commit', '-am', 'Later commit');
    const original = await service.blame(workspace, diff.originalPath, diff.originalRevision);
    assert.deepEqual(original.lines.map(line => line.content), ['original', 'context']);
    assert.ok(original.lines.every(line => line.author === 'Original Author'));
    const modified = await service.blame(workspace, 'nested/file.txt');
    assert.equal(modified.lines[0].author, 'New Author');
    assert.equal((await service.blameCapability(workspace, 'nested/file.txt', { revision: originalRevision })).available, true);

    git('mv', 'file.txt', 'renamed.txt');
    const renamed = await service.diff(workspace, 'nested/renamed.txt');
    assert.ok('originalRevision' in renamed && 'originalPath' in renamed);
    assert.equal(renamed.originalPath, 'nested/file.txt');
    assert.equal((await service.blame(workspace, renamed.originalPath, renamed.originalRevision)).lines.length, 3);
    git('reset', '--hard', 'HEAD');
    fs.unlinkSync(path.join(root, 'file.txt'));
    const deleted = await service.diff(workspace, 'nested/file.txt');
    assert.ok('deleted' in deleted && 'originalRevision' in deleted && 'originalPath' in deleted);
    assert.equal(deleted.deleted, true);
    assert.equal((await service.blame(workspace, deleted.originalPath, deleted.originalRevision)).lines.length, 3);
    await assert.rejects(service.blame(workspace, 'nested/file.txt', '--help'), /full git object id/);
    await assert.rejects(service.blameCapability(workspace, '../outside.txt', { revision: originalRevision }), /inside the workspace/);
    assert.equal((await small.blameCapability(workspace, 'nested/file.txt', { revision: originalRevision })).available, false);
    await assert.rejects(small.blame(workspace, 'nested/file.txt', originalRevision), /too large/);
    console.log('Diff blame revision, nested repository, rename, deletion, and boundary checks passed');
  } finally {
    await service.dispose();
    await small.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
