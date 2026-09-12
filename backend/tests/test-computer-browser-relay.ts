const assert = require('assert');
const { spawn } = require('child_process');
const net = require('net');
const {
  COMPUTER_BROWSER_RELAY_SCRIPT,
} = require('../../extensions/computer/backend/computer-resource-manager.cjs');

const RELAY_START_TIMEOUT_MS = 2_000;
const SOCKET_TIMEOUT_MS = 2_000;
const CLEANUP_TIMEOUT_MS = 2_000;

function listen(server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function connect(port: number): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(new Error(`Timed out connecting to ${port}`));
      }
    }, SOCKET_TIMEOUT_MS);
    const onError = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('error', onError);
      // Keep later socket errors from becoming unhandled after this helper
      // has handed the connection to a test step.
      socket.on('error', () => {});
      resolve(socket);
    });
    socket.once('error', onError);
  });
}

function receive(socket, expected: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected.toString('utf8')}`));
    }, SOCKET_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
    };
    const onData = (data: Buffer) => {
      received = Buffer.concat([received, data]);
      if (received.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed before receiving ${expected.toString('utf8')}`));
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function exited(child): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs: number): Promise<void> {
  if (exited(child)) return Promise.resolve();
  return new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      child.removeListener('exit', finish);
      child.removeListener('error', finish);
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
    child.once('error', finish);
  });
}

async function stopRelay(child): Promise<void> {
  if (!exited(child)) child.kill('SIGKILL');
  await waitForExit(child, SOCKET_TIMEOUT_MS);
  assert(exited(child), 'relay process must terminate during test cleanup');
}

async function waitForRelay(port: number, child): Promise<void> {
  const deadline = Date.now() + RELAY_START_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (exited(child)) {
      throw new Error(`relay exited before listening (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    try {
      const probe = await connect(port);
      probe.destroy();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error(`relay did not listen: ${lastError?.message || 'unknown error'}`);
}

function closeServer(server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
  });
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(predicate(), message);
}

async function destroySocket(socket): Promise<void> {
  if (!socket || socket.destroyed) return;
  await new Promise<void>(resolve => {
    socket.once('close', () => resolve());
    socket.destroy();
  });
}

async function run() {
  const upstreamConnections = new Set<import('node:net').Socket>();
  let upstream;
  let relayPortPicker;
  let relay;
  let first;
  let second;
  try {
    upstream = net.createServer(socket => {
      upstreamConnections.add(socket);
      socket.on('error', () => {});
      socket.on('data', data => socket.write(Buffer.concat([Buffer.from('echo:'), data])));
      socket.once('close', () => upstreamConnections.delete(socket));
    });
    const upstreamPort = await listen(upstream);
    relayPortPicker = net.createServer();
    const relayPort = await listen(relayPortPicker);
    await closeServer(relayPortPicker);

    const relayBinding = '("0.0.0.0",9223)';
    const upstreamBinding = '("127.0.0.1",9222)';
    assert.strictEqual(COMPUTER_BROWSER_RELAY_SCRIPT.split(relayBinding).length - 1, 1);
    assert.strictEqual(COMPUTER_BROWSER_RELAY_SCRIPT.split(upstreamBinding).length - 1, 1);
    const relayScript = COMPUTER_BROWSER_RELAY_SCRIPT
      .replace(relayBinding, `("127.0.0.1",${relayPort})`)
      .replace(upstreamBinding, `("127.0.0.1",${upstreamPort})`);
    assert.notStrictEqual(relayScript, COMPUTER_BROWSER_RELAY_SCRIPT, 'test must use isolated relay ports');

    relay = spawn('python3', ['-c', relayScript], {
      stdio: 'ignore',
    });
    relay.once('error', () => {});
    await waitForRelay(relayPort, relay);

    first = await connect(relayPort);
    first.write('first');
    await receive(first, Buffer.from('echo:first'));

    // Keep the first CDP client open while accepting and forwarding the second.
    second = await connect(relayPort);
    second.write('second');
    await receive(second, Buffer.from('echo:second'));
    assert.strictEqual(first.destroyed, false, 'the first client must remain open during the second exchange');

    await destroySocket(first);
    first = undefined;
    second.write('second-after-first-close');
    await receive(second, Buffer.from('echo:second-after-first-close'));
  } finally {
    await destroySocket(first);
    await destroySocket(second);
    if (relay) await stopRelay(relay);
    for (const socket of upstreamConnections) socket.destroy();
    if (upstream) {
      await closeServer(upstream);
      await waitFor(
        () => upstreamConnections.size === 0,
        'all upstream client sockets must be cleaned up',
      );
    }
    if (relayPortPicker) await closeServer(relayPortPicker);
  }

  console.log('Computer Browser relay concurrent-client regression test passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
