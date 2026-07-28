const assert = require('assert');
const { execFile } = require('child_process');
const http = require('http');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const browserCli = path.join(__dirname, '..', '..', 'extensions', 'browser', 'bin', 'farming-browser');
const farmingCli = path.join(__dirname, '..', 'farming-app-cli.js');

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
  const top = (await invoke(browserCli, ['--help'])).stdout;
  assert(top.includes('help workflow'));
  assert(top.includes('help debugging'));
  assert(!top.includes('network <browser-id>'));
  assert(!top.includes('cookies <browser-id>'));

  const workflow = (await invoke(browserCli, ['help', 'workflow'])).stdout;
  assert(workflow.includes('farming capabilities'));
  assert(workflow.includes('take a snapshot'));
  assert(!workflow.includes('--sameSite'));

  const debugging = (await invoke(browserCli, ['help', 'debugging'])).stdout;
  assert(debugging.includes('console, errors, network'));
  assert(!debugging.includes('--method'));

  const networkHelp = (await invoke(browserCli, ['network', '--help'])).stdout;
  assert(networkHelp.includes('--method <method>'));
  assert(networkHelp.includes('request <request-id>'));

  const globalHelp = (await invoke(farmingCli, ['--help'])).stdout;
  assert(globalHelp.includes('farming browser ...'));
  assert(!globalHelp.includes('farming browser click'));
  assert(!globalHelp.includes('farming browser snapshot'));

  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      requests.push({ method: request.method, url: request.url, body });
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/browsers') {
        response.end(JSON.stringify({
          resources: [{
            id: 'browser_project',
            workspace: '/project',
            status: 'running',
          }, {
            id: 'browser_other',
            workspace: '/other',
            status: 'running',
          }],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/browsers/browser_project/action') {
        response.end(JSON.stringify({ received: body }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    });
  });

  try {
    const port = await listen(server);
    const env = {
      FARMING_CONTROL_URL: `http://127.0.0.1:${port}`,
      FARMING_DISABLE_AUTH: '1',
    };
    const waited = JSON.parse((await invoke(browserCli, [
      'wait',
      'browser_project',
      '--text',
      'Ready',
      '--timeout',
      '9000',
    ], env)).stdout);
    assert.deepStrictEqual(waited.received, {
      kind: 'wait',
      mode: 'text',
      value: 'Ready',
      timeoutMs: 9000,
    });

    const evaluated = JSON.parse((await invoke(browserCli, [
      'eval',
      'browser_project',
      'document.querySelectorAll("button").length',
    ], env)).stdout);
    assert.strictEqual(
      evaluated.received.expression,
      'document.querySelectorAll("button").length',
    );

    const cookie = JSON.parse((await invoke(browserCli, [
      'cookies',
      'browser_project',
      'set',
      'theme',
      'dark',
      '--sameSite',
      'Lax',
      '--secure',
    ], env)).stdout);
    assert.deepStrictEqual(cookie.received, {
      kind: 'cookies',
      operation: 'set',
      name: 'theme',
      value: 'dark',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    });
    assert.strictEqual(requests.length, 3);

    await assert.rejects(
      invoke(browserCli, ['snapshot', 'browser_other'], {
        ...env,
        FARMING_PROJECT_WORKSPACE: '/project',
      }),
      error => error.stderr.includes("not available in this Agent's Project"),
    );
    assert.strictEqual(requests.at(-1).method, 'GET');
  } finally {
    await close(server);
  }

  console.log('Farming Browser CLI progressive disclosure tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
