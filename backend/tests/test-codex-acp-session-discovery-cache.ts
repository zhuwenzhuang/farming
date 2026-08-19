const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');
const adapterPath = path.join(projectRoot, 'dist', 'acp', 'codex-acp-1.4.0.mjs');
const fakeCodexPath = path.join(__dirname, 'fixtures', 'fake-codex-app-server.ts');

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-codex-discovery-cache-'));
  const requestLogFile = path.join(tmpDir, 'requests.jsonl');
  const child = spawn(process.execPath, [adapterPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      FARMING_TEST_REQUEST_LOG_FILE: requestLogFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Codex ACP discovery cache test timed out: ${stderr}`)),
        10_000,
      );
      let stdout = '';
      const completedLoads = new Set();
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
        for (;;) {
          const newline = stdout.indexOf('\n');
          if (newline < 0) break;
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.id === 1) {
            send(child, {
              jsonrpc: '2.0', id: 2, method: 'session/load',
              params: { sessionId: '019f0000-0000-7000-8000-000000000101', cwd: tmpDir, mcpServers: [] },
            });
            send(child, {
              jsonrpc: '2.0', id: 3, method: 'session/load',
              params: { sessionId: '019f0000-0000-7000-8000-000000000102', cwd: tmpDir, mcpServers: [] },
            });
          }
          if (message.id === 2 || message.id === 3) {
            if (message.error) {
              clearTimeout(timeout);
              reject(new Error(JSON.stringify(message.error)));
              return;
            }
            completedLoads.add(message.id);
            if (completedLoads.size === 2) {
              send(child, {
                jsonrpc: '2.0', id: 4, method: 'session/load',
                params: { sessionId: '019f0000-0000-7000-8000-000000000103', cwd: tmpDir, mcpServers: [] },
              });
            }
          }
          if (message.id === 4) {
            clearTimeout(timeout);
            if (message.error) reject(new Error(JSON.stringify(message.error)));
            else resolve();
            return;
          }
        }
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Codex ACP exited early: code=${code} signal=${signal || ''} ${stderr}`));
      });
      send(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          clientInfo: { name: 'farming-discovery-cache-test', version: '1' },
        },
      });
    });

    const requests = fs.readFileSync(requestLogFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const skillRequests = requests.filter(request => request.method === 'skills/list');
    const modelRequests = requests.filter(request => request.method === 'model/list');
    assert.strictEqual(skillRequests.filter(request => request.params.forceReload === true).length, 1,
      'concurrent and later Sessions in one Codex runtime must not repeat a full Skills reload');
    assert.strictEqual(skillRequests[0].params.forceReload, true,
      'the first Session must still establish an authoritative Skills snapshot');
    assert(skillRequests.slice(1).every(request => request.params.forceReload !== true),
      'later Session setup and command discovery may only consult the warm Skills cache');
    assert.strictEqual(modelRequests.length, 1,
      'Session-global model discovery must be reused by every Session in one Codex runtime');
    console.log('✓ Codex ACP reuses runtime discovery across Session loads');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
