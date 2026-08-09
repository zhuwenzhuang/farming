const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  WorkspaceFileError,
  WorkspaceFileService,
} = require('../workspace-file-service.cjs') as typeof import('../workspace-file-service.cjs');

async function run(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'farming-workspace-containment-'));
  const workspace = path.join(root, 'workspace');
  const legalDotDotName = path.join(workspace, '..foo');
  const outside = path.join(root, 'outside.txt');
  const service = new WorkspaceFileService();

  try {
    await fsp.mkdir(legalDotDotName, { recursive: true });
    await fsp.writeFile(path.join(legalDotDotName, 'inside.txt'), 'inside');
    await fsp.writeFile(outside, 'outside');

    const legal = await service.resolvePath(workspace, '..foo/inside.txt');
    assert.strictEqual(legal.relativePath, '..foo/inside.txt');
    assert.strictEqual(await fsp.readFile(legal.target, 'utf8'), 'inside');

    await assert.rejects(
      service.resolvePath(workspace, '../outside.txt'),
      (error: unknown) => error instanceof WorkspaceFileError
        && error.statusCode === 403
        && error.message === 'path must stay inside the workspace',
      'a real sibling path must not be authorized by a shared text prefix',
    );
    await assert.rejects(
      service.resolvePath(workspace, '../missing.txt', { allowMissing: true }),
      (error: unknown) => error instanceof WorkspaceFileError && error.statusCode === 403,
      'allowMissing must not weaken lexical workspace containment',
    );
  } finally {
    await service.dispose();
    await fsp.rm(root, { recursive: true, force: true });
  }

  console.log('workspace path containment passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
