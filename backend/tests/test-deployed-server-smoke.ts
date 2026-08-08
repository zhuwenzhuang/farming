const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const projectRoot = path.join(__dirname, '../..');
const smokeScript = path.join(projectRoot, 'scripts', 'smoke-deployed-server.mjs');

interface SmokeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function listen(server: import('http').Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Smoke fixture did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: import('http').Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => (
    error ? reject(error) : resolve()
  )));
}

function readBody(request: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

function runSmoke(args: string[]): Promise<SmokeResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [smokeScript, ...args], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-deployed-smoke.'));
  const workspace = path.join(root, 'workspace');
  const agents = new Map();
  const deletedAgentIds = [];
  let terminalCreates = 0;
  let chatCreates = 0;
  const createdSources: unknown[] = [];

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/farming/api/control/agents' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ agents: [...agents.values()] }));
      return;
    }

    if (url.pathname === '/farming/api/control/agents' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      createdSources.push(body.source);
      const id = body.command === 'bash' ? 'agent-terminal-smoke' : 'agent-chat-smoke';
      if (body.command === 'bash') {
        terminalCreates += 1;
        agents.set(id, {
          id,
          command: 'bash',
          cwd: path.resolve(workspace),
          status: 'running',
          runtimeBinding: { kind: 'terminal' },
        });
      } else {
        chatCreates += 1;
        agents.set(id, {
          id,
          command: 'codex',
          cwd: path.resolve(workspace),
          status: 'running',
          runtimeBinding: { kind: 'acp', state: 'idle' },
        });
      }
      response.statusCode = 201;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ agentId: id, initialInputDelivered: false }));
      return;
    }

    const match = url.pathname.match(/^\/farming\/api\/control\/agents\/([^/]+)$/);
    if (match && request.method === 'DELETE') {
      const id = decodeURIComponent(match[1]);
      agents.delete(id);
      deletedAgentIds.push(id);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ agentId: id, killed: true }));
      return;
    }

    response.statusCode = 404;
    response.end('not found');
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/farming/ws') {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, websocket => {
      websocketServer.emit('connection', websocket, request);
    });
  });
  websocketServer.on('connection', websocket => {
    websocket.send(JSON.stringify({ type: 'state', agents: [] }));
  });

  try {
    const port = await listen(server);
    const result = await runSmoke([
      '--base-url', `http://127.0.0.1:${port}/farming`,
      '--workspace', workspace,
      '--agent', 'codex',
      '--timeout-ms', '1000',
    ]);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      ok: true,
      websocket: true,
      terminal: true,
      chat: true,
    });
    assert.strictEqual(terminalCreates, 1);
    assert.strictEqual(chatCreates, 1);
    assert.deepStrictEqual(createdSources, ['deployment-smoke', 'deployment-smoke']);
    assert.deepStrictEqual(deletedAgentIds, ['agent-terminal-smoke', 'agent-chat-smoke']);
    assert.strictEqual(agents.size, 0);
    console.log('✓ deployed Server smoke reads ACP idle from the authoritative runtime binding');
  } finally {
    websocketServer.close();
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
