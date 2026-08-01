const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');
const adapterPath = path.join(projectRoot, 'dist', 'acp', 'codex-acp-1.1.4.mjs');
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
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Codex ACP realtime test timed out: ${stderr}`)),
        3_000,
      );
      let stdout = '';
      let sessionId = '';
      const realtimeEvents = [];
      let stopRequested = false;
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
            assert.deepStrictEqual(message.result.agentCapabilities._meta.codex.realtime, {
              version: 1,
              transport: 'webrtc',
              startMethod: '_codex/session/realtime/start',
              stopMethod: '_codex/session/realtime/stop',
            });
            send(child, {
              jsonrpc: '2.0',
              id: 2,
              method: 'session/new',
              params: { cwd: projectRoot, mcpServers: [] },
            });
          }
          if (message.id === 2) {
            sessionId = message.result.sessionId;
            send(child, {
              jsonrpc: '2.0',
              id: 3,
              method: '_codex/session/realtime/start',
              params: { sessionId, sdp: 'v=0\r\nfake-offer' },
            });
          }
          if (
            message.method === 'session/update'
            && message.params?.update?.sessionUpdate === 'session_info_update'
            && message.params.update._meta?.codex?.realtime
          ) {
            const realtimeEvent = message.params.update._meta.codex.realtime;
            realtimeEvents.push(realtimeEvent);
            if (realtimeEvent.method === 'thread/realtime/transcript/done' && !stopRequested) {
              stopRequested = true;
              send(child, {
                jsonrpc: '2.0',
                id: 4,
                method: '_codex/session/realtime/stop',
                params: { sessionId },
              });
            }
            if (realtimeEvent.method === 'thread/realtime/closed') {
              const methods = realtimeEvents.map(event => event.method);
              assert.deepStrictEqual(methods, [
                'thread/realtime/sdp',
                'thread/realtime/transcript/done',
                'thread/realtime/closed',
              ]);
              assert.strictEqual(realtimeEvents[0].params.sdp, 'v=0\r\nfake-answer');
              assert.strictEqual(realtimeEvents[1].params.text, 'run focused tests');
              clearTimeout(timeout);
              resolve();
              return;
            }
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
          clientInfo: { name: 'farming-realtime-test', version: '1' },
        },
      });
    });

    console.log('✓ Codex ACP forwards realtime WebRTC signaling and transcript events');
  } finally {
    child.kill('SIGTERM');
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
