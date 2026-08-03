const assert = require('assert');
const EventEmitter = require('events');
const express = require('express');
const { createControlRouter } = require('../control-api.cjs');

type HttpServer = import('http').Server;

function serverPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return address.port;
}

async function fetchJson(baseUrl, pathname, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForValue(read, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(5);
  }
  throw new Error('Timed out waiting for test state');
}

async function run() {
  const calls = [];
  const agents = new Map();
  const events = new EventEmitter();
  let nextAgent = 0;
  let killFailureAgentId = '';
  let recoveryFailure = '';
  let createResultPersistenceFailure = '';
  const durableCreateResults = new Map();
  const agentManager = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    getState() {
      return {
        mainAgentId: 'agent-main',
        agents: Array.from(agents.values()),
      };
    },
    async whenRecovered() {
      if (recoveryFailure) throw new Error(recoveryFailure);
    },
    startAgent(command, workspace, callback, options) {
      const recordedCreate = options.createRequestId
        ? durableCreateResults.get(options.createRequestId)
        : null;
      if (recordedCreate) {
        callback(recordedCreate.agentId, null, {
          deduplicated: true,
          createResult: recordedCreate.result,
        });
        return;
      }
      calls.push({ type: 'startAgent', command, workspace, options });
      nextAgent += 1;
      const id = `agent-${nextAgent}`;
      agents.set(id, {
        id,
        command,
        cwd: workspace,
        status: 'running',
        parentAgentId: options.parentAgentId,
        task: options.task,
        startedAt: 1000 + nextAgent,
        runtimeEpoch: `epoch-${nextAgent}`,
        stateRevision: 0,
        outputSeq: 0,
        previewText: 'starting runtime',
        terminalBusy: null,
        terminalInputReceived: false,
        terminalStatus: { kind: 'codex', activity: 'unknown', source: 'terminal-text' },
        agentRuntimeMode: options.agentRuntimeMode,
      });
      callback(id);
    },
    agentSupportsTerminalInput() {
      return true;
    },
    async sendInput(agentId, input, options) {
      calls.push({ type: 'sendInput', agentId, input, options });
      const agent = agents.get(agentId);
      if (agent && /[\r\n]/.test(String(input))) agent.terminalInputReceived = true;
      return { sent: true };
    },
    async clearAgentSessionBuffer(agentId, options) {
      calls.push({ type: 'clearAgentSessionBuffer', agentId, options });
      return { cleared: true, outputSeq: 7 };
    },
    setAgentAdaptiveTitle(agentId, title, token) {
      calls.push({ type: 'setAgentAdaptiveTitle', agentId, title, token });
      if (token !== `title-token-${agentId}`) {
        return { error: 'Agent title update belongs to an expired runtime' };
      }
      const adaptiveTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      agents.get(agentId).adaptiveTitle = adaptiveTitle;
      return { agentId, adaptiveTitle };
    },
    async getAgentSessionText(agentId) {
      return `output for ${agentId}`;
    },
    async killAgent(agentId, options = {}) {
      calls.push({ type: 'killAgent', agentId, options });
      if (agentId === killFailureAgentId) {
        return { agentId, error: 'runtime cleanup could not be verified' };
      }
      agents.delete(agentId);
      events.emit('update');
      return { agentId, killed: true };
    },
    async requestKillAgent(agentId, options = {}) {
      await this.whenRecovered();
      const result = await this.killAgent(agentId, options);
      return { result, completion: Promise.resolve(result) };
    },
    recordCreateRequestResult(agentId, requestId, result) {
      if (createResultPersistenceFailure) {
        return { error: createResultPersistenceFailure };
      }
      durableCreateResults.set(requestId, { agentId, result });
      return { agentId, operationId: 'aop_1', result };
    },
  };
  const app = express();
  app.use('/api/control', createControlRouter(agentManager, {
    initialInputTimeoutMs: 100,
  }));

  const server = await new Promise<HttpServer>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    const createdPromise = fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({
        command: 'codex',
        workspace: '/repo',
        task: 'Inspect optimizer bugs',
        parentAgentId: 'agent-main',
      }),
    });
    const firstAgent = await waitForValue(() => agents.get('agent-1'));
    await delay(10);
    assert.strictEqual(
      calls.filter(call => call.type === 'sendInput').length,
      0,
      'initial Terminal input must not be guessed from a fixed startup delay',
    );
    firstAgent.previewText = '› Ask Codex\n\ngpt-5.6-sol xhigh · /repo';
    firstAgent.terminalStatus = { kind: 'codex', activity: 'idle', source: 'terminal-text' };
    firstAgent.stateRevision = 1;
    events.emit('update');

    const created = await createdPromise;
    assert.strictEqual(created.response.status, 201);
    assert.strictEqual(created.body.initialInputDelivered, true);
    assert.strictEqual(created.body.inputMode, 'terminal');
    assert.strictEqual(calls[0].command, 'codex');
    assert.strictEqual(calls[0].workspace, '/repo');
    assert.strictEqual(calls[0].options.wantsMain, false);
    assert.strictEqual(calls[0].options.parentAgentId, 'agent-main');
    assert.strictEqual(calls[0].options.source, 'control-cli');
    assert.deepStrictEqual(calls[1], {
      type: 'sendInput',
      agentId: created.body.agentId,
      input: 'Inspect optimizer bugs\r',
      options: {
        expectedRuntimeEpoch: 'epoch-1',
      },
    });

    const idempotentBody = JSON.stringify({
      command: 'codex',
      workspace: '/repo',
      task: 'Deliver exactly once',
      requestId: 'control-create-1',
    });
    const startsBeforeIdempotentCreate = calls.filter(call => call.type === 'startAgent').length;
    const inputsBeforeIdempotentCreate = calls.filter(call => call.type === 'sendInput').length;
    const firstIdempotentCreate = fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: idempotentBody,
    });
    const idempotentAgent = await waitForValue(() => agents.get('agent-2'));
    const secondIdempotentCreate = fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: idempotentBody,
    });
    idempotentAgent.previewText = '› Ask Codex\n\ngpt-5.6-sol xhigh · /repo';
    idempotentAgent.terminalStatus = { kind: 'codex', activity: 'idle', source: 'terminal-text' };
    idempotentAgent.stateRevision = 1;
    events.emit('update');
    const [firstIdempotentResult, secondIdempotentResult] = await Promise.all([
      firstIdempotentCreate,
      secondIdempotentCreate,
    ]);
    assert.strictEqual(firstIdempotentResult.response.status, 201);
    assert.strictEqual(secondIdempotentResult.response.status, 201);
    assert.deepStrictEqual(secondIdempotentResult.body, firstIdempotentResult.body);
    assert.strictEqual(
      calls.filter(call => call.type === 'startAgent').length,
      startsBeforeIdempotentCreate + 1,
      'one Control Create idempotency key must admit one Agent start',
    );
    assert.strictEqual(
      calls.filter(call => call.type === 'sendInput').length,
      inputsBeforeIdempotentCreate + 1,
      'one Control Create idempotency key must deliver initial input once',
    );
    assert.strictEqual(durableCreateResults.get('control-create-1').agentId, 'agent-2');

    const list = await fetchJson(baseUrl, '/api/control/agents?parent=agent-main');
    assert.strictEqual(list.response.status, 200);
    assert.strictEqual(list.body.agents.length, 1);

    const output = await fetch(`${baseUrl}/api/control/agents/${created.body.agentId}/output?tail=7`);
    assert.strictEqual(output.status, 200);
    assert.strictEqual(await output.text(), 'agent-1');

    const sent = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: 'continue\n' }),
    });
    assert.strictEqual(sent.response.status, 200);
    assert.strictEqual(calls.at(-1).type, 'sendInput');
    assert.strictEqual(calls.at(-1).options.expectedRuntimeEpoch, 'epoch-1');

    const cleared = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/clear`, {
      method: 'POST',
    });
    assert.strictEqual(cleared.response.status, 200);
    assert.strictEqual(cleared.body.outputSeq, 7);
    assert.strictEqual(calls.at(-1).type, 'clearAgentSessionBuffer');
    assert.strictEqual(calls.at(-1).options.expectedRuntimeEpoch, 'epoch-1');

    const titled = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/title`, {
      method: 'POST',
      body: JSON.stringify({
        title: '  Diagnose ACP titles  ',
        token: `title-token-${created.body.agentId}`,
      }),
    });
    assert.strictEqual(titled.response.status, 200);
    assert.strictEqual(titled.body.adaptiveTitle, 'Diagnose ACP titles');
    assert.strictEqual(agents.get(created.body.agentId).adaptiveTitle, 'Diagnose ACP titles');

    const staleTitle = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/title`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Stale title', token: 'expired-token' }),
    });
    assert.strictEqual(staleTitle.response.status, 409);
    assert.match(staleTitle.body.error, /expired runtime/);

    const concurrentInput = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: 'shared terminal input\n' }),
    });
    assert.strictEqual(concurrentInput.response.status, 200);
    const concurrentClear = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/clear`, {
      method: 'POST',
    });
    assert.strictEqual(concurrentClear.response.status, 200);

    const cancelledPromise = fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({ command: 'codex', task: 'must not race user input' }),
    });
    const cancelledAgent = await waitForValue(() => agents.get('agent-3'));
    cancelledAgent.terminalInputReceived = true;
    events.emit('update');
    const cancelled = await cancelledPromise;
    assert.strictEqual(cancelled.response.status, 409);
    assert.strictEqual(cancelled.body.code, 'terminal-already-used');
    assert(!calls.some(call => call.type === 'sendInput' && call.agentId === 'agent-3'));

    const replacedPromise = fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({ command: 'codex', task: 'must stay on one runtime' }),
    });
    const replacedAgent = await waitForValue(() => agents.get('agent-4'));
    replacedAgent.runtimeEpoch = 'epoch-4-replacement';
    events.emit('update');
    const replaced = await replacedPromise;
    assert.strictEqual(replaced.response.status, 409);
    assert.strictEqual(replaced.body.code, 'runtime-replaced');
    assert(!calls.some(call => call.type === 'sendInput' && call.agentId === 'agent-4'));

    const chatCreated = await fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({
        command: 'codex',
        workspace: '/chat-repo',
        agentRuntimeMode: 'chat',
        additionalDirectories: ['/shared'],
        mcpServers: [{ name: 'docs', command: '/bin/docs-mcp', args: [], env: [] }],
      }),
    });
    assert.strictEqual(chatCreated.response.status, 201);
    assert.strictEqual(chatCreated.body.initialInputDelivered, false);
    assert.strictEqual(calls.at(-1).type, 'startAgent');
    assert.strictEqual(calls.at(-1).options.agentRuntimeMode, 'chat');
    assert.deepStrictEqual(calls.at(-1).options.additionalDirectories, ['/shared']);
    assert.deepStrictEqual(calls.at(-1).options.mcpServers, [
      { name: 'docs', command: '/bin/docs-mcp', args: [], env: [] },
    ]);

    createResultPersistenceFailure = 'simulated Create result disk failure';
    const undurableCreateRequestId = 'control-create-undurable-result';
    const undurableAgentId = `agent-${nextAgent + 1}`;
    const undurableCreatePromise = fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({
        command: 'codex',
        workspace: '/repo',
        task: 'deliver once even if result persistence fails',
        requestId: undurableCreateRequestId,
      }),
    });
    const undurableAgent = await waitForValue(() => agents.get(undurableAgentId));
    undurableAgent.previewText = '› Ask Codex\n\ngpt-5.6-sol xhigh · /repo';
    undurableAgent.terminalStatus = { kind: 'codex', activity: 'idle', source: 'terminal-text' };
    undurableAgent.stateRevision = 1;
    events.emit('update');
    const undurableCreate = await undurableCreatePromise;
    assert.strictEqual(undurableCreate.response.status, 409);
    assert.strictEqual(undurableCreate.body.code, 'create-result-not-durable');
    assert.strictEqual(
      undurableCreate.body.initialInputDelivered,
      true,
      'a result persistence failure must not erase a known successful input delivery outcome',
    );
    assert.strictEqual(undurableCreate.body.createResultDurable, false);
    createResultPersistenceFailure = '';

    const killed = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}?recordHistory=0`, {
      method: 'DELETE',
    });
    assert.strictEqual(killed.response.status, 200);
    assert.strictEqual(calls.at(-1).type, 'killAgent');
    assert.strictEqual(calls.at(-1).options.recordHistory, false);

    killFailureAgentId = chatCreated.body.agentId;
    const rejectedKill = await fetchJson(baseUrl, `/api/control/agents/${chatCreated.body.agentId}`, {
      method: 'DELETE',
    });
    assert.strictEqual(rejectedKill.response.status, 409);
    assert.match(rejectedKill.body.error, /could not be verified/);
    assert.strictEqual(calls.at(-1).options.recordHistory, true);
    assert.strictEqual(agents.has(chatCreated.body.agentId), true);

    recoveryFailure = 'simulated recovery failure';
    const recoveryBlockedKill = await fetchJson(
      baseUrl,
      `/api/control/agents/${chatCreated.body.agentId}`,
      { method: 'DELETE' },
    );
    assert.strictEqual(recoveryBlockedKill.response.status, 503);
    assert.strictEqual(recoveryBlockedKill.body.retryable, true);
    assert.match(recoveryBlockedKill.body.error, /simulated recovery failure/);
    recoveryFailure = '';

    console.log('✓ Control API serializes exact-runtime Terminal mutations and readiness-bound startup input');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
