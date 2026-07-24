const assert = require('assert');
const EventEmitter = require('events');
const { JsonCliRuntime, commandForTurn } = require('../json-cli-runtime');

assert.deepStrictEqual(commandForTurn({ provider: 'codex', cwd: '/tmp/demo', message: 'hi' }), {
  args: ['exec', '--json', '--skip-git-repo-check', '--cd', '/tmp/demo', '-'], stdin: 'hi',
});
assert.deepStrictEqual(commandForTurn({ provider: 'codex', cwd: '/tmp/demo', sessionId: 'thread-1', message: 'next' }), {
  args: ['exec', 'resume', '--json', '--skip-git-repo-check', 'thread-1', '-'], stdin: 'next',
});
assert.deepStrictEqual(commandForTurn({ provider: 'opencode', cwd: '/tmp/demo', sessionId: 'ses_1', message: 'next' }), {
  args: ['run', '--format', 'json', '--dir', '/tmp/demo', '--session', 'ses_1', 'next'], stdin: '',
});

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from([
      '{"type":"thread.started","thread_id":"thread-live"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"answer","type":"agent_message","text":"done"}}',
      '{"type":"turn.completed"}',
      '',
    ].join('\n')));
    child.exitCode = 0;
    child.emit('close', 0, null);
  });
  return child;
}

(async () => {
  const runtime = new JsonCliRuntime({ spawn: fakeSpawn });
  runtime.registerAgent({ agentId: 'agent-1', provider: 'codex', executable: 'codex', cwd: '/tmp/demo', env: {}, initialEvents: [] });
  const result = await runtime.submitComposerMessage('agent-1', 'work');
  assert.strictEqual(result.sessionId, 'thread-live');
  const transcript = runtime.getTranscript('agent-1');
  assert.strictEqual(transcript.turns.length, 1);
  assert.strictEqual(transcript.turns[0].userMessage, 'work');
  assert.strictEqual(transcript.turns[0].finalMessage, 'done');

  const stoppingRuntime = new JsonCliRuntime();
  const stoppingChild = new EventEmitter();
  stoppingChild.exitCode = null;
  stoppingChild.killed = false;
  stoppingChild.kill = signal => {
    stoppingChild.killed = true;
    process.nextTick(() => {
      stoppingChild.exitCode = signal === 'SIGKILL' ? 137 : 143;
      stoppingChild.emit('close', stoppingChild.exitCode, signal);
    });
    return true;
  };
  const stoppingBinding = stoppingRuntime.registerAgent({
    agentId: 'agent-stopping',
    provider: 'codex',
    executable: 'codex',
    cwd: '/tmp/demo',
    env: {},
    initialEvents: [],
  });
  stoppingBinding.child = stoppingChild;
  await stoppingRuntime.unregisterAgentAndWait('agent-stopping');
  assert.strictEqual(stoppingRuntime.bindings.has('agent-stopping'), false);
  assert.strictEqual(stoppingChild.killed, true);

  const errorChild = new EventEmitter();
  errorChild.pid = 12345;
  errorChild.exitCode = null;
  errorChild.signalCode = null;
  errorChild.stdout = new EventEmitter();
  errorChild.stderr = new EventEmitter();
  errorChild.stdin = { end() {} };
  errorChild.kill = () => {
    process.nextTick(() => errorChild.emit('error', new Error('signal failed')));
    return false;
  };
  const errorRuntime = new JsonCliRuntime({
    spawn: () => errorChild,
    processExitTimeoutMs: 10,
    processKillTimeoutMs: 10,
    ownsProcessGroups: false,
  });
  const errorBinding = errorRuntime.registerAgent({
    agentId: 'agent-error-only',
    provider: 'codex',
    executable: 'codex',
    cwd: '/tmp/demo',
    env: {},
    initialEvents: [],
  });
  const failedTurn = errorRuntime.submitComposerMessage('agent-error-only', 'work').catch(() => {});
  await assert.rejects(
    errorRuntime.unregisterAgentAndWait('agent-error-only'),
    /did not exit/,
  );
  assert.strictEqual(
    errorRuntime.bindings.has('agent-error-only'),
    true,
    'a child error without exit must retain the binding for retry',
  );
  assert.strictEqual(
    errorBinding.child,
    errorChild,
    'a child error with a process id must retain process identity for cleanup retry',
  );
  errorChild.exitCode = 143;
  assert.strictEqual(await errorRuntime.unregisterAgentAndWait('agent-error-only'), true);
  assert.strictEqual(errorRuntime.bindings.has('agent-error-only'), false);
  await failedTurn;

  console.log('json cli runtime tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
