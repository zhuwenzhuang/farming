const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { AcpRuntimeHostClient } = require('../acp-runtime-host-client.cts');
const { promptContentHash } = require('../acp-runtime-host-service.cts');

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('runtime host did not exit')), timeoutMs)),
  ]);
}

async function main() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-restart-'));
  const socketPath = path.join(configDir, 'host.sock');
  let hostChild;
  let first;
  let second;
  try {
    // This case tests controller reconnection to a live Host. Cold tsx startup
    // is a fixture prerequisite, not part of the client's connection budget.
    let hostOutput = '';
    const spawnHost = () => {
      if (hostChild) return;
      hostChild = spawn(process.execPath, [
        '--import',
        require.resolve('tsx'),
        '--eval',
        `require(${JSON.stringify(path.join(__dirname, '..', 'acp-runtime-host-process.cts'))})`
          + '.startAcpRuntimeHostProcess().then(() => process.send({ ready: true }))'
          + '.catch(error => { console.error(error); process.exit(1); });',
      ], {
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          FARMING_CONFIG_DIR: configDir,
          FARMING_ACP_RUNTIME_HOST_SOCKET: socketPath,
          FARMING_E2E_FAKE_ACP_AGENT: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      hostChild.stderr.on('data', chunk => { hostOutput = (hostOutput + chunk).slice(-65536); });
    };

    spawnHost();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        hostChild.off('message', onMessage);
        hostChild.off('exit', onExit);
        hostChild.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onMessage = message => { if (message?.ready === true) finish(); };
      const onExit = (code, signal) => finish(new Error(`Host fixture exited before ready (${code}, ${signal}): ${hostOutput}`));
      const onError = error => finish(error);
      const timer = setTimeout(() => finish(new Error(`Host fixture did not become ready: ${hostOutput}`)), 15000);
      hostChild.on('message', onMessage);
      hostChild.once('exit', onExit);
      hostChild.once('error', onError);
    });

    first = new AcpRuntimeHostClient({
      configDir,
      socketPath,
      spawnHost,
      connectRetries: 200,
      connectRetryMs: 20,
    });
    await first.ensureConnected();
    const prepared = await first.request('prepareAgent', {
      options: {
        agentId: 'agent-restart',
        provider: 'codex',
        cwd: process.cwd(),
        capabilityRuntimeEpoch: 'binding-restart',
        approvalMode: 'full',
      },
    });
    const sessionId = prepared.sessionId;
    assert(sessionId);

    const original = first.request('submitPrompt', {
      agentId: 'agent-restart',
      bindingEpoch: 'binding-restart',
      clientPromptId: 'prompt-restart',
      contentHash: promptContentHash([{ type: 'text', text: 'live progress across server restart' }]),
      prompt: [{ type: 'text', text: 'live progress across server restart' }],
    }, { timeoutMs: 0 });

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && first.bindings.get('agent-restart')?.state !== 'working') {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.strictEqual(first.bindings.get('agent-restart')?.state, 'working');
    first.disconnect();
    await assert.rejects(original, /disconnected|closed/);

    second = new AcpRuntimeHostClient({
      configDir,
      socketPath,
      spawnHost,
      connectRetries: 20,
      connectRetryMs: 20,
    });
    await second.ensureConnected();
    assert.strictEqual(second.hostEpoch, first.hostEpoch, 'Server restart must attach the same runtime Host');
    assert.strictEqual(second.bindings.get('agent-restart')?.state, 'working');
    assert.strictEqual(
      second.promptOperations.get('agent-restart\0prompt-restart')?.status,
      'provider-owned',
    );

    const joined = await second.request('submitPrompt', {
      agentId: 'agent-restart',
      bindingEpoch: 'binding-restart',
      clientPromptId: 'prompt-restart',
      contentHash: promptContentHash([{ type: 'text', text: 'live progress across server restart' }]),
      prompt: [{ type: 'text', text: 'live progress across server restart' }],
    }, { timeoutMs: 0 });
    assert.strictEqual(joined.stopReason, 'end_turn');
    const transcript = await second.request('getTranscriptSessionForRead', {
      agentId: 'agent-restart',
      options: { maxTurns: 1 },
    });
    assert(
      JSON.stringify(transcript).includes('Live progress complete.'),
      'the continued provider Turn must publish its final answer after Server restart',
    );

    await second.request('shutdownHost');
    await waitForExit(hostChild);
  } finally {
    first?.disconnect();
    second?.disconnect();
    if (hostChild && hostChild.exitCode === null && hostChild.signalCode === null) {
      hostChild.kill('SIGTERM');
      await waitForExit(hostChild).catch(() => {});
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('ACP runtime host restart continuity tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
