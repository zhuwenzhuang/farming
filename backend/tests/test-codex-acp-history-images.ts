const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');
const adapterPath = path.join(projectRoot, 'dist', 'acp', 'codex-acp-1.3.0.mjs');
const fakeCodexPath = path.join(__dirname, 'fixtures', 'fake-codex-app-server.ts');
const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const sessionId = '019f0000-0000-7000-8000-000000000999';

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-history-image-'));
  const imagePath = path.join(tmpDir, 'screen.png');
  fs.writeFileSync(imagePath, Buffer.from(imageData, 'base64'));
  const child = spawn(process.execPath, [adapterPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      FARMING_TEST_HISTORY_IMAGE_PATH: imagePath,
      FARMING_TEST_HISTORY_IMAGE_DATA_URL: `data:image/png;base64,${imageData}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const updates = [];
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`ACP history image test timed out: ${stderr}`)),
        20_000,
      );
      let stdout = '';
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
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
              params: { sessionId, cwd: tmpDir, mcpServers: [] },
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
          clientInfo: { name: 'farming-history-image-test', version: '1' },
        },
      });
    });

    const userUpdates = updates
      .filter(update => update?.sessionUpdate === 'user_message_chunk');
    const contents = userUpdates.map(update => update.content);
    assert.deepStrictEqual(contents[0], { type: 'text', text: '请检查历史图片' });
    assert.deepStrictEqual(contents.slice(1, 4), [
      { type: 'image', mimeType: 'image/png', data: imageData },
      { type: 'image', mimeType: 'image/png', data: imageData },
      {
        type: 'resource_link',
        uri: `file://${imagePath}.missing`,
        name: 'screen.png.missing',
      },
    ]);
    assert.deepStrictEqual(contents[4], { type: 'text', text: '重点检查恢复后的图片' });
    assert(userUpdates.slice(0, 4).every(update => update._meta?.codex?.steer !== true));
    assert.deepStrictEqual(userUpdates[4]._meta, {
      codex: { steer: true, turnId: 'turn-history-image' },
    });
    assert(!contents.some(content => content?.type === 'text' && content.text.includes('[@image]')));
    console.log('✓ Codex ACP session/load emits native history image blocks');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
