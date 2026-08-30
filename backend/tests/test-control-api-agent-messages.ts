const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AcpRuntime } = require('../acp-runtime.cjs');
const { AgentManager } = require('../agent-manager.cjs');
const { ConfigManager } = require('../config-manager.cjs');
const { createControlRouter } = require('../control-api.cjs');

type HttpServer = import('http').Server;

interface AcpSubmitOptions {
  delivery?: 'auto' | 'prompt' | 'steer';
  onSubmitted?: () => void;
}

interface TestAgent extends Record<string, unknown> {
  agentRecordId?: string;
  composerCommands: Array<Record<string, unknown>>;
  id: string;
  persistentSessionId?: string;
  runtimeEpoch?: string;
}

function serverPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return address.port;
}

async function postJson(baseUrl: string, pathname: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function waitFor(predicate: () => boolean, message: string, deadlineMs = 5000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-control-agent-messages-'));
  const configManager = new ConfigManager({ configDir: root });
  configManager.init();
  const acpRuntime = new AcpRuntime();
  const acpSubmissions: Array<{
    agentId: string;
    delivery?: 'auto' | 'prompt' | 'steer';
    prompt: Array<{ text?: string; type: string }>;
  }> = [];
  let rejectAcpUncertainOnce = false;
  acpRuntime.hasBinding = () => true;
  acpRuntime.reconnectAgent = async () => ({ reconnected: false });
  acpRuntime.submitMessage = async (
    agentId: string,
    prompt: Array<{ text?: string; type: string }>,
    options: AcpSubmitOptions = {},
  ) => {
    acpSubmissions.push({ agentId, prompt, delivery: options.delivery });
    if (rejectAcpUncertainOnce) {
      rejectAcpUncertainOnce = false;
      throw Object.assign(new Error('legacy ACP uncertain rejection'), { uncertain: true });
    }
    options.onSubmitted?.();
    return options.delivery === 'steer'
      ? { steered: true }
      : { stopReason: 'end_turn' };
  };

  const manager = new AgentManager(configManager, {
    acpRuntime,
    skipExecutablePreflight: true,
  });
  const terminalInputs: Array<{
    agentId: string;
    input: unknown;
    options: Record<string, unknown>;
  }> = [];
  let uncertainTerminalMessage = '';
  manager.engineBridge.getEngine = () => ({
    async sendInput(agentId, input, options = {}) {
      terminalInputs.push({ agentId, input, options });
      const text = Array.isArray(input)
        ? input.map(part => typeof part === 'string' ? part : String(part?.text || '')).join('')
        : String(input || '');
      if (text.includes(uncertainTerminalMessage) && uncertainTerminalMessage) {
        throw Object.assign(
          new Error('simulated lost PTY acknowledgement after write'),
          { terminalMutationUncertain: true },
        );
      }
      return { sent: true };
    },
  });

  const terminalAgent: TestAgent = {
    id: 'agent-terminal-message',
    command: 'codex',
    forkCommand: 'codex',
    cwd: root,
    projectWorkspace: root,
    status: 'running',
    engineName: 'native',
    category: 'coding',
    source: 'ui',
    runtimeEpoch: 'terminal-epoch-1',
    agentRuntimeMode: 'terminal',
    runtimeBinding: { kind: 'terminal' },
    providerSessionProvider: 'codex',
    providerHomeId: 'default',
    providerSessionId: 'tmp_terminal_message',
    providerSessionKey: 'agent-session:codex:tmp_terminal_message',
    providerSessionTemporary: true,
    composerCommands: [],
  };
  terminalAgent.persistentSessionId = configManager.ensureAgentSessionRecord(terminalAgent, { archived: false });
  terminalAgent.agentRecordId = terminalAgent.persistentSessionId;
  manager.agents.set(terminalAgent.id, terminalAgent);

  const acpAgent: TestAgent = {
    id: 'agent-acp-message',
    command: 'codex',
    forkCommand: 'codex',
    cwd: root,
    projectWorkspace: root,
    status: 'running',
    engineName: 'native',
    category: 'coding',
    source: 'ui',
    agentRuntimeMode: 'acp',
    runtimeBinding: { kind: 'acp', state: 'idle', supportsSteer: true },
    providerSessionProvider: 'codex',
    providerHomeId: 'default',
    providerSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    providerSessionKey: 'agent-session:codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    providerSessionTemporary: false,
    composerCommands: [],
  };
  acpAgent.persistentSessionId = configManager.ensureAgentSessionRecord(acpAgent, { archived: false });
  acpAgent.agentRecordId = acpAgent.persistentSessionId;
  manager.agents.set(acpAgent.id, acpAgent);

  const app = express();
  app.use('/api/control', createControlRouter(manager));
  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    const terminalMessagePath = `/api/control/agents/${terminalAgent.id}/messages`;
    const accepted = await postJson(baseUrl, terminalMessagePath, {
      message: 'continue exactly once',
      requestId: 'terminal-message-1',
    });
    assert.strictEqual(accepted.response.status, 202);
    assert.strictEqual(accepted.body.accepted, true);
    assert.strictEqual(terminalInputs.length, 1);
    assert.deepStrictEqual(terminalInputs[0], {
      agentId: terminalAgent.id,
      input: [{ type: 'paste', text: 'continue exactly once' }, '\r'],
      options: { expectedRuntimeEpoch: 'terminal-epoch-1' },
    });

    const deduplicated = await postJson(baseUrl, terminalMessagePath, {
      message: 'continue exactly once',
      requestId: 'terminal-message-1',
    });
    assert.strictEqual(deduplicated.response.status, 202);
    assert.strictEqual(deduplicated.body.result.deduplicated, true);
    assert.strictEqual(terminalInputs.length, 1, 'a repeated Terminal requestId must not write twice');

    const conflicting = await postJson(baseUrl, terminalMessagePath, {
      message: 'different content',
      requestId: 'terminal-message-1',
    });
    assert.strictEqual(conflicting.response.status, 409);
    assert.match(conflicting.body.error, /different content/);
    assert.strictEqual(terminalInputs.length, 1);

    let releaseBlockedInput!: () => void;
    let markBlockedInputStarted!: () => void;
    const blockedInputStarted = new Promise<void>(resolve => {
      markBlockedInputStarted = resolve;
    });
    const blockedInputRelease = new Promise<void>(resolve => {
      releaseBlockedInput = resolve;
    });
    const blockedInput = manager.enqueueInputOperation(terminalAgent.id, async () => {
      markBlockedInputStarted();
      await blockedInputRelease;
    });
    await blockedInputStarted;

    const staleRuntimeRequest = postJson(baseUrl, terminalMessagePath, {
      message: 'do not deliver to a replacement runtime',
      requestId: 'terminal-message-stale-runtime',
    });
    try {
      await waitFor(
        () => terminalAgent.composerCommands.some(
          command => command.requestId === 'terminal-message-stale-runtime' && command.state === 'intent',
        ),
        'persistent Terminal request was not admitted behind the blocked input queue',
      );
    } catch (waitError) {
      releaseBlockedInput();
      await blockedInput;
      await Promise.allSettled([staleRuntimeRequest]);
      throw waitError;
    }
    const writesBeforeRuntimeReplacement = terminalInputs.length;
    terminalAgent.runtimeEpoch = 'terminal-epoch-2';
    releaseBlockedInput();
    await blockedInput;

    const staleRuntime = await staleRuntimeRequest;
    assert.strictEqual(staleRuntime.response.status, 409);
    assert.strictEqual(staleRuntime.body.uncertain, false);
    assert.match(staleRuntime.body.error, /runtime changed before Terminal message delivery/);
    assert.strictEqual(
      terminalInputs.length,
      writesBeforeRuntimeReplacement,
      'a queued message admitted for an old runtime epoch must perform zero PTY writes',
    );

    const retriedOnNewRuntime = await postJson(baseUrl, terminalMessagePath, {
      message: 'do not deliver to a replacement runtime',
      requestId: 'terminal-message-stale-runtime',
    });
    assert.strictEqual(retriedOnNewRuntime.response.status, 202);
    assert.strictEqual(retriedOnNewRuntime.body.accepted, true);
    assert.deepStrictEqual(terminalInputs.at(-1), {
      agentId: terminalAgent.id,
      input: [{ type: 'paste', text: 'do not deliver to a replacement runtime' }, '\r'],
      options: { expectedRuntimeEpoch: 'terminal-epoch-2' },
    });

    const rawInput = await postJson(
      baseUrl,
      `/api/control/agents/${terminalAgent.id}/input`,
      { input: 'raw terminal input\n' },
    );
    assert.strictEqual(rawInput.response.status, 200);
    assert.deepStrictEqual(terminalInputs.at(-1), {
      agentId: terminalAgent.id,
      input: 'raw terminal input\n',
      options: { expectedRuntimeEpoch: terminalAgent.runtimeEpoch },
    });

    uncertainTerminalMessage = 'uncertain persistent input';
    const originalConsoleError = console.error;
    console.error = () => {};
    let uncertain;
    try {
      uncertain = await postJson(baseUrl, terminalMessagePath, {
        message: uncertainTerminalMessage,
        requestId: 'terminal-message-unknown',
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.strictEqual(uncertain.response.status, 409);
    assert.strictEqual(uncertain.body.uncertain, true);
    const writesAfterUnknown = terminalInputs.length;
    const unknownRetry = await postJson(baseUrl, terminalMessagePath, {
      message: uncertainTerminalMessage,
      requestId: 'terminal-message-unknown',
    });
    assert.strictEqual(unknownRetry.response.status, 409);
    assert.strictEqual(unknownRetry.body.uncertain, true);
    assert.strictEqual(
      terminalInputs.length,
      writesAfterUnknown,
      'an unknown Terminal delivery must not replay automatically',
    );

    const acceptedRecord = terminalAgent.composerCommands.find(
      command => command.requestId === 'terminal-message-1',
    );
    assert(acceptedRecord, 'the accepted Terminal message should retain its production content hash');
    terminalAgent.composerCommands.push({
      ...acceptedRecord,
      requestId: 'terminal-message-intent',
      state: 'intent',
      result: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    configManager.ensureAgentSessionRecord(terminalAgent, { archived: false });
    const writesBeforeIntent = terminalInputs.length;
    const intentRetry = await postJson(baseUrl, terminalMessagePath, {
      message: 'continue exactly once',
      requestId: 'terminal-message-intent',
    });
    assert.strictEqual(intentRetry.response.status, 409);
    assert.strictEqual(intentRetry.body.uncertain, true);
    assert.strictEqual(terminalInputs.length, writesBeforeIntent, 'a recovered intent must not be replayed');

    assert.strictEqual(
      manager.releaseTerminalInputFence(terminalAgent.id, { runtimeEpoch: terminalAgent.runtimeEpoch }),
      true,
      'an explicit checkpoint must reconcile the uncertain write before later legacy input',
    );
    uncertainTerminalMessage = 'legacy nonpersistent input';
    console.error = () => {};
    try {
      await assert.rejects(
        manager.sendComposerMessage(terminalAgent.id, uncertainTerminalMessage),
        error => error.uncertain === true && /delivery could not be confirmed/.test(error.message),
        'a non-persistent Terminal Composer write must expose its uncertain outcome',
      );
    } finally {
      console.error = originalConsoleError;
    }
    assert.strictEqual(
      terminalInputs.filter(call => JSON.stringify(call.input).includes(uncertainTerminalMessage)).length,
      1,
      'an uncertain non-persistent Terminal Composer delivery must write at most once',
    );

    const acpMessagePath = `/api/control/agents/${acpAgent.id}/messages`;
    const prompt = await postJson(baseUrl, acpMessagePath, {
      message: 'structured prompt',
      requestId: 'acp-message-prompt',
      delivery: 'prompt',
    });
    assert.strictEqual(prompt.response.status, 202);
    const steer = await postJson(baseUrl, acpMessagePath, {
      message: 'structured steer',
      requestId: 'acp-message-steer',
      delivery: 'steer',
    });
    assert.strictEqual(steer.response.status, 202);
    assert.deepStrictEqual(acpSubmissions.map(call => call.delivery), ['prompt', 'steer']);

    rejectAcpUncertainOnce = true;
    const rejectedAcp = await postJson(baseUrl, acpMessagePath, {
      message: 'retain ACP retry semantics',
      requestId: 'acp-message-retry',
    });
    assert.strictEqual(rejectedAcp.response.status, 409);
    assert.strictEqual(rejectedAcp.body.uncertain, true);
    const retriedAcp = await postJson(baseUrl, acpMessagePath, {
      message: 'retain ACP retry semantics',
      requestId: 'acp-message-retry',
    });
    assert.strictEqual(retriedAcp.response.status, 409);
    assert.strictEqual(retriedAcp.body.uncertain, true);
    assert.strictEqual(
      acpSubmissions.filter(call => call.prompt[0]?.text === 'retain ACP retry semantics').length,
      1,
      'an uncertain ACP submission must not be replayed under the same request id',
    );

    console.log('Control Agent messages preserve Terminal idempotency and existing raw/ACP delivery');
  } finally {
    try {
      await new Promise(resolve => server.close(resolve));
    } finally {
      try {
        await manager.dispose();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
