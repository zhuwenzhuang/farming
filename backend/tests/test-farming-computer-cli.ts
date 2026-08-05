const assert = require('assert');
const { execFile, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const computerCli = path.join(__dirname, '..', '..', 'extensions', 'computer', 'bin', 'farming-computer');
const farmingCli = path.join(__dirname, '..', 'farming-app-cli.cjs');
const manifest = require('../../extensions/computer/backend/cua-tools.json');
const { TOOL_TOPICS, describeTool } = require(computerCli);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

async function invoke(executable, args, env = {}) {
  return execFileAsync(process.execPath, [executable, ...args], {
    env: { ...process.env, ...env },
  });
}

function invokeWithInput(executable, args, input, env = {}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`CLI exited ${code}`), result));
    });
    child.stdin.end(input);
  });
}

async function run() {
  const discovered = Object.values(TOOL_TOPICS).flat();
  const upstream = manifest.tools.map(tool => tool.upstreamName);
  assert.deepStrictEqual([...discovered].sort(), [...upstream].sort(), 'all 53 former Computer MCP tools must remain discoverable through CLI topics');
  assert.strictEqual(new Set(discovered).size, upstream.length, 'each Computer tool belongs to exactly one topic');
  upstream.forEach(tool => assert.strictEqual(describeTool(tool).tool, tool));

  const top = (await invoke(computerCli, ['--help'])).stdout;
  assert(top.includes('help workflow'));
  assert(top.includes('describe <tool> --json'));
  assert(top.includes('call <tool> --json -'));
  assert(!top.includes(' mcp'));

  const workflow = (await invoke(computerCli, ['help', 'workflow'])).stdout;
  assert(workflow.includes('Observe'));
  assert(workflow.includes('outcome is uncertain'));

  const observationHelp = (await invoke(computerCli, ['help', 'observe'])).stdout;
  assert(observationHelp.includes('get_desktop_state'));
  assert(!observationHelp.includes('kill_app'));

  const description = JSON.parse((await invoke(computerCli, [
    'describe', 'computer_get_desktop_state', '--json',
  ])).stdout);
  assert.strictEqual(description.ok, true);
  assert.strictEqual(description.result.providerToolName, 'computer_get_desktop_state');
  assert.strictEqual(description.result.result.media, 'workspace-artifact');
  assert(!JSON.stringify(description).includes('MCP'));

  const globalHelp = (await invoke(farmingCli, ['--help'])).stdout;
  assert(globalHelp.includes('farming computer ...'));
  assert(!globalHelp.includes('farming computer click'));

  await assert.rejects(
    invoke(computerCli, ['mcp']),
    error => JSON.parse(error.stderr).operation === 'mcp',
  );

  const requests = [];
  let running = false;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      requests.push({
        method: request.method,
        url: request.url,
        agentId: request.headers['x-farming-agent-id'],
        capabilityToken: request.headers['x-farming-capability-token'],
        runtimeEpoch: request.headers['x-farming-capability-runtime-epoch'],
        body,
      });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/computers') {
        response.end(JSON.stringify({
          resources: running ? [{
            id: 'computer_test', ownerAgentId: 'agent_test', workspace: '/project', status: 'running',
          }] : [],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/computers') {
        response.end(JSON.stringify({
          id: 'computer_test', ownerAgentId: body.agentId, workspace: '/project', status: 'stopped',
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/computers/computer_test/start') {
        running = true;
        response.end(JSON.stringify({
          id: 'computer_test', ownerAgentId: 'agent_test', workspace: '/project', status: 'running',
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/computers/computer_test/tool/get_desktop_state') {
        response.end(JSON.stringify({
          content: [{ type: 'text', text: 'desktop ready' }, {
            type: 'image', kind: 'image', path: '.tmp/farming/computer/get-desktop-state-test.png',
            mimeType: 'image/png', size: 456,
          }],
          structuredContent: { tool: 'get_desktop_state' },
          artifacts: [{
            kind: 'image', path: '.tmp/farming/computer/get-desktop-state-test.png',
            mimeType: 'image/png', size: 456,
          }],
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found', code: 'TEST_NOT_FOUND' }));
    });
  });

  try {
    const port = await listen(server);
    const env = {
      FARMING_AGENT_ID: 'agent_test',
      FARMING_CONTROL_URL: `http://127.0.0.1:${port}`,
      FARMING_DISABLE_AUTH: '1',
      FARMING_PROJECT_WORKSPACE: '/project',
    };
    const opened = JSON.parse((await invoke(computerCli, ['open', '--name', 'Desktop'], env)).stdout);
    assert.strictEqual(opened.result.status, 'running');
    assert.strictEqual(requests.find(request => request.method === 'POST').body.name, 'Desktop');
    assert(requests.every(request => request.agentId === 'agent_test'));

    const observedProcess = await invokeWithInput(
      computerCli,
      ['call', 'computer_get_desktop_state', '--json', '-'],
      '{}',
      env,
    );
    const observed = JSON.parse(observedProcess.stdout);
    assert.strictEqual(observed.result.content[0].text, 'desktop ready');
    assert.strictEqual(observed.artifacts[0].path, '.tmp/farming/computer/get-desktop-state-test.png');
    assert(!JSON.stringify(observed).includes('base64'));
    assert(requests.some(request => request.url === '/api/computers/computer_test/tool/get_desktop_state'));
  } finally {
    await close(server);
  }
  console.log('Farming Computer CLI-only capability tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
