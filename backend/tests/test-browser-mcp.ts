const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
  mergeBrowserMcpServer,
} = require('../../extensions/browser/backend/agent-capability.cjs');

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-mcp-'));
  const projectWorkspace = path.join(tempDir, 'project');
  const otherWorkspace = path.join(tempDir, 'other');
  fs.mkdirSync(projectWorkspace);
  fs.mkdirSync(otherWorkspace);
  const tokenFile = path.join(tempDir, 'token');
  fs.writeFileSync(tokenFile, 'test-token');

  const requests = [];
  let openedCreated = false;
  const api = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        agentId: request.headers['x-farming-agent-id'],
        body,
      });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/farming/api/browsers') {
        response.end(JSON.stringify({
          resources: [
            {
              id: 'browser_project',
              ownerAgentId: 'agent_test',
              workspace: projectWorkspace,
              name: 'Project Browser',
              status: 'running',
              url: 'http://example.test/',
            },
            {
              id: 'browser_same_project_other_agent',
              ownerAgentId: 'agent_other',
              workspace: projectWorkspace,
              name: 'Other Agent Browser',
              status: 'running',
              url: 'http://other-agent.test/',
            },
            {
              id: 'browser_other',
              ownerAgentId: 'agent_test',
              workspace: otherWorkspace,
              name: 'Other Browser',
              status: 'running',
              url: 'http://other.test/',
            },
            ...(openedCreated ? [{
              id: 'browser_opened',
              ownerAgentId: 'agent_test',
              workspace: projectWorkspace,
              name: 'Opened',
              status: 'stopped',
              url: 'https://opened.test/',
            }] : []),
          ],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/farming/api/browsers') {
        openedCreated = true;
        response.statusCode = 201;
        response.end(JSON.stringify({
          id: 'browser_opened',
          ownerAgentId: body.agentId,
          workspace: projectWorkspace,
          name: body.name || 'Browser',
          status: 'stopped',
          url: body.url || 'about:blank',
        }));
        return;
      }
      if (
        request.method === 'POST'
        && request.url === '/farming/api/browsers/browser_opened/start'
      ) {
        response.end(JSON.stringify({
          id: 'browser_opened',
          ownerAgentId: 'agent_test',
          workspace: projectWorkspace,
          name: 'Opened',
          status: 'running',
          url: 'https://opened.test/',
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
        response.end(JSON.stringify({
          mimeType: body.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          data: 'iVBORw0KGgo=',
          annotations: body.annotate ? [{ ref: 'e1', label: 1 }] : undefined,
        }));
        return;
      }
      if (
        request.method === 'POST'
        && request.url === '/farming/api/browsers/browser_project/action'
        && ['emulate', 'network'].includes(body?.kind)
      ) {
        response.end(JSON.stringify({ ok: true, received: body }));
        return;
      }
      if (
        request.method === 'POST'
        && request.url === '/farming/api/browsers/browser_project/action'
        && body?.kind === 'eval'
      ) {
        response.end(JSON.stringify({ value: 'Example' }));
        return;
      }
      if (request.method === 'DELETE' && request.url === '/farming/api/browsers/browser_project') {
        response.end(JSON.stringify({ id: 'browser_project', collectionRevision: 9 }));
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
          'browser',
          'backend',
          'browser-mcp-server.cjs'
        ))}).runBrowserMcpServer()`,
      ],
      env: {
        FARMING_CONTROL_URL: `http://127.0.0.1:${port}/farming`,
        FARMING_AGENT_ID: 'agent_test',
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
      'browser_open',
      'browser_list',
      'browser_snapshot',
      'browser_screenshot',
      'browser_emulate',
      'browser_start',
      'browser_stop',
      'browser_close',
      'browser_navigate',
      'browser_click',
      'browser_fill',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_history',
      'browser_wait',
      'browser_get',
      'browser_is',
      'browser_eval',
      'browser_element_action',
      'browser_keyboard',
      'browser_select',
      'browser_drag',
      'browser_find',
      'browser_debug',
      'browser_network',
      'browser_cookies',
      'browser_storage',
      'browser_frame',
      'browser_dialog',
      'browser_upload',
      'browser_download',
    ]);
    const snapshotTool = listedTools.tools.find(tool => tool.name === 'browser_snapshot');
    assert(snapshotTool.description.includes('untrusted data'));
    assert(snapshotTool.inputSchema.required.includes('browserId'));
    const waitTool = listedTools.tools.find(tool => tool.name === 'browser_wait');
    const evalTool = listedTools.tools.find(tool => tool.name === 'browser_eval');
    const debugTool = listedTools.tools.find(tool => tool.name === 'browser_debug');
    const networkTool = listedTools.tools.find(tool => tool.name === 'browser_network');
    assert.strictEqual(waitTool.annotations.readOnlyHint, false);
    assert.strictEqual(waitTool.annotations.destructiveHint, true);
    assert.strictEqual(evalTool.annotations.readOnlyHint, false);
    assert.strictEqual(evalTool.annotations.destructiveHint, true);
    assert.strictEqual(debugTool.annotations.readOnlyHint, false);
    assert.strictEqual(debugTool.annotations.destructiveHint, true);
    assert.strictEqual(networkTool.annotations.destructiveHint, true);

    const listed = await client.callTool({ name: 'browser_list', arguments: {} });
    const listedValue = JSON.parse(listed.content[0].text);
    assert.deepStrictEqual(listedValue.resources.map(resource => resource.id), ['browser_project']);
    assert.strictEqual(requests.at(-1).agentId, 'agent_test');

    const opened = await client.callTool({
      name: 'browser_open',
      arguments: { url: 'https://opened.test/', name: 'Opened' },
    });
    assert.strictEqual(JSON.parse(opened.content[0].text).id, 'browser_opened');
    const createRequest = requests.find(request => (
      request.method === 'POST' && request.url === '/farming/api/browsers'
    ));
    assert.deepStrictEqual(createRequest.body, {
      rootId: require('../../backend/workspace-root-registry.cjs').rootIdForPath(projectWorkspace),
      agentId: 'agent_test',
      name: 'Opened',
      url: 'https://opened.test/',
    });
    assert.strictEqual(createRequest.agentId, 'agent_test');
    assert.strictEqual(requests.at(-1).url, '/farming/api/browsers/browser_opened/start');

    const snapshot = await client.callTool({
      name: 'browser_snapshot',
      arguments: {
        browserId: 'browser_project',
        mode: 'interactive',
        compact: true,
        depth: 5,
        selector: '#main',
        includeUrls: true,
        maxElements: 100,
        maxChars: 20_000,
      },
    });
    const snapshotValue = JSON.parse(snapshot.content[0].text);
    assert.strictEqual(snapshotValue.elements[0].ref, 'e1');
    assert.deepStrictEqual(requests.at(-1).body, {
      kind: 'snapshot',
      mode: 'interactive',
      compact: true,
      depth: 5,
      selector: '#main',
      includeUrls: true,
      maxElements: 100,
      maxChars: 20_000,
    });
    assert.strictEqual(requests.at(-1).authorization, 'Bearer dGVzdC10b2tlbg');
    assert.strictEqual(requests.at(-1).cookie, undefined);

    const screenshot = await client.callTool({
      name: 'browser_screenshot',
      arguments: {
        browserId: 'browser_project',
        ref: 'e1',
        annotate: true,
        format: 'jpeg',
        quality: 80,
      },
    });
    assert.strictEqual(screenshot.content[1].type, 'image');
    assert.strictEqual(screenshot.content[1].mimeType, 'image/jpeg');
    assert.strictEqual(screenshot.content[1].data, 'iVBORw0KGgo=');
    assert.deepStrictEqual(requests.at(-1).body, {
      kind: 'screenshot',
      ref: 'e1',
      annotate: true,
      format: 'jpeg',
      quality: 80,
    });

    const emulated = await client.callTool({
      name: 'browser_emulate',
      arguments: {
        browserId: 'browser_project',
        viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
        colorScheme: 'dark',
        offline: true,
      },
    });
    assert.strictEqual(JSON.parse(emulated.content[0].text).ok, true);
    assert.deepStrictEqual(requests.at(-1).body, {
      kind: 'emulate',
      viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
      colorScheme: 'dark',
      offline: true,
    });

    const evaluated = await client.callTool({
      name: 'browser_eval',
      arguments: { browserId: 'browser_project', expression: 'document.title' },
    });
    assert.strictEqual(JSON.parse(evaluated.content[0].text).value, 'Example');
    assert.deepStrictEqual(requests.at(-1).body, {
      kind: 'eval',
      expression: 'document.title',
    });

    const routed = await client.callTool({
      name: 'browser_network',
      arguments: {
        browserId: 'browser_project',
        operation: 'route',
        pattern: '**/api/*',
        routeAction: 'respond',
        body: { mocked: true },
        resourceType: 'xhr,fetch',
      },
    });
    assert.strictEqual(JSON.parse(routed.content[0].text).ok, true);
    assert.deepStrictEqual(requests.at(-1).body, {
      kind: 'network',
      operation: 'route',
      pattern: '**/api/*',
      body: { mocked: true },
      resourceType: 'xhr,fetch',
    });

    const closed = await client.callTool({
      name: 'browser_close',
      arguments: { browserId: 'browser_project' },
    });
    assert.strictEqual(JSON.parse(closed.content[0].text).id, 'browser_project');
    assert.strictEqual(requests.at(-1).method, 'DELETE');

    const requestCountBeforeDeniedCall = requests.length;
    const denied = await client.callTool({
      name: 'browser_snapshot',
      arguments: { browserId: 'browser_other' },
    });
    assert.strictEqual(denied.isError, true);
    assert(denied.content[0].text.includes('not owned by this Agent'));
    assert.strictEqual(requests.length, requestCountBeforeDeniedCall + 1);
    assert.strictEqual(requests.at(-1).method, 'GET');

    const projected = mergeBrowserMcpServer([
      { name: 'docs', command: '/bin/docs-mcp', args: [], env: [] },
    ], {
      cliBinDir: '/opt/farming/bin',
      agentEnv: {
        FARMING_CONTROL_URL: 'http://127.0.0.1:6694/farming',
        FARMING_AGENT_ID: 'agent_test',
        FARMING_PROJECT_WORKSPACE: projectWorkspace,
        FARMING_TOKEN_FILE: tokenFile,
      },
    });
    assert.deepStrictEqual(projected.map(server => server.name), ['docs', 'farming-browser']);
    assert.strictEqual(projected[1].command, '/opt/farming/bin/farming');
    assert.deepStrictEqual(projected[1].args, ['browser', 'mcp']);
    assert(!JSON.stringify(projected[1]).includes('test-token'));
    const shared = mergeBrowserMcpServer(projected, {
      url: 'http://127.0.0.1:6694/farming/api/agent-capabilities/browser/mcp',
      token: 'scoped-browser-token',
    });
    assert.deepStrictEqual(shared[1], {
      name: 'farming-browser',
      type: 'http',
      url: 'http://127.0.0.1:6694/farming/api/agent-capabilities/browser/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer scoped-browser-token' }],
      _meta: { 'farming.dev/extension': 'browser' },
    });
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
