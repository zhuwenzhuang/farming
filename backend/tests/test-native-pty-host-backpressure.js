const assert = require('assert');
const NativePtyHost = require('../native-pty-host');

function fakeSocket(options = {}) {
  return {
    destroyed: false,
    writableLength: options.writableLength || 0,
    writes: [],
    errors: [],
    write(message) {
      this.writes.push(message);
      this.writableLength += Buffer.byteLength(message);
      return options.acceptWrite !== false;
    },
    destroy(error) {
      this.destroyed = true;
      this.errors.push(error);
    },
  };
}

function hostForTest() {
  const host = Object.create(NativePtyHost.prototype);
  host.clients = new Set();
  host.clientMaxBufferedBytes = 100;
  host.clientMaxRequestBytes = 40;
  return host;
}

function run() {
  const host = hostForTest();
  const healthy = { socket: fakeSocket(), buffer: '' };
  const slow = { socket: fakeSocket({ writableLength: 101 }), buffer: '' };
  host.clients.add(healthy);
  host.clients.add(slow);

  host.broadcast('session-output', { data: 'hello' });
  assert.strictEqual(healthy.socket.writes.length, 1);
  assert.strictEqual(healthy.socket.destroyed, false);
  assert.strictEqual(slow.socket.writes.length, 0);
  assert.strictEqual(slow.socket.destroyed, true, 'a slow native client should be isolated');
  assert.match(slow.socket.errors[0].message, /backpressure/);

  const rejected = { socket: fakeSocket({ writableLength: 90, acceptWrite: false }), buffer: '' };
  assert.strictEqual(host.writeClientMessage(rejected, 'x'.repeat(20)), false);
  assert.strictEqual(rejected.socket.destroyed, true, 'a rejected write over the limit should disconnect');

  const incomplete = { socket: fakeSocket(), buffer: '' };
  host.handleClientData(incomplete, Buffer.from('x'.repeat(41)));
  assert.strictEqual(incomplete.socket.destroyed, true, 'an unterminated oversized request should disconnect');

  const oversizedLine = { socket: fakeSocket(), buffer: '' };
  host.handleClientData(oversizedLine, Buffer.from(`${'x'.repeat(41)}\n`));
  assert.strictEqual(oversizedLine.socket.destroyed, true, 'an oversized complete request should disconnect');

  console.log('native PTY host backpressure tests passed');
}

run();
