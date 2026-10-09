const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { stopDaemon } = require('../farming-app-cli.cjs');
const { hardStopConfigProcesses } = require('../config-process-ownership.cjs');
const { readServerProcessIdentity } = require('../server-process-identity.cjs');
const { nativePtyHostSocketPath, nativePtyHostPrivateSocketNamePattern } = require('../native-pty-host-path.cjs');

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function freePort() {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

function groupRecord(configDir, role) {
  const directory = path.join(configDir, '.farming-processes');
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith('.json')) continue;
    const record = JSON.parse(fs.readFileSync(path.join(directory, entry), 'utf8'));
    if (record.role === role) return record;
  }
  return null;
}

async function run() {
  if (process.platform === 'win32') {
    console.log('foreground Config process-group isolation test skipped on Windows');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-foreground-stop-'));
  const lanes = [];
  const caller = readServerProcessIdentity(process.pid);
  assert(caller);
  try {
    for (const name of ['target', 'peer']) {
      const configDir = path.join(root, name, 'config');
      const workspace = path.join(root, name, 'workspace');
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(workspace, { recursive: true });
      const executable = path.join(workspace, 'owned-shell');
      fs.writeFileSync(executable, '#!/bin/sh\nsleep 300 &\necho "$!" > descendant.pid\nwait\n', { mode: 0o700 });
      const port = await freePort();
      const env = { ...process.env, FARMING_CONFIG_DIR: configDir, FARMING_BASE_PATH: '/farming',
        FARMING_DISABLE_AUTH: '1', FARMING_RUN_SERVER: '1', FARMING_SKIP_RUNTIME_PREPARE: '1',
        FARMING_SESSION_ENGINE: 'native', NODE_ENV: 'test', PORT: String(port) };
      // Deliberately inherit the same caller group, matching simultaneous
      // foreground Config launches. Never group-signal these Server roots.
      const child = spawn(process.execPath, ['backend/farming-app-cli.cjs'], {
        cwd: path.resolve(__dirname, '../..'), env, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      lanes.push({ configDir, workspace, executable, port, env, child, output: () => output });
    }
    for (const lane of lanes) {
      const baseUrl = `http://127.0.0.1:${lane.port}/farming`;
      await waitFor(async () => {
        if (lane.child.exitCode !== null || lane.child.signalCode !== null) throw new Error(lane.output());
        return fetch(`${baseUrl}/api/control/agents`, { signal: AbortSignal.timeout(1000) })
          .then(response => response.ok).catch(() => false);
      }, 'foreground Server readiness');
      lane.serverIdentity = readServerProcessIdentity(lane.child.pid);
      assert.equal(lane.serverIdentity.processGroupId, caller.processGroupId, 'foreground Servers share the caller group');
      const response = await fetch(`${baseUrl}/api/control/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: lane.executable, workspace: lane.workspace, agentRuntimeMode: 'terminal' }),
        signal: AbortSignal.timeout(15_000),
      });
      const created = await response.json();
      assert.equal(response.status, 201, JSON.stringify(created));
      lane.host = await waitFor(() => groupRecord(lane.configDir, 'native-pty-host'), 'native Host ownership');
      lane.terminal = await waitFor(() => groupRecord(lane.configDir, 'terminal'), 'terminal ownership');
      const descendantFile = path.join(lane.workspace, 'descendant.pid');
      const descendantPid = await waitFor(() => fs.existsSync(descendantFile)
        ? Number(fs.readFileSync(descendantFile, 'utf8').trim()) : 0, 'terminal descendant');
      lane.descendant = readServerProcessIdentity(descendantPid);
      assert(lane.descendant);
      assert.equal(lane.host.pid, lane.host.processGroupId, 'native Host must lead an isolated group');
      assert.notEqual(lane.host.processGroupId, caller.processGroupId, 'Host must not own the shared foreground group');
      assert.equal(lane.terminal.pid, lane.terminal.processGroupId);
      assert.equal(lane.descendant.processGroupId, lane.terminal.processGroupId);
    }
    assert.notEqual(lanes[0].host.processGroupId, lanes[1].host.processGroupId);
    assert.equal(await stopDaemon({ env: lanes[0].env }), 0);
    await waitFor(() => lanes[0].child.signalCode === 'SIGKILL', 'selected Server SIGKILL', 5000);
    for (const identity of [lanes[0].host, lanes[0].terminal, lanes[0].descendant]) {
      await waitFor(() => !readServerProcessIdentity(identity.pid), 'selected Config group exit', 5000);
    }
    assert.deepStrictEqual(readServerProcessIdentity(process.pid), caller, 'fixture caller must survive');
    for (const identity of [lanes[1].serverIdentity, lanes[1].host, lanes[1].terminal, lanes[1].descendant]) {
      const live = readServerProcessIdentity(identity.pid);
      assert(live && live.startedAt === identity.startedAt, 'peer Config process must remain live');
    }
    const peerResponse = await fetch(`http://127.0.0.1:${lanes[1].port}/farming/api/control/agents`,
      { signal: AbortSignal.timeout(2000) });
    assert(peerResponse.ok, 'peer Config must remain responsive after target stop');
    console.log('foreground Config hard-stop keeps shared caller and peer Server/Host/terminal/descendant alive');
  } finally {
    for (const lane of lanes) {
      if (lane.child.exitCode === null && lane.child.signalCode === null) {
        const current = readServerProcessIdentity(lane.child.pid);
        if (current && (!lane.serverIdentity || current.startedAt === lane.serverIdentity.startedAt)) {
          lane.child.kill('SIGKILL');
          await waitFor(() => lane.child.exitCode !== null || lane.child.signalCode !== null,
            'fixture Server cleanup', 5000);
        }
      }
      const cleaned = await hardStopConfigProcesses(lane.configDir);
      assert.equal(cleaned.refused, 0, 'fixture cleanup must prove all Config group ownership');
      const socket = nativePtyHostSocketPath(lane.configDir);
      const privateNames = nativePtyHostPrivateSocketNamePattern(socket);
      fs.rmSync(socket, { force: true });
      for (const name of fs.readdirSync(path.dirname(socket)).filter(name => privateNames.test(name))) {
        fs.rmSync(path.join(path.dirname(socket), name), { force: true });
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
