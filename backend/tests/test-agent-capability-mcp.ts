const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {
  createAgentCapabilityMcpHandler,
} = require('../agent-capability-mcp.cjs');
const { AgentCapabilityTokens } = require('../agent-capability-tokens.cjs');
const { canonicalWorkspacePath } = require('../workspace-root-registry.cjs');

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
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-capability-mcp-'));
  const workspace = path.join(temporaryRoot, 'workspace');
  const linkedWorkspace = path.join(temporaryRoot, 'workspace-link');
  const otherWorkspace = path.join(temporaryRoot, 'other-workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(otherWorkspace);
  fs.symlinkSync(workspace, linkedWorkspace);
  const canonicalWorkspace = canonicalWorkspacePath(workspace);
  const tokens = new AgentCapabilityTokens();
  const token = tokens.issue({
    agentId: 'agent-browser-one',
    capability: 'browser',
    runtimeEpoch: 'runtime-one',
    workspace: linkedWorkspace,
  });
  const otherAgentToken = tokens.issue({
    agentId: 'agent-browser-two',
    capability: 'browser',
    runtimeEpoch: 'runtime-one',
    workspace,
  });
  const wrongWorkspaceToken = tokens.issue({
    agentId: 'agent-browser-three',
    capability: 'browser',
    runtimeEpoch: 'runtime-one',
    workspace: otherWorkspace,
  });
  let routedAgentId = '';
  const controlApp = express();
  controlApp.get('/api/browsers', (request, response) => {
    routedAgentId = String(request.headers['x-farming-agent-id'] || '');
    response.json({
      resources: [{
        id: 'browser-one',
        ownerAgentId: routedAgentId,
        workspace: canonicalWorkspace,
      }],
    });
  });
  const controlServer = http.createServer(controlApp);
  const controlPort = await listen(controlServer);
  let bindingActive = true;
  let runtimeEpoch = 'runtime-one';
  const app = express();
  app.post('/mcp', express.json({ limit: '1mb' }), createAgentCapabilityMcpHandler({
    authDisabled: true,
    capability: 'browser',
    controlUrl: `http://127.0.0.1:${controlPort}`,
    resolveAgentBinding: agentId => (
      bindingActive && ['agent-browser-one', 'agent-browser-three'].includes(agentId)
        ? { runtimeEpoch, workspace }
        : null
    ),
    resolveToken: (candidate, capability) => tokens.resolve(candidate, capability),
  }));
  const server = http.createServer(app);
  const port = await listen(server);
  const client = new Client({ name: 'shared-capability-test', version: '1.0.0' });
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.some(tool => tool.name === 'browser_list'));
    assert(tools.tools.some(tool => tool.name === 'browser_open'));
    const listed = await client.callTool({ name: 'browser_list', arguments: {} });
    assert.deepStrictEqual(listed.structuredContent, {
      resources: [{
        id: 'browser-one',
        ownerAgentId: 'agent-browser-one',
        workspace: canonicalWorkspace,
      }],
    });
    assert.strictEqual(
      routedAgentId,
      'agent-browser-one',
      'the shared MCP route must forward the token-bound Agent identity to the real tool client',
    );

    const concurrentClients = Array.from({ length: 8 }, (_, index) => {
      const concurrentClient = new Client({
        name: `concurrent-capability-test-${index}`,
        version: '1.0.0',
      });
      const concurrentTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
      );
      return { client: concurrentClient, transport: concurrentTransport };
    });
    try {
      await Promise.all(concurrentClients.map(async entry => {
        await entry.client.connect(entry.transport);
        const listed = await entry.client.callTool({ name: 'browser_list', arguments: {} });
        assert.strictEqual(listed.structuredContent.resources[0].ownerAgentId, 'agent-browser-one');
      }));
    } finally {
      await Promise.all(concurrentClients.map(entry => entry.client.close().catch(() => {})));
    }

    runtimeEpoch = 'runtime-two';
    const staleEpochClient = new Client({ name: 'stale-epoch-capability-test', version: '1.0.0' });
    const staleEpochTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    await assert.rejects(
      () => staleEpochClient.connect(staleEpochTransport),
      /403|Agent capability binding is no longer active/,
      'a token from a stopped or replaced ACP runtime must fail the current epoch fence',
    );
    await staleEpochClient.close().catch(() => {});

    const rotatedToken = tokens.issue({
      agentId: 'agent-browser-one',
      capability: 'browser',
      runtimeEpoch,
      workspace,
    });
    assert.notStrictEqual(rotatedToken, token);
    const rotatedClient = new Client({ name: 'rotated-capability-test', version: '1.0.0' });
    const rotatedTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${rotatedToken}` } } },
    );
    await rotatedClient.connect(rotatedTransport);
    await rotatedClient.callTool({ name: 'browser_list', arguments: {} });
    await rotatedClient.close();

    const permanentlyStaleClient = new Client({ name: 'permanently-stale-capability-test', version: '1.0.0' });
    const permanentlyStaleTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    await assert.rejects(
      () => permanentlyStaleClient.connect(permanentlyStaleTransport),
      /401|Invalid Agent capability token/,
      'rotation must physically remove the previous token so it cannot reactivate',
    );
    await permanentlyStaleClient.close().catch(() => {});

    const forgedClient = new Client({ name: 'forged-capability-test', version: '1.0.0' });
    const forgedTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: 'Bearer forged-token' } } },
    );
    await assert.rejects(() => forgedClient.connect(forgedTransport), /401|Invalid Agent capability token/);
    await forgedClient.close().catch(() => {});

    for (const [name, rejectedToken] of [
      ['other-agent', otherAgentToken],
      ['wrong-workspace', wrongWorkspaceToken],
    ]) {
      const rejectedClient = new Client({ name: `${name}-capability-test`, version: '1.0.0' });
      const rejectedTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${rejectedToken}` } } },
      );
      await assert.rejects(
        () => rejectedClient.connect(rejectedTransport),
        /403|Agent capability binding is no longer active/,
      );
      await rejectedClient.close().catch(() => {});
    }

    bindingActive = false;
    const stoppedClient = new Client({ name: 'stopped-agent-capability-test', version: '1.0.0' });
    const stoppedTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${rotatedToken}` } } },
    );
    await assert.rejects(
      () => stoppedClient.connect(stoppedTransport),
      /403|Agent capability binding is no longer active/,
    );
    await stoppedClient.close().catch(() => {});
  } finally {
    await client.close().catch(() => {});
    await close(server).catch(() => {});
    await close(controlServer).catch(() => {});
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log('Shared Agent capability MCP tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
