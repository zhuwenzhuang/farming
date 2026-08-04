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
let currentPhase = 'initializing';

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function agentById(body: UnknownRecord, agentId: string): UnknownRecord | null {
  return recordArray(body.agents).find(agent => String(agent.id || '') === agentId) || null;
}

function runtimeState(agent: UnknownRecord | null): string {
  return isRecord(agent?.runtimeBinding) ? String(agent.runtimeBinding.state || '') : '';
}

function structuredRuntimeProcess(record: UnknownRecord | null): UnknownRecord | null {
  return isRecord(record?.structuredRuntimeProcess) ? record.structuredRuntimeProcess : null;
}

function errorCode(error: unknown): string {
  return isRecord(error) ? String(error.code || '') : '';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a TCP port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor<T>(
  operation: () => T | Promise<T>,
  label: string,
  timeoutMs = 20_000,
): Promise<NonNullable<T>> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
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

function startServerProcess(options: { capabilityEnvFile: string; configDir: string; port: number }) {
  const child = spawn(process.execPath, ['backend/farming-app-cli.cjs'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(options.port),
      FARMING_BASE_PATH: '/farming',
      FARMING_CONFIG_DIR: options.configDir,
      FARMING_DISABLE_AUTH: '1',
      FARMING_E2E_FAKE_ACP_AGENT: '1',
      FARMING_E2E_FAKE_EXECUTABLES: '1',
      FARMING_TEST_ACP_CAPABILITY_ENV_FILE: options.capabilityEnvFile,
      FARMING_RUN_SERVER: '1',
      NODE_ENV: 'test',
    },
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  return Object.assign(child, { outputText: () => output });
}

async function stopServerProcess(child: ReturnType<typeof startServerProcess> | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    delay(5_000).then(() => {
      throw new Error(`Farming Server did not exit after SIGKILL:\n${child.outputText()}`);
    }),
  ]);
}

async function fetchJson(
  baseUrl: string,
  pathname: string,
  options: RequestInit = {},
): Promise<{ body: UnknownRecord; response: Response }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(5_000),
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body: unknown = await response.json().catch(() => ({}));
  return { response, body: isRecord(body) ? body : {} };
}

