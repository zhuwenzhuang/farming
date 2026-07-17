const assert = require('assert');
const {
  MAX_REPLAY_EVENT_BYTES,
  TERMINAL_STATE_VERSION,
  deserializeTerminalState,
  serializeTerminalState,
} = require('../terminal-state-serialization');

function entry(overrides = {}) {
  return {
    id: 'agent-terminal-revive',
    metadata: {
      agentId: 'agent-terminal-revive',
      category: 'shell',
    },
    processDetails: {
      cwd: '/tmp/example',
      title: 'bash',
    },
    processLaunchConfig: {
      command: '/bin/bash',
      args: ['-l'],
      category: 'shell',
    },
    replayEvent: {
      events: [{
        data: 'before rotation\r\n$ ',
        cols: 120,
        rows: 40,
      }],
    },
    timestamp: 1234,
    ...overrides,
  };
}

function expectRejected(serialized, pattern) {
  assert.throws(() => deserializeTerminalState(serialized), pattern);
}

function run() {
  const serialized = serializeTerminalState([entry()]);
  const parsedEnvelope = JSON.parse(serialized);
  assert.strictEqual(parsedEnvelope.version, TERMINAL_STATE_VERSION);
  const restored = deserializeTerminalState(serialized);
  assert.deepStrictEqual(restored, [entry()]);

  expectRejected('{', /not valid JSON/);
  expectRejected(JSON.stringify({ version: TERMINAL_STATE_VERSION + 1, state: [] }), /unsupported format or version/);
  expectRejected(JSON.stringify({
    version: TERMINAL_STATE_VERSION,
    state: [entry({ id: '../escape' })],
  }), /invalid session id/);
  expectRejected(JSON.stringify({
    version: TERMINAL_STATE_VERSION,
    state: [entry(), entry()],
  }), /duplicate session id/);
  expectRejected(JSON.stringify({
    version: TERMINAL_STATE_VERSION,
    state: [entry({
      replayEvent: {
        events: [{
          data: 'x'.repeat(MAX_REPLAY_EVENT_BYTES + 1),
          cols: 80,
          rows: 30,
        }],
      },
    })],
  }), /replay event exceeds the size limit/);

  console.log('terminal state serialization tests passed');
}

run();
