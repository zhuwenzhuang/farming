const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { AcpRuntimeHostClient } = require('../acp-runtime-host-client.cjs');
const { acpRuntimeHostSocketPath } = require('../acp-runtime-host-path.cjs');

const projectRoot = path.resolve(__dirname, '../..');
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(operation: () => T | Promise<T>, label: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out waiting for ${label}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isRecord(error) && String(error.code || '') !== 'ESRCH';
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await delay(50);
  }
  return !processAlive(pid);
}

async function stopExactProcess(pid: number): Promise<void> {
  if (!processAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch {
    // Best-effort cleanup; the process may have exited after the liveness check.
  }
  if (await waitForProcessExit(pid, 2_000)) return;
  try { process.kill(pid, 'SIGKILL'); } catch {
    // Best-effort cleanup; the process may have exited after the liveness check.
  }
  assert(await waitForProcessExit(pid, 5_000), `exact process ${pid} did not exit after SIGKILL`);
}

async function shutdownHost(configDir: string): Promise<void> {
  const client = new AcpRuntimeHostClient({ configDir, connectRetries: 20, connectRetryMs: 25 });
  try {
    await client.ensureConnected();
    await client.request('shutdownHost', {}, { timeoutMs: 5_000 });
  } catch (error: unknown) {
    const code = isRecord(error) ? String(error.code || '') : '';
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(code)) throw error;
  } finally {
    client.disconnect();
  }
}

async function stopProcess(child: ReturnType<typeof spawn> | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    delay(5_000),
  ]);
}

function pingHost(socketPath: string): Promise<UnknownRecord> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const finish = (error?: Error, result: UnknownRecord = {}) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.once('error', finish);
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: 1, method: 'ping', params: {} })}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.ok !== true) finish(new Error('Host ping failed'));
      else finish(undefined, isRecord(message.result) ? message.result : {});
    });
  });
}

function persistedRuntimeProcess(configDir: string, agentId: string): UnknownRecord | null {
  const directory = path.join(configDir, 'sessions');
  if (!fs.existsSync(directory)) return null;
  for (const name of fs.readdirSync(directory)) {
    if (!/^agent_[A-Za-z0-9_-]+\.json$/.test(name)) continue;
    const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (String(value.runtimeAgentId || '') !== agentId) continue;
    return isRecord(value.structuredRuntimeProcess) ? value.structuredRuntimeProcess : null;
  }
  return null;
}

async function fetchJson(
  baseUrl: string,
  pathname: string,
  options: RequestInit & { timeoutMs?: number } = {},
) {
  const { timeoutMs = 5_000, ...requestOptions } = options;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      ...requestOptions,
      signal: requestOptions.signal || AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', ...(requestOptions.headers || {}) },
    });
  } catch (error) {
    throw new Error(`${String(requestOptions.method || 'GET')} ${pathname} failed`, { cause: error });
  }
  const parsed: unknown = await response.json().catch(() => ({}));
  return { response, body: isRecord(parsed) ? parsed : {} };
}

