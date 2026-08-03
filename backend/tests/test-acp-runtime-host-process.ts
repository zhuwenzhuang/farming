const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { AcpRuntimeHostProcess } = require('../acp-runtime-host-process.cts');
const { promptContentHash } = require('../acp-runtime-host-service.cts');
const { acpRuntimeHostSocketPath } = require('../acp-runtime-host-path.cts');

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.promptCalls = 0;
    this.promptCompletion = null;
    this.inputCalls = 0;
  }

  bindingEpoch(agentId) {
    return this.sessions.get(agentId)?.bindingEpoch || '';
  }

  getSession(agentId) {
    return { ...this.sessions.get(agentId) };
  }

  async prepareAgent(options) {
    const session = {
      agentId: options.agentId,
      bindingEpoch: options.capabilityRuntimeEpoch,
      sessionId: options.sessionId,
      state: 'idle',
      revision: 1,
    };
    this.sessions.set(options.agentId, session);
    this.emit('agent-runtime', session);
    return { sessionId: options.sessionId, historyMode: 'load' };
  }

  submitMessage(agentId, _prompt, options: { onSubmitted?: () => void } = {}) {
    this.promptCalls += 1;
    options.onSubmitted?.();
    const session = this.sessions.get(agentId);
    session.state = 'working';
    session.revision += 1;
    this.emit('agent-runtime', session);
    return new Promise(resolve => {
      this.promptCompletion = result => {
        session.state = 'idle';
        session.revision += 1;
        this.emit('agent-runtime', session);
        resolve(result);
      };
    });
  }

  async dispose() {}

  inputTerminal() {
    this.inputCalls += 1;
    return { written: true };
  }
}

class HostClient {
  socket;
  buffer;
  nextId;
  pending;

  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    socket.on('data', chunk => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const message = JSON.parse(line);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(message.error?.message || String(message.error)));
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  request(method, params = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => (
      this.pending.set(id, { resolve, reject })
    ));
    this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  close() {
    this.socket.destroy();
  }
}

