const assert = require('node:assert/strict');
const { NativePtyHostClient } = require('../native-pty-host-client.cjs');

async function testPendingRegistration(fail: boolean) {
  let complete!: () => void;
  let reject!: (error: Error) => void;
  const registration = new Promise<void>((resolve, rejectPromise) => {
    complete = resolve;
    reject = rejectPromise;
  });
  // Model the exact cut after connectOnce attaches the socket, before the
  // runtime/controller handshake settles. No real process or socket is owned.
  const client = {
    disposed: false,
    socket: { destroyed: false },
    connecting: registration,
  };
  const outcomes: Array<'ready' | 'failed'> = [];
  const failure = new Error('controller registration rejected');
  const waiters = Array.from({ length: 3 }, () =>
    NativePtyHostClient.prototype.ensureConnected.call(client).then(
      () => { outcomes.push('ready'); },
      (error: unknown) => {
        assert.equal(error, failure);
        outcomes.push('failed');
      },
    ));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(outcomes, [], 'an attached socket must not bypass pending controller registration');
    if (fail) reject(failure);
    else complete();
    await Promise.all(waiters);
    assert.deepEqual(outcomes, Array(3).fill(fail ? 'failed' : 'ready'));
  } finally {
    complete();
    await Promise.allSettled(waiters);
  }
}

async function run() {
  await testPendingRegistration(false);
  await testPendingRegistration(true);
  await assert.rejects(
    NativePtyHostClient.prototype.ensureConnected.call({ disposed: true }),
    /disposed/,
  );
  console.log('native PTY connection admission tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