async function main() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-host-sigkill-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-host-sigkill-workspace-'));
  const socketPath = acpRuntimeHostSocketPath(configDir);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/farming`;
  const server = spawn(process.execPath, ['backend/farming-app-cli.cjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      FARMING_BASE_PATH: '/farming',
      FARMING_CONFIG_DIR: configDir,
      FARMING_DISABLE_AUTH: '1',
      FARMING_E2E_FAKE_ACP_AGENT: '1',
      FARMING_E2E_FAKE_EXECUTABLES: '1',
      FARMING_RUN_SERVER: '1',
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  let hostPid = 0;
  let oldAdapterPid = 0;
  let replacementHostPid = 0;
  let replacementAdapterPid = 0;
  try {
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/control/agents`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
      return response?.ok;
    }, 'Farming Server startup');

    const created = await fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      timeoutMs: 15_000,
      body: JSON.stringify({
        command: 'codex',
        workspace,
        agentRuntimeMode: 'chat',
        requestId: `host-sigkill-create-${Date.now()}`,
      }),
    });
    assert.strictEqual(created.response.status, 201, JSON.stringify(created.body));
    const agentId = String(created.body.agentId || '');
    assert(agentId);
    const createdAgent = await waitFor(async () => {
      const listed = await fetchJson(baseUrl, '/api/control/agents');
      const agent = Array.isArray(listed.body.agents)
        ? listed.body.agents.find(candidate => candidate.id === agentId)
        : null;
      return isRecord(agent?.runtimeBinding)
        && agent.runtimeBinding.kind === 'acp'
        && agent.runtimeBinding.state === 'idle'
        ? agent
        : null;
    }, 'idle ACP Agent');
    const providerSessionId = String(createdAgent.providerSessionId || '');
    assert(providerSessionId);

    const promptRequestId = `host-sigkill-prompt-${Date.now()}`;
    const submitted = await fetchJson(baseUrl, `/api/control/agents/${agentId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        message: `host sigkill no replay ${promptRequestId}`,
        requestId: promptRequestId,
        delivery: 'prompt',
      }),
    });
    assert.strictEqual(submitted.response.status, 202, JSON.stringify(submitted.body));
    await waitFor(() => {
      const directory = path.join(configDir, 'fake-acp-session-state');
      if (!fs.existsSync(directory)) return false;
      const markers = fs.readdirSync(directory).filter(name => name.endsWith('.host-sigkill-prompt-count'));
      return markers.length === 1 && fs.readFileSync(path.join(directory, markers[0]), 'utf8').trim() === '1';
    }, 'provider ownership marker');

    oldAdapterPid = Number((await waitFor(
      () => persistedRuntimeProcess(configDir, agentId),
      'persisted adapter identity',
    )).pid || 0);
    assert(processAlive(oldAdapterPid));
    hostPid = Number((await waitFor(() => pingHost(socketPath), 'Host ping')).pid || 0);
    assert(processAlive(hostPid));

    process.kill(hostPid, 'SIGKILL');
    await waitFor(() => !processAlive(hostPid), 'Host SIGKILL exit');

    const autonomouslyRecovered = await waitFor(async () => {
      const listed = await fetchJson(baseUrl, '/api/control/agents');
      const agent = Array.isArray(listed.body.agents)
        ? listed.body.agents.find(candidate => candidate.id === agentId)
        : null;
      return isRecord(agent?.runtimeBinding)
        && agent.runtimeBinding.kind === 'acp'
        && agent.runtimeBinding.state === 'idle'
        && String(agent.providerSessionId || '') === providerSessionId
        ? agent
        : null;
    }, 'automatic cold resume after Host binding loss', 30_000);
    assert.strictEqual(autonomouslyRecovered.runtimeBinding.kind, 'acp');
    await waitFor(() => !processAlive(oldAdapterPid), 'old adapter cleanup after Host recovery');
    const replacement = await waitFor(() => {
      const identity = persistedRuntimeProcess(configDir, agentId);
      return identity && Number(identity.pid || 0) !== oldAdapterPid ? identity : null;
    }, 'replacement adapter identity');
    replacementAdapterPid = Number(replacement.pid || 0);
    assert(processAlive(replacementAdapterPid));
    const replacementHost = await pingHost(socketPath);
    replacementHostPid = Number(replacementHost.pid || 0);
    assert.notStrictEqual(replacementHostPid, hostPid);

    const explicitRequestId = `host-sigkill-explicit-${Date.now()}`;
    const explicit = await fetchJson(baseUrl, `/api/control/agents/${agentId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        message: 'new explicit request after reconnect',
        requestId: explicitRequestId,
        delivery: 'prompt',
      }),
    });
    assert.strictEqual(explicit.response.status, 202, JSON.stringify(explicit.body));

    const transcript = await waitFor(async () => {
      const result = await fetchJson(baseUrl, `/api/agents/${agentId}/acp-transcript?maxTurns=20`);
      return result.response.ok && JSON.stringify(result.body).includes('ACP reconnect reply') ? result.body : null;
    }, 'explicit post-SIGKILL reply', 30_000);
    assert(JSON.stringify(transcript).includes('ACP reconnect reply'));
    const markerDirectory = path.join(configDir, 'fake-acp-session-state');
    const marker = fs.readdirSync(markerDirectory).find(name => name.endsWith('.host-sigkill-prompt-count'));
    assert(marker);
    assert.strictEqual(
      fs.readFileSync(path.join(markerDirectory, marker), 'utf8').trim(),
      '1',
      'Host recovery must never replay the uncertain provider-owned prompt',
    );
    console.log('ACP runtime Host SIGKILL cold-resumes Chat without replaying an active Turn');
  } finally {
    await stopProcess(server);
    await shutdownHost(configDir).catch(() => {});
    for (const pid of [replacementAdapterPid, oldAdapterPid, replacementHostPid, hostPid]) {
      await stopExactProcess(pid).catch(() => {});
    }
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
}

const watchdog = setTimeout(() => {
  console.error('ACP runtime Host SIGKILL test exceeded 70 seconds');
  process.exitCode = 1;
}, 70_000);

main().then(() => clearTimeout(watchdog)).catch((error: unknown) => {
  clearTimeout(watchdog);
  console.error(error);
  process.exitCode = 1;
});