async function connect(socketPath) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return new HostClient(socket);
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function main() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-process-'));
  const socketPath = path.join(configDir, 'host.sock');
  const runtime = new FakeRuntime();
  const host = new AcpRuntimeHostProcess({
    configDir,
    socketPath,
    runtime,
    exitOnShutdown: false,
  });
  try {
    await host.start();
    const first = await connect(socketPath);
    await first.request('registerController', { identity: { id: 'server-a', generation: 1 } });
    await first.request('prepareAgent', {
      options: {
        agentId: 'agent-1',
        capabilityRuntimeEpoch: 'binding-1',
        sessionId: 'session-1',
      },
    });
    const originalPrompt = first.request('submitPrompt', {
      agentId: 'agent-1',
      bindingEpoch: 'binding-1',
      clientPromptId: 'prompt-1',
      contentHash: promptContentHash([{ type: 'text', text: 'work' }]),
      prompt: [{ type: 'text', text: 'work' }],
    });
    await waitFor(() => runtime.promptCalls === 1, 'prompt was not admitted by the runtime host');
    assert.strictEqual(runtime.promptCalls, 1);
    first.close();
    await new Promise(resolve => setImmediate(resolve));

    const stale = await connect(socketPath);
    await assert.rejects(
      stale.request('registerController', { identity: { id: 'server-a', generation: 1 } }),
      /Stale ACP runtime host controller/,
    );
    stale.close();

    const second = await connect(socketPath);
    await second.request('registerController', { identity: { id: 'server-b', generation: 2 } });
    const replacement = await connect(socketPath);
    await replacement.request('registerController', { identity: { id: 'server-b', generation: 2 } });
    await waitFor(() => second.socket.destroyed, 'duplicate controller lease did not replace its old socket');
    const terminalMutation = {
      agentId: 'agent-1',
      terminalId: 'terminal-1',
      input: 'echo once\n',
      operationId: 'terminal-input-1',
      bindingEpoch: 'binding-1',
      signature: 'terminal-input-signature-1',
    };
    assert.strictEqual((await replacement.request('inputTerminal', terminalMutation)).written, true);
    assert.strictEqual((await replacement.request('inputTerminal', terminalMutation)).written, true);
    assert.strictEqual(runtime.inputCalls, 1, 'stable terminal input operationId must execute once per Host epoch');
    const recovered = await replacement.request('recover');
    assert.strictEqual(recovered.bindings[0].state, 'working');
    assert.strictEqual(recovered.promptOperations[0].status, 'provider-owned');
    const joinedPrompt = replacement.request('submitPrompt', {
      agentId: 'agent-1',
      bindingEpoch: 'binding-1',
      clientPromptId: 'prompt-1',
      contentHash: promptContentHash([{ type: 'text', text: 'work' }]),
      prompt: [{ type: 'text', text: 'work' }],
    });
    assert.strictEqual(runtime.promptCalls, 1);
    runtime.promptCompletion({ stopReason: 'end_turn' });
    const result = await joinedPrompt;
    assert.strictEqual(result.stopReason, 'end_turn');
    assert.strictEqual(runtime.promptCalls, 1);
    void originalPrompt.catch(() => {});
    replacement.close();
    const shuttingDown = host.dispose();
    await assert.rejects(connect(socketPath), /ENOENT|ECONNREFUSED/);
    await shuttingDown;
  } finally {
    await host.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  const idleConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-idle-'));
  const idleSocketDirectory = path.dirname(acpRuntimeHostSocketPath(idleConfigDir));
  const idleRuntime = new FakeRuntime();
  const idleHost = new AcpRuntimeHostProcess({
    configDir: idleConfigDir,
    runtime: idleRuntime,
    exitOnShutdown: false,
    idleExitMs: 20,
  });
  try {
    await idleHost.start();
    assert.strictEqual(fs.statSync(idleSocketDirectory).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(acpRuntimeHostSocketPath(idleConfigDir)).mode & 0o777, 0o600);
    await waitFor(() => idleHost.disposed, 'an unclaimed detached Host did not exit when idle');
  } finally {
    await idleHost.dispose();
    fs.rmSync(idleSocketDirectory, { recursive: true, force: true });
    fs.rmSync(idleConfigDir, { recursive: true, force: true });
  }

  if (process.platform !== 'win32') {
    const symlinkConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-symlink-'));
    const symlinkSocketDirectory = path.dirname(acpRuntimeHostSocketPath(symlinkConfigDir));
    const symlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-target-'));
    try {
      fs.rmSync(symlinkSocketDirectory, { recursive: true, force: true });
      fs.symlinkSync(symlinkTarget, symlinkSocketDirectory);
      const symlinkHost = new AcpRuntimeHostProcess({
        configDir: symlinkConfigDir,
        runtime: new FakeRuntime(),
        exitOnShutdown: false,
      });
      await assert.rejects(symlinkHost.start(), /not a private directory/);
      await symlinkHost.dispose();
      const customParent = path.join(symlinkConfigDir, 'custom-socket-parent');
      fs.symlinkSync(symlinkTarget, customParent);
      const customSymlinkHost = new AcpRuntimeHostProcess({
        configDir: symlinkConfigDir,
        socketPath: path.join(customParent, 'host.sock'),
        runtime: new FakeRuntime(),
        exitOnShutdown: false,
      });
      await assert.rejects(customSymlinkHost.start(), /not a private directory/);
      await customSymlinkHost.dispose();
      const broadParent = path.join(symlinkConfigDir, 'broad-socket-parent');
      fs.mkdirSync(broadParent, { mode: 0o755 });
      fs.chmodSync(broadParent, 0o755);
      const broadHost = new AcpRuntimeHostProcess({
        configDir: symlinkConfigDir,
        socketPath: path.join(broadParent, 'host.sock'),
        runtime: new FakeRuntime(),
        exitOnShutdown: false,
      });
      await assert.rejects(broadHost.start(), /accessible to other users/);
      await broadHost.dispose();
    } finally {
      fs.rmSync(symlinkSocketDirectory, { recursive: true, force: true });
      fs.rmSync(symlinkTarget, { recursive: true, force: true });
      fs.rmSync(symlinkConfigDir, { recursive: true, force: true });
    }
  }

  console.log('ACP runtime host process tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