async function waitForServer(baseUrl: string, child: ReturnType<typeof startServerProcess>, label: string) {
  return waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited during startup:\n${child.outputText()}`);
    }
    const response = await fetch(`${baseUrl}/api/control/agents`, {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    return response?.ok === true;
  }, label);
}

function pingHost(socketPath: string): Promise<UnknownRecord> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const finish = (error?: Error, value?: UnknownRecord) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(value || {});
    };
    socket.once('error', error => finish(error));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, method: 'ping', params: {} })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const parsed: unknown = JSON.parse(buffer.slice(0, newline));
      const message = isRecord(parsed) ? parsed : {};
      if (message.ok !== true) finish(new Error(String(message.error || 'Host ping failed')));
      else finish(undefined, isRecord(message.result) ? message.result : {});
    });
  });
}

function persistedAgentRecord(configDir: string, agentId: string): UnknownRecord | null {
  const sessionsDir = path.join(configDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;
  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^agent_[A-Za-z0-9_-]+\.json$/.test(entry.name)) continue;
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(sessionsDir, entry.name), 'utf8'));
    const record = isRecord(parsed) ? parsed : {};
    if (String(record.runtimeAgentId || '') === agentId) return record;
  }
  return null;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== 'ESRCH';
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!processAlive(pid)) return true;
    await delay(50);
  }
  return !processAlive(pid);
}

async function stopExactProcess(pid: number): Promise<void> {
  if (!processAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Best-effort cleanup; the process may have exited after the liveness check.
  }
  if (await waitForProcessExit(pid, 2_000)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Best-effort cleanup; the process may have exited after the liveness check.
  }
  assert(await waitForProcessExit(pid, 5_000), `exact process ${pid} did not exit after SIGKILL`);
}

async function removeExactDirectory(directory: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      lastError = error;
      if (errorCode(error) !== 'ENOTEMPTY') throw error;
      await delay(50);
    }
  }
  throw lastError;
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

async function shutdownHost(configDir: string): Promise<void> {
  const client = new AcpRuntimeHostClient({ configDir, connectRetries: 20, connectRetryMs: 25 });
  try {
    await client.ensureConnected();
    await client.request('shutdownHost', {}, { timeoutMs: 5_000 });
  } catch (error: unknown) {
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(errorCode(error))) {
      throw error;
    }
  } finally {
    client.disconnect();
  }
}

async function run(): Promise<void> {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-acp-host-restart-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-acp-host-workspace-'));
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ browserExtensionEnabled: true }),
    { mode: 0o600 },
  );
  const socketPath = acpRuntimeHostSocketPath(configDir);
  const firstPort = await freePort();
  const secondPort = await freePort();
  const firstBaseUrl = `http://127.0.0.1:${firstPort}/farming`;
  const secondBaseUrl = `http://127.0.0.1:${secondPort}/farming`;
  const createRequestId = `create-acp-restart-${Date.now()}`;
  const promptRequestId = `prompt-acp-restart-${Date.now()}`;
  const prompt = `live progress across production Server restart ${promptRequestId}`;
  let serverA: ReturnType<typeof startServerProcess> | null = null;
  let serverB: ReturnType<typeof startServerProcess> | null = null;
  let adapterPid = 0;
  let hostPid = 0;
  let agentId = '';
  const capabilityEnvFile = path.join(configDir, 'test-acp-capability-env.json');

  try {
    currentPhase = 'starting Server A';
    serverA = startServerProcess({ capabilityEnvFile, configDir, port: firstPort });
    await waitForServer(firstBaseUrl, serverA, 'Farming Server A startup');

    currentPhase = 'creating ACP Agent';
    const created = await fetchJson(firstBaseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({
        command: 'codex',
        workspace,
        agentRuntimeMode: 'chat',
        requestId: createRequestId,
      }),
    });
    assert.strictEqual(created.response.status, 201, JSON.stringify(created.body));
    agentId = String(created.body.agentId || '');
    assert(agentId, 'control API must return the created ACP Agent id');

    await waitFor(async () => {
      const listed = await fetchJson(firstBaseUrl, '/api/control/agents');
      const agent = agentById(listed.body, agentId);
      return listed.response.ok && runtimeState(agent) === 'idle' ? agent : null;
    }, 'new ACP Agent idle state');

    const capabilityEnv = await waitFor(() => {
      if (!fs.existsSync(capabilityEnvFile)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(capabilityEnvFile, 'utf8'));
      return isRecord(parsed) ? parsed : null;
    }, 'captured ACP capability environment');
    assert.strictEqual(capabilityEnv.agentId, agentId);
    assert.strictEqual(capabilityEnv.workspace, fs.realpathSync(workspace));
    assert.match(String(capabilityEnv.browserToken || ''), /^[A-Za-z0-9_-]{40,}$/);
    assert.match(String(capabilityEnv.computerToken || ''), /^[A-Za-z0-9_-]{40,}$/);
    assert.match(String(capabilityEnv.runtimeEpoch || ''), /^[A-Za-z0-9._:-]{1,160}$/);
    const capabilityHeaders = {
      'X-Farming-Agent-Id': agentId,
      'X-Farming-Capability-Token': String(capabilityEnv.browserToken),
      'X-Farming-Capability-Runtime-Epoch': String(capabilityEnv.runtimeEpoch),
    };
    const browserBeforeRestart = await fetchJson(firstBaseUrl, '/api/browsers', {
      headers: capabilityHeaders,
    });
    assert.strictEqual(browserBeforeRestart.response.status, 200, JSON.stringify(browserBeforeRestart.body));

    currentPhase = 'submitting active Turn';
    const submitted = await fetchJson(firstBaseUrl, `/api/control/agents/${agentId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: prompt, requestId: promptRequestId, delivery: 'prompt' }),
    });
    assert.strictEqual(submitted.response.status, 202, JSON.stringify(submitted.body));

    await waitFor(async () => {
      const listed = await fetchJson(firstBaseUrl, '/api/control/agents');
      const agent = agentById(listed.body, agentId);
      return runtimeState(agent) === 'working' ? agent : null;
    }, 'Server A working ACP Turn');

    const persisted = await waitFor(
      () => structuredRuntimeProcess(persistedAgentRecord(configDir, agentId)),
      'persisted ACP adapter identity',
    );
    adapterPid = Number(persisted.pid || 0);
    assert(processAlive(adapterPid), 'the exact ACP adapter process must be alive before restart');

    const hostA = await waitFor(() => pingHost(socketPath), 'ACP Runtime Host A ping');
    hostPid = Number(hostA.pid || 0);
    assert(processAlive(hostPid), 'the ACP Runtime Host must be alive before Server restart');
    assert(hostA.hostEpoch, 'the ACP Runtime Host must expose a hostEpoch');

    currentPhase = 'stopping Server A';
    await stopServerProcess(serverA);
    serverA = null;

    const hostAfterServerA = await waitFor(() => pingHost(socketPath), 'Host survival after Server A exit');
    assert.strictEqual(hostAfterServerA.pid, hostA.pid, 'Server exit must not replace the ACP Runtime Host');
    assert.strictEqual(hostAfterServerA.hostEpoch, hostA.hostEpoch, 'Server exit must preserve hostEpoch');
    assert(processAlive(adapterPid), 'Server exit must not stop the Host-owned ACP adapter');

    currentPhase = 'starting Server B';
    serverB = startServerProcess({ capabilityEnvFile, configDir, port: secondPort });
    await waitForServer(secondBaseUrl, serverB, 'Farming Server B startup');

    let recovered: UnknownRecord;
    let lastRecoveredAgent: UnknownRecord | null = null;
    try {
      recovered = await waitFor(async () => {
        const listed = await fetchJson(secondBaseUrl, '/api/control/agents');
        const matches = recordArray(listed.body.agents)
          .filter(agent => String(agent.id || '') === agentId);
        lastRecoveredAgent = matches.length === 1 ? matches[0] : null;
        return matches.length === 1 && ['working', 'idle'].includes(runtimeState(matches[0]))
          ? matches[0]
          : null;
      }, 'same healthy ACP Agent after Server B recovery');
    } catch (error) {
      throw new Error(`Server B did not recover the active ACP Agent. Last state: ${JSON.stringify(lastRecoveredAgent)}\n${serverB.outputText()}`, {
        cause: error,
      });
    }
    assert.strictEqual(recovered.id, agentId);
    assert(
      processAlive(adapterPid),
      'Server B recovery must retain the original exact ACP adapter process',
    );
    const persistedAfterRecovery = await waitFor(
      () => structuredRuntimeProcess(persistedAgentRecord(configDir, agentId)),
      'persisted ACP adapter identity after Server B recovery',
    );
    assert.strictEqual(
      Number(persistedAfterRecovery.pid || 0),
      adapterPid,
      'Server B must not kill the old adapter and silently persist a replacement process',
    );

    const hostB = await pingHost(socketPath);
    assert.strictEqual(hostB.pid, hostA.pid, 'Server B must attach the existing Host process');
    assert.strictEqual(hostB.hostEpoch, hostA.hostEpoch, 'Server B must recover the existing hostEpoch');

    const browserAfterRestart = await fetchJson(secondBaseUrl, '/api/browsers', {
      headers: capabilityHeaders,
    });
    assert.strictEqual(
      browserAfterRestart.response.status,
      200,
      `the surviving ACP process credential must remain valid after Server restart: ${JSON.stringify(browserAfterRestart.body)}`,
    );
    const missingCredential = await fetchJson(secondBaseUrl, '/api/browsers', {
      headers: {
        'X-Farming-Agent-Id': agentId,
        'X-Farming-Capability-Runtime-Epoch': String(capabilityEnv.runtimeEpoch),
      },
    });
    assert.strictEqual(missingCredential.response.status, 401);
    assert.strictEqual(missingCredential.body.code, 'BROWSER_AGENT_CREDENTIAL_INVALID');
    const crossCapabilityCredential = await fetchJson(secondBaseUrl, '/api/browsers', {
      headers: {
        ...capabilityHeaders,
        'X-Farming-Capability-Token': String(capabilityEnv.computerToken),
      },
    });
    assert.strictEqual(crossCapabilityCredential.response.status, 401);
    assert.strictEqual(crossCapabilityCredential.body.code, 'BROWSER_AGENT_CREDENTIAL_INVALID');

    currentPhase = 'joining duplicate prompt';
    const duplicate = await fetchJson(secondBaseUrl, `/api/control/agents/${agentId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: prompt, requestId: promptRequestId, delivery: 'prompt' }),
    });
    assert.strictEqual(duplicate.response.status, 202, JSON.stringify(duplicate.body));

    const transcript = await waitFor(async () => {
      const result = await fetchJson(secondBaseUrl, `/api/agents/${agentId}/acp-transcript?maxTurns=20`);
      const serialized = JSON.stringify(result.body);
      return result.response.ok && serialized.includes('Live progress complete.')
        ? result.body
        : null;
    }, 'continued ACP Turn final transcript', 15_000);
    const serializedTranscript = JSON.stringify(transcript);
    assert.strictEqual(
      countOccurrences(serializedTranscript, 'Live progress complete.'),
      1,
      'the provider prompt must execute exactly once across Server restart and duplicate submission',
    );
    assert.strictEqual(
      countOccurrences(serializedTranscript, prompt),
      1,
      'the recovered transcript must contain one exact user prompt',
    );

    currentPhase = 'deleting recovered Agent';
    const deleted = await fetchJson(secondBaseUrl, `/api/control/agents/${agentId}?recordHistory=0`, {
      method: 'DELETE',
    });
    assert([200, 202].includes(deleted.response.status), JSON.stringify(deleted.body));
    await waitFor(async () => {
      const listed = await fetchJson(secondBaseUrl, '/api/control/agents');
      return listed.response.ok && !agentById(listed.body, agentId);
    }, 'explicit Agent deletion');
    await waitFor(() => !processAlive(adapterPid), 'exact ACP adapter exit after Agent deletion');

    const hostAfterDelete = await pingHost(socketPath);
    assert.strictEqual(hostAfterDelete.pid, hostA.pid, 'deleting one Agent must not replace its Runtime Host');
    assert.strictEqual(hostAfterDelete.hostEpoch, hostA.hostEpoch);

    currentPhase = 'stopping Server B';
    await stopServerProcess(serverB);
    serverB = null;

    currentPhase = 'connecting deleted-binding inspector';
    const inspector = new AcpRuntimeHostClient({
      configDir,
      connectRetries: 5,
      connectRetryMs: 25,
      requestTimeoutMs: 5_000,
    });
    try {
      await Promise.race([
        inspector.ensureConnected(),
        delay(10_000).then(() => {
          throw new Error('Timed out connecting the deleted-binding Host inspector');
        }),
      ]);
      currentPhase = 'checking deleted Host binding';
      assert.strictEqual(inspector.hostEpoch, hostA.hostEpoch, 'inspection must attach the same Host');
      assert.strictEqual(
        inspector.bindings.has(agentId),
        false,
        'explicit Agent deletion must remove the exact Host binding',
      );
      currentPhase = 'shutting down inspected Host';
      await inspector.request('shutdownHost', {}, { timeoutMs: 5_000 });
    } finally {
      inspector.disconnect();
    }
    currentPhase = 'waiting for inspected Host shutdown';
    if (!(await waitForProcessExit(hostPid, 3_000))) {
      await stopExactProcess(hostPid);
    }

    currentPhase = 'complete';
    console.log('Server A/B restart preserves one active ACP Turn and exact Host-owned deletion');
  } finally {
    await stopServerProcess(serverA).catch(() => {});
    await stopServerProcess(serverB).catch(() => {});
    await shutdownHost(configDir).catch(() => {});
    await stopExactProcess(adapterPid).catch(() => {});
    await stopExactProcess(hostPid).catch(() => {});
    await removeExactDirectory(configDir);
    await removeExactDirectory(workspace);
    await removeExactDirectory(path.dirname(socketPath));
  }
}

const watchdog = setTimeout(() => {
  console.error(`Server ACP Runtime Host restart test exceeded 60 seconds during ${currentPhase}`);
  process.exitCode = 1;
}, 60_000);

run().then(() => {
  clearTimeout(watchdog);
}).catch(error => {
  clearTimeout(watchdog);
  console.error(error);
  process.exitCode = 1;
});
