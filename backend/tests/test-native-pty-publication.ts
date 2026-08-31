const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { NativePtyHost } = require('../native-pty-host.cjs');
const { NativePtyHostClient } = require('../native-pty-host-client.cjs');
const { nativePtyHostSocketPath } = require('../native-pty-host-path.cjs');
const { probeUnixSocket } = require('../terminal-runtime-cleanup.cjs');

async function run() {
  if (process.platform === 'win32') {
    console.log('native PTY Unix socket publication test skipped on Windows');
    return;
  }

  const publicationConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-publication-'));
  const publicationSocketPath = nativePtyHostSocketPath(publicationConfigDir);
  const publicationHost = new NativePtyHost({ configDir: publicationConfigDir, exitOnShutdown: false });
  const publicationClient = new NativePtyHostClient({ configDir: publicationConfigDir });
  const foreignSocketPath = `${publicationSocketPath}.foreign`;
  const originalLink = fs.linkSync;
  let restoredBeforeHostPublication = false;
  let foreignServer;
  try {
    // The kernel exposes the private listener before the host's listen
    // callback publishes its public link. Insert the client's real recovery
    // action at that exact boundary rather than depending on scheduling luck.
    fs.linkSync = (source, destination) => {
      if (
        source === publicationHost.boundSocketPath
        && destination === publicationSocketPath
        && !restoredBeforeHostPublication
      ) {
        restoredBeforeHostPublication = true;
        publicationClient.restorePublicSocketPath(source);
      }
      return originalLink(source, destination);
    };
    await publicationHost.start();
    fs.linkSync = originalLink;
    assert(restoredBeforeHostPublication, 'the client must publish before host startup resumes');
    assert.strictEqual(
      fs.statSync(publicationSocketPath, { bigint: true }).ino,
      fs.statSync(publicationHost.boundSocketPath, { bigint: true }).ino,
      'client-first publication must retain the host private listener identity',
    );
    assert.strictEqual((await probeUnixSocket(publicationSocketPath)).active, true);
    publicationClient.restorePublicSocketPath(publicationHost.boundSocketPath);

    foreignServer = net.createServer(socket => socket.end());
    await new Promise<void>((resolve, reject) => {
      foreignServer.once('error', reject);
      foreignServer.listen(foreignSocketPath, resolve);
    });
    fs.unlinkSync(publicationSocketPath);
    fs.linkSync(foreignSocketPath, publicationSocketPath);
    assert.throws(
      () => publicationClient.restorePublicSocketPath(publicationHost.boundSocketPath),
      error => error?.code === 'EEXIST',
      'recovery must reject a public link owned by a different socket',
    );
    let publicationConnectAttempts = 0;
    publicationClient.resolveConnectSocketPath = async () => {
      publicationConnectAttempts += 1;
      return publicationHost.boundSocketPath;
    };
    await assert.rejects(
      () => publicationClient.ensureConnected({ startHost: false }),
      error => error?.code === 'EEXIST',
      'a publication conflict after connect must reject instead of escaping the socket callback',
    );
    assert.strictEqual(publicationConnectAttempts, 1, 'a foreign public socket must fail closed without retry');
    assert.strictEqual(
      fs.statSync(publicationSocketPath, { bigint: true }).ino,
      fs.statSync(foreignSocketPath, { bigint: true }).ino,
      'failed recovery must preserve the competing listener',
    );
  } finally {
    fs.linkSync = originalLink;
    publicationClient.disconnect();
    try {
      await publicationHost.dispose();
    } finally {
      try {
        if (foreignServer) await new Promise<void>(resolve => foreignServer.close(() => resolve()));
      } finally {
        fs.rmSync(publicationSocketPath, { force: true });
        fs.rmSync(foreignSocketPath, { force: true });
        fs.rmSync(publicationConfigDir, { recursive: true, force: true });
      }
    }
  }

  console.log('test-native-pty-publication passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
