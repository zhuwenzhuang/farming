const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { AcpRealtimeOperationCoordinator } = require('../acp-realtime-operation-coordinator.cjs');

const projectRoot = path.join(__dirname, '..', '..');
const adapterPath = path.join(projectRoot, 'dist', 'acp', 'codex-acp-1.1.4.mjs');
const fakeCodexPath = path.join(__dirname, 'fixtures', 'fake-codex-app-server.ts');

function waitForPath(filePath) {
  if (fs.existsSync(filePath)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const directory = path.dirname(filePath);
    const watcher = fs.watch(directory, () => {
      if (!fs.existsSync(filePath)) return;
      watcher.close();
      resolve();
    });
    watcher.once('error', reject);
  });
}

async function runCase() {
  const fenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-realtime-fence-'));
  const child = spawn(process.execPath, [adapterPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      FARMING_TEST_STALL_PROMPT: '1',
      FARMING_TEST_REALTIME_FENCE_DIR: fenceDirectory,
      FARMING_TEST_REALTIME_LOSE_START_RESPONSE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextRequestId = 0;
  let stdout = '';
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: unknown) => void;
  }>();
  const realtimeEvents: any[] = [];
  const eventWaiters = new Set<{
    predicate: (event: any) => boolean;
    resolve: (event: any) => void;
  }>();

  const settleEventWaiters = (event: any) => {
    for (const waiter of eventWaiters) {
      if (!waiter.predicate(event)) continue;
      eventWaiters.delete(waiter);
      waiter.resolve(event);
    }
  };
  const waitForRealtimeEvent = (predicate: (event: any) => boolean) => {
    const existing = realtimeEvents.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => eventWaiters.add({ predicate, resolve }));
  };
  const request = (method: string, params: Record<string, unknown>): Promise<any> => {
    const id = ++nextRequestId;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };

  child.stderr.resume();
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8');
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(Object.assign(new Error(message.error.message), {
            name: 'RequestError',
            code: message.error.code,
            data: message.error.data,
          }));
        } else {
          waiter.resolve(message.result);
        }
        continue;
      }
      const realtime = message.params?.update?._meta?.codex?.realtime;
      if (
        message.method === 'session/update'
        && message.params?.update?.sessionUpdate === 'session_info_update'
        && realtime
      ) {
        realtimeEvents.push(realtime);
        settleEventWaiters(realtime);
      }
    }
  });

  try {
    const initialized = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'farming-realtime-test', version: '1' },
    });
    assert.deepStrictEqual(initialized.agentCapabilities._meta.codex.realtime, {
      version: 1,
      transport: 'webrtc',
      startMethod: '_codex/session/realtime/start',
      stopMethod: '_codex/session/realtime/stop',
    });
    const session = await request('session/new', { cwd: projectRoot, mcpServers: [] });
    const sessionId = session.sessionId;
    const coordinator = new AcpRealtimeOperationCoordinator();
    let adapterStarts = 0;

    const startOperation = operationId => coordinator.start(
      'agent-a',
      'binding-1',
      operationId,
      async () => {
        adapterStarts += 1;
        const adapterStart = request('_codex/session/realtime/start', {
          sessionId,
          operationId,
          sdp: `v=0\r\n${operationId}`,
        });
        if (operationId === 'voice-op-a') {
          void adapterStart.catch(() => undefined);
          await waitForPath(path.join(fenceDirectory, 'start-accepted-without-response'));
          throw Object.assign(new Error('Codex realtime start response outcome is unknown'), {
            realtimeStartOutcome: 'uncertain',
          });
        }
        await adapterStart;
        return { started: true };
      },
      () => request('_codex/session/realtime/stop', { sessionId, operationId }),
    );

    const startingA = startOperation('voice-op-a');
    await waitForPath(path.join(fenceDirectory, 'start-accepted-without-response'));
    const transcriptA = await waitForRealtimeEvent(
      event => event.operationId === 'voice-op-a' && event.method === 'thread/realtime/transcript/done',
    );
    assert.strictEqual(transcriptA.params.text, 'run focused tests');

    const startingB = startOperation('voice-op-b');
    await waitForPath(path.join(fenceDirectory, 'stop-response-returned'));
    assert.strictEqual(
      adapterStarts,
      1,
      'operation B must not reach the adapter after stop RPC response but before A closed',
    );

    fs.writeFileSync(path.join(fenceDirectory, 'release-closed'), '');
    const delayedSdpA = await waitForRealtimeEvent(
      event => event.operationId === 'voice-op-a'
        && event.method === 'thread/realtime/sdp'
        && event.params.sdp.includes('fake-delayed-a-answer'),
    );
    assert.strictEqual(delayedSdpA.operationId, 'voice-op-a');
    await waitForRealtimeEvent(
      event => event.operationId === 'voice-op-a' && event.method === 'thread/realtime/closed',
    );
    assert.deepStrictEqual(await startingA, {
      started: false,
      cancelled: true,
      operationId: 'voice-op-a',
    });
    assert.deepStrictEqual(await startingB, {
      started: true,
      operationId: 'voice-op-b',
    });
    assert.strictEqual(adapterStarts, 2);
    const sdpB = await waitForRealtimeEvent(
      event => event.operationId === 'voice-op-b' && event.method === 'thread/realtime/sdp',
    );
    assert.strictEqual(sdpB.params.sdp, 'v=0\r\nfake-answer');
    assert.ok(
      realtimeEvents.every(event => event.operationId === 'voice-op-a' || event.operationId === 'voice-op-b'),
      'the adapter, not the app-server notification, must attach an exact operation owner',
    );
  } finally {
    child.kill('SIGTERM');
    for (const waiter of pending.values()) waiter.reject(new Error('Codex ACP test ended'));
    fs.rmSync(fenceDirectory, { recursive: true, force: true });
  }
}

async function run() {
  let timeout;
  try {
    await Promise.race([
      runCase(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Codex ACP realtime fence test timed out')), 8_000);
      }),
    ]);
    console.log('✓ Codex ACP fences delayed Realtime events by exact operation ID');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
