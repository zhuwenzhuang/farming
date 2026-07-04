const assert = require('assert');
const { isRestartBlockingAgent } = require('../agent-activity');

function agent(overrides = {}) {
  return {
    id: 'agent-1',
    command: 'codex',
    status: 'running',
    isMain: false,
    archived: false,
    terminalBusy: null,
    output: '',
    previewText: '',
    ...overrides,
  };
}

function run() {
  assert.strictEqual(
    isRestartBlockingAgent(agent({
      output: [
        '■ stream disconnected before completion: Your input exceeds the context window of this model.',
        'gpt-5.5 high · /repo        Goal blocked (/goal resume)',
      ].join('\n'),
    })),
    false,
    'blocked Codex sessions should not block restart'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      output: '› Explain this codebase\ngpt-5.5 high · /repo',
    })),
    false,
    'idle Codex TUI sessions should not block restart'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      previewText: 'Working\nEsc to interrupt',
    })),
    true,
    'active Codex turns without a recoverable engine should block restart'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      command: 'bash',
      previewText: 'Working (12s • esc to interrupt)\nRunning git push origin feature',
    })),
    true,
    'bash-launched Codex turns should block restart when the terminal output shows Codex activity'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      command: 'codex',
      previewText: '$ ',
    })),
    false,
    'a current shell prompt should override a stale Codex launch command for restart blocking'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      engineName: 'native',
      previewText: 'Working\nEsc to interrupt',
    })),
    false,
    'active native-backed Codex turns should not block server restart'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      command: 'claude',
      previewText: 'Thinking...\nPress Esc to interrupt',
    })),
    true,
    'active Claude turns should block restart'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      command: 'bash',
      terminalBusy: false,
      output: '$ ',
    })),
    false,
    'idle shell sessions should not block restart'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      command: 'bash',
      terminalBusy: true,
    })),
    true,
    'busy non-recoverable shell sessions should block restart'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      command: 'bash',
      engineName: 'native',
      terminalBusy: true,
    })),
    false,
    'busy native-backed shell sessions should not block server restart'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      status: 'pending',
      engineName: 'native',
    })),
    true,
    'pending native-backed agents should still block until session metadata is stable'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      command: 'python3 server.py',
    })),
    true,
    'unknown running agents should remain restart-blocking'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      command: 'python3 server.py',
      engineName: 'native',
    })),
    false,
    'unknown commands should not block restart once they are native-backed'
  );

  assert.strictEqual(
    isRestartBlockingAgent(agent({
      isMain: true,
      command: 'python3 server.py',
    })),
    false,
    'main agents should not block restart'
  );

  console.log('✓ Agent activity distinguishes online agents from active work');
}

run();
