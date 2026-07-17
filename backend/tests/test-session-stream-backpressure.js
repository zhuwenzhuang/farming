const assert = require('assert');
const {
  deliverSessionStreamToClients,
} = require('../session-stream-protocol');

function client(options = {}) {
  return {
    readyState: options.readyState ?? 1,
    bufferedAmount: options.bufferedAmount ?? 0,
    streamScope: options.streamScope || 'all',
    focusedAgentId: options.focusedAgentId || '',
    sent: [],
    closed: [],
    send(message) {
      this.sent.push(message);
    },
    close(code, reason) {
      this.closed.push({ code, reason });
      this.readyState = 2;
    },
  };
}

function run() {
  const healthy = client();
  const slow = client({ bufferedAmount: 101 });
  const unfocused = client({ streamScope: 'focused', focusedAgentId: 'agent-b' });
  const closing = client({ readyState: 2, bufferedAmount: 1000 });
  const stream = { agentId: 'agent-a', data: 'hello' };
  const result = deliverSessionStreamToClients(
    [healthy, slow, unfocused, closing],
    stream,
    { maxBufferedAmount: 100, openState: 1 },
  );

  assert.deepStrictEqual(result, { sent: 1, closed: 1, skipped: 2 });
  assert.strictEqual(healthy.sent.length, 1);
  assert.deepStrictEqual(JSON.parse(healthy.sent[0]), {
    type: 'session-output',
    stream,
  });
  assert.deepStrictEqual(slow.closed, [{
    code: 1013,
    reason: 'terminal stream backpressure',
  }]);
  assert.strictEqual(slow.sent.length, 0);
  assert.strictEqual(unfocused.sent.length, 0);
  assert.strictEqual(unfocused.closed.length, 0);
  assert.strictEqual(closing.closed.length, 0, 'a closing socket must not be closed repeatedly');

  deliverSessionStreamToClients([slow], stream, {
    maxBufferedAmount: 100,
    openState: 1,
  });
  assert.strictEqual(slow.closed.length, 1);

  console.log('session stream backpressure tests passed');
}

run();
