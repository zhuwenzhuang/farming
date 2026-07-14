const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AcpPatchDecisionError, rejectPatch } = require('../acp/patch-decisions');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-patch-'));
  try {
    const modified = path.join(root, 'modified.txt');
    fs.writeFileSync(modified, 'after\n');
    const modifiedEntry = { content: [{ type: 'diff', path: modified, oldText: 'before\n', newText: 'after\n' }] };
    const modifiedResult = await rejectPatch({ entry: modifiedEntry, root, requestedPath: modified });
    assert.strictEqual(modifiedResult.action, 'reverted');
    assert.strictEqual(fs.readFileSync(modified, 'utf8'), 'before\n');

    const added = path.join(root, 'added.txt');
    fs.writeFileSync(added, 'new\n');
    await rejectPatch({
      entry: { content: [{ type: 'diff', path: added, oldText: null, newText: 'new\n', _meta: { kind: 'added' } }] },
      root,
      requestedPath: added,
    });
    assert.strictEqual(fs.existsSync(added), false);

    const deleted = path.join(root, 'deleted.txt');
    await rejectPatch({
      entry: { content: [{ type: 'diff', path: deleted, oldText: 'restored\n', newText: '', _meta: { kind: 'deleted' } }] },
      root,
      requestedPath: deleted,
    });
    assert.strictEqual(fs.readFileSync(deleted, 'utf8'), 'restored\n');

    const conflicted = path.join(root, 'conflicted.txt');
    fs.writeFileSync(conflicted, 'newer change\n');
    await assert.rejects(
      () => rejectPatch({
        entry: { content: [{ type: 'diff', path: conflicted, oldText: 'before\n', newText: 'after\n' }] },
        root,
        requestedPath: conflicted,
      }),
      error => error instanceof AcpPatchDecisionError && error.statusCode === 409,
    );
    assert.strictEqual(fs.readFileSync(conflicted, 'utf8'), 'newer change\n');

    const outside = path.join(root, '..', 'outside.txt');
    await assert.rejects(
      () => rejectPatch({
        entry: { content: [{ type: 'diff', path: outside, oldText: '', newText: 'outside' }] },
        root,
        requestedPath: outside,
      }),
      error => error instanceof AcpPatchDecisionError && error.statusCode === 403,
    );

    const real = path.join(root, 'real.txt');
    const linked = path.join(root, 'linked.txt');
    fs.writeFileSync(real, 'after\n');
    fs.symlinkSync(real, linked);
    await assert.rejects(
      () => rejectPatch({
        entry: { content: [{ type: 'diff', path: linked, oldText: 'before\n', newText: 'after\n' }] },
        root,
        requestedPath: linked,
      }),
      error => error instanceof AcpPatchDecisionError && /symbolic link/.test(error.message),
    );
    assert.strictEqual(fs.readFileSync(real, 'utf8'), 'after\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('ACP patch decision tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
