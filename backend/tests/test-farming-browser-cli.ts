const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const browserCli = path.join(__dirname, '..', '..', 'extensions', 'browser', 'bin', 'farming-browser');
const farmingCli = path.join(__dirname, '..', 'farming-app-cli.cjs');
const { describeCommand } = require(browserCli);

const LEGACY_MCP_TO_CLI = {
  browser_open: ['open'], browser_list: ['list'], browser_snapshot: ['snapshot'],
  browser_screenshot: ['screenshot'], browser_start: ['start'], browser_stop: ['stop'],
  browser_navigate: ['navigate'], browser_click: ['click'], browser_fill: ['fill'],
  browser_type: ['type'], browser_press: ['press'], browser_scroll: ['scroll'],
  browser_history: ['back', 'forward', 'reload'], browser_wait: ['wait'],
  browser_get: ['get'], browser_is: ['is'], browser_eval: ['eval'],
  browser_element_action: ['dblclick', 'hover', 'focus', 'check', 'uncheck', 'scrollintoview', 'highlight'],
  browser_keyboard: ['keyboard'], browser_select: ['select'], browser_drag: ['drag'],
  browser_find: ['find'], browser_debug: ['console', 'errors', 'network'],
  browser_cookies: ['cookies'], browser_storage: ['storage'], browser_frame: ['frame'],
  browser_dialog: ['dialog'], browser_upload: ['upload'], browser_download: ['download'],
};

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

