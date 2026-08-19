const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');
const adapterPath = path.join(projectRoot, 'dist', 'acp', 'codex-acp-1.6.0.mjs');
const fakeCodexPath = path.join(__dirname, 'fixtures', 'fake-codex-app-server.ts');
const sessionId = '019f0000-0000-7000-8000-000000000999';

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function run() {
  const child = spawn(process.execPath, [adapterPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      FARMING_TEST_SPLIT_UTF8: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const updates = [];
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8');

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`ACP split UTF-8 test timed out: ${stderr}`)),
        20_000,
      );
      let stdout = '';
      child.stdout.on('data', chunk => {
        stdout += chunk;
        for (;;) {
          const newline = stdout.indexOf('\n');
          if (newline < 0) break;
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.method === 'session/update') {
            updates.push(message.params?.update);
          }
          if (message.id === 1) {
            if (message.error) {
              clearTimeout(timeout);
              reject(new Error(JSON.stringify(message.error)));
              return;
            }
            send(child, {
              jsonrpc: '2.0',
              id: 2,
              method: 'session/load',
              params: { sessionId, cwd: projectRoot, mcpServers: [] },
            });
          }
          if (message.id === 2) {
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
          clientInfo: { name: 'farming-split-utf8-test', version: '1' },
        },
      });
    });

    const firstText = updates.find(update => (
      update?.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text'
    ))?.content?.text;
    assert.strictEqual(firstText, '通用谓词解析器');
    assert(!updates.some(update => JSON.stringify(update).includes('\uFFFD')));
    console.log('✓ Codex ACP preserves UTF-8 characters split across stdout chunks');
  } finally {
    child.kill('SIGTERM');
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
