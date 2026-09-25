const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WorkspaceFileService } = require('../workspace-file-service.cjs');

async function run() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-change-pages-'));
  const root = path.join(temp, 'project');
  const source = path.join(temp, 'source');
  const service = new WorkspaceFileService();
  const git = (cwd: string, ...args: string[]) => String(execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  const init = async (cwd: string) => {
    await fs.mkdir(cwd, { recursive: true });
    git(cwd, 'init', '-q'); git(cwd, 'config', 'user.name', 'Fixture'); git(cwd, 'config', 'user.email', 'fixture@example.test');
    git(cwd, 'config', 'core.hooksPath', '/dev/null');
  };
  try {
    await init(source); await fs.writeFile(path.join(source, 'code.txt'), 'base\n');
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
    await init(root); git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'module');
    git(root, 'commit', '-qm', 'base');
    const child = path.join(root, 'module');
    await fs.writeFile(path.join(child, 'code.txt'), 'dirty\n');
    await fs.writeFile(path.join(child, 'new.txt'), 'new\n');
    for (let i = 0; i < 1005; i++) await fs.writeFile(path.join(root, `file-${String(i).padStart(4, '0')}.txt`), 'fixture');
    const inventory = await service.changesInventory(root);
    assert.equal(inventory.repositories[0].trackedCount, 0, 'child dirtiness must not become a duplicate parent change');
    assert.equal(inventory.repositories[0].untrackedCount, 1005);
    assert.equal(inventory.repositories[1].trackedCount, 1);
    assert.equal(inventory.repositories[1].untrackedCount, 1);
    const childPage = await service.changesPage(root, { repositoryPath: 'module', scope: 'untracked', limit: 1 });
    assert.deepEqual(childPage.items.map(item => item.path), ['module/new.txt']);
    let cursor = `${inventory.repositories[0].revision}:0`;
    const seen: string[] = [];
    do {
      const page = await service.changesPage(root, { scope: 'untracked', limit: 100, cursor });
      assert.equal(page.total, 1005); seen.push(...page.items.map(item => item.path)); cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 1005); assert.equal(new Set(seen).size, 1005);
    await assert.rejects(service.changesPage(root, { repositoryPath: 'module', scope: 'tracked', cursor: `${inventory.repositories[0].revision}:0` }), /changed/);
    await fs.writeFile(path.join(root, 'newer.txt'), 'new');
    await assert.rejects(service.changesPage(root, { scope: 'untracked', cursor: `${inventory.repositories[0].revision}:100` }), /Refresh/);
    git(child, 'config', 'user.name', 'Fixture'); git(child, 'config', 'user.email', 'fixture@example.test'); git(child, 'config', 'core.hooksPath', '/dev/null');
    git(child, 'add', 'code.txt'); git(child, 'commit', '-qm', 'version');
    const version = await service.changesPage(root, { scope: 'tracked' });
    assert.equal(version.items.length, 1); assert.equal(version.items[0].submodule, true); assert.equal(version.items[0].path, 'module');
    git(root, 'add', 'module');
    const stagedVersion = await service.changesPage(root, { scope: 'tracked' });
    assert.equal(stagedVersion.items[0].indexStatus, 'M'); assert.equal(stagedVersion.items[0].submodule, true);
    git(root, 'rm', '--cached', '-f', '-q', 'module');
    const removedVersion = await service.changesPage(root, { scope: 'tracked' });
    assert.equal(removedVersion.items.find(item => item.path === 'module')?.indexStatus, 'D');
    assert.equal(removedVersion.items.find(item => item.path === 'module')?.submodule, true);
    git(root, 'reset', '-q', 'HEAD', '--', 'module');
    const baseVersion = git(source, 'rev-parse', 'HEAD');
    const childVersion = git(child, 'rev-parse', 'HEAD');
    execFileSync('git', ['-C', root, 'update-index', '--index-info'], { input:
      `0 ${'0'.repeat(40)}\tmodule\n160000 ${baseVersion} 1\tmodule\n160000 ${childVersion} 2\tmodule\n160000 ${baseVersion} 3\tmodule\n`,
      stdio: ['pipe', 'pipe', 'pipe'] });
    const conflict = (await service.changesPage(root, { scope: 'tracked' })).items.find(item => item.path === 'module');
    assert.equal(conflict?.gitStatus, 'conflicted'); assert.equal(conflict?.submodule, true);
    git(root, 'reset', '-q', 'HEAD', '--', 'module');
    const original = 'old name\nwith newline.txt';
    const renamed = 'new name\nwith newline.txt';
    await fs.writeFile(path.join(root, original), 'rename fixture');
    git(root, 'add', '--', original); git(root, 'commit', '-qm', 'rename base');
    git(root, 'mv', '--', original, renamed);
    const rename = (await service.changesPage(root, { scope: 'tracked' })).items.find(item => item.path === renamed);
    assert.equal(rename?.previousPath, original); assert.equal(rename?.indexStatus, 'R');
    await fs.symlink(source, path.join(root, 'escaped'));
    await assert.rejects(service.changesPage(root, { repositoryPath: 'escaped', scope: 'tracked' }), /outside/);
    await assert.rejects(service.changesPage(root, { repositoryPath: '../source', scope: 'tracked' }), /Invalid/);
    const bounded = new WorkspaceFileService({ commandRunner: { run: async () => { const e = Object.assign(new Error('large'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }); throw e; } } });
    try { await assert.rejects(bounded.changeSnapshot(root), /exceeds/); } finally { await bounded.dispose(); }
  } finally { await service.dispose(); await fs.rm(temp, { recursive: true, force: true }); }
}
run().then(() => console.log('workspace change pagination passed')).catch(error => { console.error(error); process.exitCode = 1; });
