const assert = require('assert');
const { deriveRuntimeObservation } = require('../runtime-observation');

function run() {
  assert.deepStrictEqual(deriveRuntimeObservation({
    status: 'running',
    providerSessionProvider: 'codex',
    runtimeBinding: { kind: 'acp', state: 'waiting-for-permission' },
    lastActivity: 42,
  }), {
    kind: 'codex',
    phase: 'waiting',
    confidence: 'authoritative',
    source: 'structured-runtime',
    observerVersion: 'structured-v1',
    observedAt: 42,
  });

  const shell = deriveRuntimeObservation({
    command: 'zsh',
    status: 'running',
    terminalStatus: {
      kind: 'shell',
      activity: 'busy',
      source: 'shell-status-marker',
    },
  });
  assert.strictEqual(shell.phase, 'working');
  assert.strictEqual(shell.source, 'shell-marker');
  assert.strictEqual(shell.confidence, 'high');

  const stopped = deriveRuntimeObservation({
    command: 'codex',
    status: 'stopped',
    previewText: 'Working (1s • esc to interrupt)',
  });
  assert.strictEqual(stopped.phase, 'exited');
  console.log('runtime observation tests passed');
}

run();
