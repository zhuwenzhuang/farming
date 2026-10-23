const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  copyIfExists,
  nodePty,
  loadNodePtyNativeModule,
} = require('../packaged-node-pty.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-packaged-node-pty.'));
  const source = path.join(root, 'source.node');
  const target = path.join(root, 'runtime', 'pty.node');
  try {
    fs.writeFileSync(source, 'native-addon-v1');
    const brokenPackage = path.join(root, 'broken-node-pty');
    const nativeDir = path.join(brokenPackage, 'prebuilds', `${process.platform}-${process.arch}`);
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, 'pty.node'), 'invalid native library');
    assert.throws(() => loadNodePtyNativeModule(brokenPackage, 'pty'), error => {
      assert.match(error.message, /Failed to load node-pty native module/);
      assert.strictEqual(error.cause?.code, 'ERR_DLOPEN_FAILED');
      assert.ok(error.message.includes(error.cause.message), 'preserve the original loader diagnostic');
      assert.ok(!error.message.includes('Cannot find module'), 'later missing paths must not mask dlopen');
      return true;
    });
    assert.throws(() => loadNodePtyNativeModule(brokenPackage, 'missing'), /Missing node-pty native module/);
    assert.strictEqual(typeof nodePty.spawn, 'function');
    const pty = nodePty.spawn(
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/c', 'echo farming-pty-ready'] : ['-c', 'printf farming-pty-ready'],
      { cwd: root, env: process.env },
    );
    let output = '';
    let exited = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const data = pty.onData(chunk => { output += chunk; });
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('native PTY smoke timed out')), 5000);
        pty.onExit(({ exitCode }) => {
          exited = true;
          if (exitCode === 0) resolve();
          else reject(new Error(`native PTY exited with ${exitCode}`));
        });
      });
      assert.ok(output.includes('farming-pty-ready'), 'selected addon and spawn helper must start a real PTY');
    } finally {
      clearTimeout(timer);
      data.dispose();
      if (!exited) pty.kill();
    }
    assert.strictEqual(copyIfExists(source, target), true);
    const firstStat = fs.statSync(target);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'native-addon-v1');

    assert.strictEqual(copyIfExists(source, target), true);
    const unchangedStat = fs.statSync(target);
    assert.strictEqual(
      unchangedStat.ino,
      firstStat.ino,
      'loading the same native addon twice must not replace or truncate its mapped inode',
    );

    fs.writeFileSync(source, 'native-addon-v2-with-new-bytes');
    assert.strictEqual(copyIfExists(source, target), true);
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

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
