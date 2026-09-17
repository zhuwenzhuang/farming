const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const readline = require('readline');

async function run() {
  const root = path.join(__dirname, '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-codex-archive-'));
  const log = path.join(tmp, 'requests.jsonl');
  const child = spawn(process.execPath, [path.join(root, 'dist/acp/codex-acp-1.12.0.mjs')], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      CODEX_HOME: tmp,
      CODEX_PATH: path.join(__dirname, 'fixtures/fake-codex-app-server.ts'),
      FARMING_TEST_MULTI_SESSION: '1',
      FARMING_TEST_REQUEST_LOG_FILE: log,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const pending = new Map();
  let nextId = 1;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const request = (method, params) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out: ${stderr}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const initialized = await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'farming-archive-test', version: '1' },
      clientCapabilities: {},
    });
    assert.deepStrictEqual(initialized.agentCapabilities._meta.sessionArchive, {
      method: '_session/archive', version: 1,
    });
    const first = await request('session/new', { cwd: tmp, mcpServers: [] });
    const peer = await request('session/new', { cwd: tmp, mcpServers: [] });
    assert.notStrictEqual(first.sessionId, peer.sessionId);
    assert.deepStrictEqual(await request('_session/archive', { sessionId: first.sessionId }), { archived: true });
    await request('session/load', { sessionId: peer.sessionId, cwd: tmp, mcpServers: [] });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const archive = calls.filter(call => call.method === 'thread/archive');
    assert.strictEqual(archive.length, 1);
    assert.strictEqual(archive[0].params.threadId, first.sessionId);
    assert.strictEqual(new Set(calls.map(call => call.pid)).size, 1,
      'archive must use the app-server process that owns both Sessions');
    assert.strictEqual(calls.some(call => call.method === 'thread/delete'), false);
    assert.strictEqual(calls.some(call => call.method === 'thread/unsubscribe' && call.params.threadId === peer.sessionId), false);
    await assert.rejects(request('_session/archive', { sessionId: 'unknown-session' }), /Unknown session/);
    console.log('test-codex-acp-archive passed');
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    lines.close();
    try {
      const exited = child.exitCode === null && child.signalCode === null
        ? once(child, 'exit')
        : Promise.resolve();
      if (child.pid) {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) { assert.strictEqual(error.code, 'ESRCH'); }
        }
        await exited;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
