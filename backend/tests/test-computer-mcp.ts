const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
  mergeComputerMcpServer,
} = require('../../extensions/computer/backend/agent-capability.cjs');

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

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-computer-mcp-'));
  const workspace = path.join(tempDir, 'project');
  fs.mkdirSync(workspace);
  const tokenFile = path.join(tempDir, 'token');
  fs.writeFileSync(tokenFile, 'test-token');
  const requests = [];
  let opened = false;
  const api = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        agentId: request.headers['x-farming-agent-id'],
        body,
      });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/farming/api/computers') {
        response.end(JSON.stringify({
          resources: opened ? [{
            id: 'computer_test',
            ownerAgentId: 'agent_test',
            status: 'running',
            workspace,
          }] : [],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/farming/api/computers') {
        opened = true;
        response.end(JSON.stringify({
          id: 'computer_test',
          ownerAgentId: 'agent_test',
          status: 'stopped',
          workspace,
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/farming/api/computers/computer_test/start') {
        response.end(JSON.stringify({
          id: 'computer_test',
          ownerAgentId: 'agent_test',
          status: 'running',
          workspace,
        }));
        return;
      }
      if (
        request.method === 'POST'
        && request.url === '/farming/api/computers/computer_test/tool/get_desktop_state'
      ) {
        response.end(JSON.stringify({
          content: [{ type: 'text', text: '{"desktop":"ready"}' }],
          structuredContent: { desktop: 'ready' },
        }));
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
      args: [
        '-e',
        `require(${JSON.stringify(path.join(
          __dirname,
          '..',
          '..',
          'extensions',
          'computer',
          'backend',
          'computer-mcp-server.cjs',
        ))}).runComputerMcpServer()`,
      ],
      env: {
        FARMING_CONTROL_URL: `http://127.0.0.1:${port}/farming`,
        FARMING_AGENT_ID: 'agent_test',
        FARMING_PROJECT_WORKSPACE: workspace,
        FARMING_TOKEN_FILE: tokenFile,
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'farming-computer-mcp-test', version: '1.0.0' });
    await client.connect(transport);

    const listed = await client.listTools();
    assert.strictEqual(listed.tools.length, 56);
    const names = listed.tools.map(tool => tool.name);
    assert.deepStrictEqual(names.slice(0, 3), [
      'computer_open',
      'computer_list',
      'computer_stop',
    ]);
    assert(names.includes('computer_get_desktop_state'));
    assert(names.includes('computer_click'));
    assert(names.includes('computer_browser_navigate'));
    assert(names.includes('computer_start_recording'));
    assert.strictEqual(new Set(names).size, names.length);

    const result = await client.callTool({
      name: 'computer_get_desktop_state',
      arguments: {},
    });
    assert.deepStrictEqual(result.structuredContent, { desktop: 'ready' });
    assert(requests.every(request => request.agentId === 'agent_test'));
    assert(requests.every(request => request.authorization === 'Bearer dGVzdC10b2tlbg'));
    assert(requests.every(request => request.cookie === undefined));
    assert(requests.some(request =>
      request.url === '/farming/api/computers/computer_test/tool/get_desktop_state'
    ));

    const merged = mergeComputerMcpServer([], {
      cliBinDir: tempDir,
      agentEnv: {
        FARMING_AGENT_ID: 'agent_test',
        FARMING_PROJECT_WORKSPACE: workspace,
        FARMING_CONTROL_URL: `http://127.0.0.1:${port}/farming`,
        FARMING_TOKEN_FILE: tokenFile,
      },
    });
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].name, 'farming-computer');
    assert.throws(
      () => mergeComputerMcpServer([{
        name: 'farming-computer',
        command: 'other-command',
        args: [],
        env: [],
      }], {
        cliBinDir: tempDir,
        agentEnv: {
          FARMING_AGENT_ID: 'agent_test',
          FARMING_PROJECT_WORKSPACE: workspace,
          FARMING_CONTROL_URL: `http://127.0.0.1:${port}/farming`,
          FARMING_TOKEN_FILE: tokenFile,
        },
      }),
      /reserved/,
    );
    console.log('Computer MCP contract regression test passed.');
  } finally {
    if (client) await client.close().catch(() => {});
    await close(api).catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
