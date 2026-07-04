const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  cleanupStaleNativePtySocket,
  cleanupTerminalRuntime,
} = require('../terminal-runtime-cleanup');
const { nativePtyHostSocketPath } = require('../native-pty-host-path');

async function listenUnixSocket(socketPath) {
  const server = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function closeServer(server) {
  await new Promise(resolve => server.close(() => resolve()));
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-runtime-cleanup-'));
  try {
    const nativeSocketPath = nativePtyHostSocketPath(configDir);
    fs.mkdirSync(path.dirname(nativeSocketPath), { recursive: true });
    fs.writeFileSync(nativeSocketPath, '');
    const staleSocket = await cleanupStaleNativePtySocket({
      socketPath: nativeSocketPath,
      timeoutMs: 20,
    });
    assert.strictEqual(staleSocket.removed, true);
    assert(!fs.existsSync(nativeSocketPath), 'stale native pty socket should be removed');

    const activeServer = await listenUnixSocket(nativeSocketPath);
    try {
      const activeSocket = await cleanupStaleNativePtySocket({
        socketPath: nativeSocketPath,
        timeoutMs: 100,
      });
      assert.strictEqual(activeSocket.active, true);
      assert.strictEqual(activeSocket.removed, false);
      assert(fs.existsSync(nativeSocketPath), 'active native pty socket should be preserved');
    } finally {
      await closeServer(activeServer);
      fs.rmSync(nativeSocketPath, { force: true });
    }

    const combined = await cleanupTerminalRuntime({
      configDir,
      timeoutMs: 20,
    });
    assert.strictEqual(combined.nativeSocket.removed, false);

    console.log('test-terminal-runtime-cleanup passed');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
