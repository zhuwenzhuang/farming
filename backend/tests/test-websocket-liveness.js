const assert = require('assert');
const {
  advanceWebSocketLiveness,
  initializeWebSocketLiveness,
} = require('../../shared/websocket-liveness');

function socketFixture() {
  const handlers = new Map();
  return {
    readyState: 1,
    pings: 0,
    terminated: 0,
    on(event, handler) {
      handlers.set(event, handler);
    },
    ping() {
      this.pings += 1;
    },
    terminate() {
      this.terminated += 1;
    },
    emit(event) {
      handlers.get(event)?.();
    },
  };
}

const socket = socketFixture();
initializeWebSocketLiveness(socket);
assert.strictEqual(socket.farmingHeartbeatAlive, true);
assert.strictEqual(advanceWebSocketLiveness(socket, 1), 'pinged');
assert.strictEqual(socket.pings, 1);
assert.strictEqual(socket.farmingHeartbeatAlive, false);

socket.emit('pong');
assert.strictEqual(socket.farmingHeartbeatAlive, true);
assert.strictEqual(advanceWebSocketLiveness(socket, 1), 'pinged');
assert.strictEqual(socket.terminated, 0);

assert.strictEqual(advanceWebSocketLiveness(socket, 1), 'terminated');
assert.strictEqual(socket.terminated, 1);

socket.readyState = 3;
assert.strictEqual(advanceWebSocketLiveness(socket, 1), 'ignored');

const failedPingSocket = socketFixture();
initializeWebSocketLiveness(failedPingSocket);
failedPingSocket.ping = () => {
  throw new Error('socket closed during ping');
};
assert.strictEqual(advanceWebSocketLiveness(failedPingSocket, 1), 'terminated');
assert.strictEqual(failedPingSocket.terminated, 1);

console.log('test-websocket-liveness passed');
