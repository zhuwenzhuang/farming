const assert = require('assert');
const http = require('http');
const { bearerAuthorizationHeader } = require('../auth.cjs');
const {
  farmingCapabilities,
  formatCapabilities,
  normalizeBaseUrl,
  parseArgs,
  formatAgent,
  request,
  run,
} = require('../farming-cli.cjs');

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

  assert.deepStrictEqual(parseArgs(['spawn', '--help']), { command: 'help' });
  assert.deepStrictEqual(parseArgs(['spawn', '-h']), { command: 'help' });
  assert.deepStrictEqual(
    parseArgs(['spawn', '--workspace', '/repo', '--help']),
    { command: 'help' },
  );
  const spawnChildHelp = parseArgs(['spawn', '--', 'qodercli', '--help']);
  assert.strictEqual(spawnChildHelp.command, 'spawn');
  assert.strictEqual(spawnChildHelp.options.childCommand, 'qodercli --help');

  // Arguments that carry whitespace or quotes survive the CLI → API →
  // parseCommand round trip with their boundaries intact.
  const { parseCommand } = require('../cli-agents.cjs');
  const spawnWithSpaces = parseArgs([
    'spawn', '--', 'grep', 'foo bar', 'file.txt',
  ]);
  assert.deepStrictEqual(
    parseCommand(spawnWithSpaces.options.childCommand),
    ['grep', 'foo bar', 'file.txt'],
  );
  const spawnWithQuote = parseArgs([
    'spawn', '--', 'echo', 'it\'s a "test"',
  ]);
  assert.deepStrictEqual(
    parseCommand(spawnWithQuote.options.childCommand),
    ['echo', 'it\'s a "test"'],
  );
  // Empty string arguments are preserved.
  const spawnWithEmpty = parseArgs(['spawn', '--', 'printf', '%s', '']);
  assert.deepStrictEqual(
    parseCommand(spawnWithEmpty.options.childCommand),
    ['printf', '%s', ''],
  );
  // Backslashes inside arguments are preserved literally.
  const spawnWithBackslash = parseArgs(['spawn', '--', 'printf', '%s', 'a\\b']);
  assert.deepStrictEqual(
    parseCommand(spawnWithBackslash.options.childCommand),
    ['printf', '%s', 'a\\b'],
  );
  // An empty executable is rejected at the CLI boundary.
  assert.throws(
    () => parseArgs(['spawn', '--', '']),
    /non-empty executable/,
  );
  // A whitespace-only executable is also rejected.
  assert.throws(
    () => parseArgs(['spawn', '--', '   ']),
    /non-empty executable/,
  );
  // resolveLaunchCommand also rejects an empty program server-side.
  const { resolveLaunchCommand } = require('../cli-agents.cjs');
  assert.throws(
    () => resolveLaunchCommand("''"),
    /non-empty executable/,
  );
  assert.throws(
    () => resolveLaunchCommand("'   '"),
    /non-empty executable/,
  );

  const list = parseArgs(['list', '--json', '--parent', 'agent-main']);
  assert.deepStrictEqual(list, {
    command: 'list',
    options: {
      json: true,
      parent: 'agent-main',
    },
  });

  assert.deepStrictEqual(parseArgs(['skills']), { command: 'skills' });
  assert.deepStrictEqual(parseArgs(['capabilities', '--json']), {
    command: 'capabilities',
    options: { json: true },
  });
  for (const command of ['skills', 'capabilities', 'list', 'output', 'send', 'title', 'kill']) {
    assert.deepStrictEqual(parseArgs([command, '--help']), { command: 'help' });
  }
  const browserCapabilities = farmingCapabilities({
    enabled: true,
    available: true,
  });
  const formattedBrowserCapabilities = formatCapabilities(browserCapabilities);
  assert.match(formattedBrowserCapabilities, /browser: available/);
  assert.match(formattedBrowserCapabilities, /Default browser path/);
  assert.match(formattedBrowserCapabilities, /farming browser help workflow/);
  assert.throws(() => parseArgs(['memory', 'report']), /Unknown command: memory/);
  assert.throws(() => parseArgs(['memory', '--help']), /Unknown command: memory/);

  const send = parseArgs(['send', 'agent-child', 'run', 'tests']);
  assert.deepStrictEqual(send, {
    command: 'send',
    options: {
      agentId: 'agent-child',
      input: 'run tests\r',
    },
  });
  assert.deepStrictEqual(parseArgs(['title', 'Fix', 'ACP', 'titles']), {
    command: 'title',
    options: { title: 'Fix ACP titles' },
  });
  assert.throws(() => parseArgs(['title']), /requires a concise title/);

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

  let titleRequest = null;
  const titleServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      titleRequest = {
        method: req.method,
        path: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ adaptiveTitle: 'Fix ACP titles' }));
    });
  });
  const titlePort = await listen(titleServer);
  const previousControlUrl = process.env.FARMING_CONTROL_URL;
  const previousTitleToken = process.env.FARMING_AGENT_TITLE_TOKEN;
  const previousTitleDisableAuth = process.env.FARMING_DISABLE_AUTH;
  process.env.FARMING_CONTROL_URL = `http://127.0.0.1:${titlePort}`;
  process.env.FARMING_AGENT_TITLE_TOKEN = 'runtime-title-token';
  process.env.FARMING_DISABLE_AUTH = '1';
  let titleOutput = '';
  try {
    await run(['title', 'Fix', 'ACP', 'titles'], {
      stdout: { write(chunk) { titleOutput += chunk; } },
    });
    assert.deepStrictEqual(titleRequest, {
      method: 'POST',
      path: '/api/control/agents/agent-main/title',
      body: { title: 'Fix ACP titles', token: 'runtime-title-token' },
    });
    assert.strictEqual(titleOutput, 'Title updated: Fix ACP titles\n');
  } finally {
    titleServer.close();
    if (previousControlUrl === undefined) delete process.env.FARMING_CONTROL_URL;
    else process.env.FARMING_CONTROL_URL = previousControlUrl;
    if (previousTitleToken === undefined) delete process.env.FARMING_AGENT_TITLE_TOKEN;
    else process.env.FARMING_AGENT_TITLE_TOKEN = previousTitleToken;
    if (previousTitleDisableAuth === undefined) delete process.env.FARMING_DISABLE_AUTH;
    else process.env.FARMING_DISABLE_AUTH = previousTitleDisableAuth;
  }

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
  assert(!skillsOutput.includes('farming memory report'));

  let authorizationHeader = null;
  let authenticatedCookieHeader = null;
  const encodedServer = http.createServer((req, res) => {
    authorizationHeader = req.headers.authorization || '';
    authenticatedCookieHeader = req.headers.cookie || '';
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
      authorizationHeader,
      bearerAuthorizationHeader('春山-秋水-云月-松风-星河-春夏秋冬'),
      'control calls should transport UTF-8 tokens through a standard Bearer header'
    );
    assert.strictEqual(authenticatedCookieHeader, '', 'machine control calls should not depend on legacy cookies');
  } finally {
    encodedServer.close();
  }

  process.env.FARMING_DISABLE_AUTH = '1';
  let cookieHeader = null;
  let disabledAuthorizationHeader = null;
  const server = http.createServer((req, res) => {
    cookieHeader = req.headers.cookie || '';
    disabledAuthorizationHeader = req.headers.authorization || '';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  try {
    assert.strictEqual(await request('/api/control/agents', { baseUrl: `http://127.0.0.1:${port}` }).then(data => data.ok), true);
    assert.strictEqual(cookieHeader, '', 'disabled auth control calls should not require or send a token cookie');
    assert.strictEqual(disabledAuthorizationHeader, '', 'disabled auth control calls should not send Bearer credentials');
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
