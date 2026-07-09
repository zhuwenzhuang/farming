const assert = require('assert');
const { AgentJsonStreamParser, JsonlStreamDecoder } = require('../agent-json-stream');

{
  const decoder = new JsonlStreamDecoder();
  assert.deepStrictEqual(decoder.push('not json\n{"type":"first"}\n{"type"'), [
    { type: 'first' },
  ]);
  assert.deepStrictEqual(decoder.push(':"second"}\n'), [{ type: 'second' }]);
  assert.deepStrictEqual(decoder.push('{"type":"trailing"}'), []);
  assert.deepStrictEqual(decoder.flush(), [{ type: 'trailing' }]);
}

{
  const parser = new AgentJsonStreamParser({
    provider: 'codex',
    operationId: 'codex-demo',
    prompt: 'Inspect the project without changing files.',
  });
  parser.push([
    '{"type":"thread.started","thread_id":"thread-codex-demo"}',
    '{"type":"turn.started"}',
    'a harmless stdout notice',
    '{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"pwd","status":"in_progress"}}',
  ].join('\n') + '\n');
  parser.push('{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","command":"pwd","aggregated_output":"/tmp/demo\\n","exit_code":0,"status":"completed"}}\n');
  parser.push('{"type":"item.completed","item":{"id":"answer-1","type":"agent_message","text":"The project is ready."}}\n');
  parser.push('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\n');

  const turns = parser.transcript();
  assert.strictEqual(parser.sessionId, 'thread-codex-demo');
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].userMessage, 'Inspect the project without changing files.');
  assert.strictEqual(turns[0].finalMessage, 'The project is ready.');
  assert.strictEqual(turns[0].status, 'completed');
  assert.strictEqual(turns[0].processItems.length, 1);
  assert.strictEqual(turns[0].processItems[0].title, 'Ran pwd');
  assert.strictEqual(turns[0].processItems[0].status, 'completed');
  assert(turns[0].processItems[0].detail.includes('/tmp/demo'));
}

{
  const parser = new AgentJsonStreamParser({
    provider: 'opencode',
    operationId: 'opencode-demo',
    prompt: 'Run pwd once and report the result.',
  });
  const records = [
    {
      type: 'step_start',
      timestamp: 100,
      sessionID: 'ses_opencode_demo',
      part: { id: 'step-1', type: 'step-start' },
    },
    {
      type: 'tool_use',
      timestamp: 120,
      sessionID: 'ses_opencode_demo',
      part: {
        id: 'part-tool',
        type: 'tool',
        tool: 'bash',
        callID: 'call-pwd',
        state: {
          status: 'completed',
          input: { command: 'pwd' },
          output: '/tmp/demo\n',
          metadata: { exit: 0, output: '/tmp/demo\n' },
        },
      },
    },
    {
      type: 'step_finish',
      timestamp: 130,
      sessionID: 'ses_opencode_demo',
      part: { reason: 'tool-calls', type: 'step-finish' },
    },
    {
      type: 'step_start',
      timestamp: 140,
      sessionID: 'ses_opencode_demo',
      part: { id: 'step-2', type: 'step-start' },
    },
    {
      type: 'text',
      timestamp: 150,
      sessionID: 'ses_opencode_demo',
      part: { id: 'text-1', type: 'text', text: 'The current directory is `/tmp/demo`.' },
    },
    {
      type: 'step_finish',
      timestamp: 160,
      sessionID: 'ses_opencode_demo',
      part: { reason: 'stop', type: 'step-finish' },
    },
  ];

  const jsonl = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  parser.push(jsonl.slice(0, 73));
  parser.push(jsonl.slice(73));
  parser.flush();

  const turns = parser.transcript();
  assert.strictEqual(parser.sessionId, 'ses_opencode_demo');
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].userMessage, 'Run pwd once and report the result.');
  assert.strictEqual(turns[0].finalMessage, 'The current directory is `/tmp/demo`.');
  assert.strictEqual(turns[0].status, 'completed');
  assert.strictEqual(turns[0].processItems.length, 1);
  assert.strictEqual(turns[0].processItems[0].title, 'Ran pwd');
  assert.strictEqual(turns[0].processItems[0].status, 'completed');
}

{
  assert.throws(
    () => new AgentJsonStreamParser({ provider: 'unknown' }),
    /Unsupported agent JSON provider/,
  );
}

console.log('agent json stream parser tests passed');
