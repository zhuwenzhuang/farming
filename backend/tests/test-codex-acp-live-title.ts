const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');
const adapterPath = path.join(projectRoot, 'dist', 'acp', 'codex-acp-1.4.0.mjs');
const fakeCodexPath = path.join(__dirname, 'fixtures', 'fake-codex-app-server.ts');

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function run() {
  const child = spawn(process.execPath, [adapterPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      FARMING_TEST_STALL_PROMPT: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
  });

  try {
    const title = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Codex ACP did not publish a title while the first turn was active: ${stderr}`)),
        3_000,
      );
      let stdout = '';
      let promptCompleted = false;
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
              jsonrpc: '2.0',
              id: 2,
              method: 'session/new',
              params: { cwd: projectRoot, mcpServers: [] },
            });
          }
          if (message.id === 2) {
            send(child, {
              jsonrpc: '2.0',
              id: 3,
              method: 'session/prompt',
              params: {
                sessionId: message.result.sessionId,
                prompt: [{ type: 'text', text: 'Diagnose the Agent title synchronization defect' }],
              },
            });
          }
          if (message.id === 3) promptCompleted = true;
          if (
            message.method === 'session/update'
            && message.params?.update?.sessionUpdate === 'session_info_update'
            && message.params.update.title
          ) {
            clearTimeout(timeout);
            assert.strictEqual(promptCompleted, false, 'the fake first turn must still be active');
            resolve(message.params.update.title);
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
          clientInfo: { name: 'farming-live-title-test', version: '1' },
        },
      });
    });

    assert.strictEqual(title, 'Diagnose the Agent title synchronization defect');
    console.log('✓ Codex ACP publishes the first task title before the turn completes');
  } finally {
    child.kill('SIGTERM');
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
