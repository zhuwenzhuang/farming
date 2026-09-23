import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';

function killTestProcessGroup(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

async function run() {
  const root = path.resolve(__dirname, '../..');
  const child = spawn(process.execPath, [path.join(root, 'dist/acp/codex-acp-1.12.0.mjs')], {
    cwd: root,
    env: { ...process.env, CODEX_PATH: path.join(__dirname, 'fixtures/fake-codex-app-server.ts'),
      FARMING_TEST_LARGE_HISTORY: '1', FARMING_TEST_SPLIT_UTF8: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const closed = once(child, 'close');
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const texts: string[] = [];
  const send = (id: number, method: string, params: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`64 MiB history did not load within 15 seconds: ${stderr}`)), 15_000);
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Adapter exited: ${code} ${signal}: ${stderr}`)));
      lines.on('line', line => {
        try {
          const message = JSON.parse(line);
          if (message.error) throw new Error(JSON.stringify(message.error));
          const update = message.params?.update;
          if (update?.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text') texts.push(update.content.text);
          if (message.id === 1) send(2, 'session/load', {
            sessionId: '019f0000-0000-7000-8000-000000000999', cwd: root, mcpServers: [],
          });
          if (message.id === 2) {
            assert(texts.includes('通用谓词解析器'), 'the complete history must survive fragmented UTF-8');
            assert(!texts.some(text => text.includes('\uFFFD')));
            assert(message.result.models.availableModels.length > 0, 'later model discovery must complete after the large response');
            resolve();
          }
        } catch (error) { reject(error); }
      });
      send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'farming-large-history-test', version: '1' } });
    });
    console.log('✓ Codex ACP loads a 64 MiB fragmented history response within the setup budget');
  } finally {
    clearTimeout(timer);
    lines.close();
    killTestProcessGroup(child);
    await closed;
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
