const assert = require('assert');
const http = require('http');
const { normalizeBaseUrl, parseArgs, formatAgent, request, run } = require('../farming-cli');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function test() {
  const previousDisableAuth = process.env.FARMING_DISABLE_AUTH;
  delete process.env.FARMING_DISABLE_AUTH;

  process.env.FARMING_AGENT_ID = 'agent-main';
  process.env.FARMING_CONTROL_URL = 'http://127.0.0.1:3000/farming/';

  const spawn = parseArgs([
    'spawn',
    '--workspace',
    '/repo',
    '--task',
    'Inspect optimizer bugs',
    '--',
    'claude',
    '--model',
    'sonnet',
  ]);

  assert.strictEqual(spawn.command, 'spawn');
  assert.strictEqual(spawn.options.workspace, '/repo');
  assert.strictEqual(spawn.options.task, 'Inspect optimizer bugs');
  assert.strictEqual(spawn.options.parent, 'agent-main');
  assert.strictEqual(spawn.options.childCommand, 'claude --model sonnet');

  const list = parseArgs(['list', '--json', '--parent', 'agent-main']);
  assert.deepStrictEqual(list, {
    command: 'list',
    options: {
      json: true,
      parent: 'agent-main',
    },
  });

  assert.deepStrictEqual(parseArgs(['skills']), { command: 'skills' });

  assert.deepStrictEqual(parseArgs(['memory', 'report', '--period', 'week', '--json']), {
    command: 'memory-report',
    options: {
      period: 'week',
      since: '',
      until: '',
      homeDir: '',
      json: true,
    },
  });

  const send = parseArgs(['send', 'agent-child', 'run', 'tests']);
  assert.deepStrictEqual(send, {
    command: 'send',
    options: {
      agentId: 'agent-child',
      input: 'run tests\r',
    },
  });

  assert.strictEqual(
    normalizeBaseUrl(),
    'http://127.0.0.1:3000/farming'
  );

  assert.strictEqual(
    formatAgent({
      id: 'agent-child',
      command: 'claude',
      status: 'running',
      cwd: '/repo',
      parentAgentId: 'agent-main',
      task: 'Inspect',
    }),
    '- agent-child | claude | running | /repo | parent: agent-main | task: Inspect'
  );

  let skillsOutput = '';
  await run(['skills'], {
    stdout: {
      write(chunk) {
        skillsOutput += chunk;
      },
    },
  });
  assert(skillsOutput.includes('Farming Main Agent Skills'));
  assert(skillsOutput.includes('farming spawn'));
  assert(skillsOutput.includes('牧场除虫计划'));
  assert(skillsOutput.includes('明确模块间协议'));
  assert(skillsOutput.includes('记忆读取总结'));
  assert(skillsOutput.includes('farming memory report'));

  let encodedCookieHeader = null;
  const encodedServer = http.createServer((req, res) => {
    encodedCookieHeader = req.headers.cookie || '';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const encodedPort = await listen(encodedServer);
  try {
    assert.strictEqual(
      await request('/api/control/agents', {
        baseUrl: `http://127.0.0.1:${encodedPort}`,
        token: '春山-秋水-云月-松风-星河-春夏秋冬',
      }).then(data => data.ok),
      true
    );
    assert.strictEqual(
      encodedCookieHeader,
      `farming_token=${encodeURIComponent('春山-秋水-云月-松风-星河-春夏秋冬')}`,
      'control calls should percent-encode Chinese token cookies'
    );
  } finally {
    encodedServer.close();
  }

  process.env.FARMING_DISABLE_AUTH = '1';
  let cookieHeader = null;
  const server = http.createServer((req, res) => {
    cookieHeader = req.headers.cookie || '';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  try {
    assert.strictEqual(await request('/api/control/agents', { baseUrl: `http://127.0.0.1:${port}` }).then(data => data.ok), true);
    assert.strictEqual(cookieHeader, '', 'disabled auth control calls should not require or send a token cookie');
  } finally {
    server.close();
    if (previousDisableAuth === undefined) {
      delete process.env.FARMING_DISABLE_AUTH;
    } else {
      process.env.FARMING_DISABLE_AUTH = previousDisableAuth;
    }
  }

  console.log('✓ Farming CLI parses lifecycle commands');
}

test().catch((error) => {
  console.error(error);
  process.exit(1);
});