async function run() {
  for (const [legacyTool, commands] of Object.entries(LEGACY_MCP_TO_CLI)) {
    assert(commands.length > 0, `${legacyTool} must retain a CLI mapping`);
    commands.forEach(command => assert.strictEqual(describeCommand(command).command, command));
  }

  const top = (await invoke(browserCli, ['--help'])).stdout;
  assert(top.includes('help workflow'));
  assert(top.includes('describe <command> --json'));
  assert(!top.includes(' mcp'));
  assert(!top.includes('network <browser-id>'));

  const workflow = (await invoke(browserCli, ['help', 'workflow'])).stdout;
  assert(workflow.includes('farming capabilities'));
  assert(workflow.includes('take a snapshot'));
  assert(!workflow.includes('--sameSite'));

  const openDescription = describeCommand('open');
  const sourceOption = openDescription.input.options.find(option => option.name === '--source');
  assert.deepStrictEqual(sourceOption.values, ['system', 'extension', 'isolated']);
  assert.strictEqual(
    openDescription.input.options.some(option => option.name === '--cdp-url'),
    false,
  );

  const screenshotDescription = JSON.parse((await invoke(browserCli, [
    'describe', 'screenshot', '--json',
  ])).stdout);
  assert.strictEqual(screenshotDescription.ok, true);
  assert.strictEqual(screenshotDescription.result.result.media, 'workspace-artifact');
  assert.strictEqual(screenshotDescription.result.annotations.readOnly, false);
  assert.strictEqual(screenshotDescription.result.annotations.idempotent, false);
  assert.strictEqual(screenshotDescription.result.annotations.uncertainOnTransportFailure, true);
  assert.deepStrictEqual(
    screenshotDescription.result.input.positionals.map(field => field.name),
    ['browser-id'],
  );
  const deleteDescription = JSON.parse((await invoke(browserCli, [
    'describe', 'delete', '--json',
  ])).stdout);
  assert.strictEqual(deleteDescription.result.annotations.readOnly, false);
  assert.strictEqual(deleteDescription.result.annotations.destructive, true);
  assert.strictEqual(deleteDescription.result.annotations.idempotent, false);
  assert.strictEqual(deleteDescription.result.annotations.openWorld, false);

  const globalHelp = (await invoke(farmingCli, ['--help'])).stdout;
  assert(globalHelp.includes('farming browser ...'));
  assert(!globalHelp.includes('farming browser click'));

  await assert.rejects(
    invoke(browserCli, ['mcp']),
    error => {
      const failure = JSON.parse(error.stderr);
      return failure.ok === false && failure.operation === 'mcp';
    },
  );

  const symlinkFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-cli-workspace-'));
  const canonicalWorkspace = path.join(symlinkFixture, 'canonical');
  const linkedWorkspace = path.join(symlinkFixture, 'linked');
  fs.mkdirSync(canonicalWorkspace);
  fs.symlinkSync(canonicalWorkspace, linkedWorkspace, process.platform === 'win32' ? 'junction' : 'dir');
  const requests = [];
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
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/browsers') {
        response.end(JSON.stringify({
          resources: [{
            id: 'browser_project', ownerAgentId: 'agent_test', workspace: '/project', status: 'running',
          }, {
            id: 'browser_symlink', ownerAgentId: 'agent_test', workspace: canonicalWorkspace, status: 'running',
          }, {
            id: 'browser_other', ownerAgentId: 'agent_other', workspace: '/project', status: 'running',
          }],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/browsers') {
        response.end(JSON.stringify({ id: 'browser_created', received: body }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/browsers/browser_created/start') {
        response.end(JSON.stringify({ id: 'browser_created', status: 'running' }));
        return;
      }
      if (request.method === 'DELETE' && request.url === '/api/browsers/browser_project') {
        response.end(JSON.stringify({ id: 'browser_project', deleted: true }));
        return;
      }
      if (request.method === 'POST' && ['/api/browsers/browser_project/action', '/api/browsers/browser_symlink/action'].includes(request.url)) {
        if (body.kind === 'screenshot') {
          response.end(JSON.stringify({
            artifact: {
              kind: 'image', path: '.tmp/farming/browser/screenshot-test.png',
              mimeType: 'image/png', size: 123,
            },
          }));
        } else {
          response.end(JSON.stringify({ received: body }));
        }
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found', code: 'TEST_NOT_FOUND' }));
    });
  });

  try {
    const port = await listen(server);
    const env = {
      FARMING_CONTROL_URL: `http://127.0.0.1:${port}`,
      FARMING_DISABLE_AUTH: '1',
    };
    const waited = JSON.parse((await invoke(browserCli, [
      'wait', 'browser_project', '--text', 'Ready', '--timeout', '9000',
    ], env)).stdout);
    assert.strictEqual(waited.ok, true);
    assert.deepStrictEqual(waited.result.received, {
      kind: 'wait', mode: 'text', value: 'Ready', timeoutMs: 9000,
    });

    const screenshot = JSON.parse((await invoke(browserCli, [
      'screenshot', 'browser_project',
    ], env)).stdout);
    assert.strictEqual(screenshot.artifacts[0].path, '.tmp/farming/browser/screenshot-test.png');
    assert(!JSON.stringify(screenshot).includes('base64'));

    const opened = JSON.parse((await invoke(browserCli, ['open', '--url', 'https://example.test'], {
      ...env,
      FARMING_AGENT_ID: 'agent_test',
      FARMING_PROJECT_WORKSPACE: '/project',
    })).stdout);
    assert.strictEqual(opened.result.status, 'running');
    assert.strictEqual(requests.find(item => item.url === '/api/browsers').body.agentId, 'agent_test');
    assert(requests.some(item => item.url === '/api/browsers/browser_created/start'));

    const deleted = JSON.parse((await invoke(browserCli, ['delete', 'browser_project'], {
      ...env,
      FARMING_AGENT_ID: 'agent_test',
      FARMING_PROJECT_WORKSPACE: '/project',
    })).stdout);
    assert.strictEqual(deleted.result.deleted, true);
    assert(requests.some(item => item.method === 'DELETE' && item.url === '/api/browsers/browser_project'));

    const symlinkSnapshot = JSON.parse((await invoke(browserCli, ['snapshot', 'browser_symlink'], {
      ...env,
      FARMING_AGENT_ID: 'agent_test',
      FARMING_PROJECT_WORKSPACE: linkedWorkspace,
    })).stdout);
    assert.strictEqual(symlinkSnapshot.ok, true, 'workspace symlink aliases must preserve Browser ownership');

    await assert.rejects(
      invoke(browserCli, ['open', '--workspace', '/other-project'], {
          ...env,
          FARMING_AGENT_ID: 'agent_test',
          FARMING_PROJECT_WORKSPACE: '/project',
      }),
      error => JSON.parse(error.stderr).message.includes('cannot leave this Agent Project workspace'),
    );

    await assert.rejects(
      invoke(browserCli, ['snapshot', 'browser_other'], {
          ...env,
          FARMING_AGENT_ID: 'agent_test',
          FARMING_PROJECT_WORKSPACE: '/project',
      }),
      error => JSON.parse(error.stderr).message.includes('not owned by this Agent'),
    );
  } finally {
    await close(server);
    fs.rmSync(symlinkFixture, { recursive: true, force: true });
  }

  console.log('Farming Browser CLI-only capability tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
