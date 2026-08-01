const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  nativePtyHostPrivateSocketPath,
  nativePtyHostSocketPath,
} = require('../native-pty-host-path.cjs');

function run() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-pty-path-'));
  const previousTmpdir = process.env.TMPDIR;
  try {
    const realConfigDir = path.join(fixtureRoot, 'real-config');
    const otherConfigDir = path.join(fixtureRoot, 'other-config');
    const linkedConfigDir = path.join(fixtureRoot, 'linked-config');
    const realFutureConfigDir = path.join(realConfigDir, 'future', 'config');
    const linkedFutureConfigDir = path.join(linkedConfigDir, 'future', 'config');
    fs.mkdirSync(realConfigDir);
    fs.mkdirSync(otherConfigDir);
    fs.symlinkSync(realConfigDir, linkedConfigDir, process.platform === 'win32' ? 'junction' : 'dir');

    const realSocketPath = nativePtyHostSocketPath(realConfigDir);
    assert.strictEqual(
      nativePtyHostSocketPath(linkedConfigDir),
      realSocketPath,
      'a symlinked Config directory must resolve to the same native PTY host',
    );
    assert.strictEqual(
      nativePtyHostSocketPath(linkedFutureConfigDir),
      nativePtyHostSocketPath(realFutureConfigDir),
      'a missing Config below a symlinked parent must keep the same native PTY host identity',
    );
    assert.notStrictEqual(
      nativePtyHostSocketPath(otherConfigDir),
      realSocketPath,
      'different Config directories must use different native PTY hosts',
    );
    assert.strictEqual(
      nativePtyHostPrivateSocketPath(nativePtyHostSocketPath(linkedConfigDir), {
        pid: 123,
        nonce: 'abcdef01',
      }),
      nativePtyHostPrivateSocketPath(realSocketPath, { pid: 123, nonce: 'abcdef01' }),
      'related private socket paths must share the canonical Config identity',
    );
    assert.notStrictEqual(
      nativePtyHostPrivateSocketPath(nativePtyHostSocketPath(otherConfigDir), {
        pid: 123,
        nonce: 'abcdef01',
      }),
      nativePtyHostPrivateSocketPath(realSocketPath, { pid: 123, nonce: 'abcdef01' }),
      'different Config directories must use different private socket identities',
    );

    if (process.platform !== 'win32') {
      process.env.TMPDIR = path.join(fixtureRoot, 'x'.repeat(120));
      const boundedSocketPath = nativePtyHostSocketPath(realConfigDir);
      assert.strictEqual(path.dirname(boundedSocketPath), '/tmp');
      assert(
        Buffer.byteLength(boundedSocketPath) <= 103,
        'native PTY Unix socket paths must stay within the portable platform limit',
      );
      assert(
        Buffer.byteLength(nativePtyHostPrivateSocketPath(boundedSocketPath, {
          pid: 123,
          nonce: 'abcdef01',
        })) <= 103,
        'related private socket paths must stay within the portable platform limit',
      );
      assert.strictEqual(
        nativePtyHostSocketPath(realConfigDir),
        boundedSocketPath,
        'Unix socket path fallback must be stable',
      );
    }

    console.log('test-native-pty-host-path passed');
  } finally {
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

run();
