const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const NativePtyHostClient = require('../native-pty-host-client');
const { nativePtyHostSocketPath } = require('../native-pty-host-path');

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

async function waitFor(fn, label, timeoutMs = 12000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error(`Timed out waiting for ${label}`);
}

function startServerProcess({ port, configDir }) {
  const fixtureBinDir = path.join(__dirname, '..', '..', 'tests', 'e2e', 'fixtures');
  const child = spawn(process.execPath, ['backend/farming-app-cli.js'], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      FARMING_BASE_PATH: '/farming',
      FARMING_CONFIG_DIR: configDir,
      FARMING_DISABLE_AUTH: '1',
      FARMING_RUN_SERVER: '1',
      FARMING_E2E_FAKE_EXECUTABLES: '1',
      FARMING_CODEX_BIN: path.join(fixtureBinDir, 'fake-codex'),
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
  child.kill('SIGKILL');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(5000).then(() => {
      throw new Error('Farming server did not exit after SIGKILL');
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
    await client.request('shutdownHost', {}, { timeoutMs: 5000 });
  } catch (error) {
    if (!error || !['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) {
      throw error;
    }
  } finally {
    client.disconnect();
  }
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-restart-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-restart-workspace-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/farming`;
  const marker = `SERVER_RESTART_MARKER_${Date.now()}`;
  const secondMarker = `${marker}_SECOND`;
  const postRecoveryMarker = `${marker}_POST_RECOVERY`;
  const fakeSessionId = '019f1234-5678-7abc-8def-0123456789ab';
  let serverProcess = null;
  let agentId = '';

  try {
    serverProcess = startServerProcess({ port, configDir });
    await waitFor(
      () => fetch(`${baseUrl}/api/control/agents`).then(response => response.ok).catch(() => false),
      'first Farming server startup',
      20000
    );

    const created = await fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({ command: `codex resume ${fakeSessionId}`, workspace }),
    });
    assert.strictEqual(created.response.status, 201, JSON.stringify(created.body));
    agentId = created.body.agentId;
    assert(agentId, 'control API should return the created agent id');

    await waitFor(async () => {
      const view = await fetchJson(baseUrl, `/api/agents/${agentId}/session-view`);
      return view.response.ok && String(view.body.session?.output || '').includes('Fake Codex') ? view.body.session : null;
    }, 'initial fake Codex output');

    const sent = await fetchJson(baseUrl, `/api/control/agents/${agentId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: `${marker}\n` }),
    });
    assert.strictEqual(sent.response.status, 200, JSON.stringify(sent.body));
    await waitFor(async () => {
      const view = await fetchJson(baseUrl, `/api/agents/${agentId}/session-view`);
      return view.response.ok && String(view.body.session?.output || '').includes(marker) ? view.body.session : null;
    }, 'terminal marker before restart');

    await stopServerProcess(serverProcess);
    serverProcess = null;

    serverProcess = startServerProcess({ port, configDir });
    await waitFor(
      () => fetch(`${baseUrl}/api/control/agents`).then(response => response.ok).catch(() => false),
      'second Farming server startup',
      20000
    );

    await waitFor(async () => {
      const listed = await fetchJson(baseUrl, '/api/control/agents');
      return listed.response.ok && (listed.body.agents || []).some(agent => agent.id === agentId);
    }, 'recovered agent after server restart', 20000);

    const recoveredView = await waitFor(async () => {
      const view = await fetchJson(baseUrl, `/api/agents/${agentId}/session-view`);
      return view.response.ok && String(view.body.session?.output || '').includes(marker) ? view.body.session : null;
    }, 'recovered terminal output after server restart', 20000);

    assert.strictEqual(recoveredView.engineName, 'native');
    assert.strictEqual(recoveredView.status, 'running');
    assert(Number.isFinite(recoveredView.outputSeq), 'recovered session view should expose outputSeq');

    const sentAfterRecovery = await fetchJson(baseUrl, `/api/control/agents/${agentId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: `${secondMarker}\n` }),
    });
    assert.strictEqual(sentAfterRecovery.response.status, 200, JSON.stringify(sentAfterRecovery.body));
    await waitFor(async () => {
      const view = await fetchJson(baseUrl, `/api/agents/${agentId}/session-view`);
      return view.response.ok && String(view.body.session?.output || '').includes(secondMarker);
    }, 'terminal input after first recovery');

    await stopServerProcess(serverProcess);
    serverProcess = null;
    serverProcess = startServerProcess({ port, configDir });
    await waitFor(
      () => fetch(`${baseUrl}/api/control/agents`).then(response => response.ok).catch(() => false),
      'third Farming server startup',
      20000
    );

    const twiceRecoveredAgents = await waitFor(async () => {
      const listed = await fetchJson(baseUrl, '/api/control/agents');
      if (!listed.response.ok) return null;
      const matches = (listed.body.agents || []).filter(agent => agent.id === agentId);
      return matches.length === 1 ? matches : null;
    }, 'single recovered agent after second server restart', 20000);
    assert.strictEqual(twiceRecoveredAgents.length, 1, 'repeated failover must not duplicate the Agent');

    const twiceRecoveredView = await waitFor(async () => {
      const view = await fetchJson(baseUrl, `/api/agents/${agentId}/session-view`);
      const output = String(view.body.session?.output || '');
      return view.response.ok && output.includes(marker) && output.includes(secondMarker)
        ? view.body.session
        : null;
    }, 'terminal output after second server restart', 20000);
    assert.strictEqual(twiceRecoveredView.engineName, 'native');
    assert.strictEqual(twiceRecoveredView.status, 'running');

    const sentAfterSecondRecovery = await fetchJson(baseUrl, `/api/control/agents/${agentId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: `${postRecoveryMarker}\n` }),
    });
    assert.strictEqual(sentAfterSecondRecovery.response.status, 200, JSON.stringify(sentAfterSecondRecovery.body));
    await waitFor(async () => {
      const view = await fetchJson(baseUrl, `/api/agents/${agentId}/session-view`);
      return view.response.ok && String(view.body.session?.output || '').includes(postRecoveryMarker);
    }, 'terminal input after repeated recovery');
    assert(
      !serverProcess.outputText().includes('circular dependency'),
      `CLI Server startup emitted a circular dependency warning:\n${serverProcess.outputText()}`,
    );

    await fetchJson(baseUrl, `/api/control/agents/${agentId}`, { method: 'DELETE' });

    console.log('✓ repeated Farming server failover preserves one writable native pty terminal session');
  } finally {
    await stopServerProcess(serverProcess);
    await shutdownNativeHost(configDir).catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
