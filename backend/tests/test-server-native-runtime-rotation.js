const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const NativePtyHost = require('../native-pty-host');
const NativePtyHostClient = require('../native-pty-host-client');
const NativeSessionEngine = require('../native-session-engine');
const { FarmingSessionStore } = require('../farming-session-store');
const { nativePtyHostSocketPath } = require('../native-pty-host-path');
const { nativePtyHostRuntimeIdentity } = require('../native-pty-host-identity');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error(`Timed out waiting for ${label}`);
}

function startServerProcess({ port, configDir, codexBin }) {
  const fixtureBinDir = path.join(__dirname, '..', '..', 'tests', 'e2e', 'fixtures');
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      FARMING_BASE_PATH: '/farming',
      FARMING_CONFIG_DIR: configDir,
      FARMING_DISABLE_AUTH: '1',
      FARMING_E2E_FAKE_EXECUTABLES: '1',
      FARMING_CODEX_BIN: codexBin || path.join(fixtureBinDir, 'fake-codex'),
      NODE_ENV: 'test',
      PATH: `${fixtureBinDir}${path.delimiter}${process.env.PATH || ''}`,
    },
  });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', chunk => {
    output += chunk.toString('utf8');
  });
  child.outputText = () => output;
  return child;
}

async function stopServerProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(5000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }),
  ]);
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function shutdownNativeHost(configDir) {
  const client = new NativePtyHostClient({
    configDir,
    socketPath: nativePtyHostSocketPath(configDir),
  });
  try {
    const preparation = await client.request('serializeTerminalState', {}, { timeoutMs: 5000 });
    await client.request('shutdownHost', {
      preparationToken: preparation?.preparationToken || '',
    }, { timeoutMs: 5000 });
  } catch (error) {
    if (!error || !['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) {
      throw error;
    }
  } finally {
    client.disconnect();
  }
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-runtime-rotation-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-runtime-rotation-workspace-'));
  const socketPath = nativePtyHostSocketPath(configDir);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/farming`;
  const currentIdentity = nativePtyHostRuntimeIdentity();
  const oldIdentity = {
    ...currentIdentity,
    buildId: currentIdentity.buildId.replace(
      /^./,
      currentIdentity.buildId[0] === '0' ? '1' : '0',
    ),
    version: 'old-runtime-test',
  };
  const agentIds = Array.from({ length: 4 }, (_, index) => `agent-runtime-rotation-codex-${index}`);
  const sessionIds = [
    '019f9000-0000-7000-8000-000000000001',
    '019f9000-0000-7000-8000-000000000002',
    '019f9000-0000-7000-8000-000000000003',
    '019f9000-0000-7000-8000-000000000004',
  ];
  const beforeMarker = `BEFORE_ROTATION_${Date.now()}`;
  const afterMarker = `AFTER_ROTATION_${Date.now()}`;
  const fakeCodex = path.join(__dirname, '..', '..', 'tests', 'e2e', 'fixtures', 'fake-codex');
  const startupLockDir = path.join(configDir, 'fake-codex-startup.lock');
  const startupLockedFakeCodex = path.join(configDir, 'fake-codex-startup-lock');
  const providerHomeAlias = path.join(configDir, 'provider-home-alias');
  fs.symlinkSync(configDir, providerHomeAlias, 'dir');
  fs.writeFileSync(startupLockedFakeCodex, `#!/usr/bin/env bash
set -eu
if [[ " $* " == *" resume "* ]]; then
  if ! mkdir '${startupLockDir}'; then
    printf 'database is locked\\n' >&2
    exit 5
  fi
  trap "rmdir '${startupLockDir}' 2>/dev/null || true" EXIT
  printf 'Could not create otel exporter: fixture warning\\n' >&2
  sleep 0.25
  rmdir '${startupLockDir}'
  trap - EXIT
  printf '\\033[?25l\\033[?25h'
  if [[ " $* " == *" 019f9000-0000-7000-8000-000000000004 "* ]]; then
    printf 'Account setup required\\n'
    while IFS= read -r line; do
      printf 'setup received: %s\\n' "$line"
    done
    exit 0
  fi
fi
exec '${fakeCodex}' "$@"
`);
  fs.chmodSync(startupLockedFakeCodex, 0o755);
  const sessionStore = new FarmingSessionStore(configDir);
  sessionStore.init();
  sessionStore.setMainPageSessionKeys(sessionIds.map(sessionId => `agent-session:codex:${sessionId}`));
  const oldHost = new NativePtyHost({
    configDir,
    socketPath,
    runtimeIdentity: oldIdentity,
    exitOnShutdown: false,
  });
  let oldEngine = null;
  let serverProcess = null;

  try {
    await oldHost.start();
    const oldClient = new NativePtyHostClient({
      configDir,
      socketPath,
      expectedRuntimeIdentity: oldIdentity,
      preserveHostOnDisconnect: true,
    });
    oldEngine = new NativeSessionEngine({
      client: oldClient,
      preserveHostOnDispose: true,
    });
    const oldEpochs = new Map();
    for (let index = 0; index < agentIds.length; index += 1) {
      const agentId = agentIds[index];
      const sessionId = sessionIds[index];
      await oldEngine.createSession({
        agentId,
        command: fakeCodex,
        args: [],
        cwd: workspace,
        env: process.env,
        category: 'coding',
        metadata: {
          agentId,
          command: 'codex',
          forkCommand: fakeCodex,
          cwd: workspace,
          projectWorkspace: workspace,
          category: 'coding',
          wantsMain: false,
          visibleOnMainPage: true,
          source: 'runtime-rotation-test',
          provider: 'codex',
          providerSessionProvider: 'codex',
          providerHomeId: 'default',
          providerHomePath: index === 1 ? providerHomeAlias : configDir,
          providerSessionId: sessionId,
          providerSessionKey: `agent-session:codex:${sessionId}`,
        },
      });
      const initialState = await oldEngine.getSessionState(agentId);
      await oldEngine.sendInput(agentId, `${beforeMarker}_${index}\n`, {
        expectedRuntimeEpoch: initialState.runtimeEpoch,
      });
      const oldState = await waitFor(async () => {
        const state = await oldEngine.getSessionState(agentId);
        return String(state?.output || '').includes(`${beforeMarker}_${index}`) ? state : null;
      }, `old host marker ${index}`);
      oldEpochs.set(agentId, oldState.runtimeEpoch);
    }
    oldEngine.dispose();
    oldEngine = null;

    serverProcess = startServerProcess({
      port,
      configDir,
      codexBin: startupLockedFakeCodex,
    });
    await waitFor(
      () => fetch(`${baseUrl}/api/control/agents`).then(response => response.ok).catch(() => false),
      'Farming server startup after runtime mismatch',
    );

    for (let index = 0; index < agentIds.length; index += 1) {
      const agentId = agentIds[index];
      const revived = await waitFor(async () => {
        const view = await fetchJson(baseUrl, `/api/agents/${agentId}/session-view`);
        const session = view.body.session;
        return view.response.ok
          && session?.runtimeEpoch
          && session.runtimeEpoch !== oldEpochs.get(agentId)
          && String(session.renderOutput || '').includes(`${beforeMarker}_${index}`)
          && String(session.renderOutput || '').includes('History restored')
          && (
            index !== agentIds.length - 1
            || String(session.renderOutput || '').includes('Account setup required')
          )
          ? session
          : Promise.reject(new Error(
            `revived terminal not ready: ${view.response.status} ${JSON.stringify(view.body)}`,
          ));
      }, `revived terminal ${index} after controlled host rotation`);
      assert.strictEqual(revived.status, 'running');
      assert.strictEqual(revived.outputSeq >= 1, true);
      assert.strictEqual(revived.stateRevision >= 1, true);
      if (index === agentIds.length - 1) {
        assert(
          String(revived.renderOutput || '').includes('Account setup required'),
          'a healthy nonstandard Codex startup screen should release the queue',
        );
      }
    }
    assert(!serverProcess.outputText().includes('database is locked'), serverProcess.outputText());

    const agentId = agentIds[0];
    const sent = await fetchJson(baseUrl, `/api/control/agents/${agentId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: `${afterMarker}\n` }),
    });
    assert.strictEqual(sent.response.status, 200, JSON.stringify(sent.body));
    await waitFor(async () => {
      const view = await fetchJson(baseUrl, `/api/agents/${agentId}/session-view`);
      return String(view.body.session?.output || '').includes(afterMarker);
    }, 'new input after controlled host rotation');

    for (const currentAgentId of agentIds) {
      await fetchJson(baseUrl, `/api/control/agents/${currentAgentId}`, { method: 'DELETE' });
    }
    console.log('✓ Controlled native PTY runtime rotation serializes same-home Codex startup');
  } catch (error) {
    if (serverProcess?.outputText) {
      console.error(serverProcess.outputText());
    }
    throw error;
  } finally {
    if (oldEngine) oldEngine.dispose();
    await stopServerProcess(serverProcess);
    await oldHost.dispose().catch(() => {});
    await shutdownNativeHost(configDir).catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
