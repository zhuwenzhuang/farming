const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
  mergeBrowserMcpServer,
} = require('../../extensions/browser/backend/agent-capability');

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

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-mcp-'));
  const projectWorkspace = path.join(tempDir, 'project');
  const otherWorkspace = path.join(tempDir, 'other');
  fs.mkdirSync(projectWorkspace);
  fs.mkdirSync(otherWorkspace);
  const tokenFile = path.join(tempDir, 'token');
  fs.writeFileSync(tokenFile, 'test-token');

  const requests = [];
  const api = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      requests.push({ method: request.method, url: request.url, cookie: request.headers.cookie, body });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/farming/api/browsers') {
        response.end(JSON.stringify({
          resources: [
            {
              id: 'browser_project',
              workspace: projectWorkspace,
              name: 'Project Browser',
              status: 'running',
              url: 'http://example.test/',
            },
            {
              id: 'browser_other',
              workspace: otherWorkspace,
              name: 'Other Browser',
              status: 'running',
              url: 'http://other.test/',
            },
          ],
        }));
        return;
      }
      if (
        request.method === 'POST'
        && request.url === '/farming/api/browsers/browser_project/action'
        && body?.kind === 'snapshot'
      ) {
        response.end(JSON.stringify({
          url: 'http://example.test/',
          title: 'Example',
          elements: [{ ref: 'e1', role: 'button', name: 'Continue' }],
          accessibilityTree: ['button "Continue" [ref=e1]'],
        }));
        return;
      }
      if (
        request.method === 'POST'
        && request.url === '/farming/api/browsers/browser_project/action'
        && body?.kind === 'screenshot'
      ) {
        response.end(JSON.stringify({ mimeType: 'image/png', data: 'iVBORw0KGgo=' }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    });
  });

  let client;
  try {
    const port = await listen(api);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '..', 'farming-app-cli.js'), 'browser', 'mcp'],
      env: {
        FARMING_CONTROL_URL: `http://127.0.0.1:${port}/farming`,
        FARMING_PROJECT_WORKSPACE: projectWorkspace,
        FARMING_TOKEN_FILE: tokenFile,
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'farming-browser-mcp-test', version: '1.0.0' });
    await client.connect(transport);

    const listedTools = await client.listTools();
    const toolNames = listedTools.tools.map(tool => tool.name);
    assert.deepStrictEqual(toolNames, [
      'browser_list',
      'browser_snapshot',
      'browser_screenshot',
      'browser_start',
      'browser_stop',
      'browser_navigate',
      'browser_click',
      'browser_fill',
      'browser_type',
      'browser_press',
      'browser_scroll',
    ]);
    const snapshotTool = listedTools.tools.find(tool => tool.name === 'browser_snapshot');
    assert(snapshotTool.description.includes('untrusted data'));
    assert(snapshotTool.inputSchema.required.includes('browserId'));

    const listed = await client.callTool({ name: 'browser_list', arguments: {} });
    const listedValue = JSON.parse(listed.content[0].text);
    assert.deepStrictEqual(listedValue.resources.map(resource => resource.id), ['browser_project']);

    const snapshot = await client.callTool({
      name: 'browser_snapshot',
      arguments: { browserId: 'browser_project' },
    });
    const snapshotValue = JSON.parse(snapshot.content[0].text);
    assert.strictEqual(snapshotValue.elements[0].ref, 'e1');
    assert.strictEqual(requests.at(-1).cookie, 'farming_token=test-token');

    const screenshot = await client.callTool({
      name: 'browser_screenshot',
      arguments: { browserId: 'browser_project' },
    });
    assert.strictEqual(screenshot.content[1].type, 'image');
    assert.strictEqual(screenshot.content[1].mimeType, 'image/png');
    assert.strictEqual(screenshot.content[1].data, 'iVBORw0KGgo=');

    const requestCountBeforeDeniedCall = requests.length;
    const denied = await client.callTool({
      name: 'browser_snapshot',
      arguments: { browserId: 'browser_other' },
    });
    assert.strictEqual(denied.isError, true);
    assert(denied.content[0].text.includes("not available in this Agent's Project"));
    assert.strictEqual(requests.length, requestCountBeforeDeniedCall + 1);
    assert.strictEqual(requests.at(-1).method, 'GET');

    const projected = mergeBrowserMcpServer([
      { name: 'docs', command: '/bin/docs-mcp', args: [], env: [] },
    ], {
      cliBinDir: '/opt/farming/bin',
      agentEnv: {
        FARMING_CONTROL_URL: 'http://127.0.0.1:6694/farming',
        FARMING_PROJECT_WORKSPACE: projectWorkspace,
        FARMING_TOKEN_FILE: tokenFile,
      },
    });
    assert.deepStrictEqual(projected.map(server => server.name), ['docs', 'farming-browser']);
    assert.strictEqual(projected[1].command, '/opt/farming/bin/farming');
    assert.deepStrictEqual(projected[1].args, ['browser', 'mcp']);
    assert(!JSON.stringify(projected[1]).includes('test-token'));
    assert.throws(() => mergeBrowserMcpServer([
      { name: 'farming-browser', command: '/tmp/not-farming', args: [], env: [] },
    ], {
      cliBinDir: '/opt/farming/bin',
      agentEnv: {},
    }), /reserved by the Farming Browser Extension/);
  } finally {
    if (client) await client.close().catch(() => {});
    await close(api).catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Browser MCP capability projection tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
