const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_IMAGE_ARTIFACT_BYTES,
  writeWorkspaceImageArtifact,
} = require('../workspace-artifacts.cjs');

async function run() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-workspace-artifacts-'));
  const workspace = path.join(temporaryRoot, 'project');
  fs.mkdirSync(workspace);
  try {
    const artifact = await writeWorkspaceImageArtifact({
      bytes: Buffer.from('small image fixture'),
      capability: 'browser',
      mimeType: 'image/png',
      operation: 'screenshot',
      workspace,
    });
    assert.strictEqual(artifact.kind, 'image');
    assert(artifact.path.startsWith('.tmp/farming/browser/screenshot-'));
    const artifactPath = path.join(workspace, artifact.path);
    assert.strictEqual(fs.readFileSync(artifactPath, 'utf8'), 'small image fixture');
    assert.strictEqual(fs.statSync(artifactPath).mode & 0o777, 0o600);

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      writeWorkspaceImageArtifact({
        bytes: Buffer.from('must not be written'),
        capability: 'computer',
        operation: 'desktop',
        signal: aborted.signal,
        workspace,
      }),
      error => error.name === 'AbortError',
      'workspace artifact writes must honor the shared Computer request deadline signal',
    );

    await assert.rejects(
      writeWorkspaceImageArtifact({
        bytes: Buffer.alloc(MAX_IMAGE_ARTIFACT_BYTES + 1),
        capability: 'computer',
        operation: 'desktop',
        workspace,
      }),
      /exceeds/,
    );

    const escapedWorkspace = path.join(temporaryRoot, 'escaped-project');
    const outside = path.join(temporaryRoot, 'outside');
    fs.mkdirSync(escapedWorkspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(escapedWorkspace, '.tmp'));
    await assert.rejects(
      writeWorkspaceImageArtifact({
        bytes: Buffer.from('blocked'),
        capability: 'computer',
        operation: 'desktop',
        workspace: escapedWorkspace,
      }),
      /symlink|outside the Project workspace/,
    );
    assert.strictEqual(
      fs.existsSync(path.join(outside, 'farming')),
      false,
      'rejecting a symlinked artifact path must not create anything outside the workspace',
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log('Workspace artifact tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
