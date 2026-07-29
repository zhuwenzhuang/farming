const assert = require('assert');
const { execFile } = require('child_process');
const http = require('http');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const computerCli = path.join(__dirname, '..', '..', 'extensions', 'computer', 'bin', 'farming-computer');
const farmingCli = path.join(__dirname, '..', 'farming-app-cli.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

async function invoke(executable, args, env = {}) {
  return execFileAsync(process.execPath, [executable, ...args], {
    env: { ...process.env, ...env },
  });
}

async function run() {
  const top = (await invoke(computerCli, ['--help'])).stdout;
  assert(top.includes('help workflow'));
  assert(top.includes('call <tool> [json]'));
  assert(!top.includes('browser_navigate --url'));

  const workflow = (await invoke(computerCli, ['help', 'workflow'])).stdout;
  assert(workflow.includes('Observe'));
  assert(workflow.includes('outcome is uncertain'));

  const globalHelp = (await invoke(farmingCli, ['--help'])).stdout;
  assert(globalHelp.includes('farming computer ...'));
  assert(!globalHelp.includes('farming computer click'));

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
        body,
      });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/computers') {
        response.end(JSON.stringify({
          resources: running ? [{
            id: 'computer_test',
            ownerAgentId: 'agent_test',
            status: 'running',
          }] : [],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/computers') {
        response.end(JSON.stringify({
          id: 'computer_test',
          ownerAgentId: body.agentId,
          status: 'stopped',
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/computers/computer_test/start') {
        running = true;
        response.end(JSON.stringify({
          id: 'computer_test',
          ownerAgentId: 'agent_test',
          status: 'running',
        }));
        return;
      }
      if (
        request.method === 'POST'
        && request.url === '/api/computers/computer_test/tool/get_desktop_state'
      ) {
        response.end(JSON.stringify({
          content: [{ type: 'text', text: 'desktop ready' }],
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
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
    assert.strictEqual(opened.status, 'running');
    assert.strictEqual(requests.find(request => request.method === 'POST').body.name, 'Desktop');
    assert(requests.every(request => request.agentId === 'agent_test'));

    const observed = JSON.parse((await invoke(computerCli, [
      'call',
      'computer_get_desktop_state',
      '{}',
    ], env)).stdout);
    assert.strictEqual(observed.content[0].text, 'desktop ready');
    assert(requests.some(request =>
      request.url === '/api/computers/computer_test/tool/get_desktop_state'
    ));
  } finally {
    await close(server);
  }
  console.log('Farming Computer CLI progressive disclosure tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
