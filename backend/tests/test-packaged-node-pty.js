const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const packagedNodePty = require('../packaged-node-pty');

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-packaged-node-pty.'));
  const source = path.join(root, 'source.node');
  const target = path.join(root, 'runtime', 'pty.node');
  try {
    fs.writeFileSync(source, 'native-addon-v1');
    assert.strictEqual(packagedNodePty.copyIfExists(source, target), true);
    const firstStat = fs.statSync(target);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'native-addon-v1');

    assert.strictEqual(packagedNodePty.copyIfExists(source, target), true);
    const unchangedStat = fs.statSync(target);
    assert.strictEqual(
      unchangedStat.ino,
      firstStat.ino,
      'loading the same native addon twice must not replace or truncate its mapped inode',
    );

    fs.writeFileSync(source, 'native-addon-v2-with-new-bytes');
    assert.strictEqual(packagedNodePty.copyIfExists(source, target), true);
    const replacedStat = fs.statSync(target);
    assert.notStrictEqual(
      replacedStat.ino,
      unchangedStat.ino,
      'an upgraded native addon must use atomic replacement instead of rewriting a loaded file',
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'native-addon-v2-with-new-bytes');
    assert.strictEqual(
      fs.readdirSync(path.dirname(target)).some(name => name.endsWith('.tmp')),
      false,
      'atomic extraction must not leave temporary native addons behind',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('✓ Packaged node-pty extraction never rewrites a loaded native addon inode');
}

run();
