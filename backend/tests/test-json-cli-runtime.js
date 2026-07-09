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
  console.log('json cli runtime tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
