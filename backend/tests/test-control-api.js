const assert = require('assert');
const EventEmitter = require('events');
const express = require('express');
const { createControlRouter } = require('../control-api');

async function fetchJson(baseUrl, pathname, options = {}) {
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

async function run() {
  const calls = [];
  const agents = new Map();
  const events = new EventEmitter();
  let browserControlled = false;
  let nextAgent = 0;
  const agentManager = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    getState() {
      return {
        mainAgentId: 'agent-main',
        agents: Array.from(agents.values()),
      };
    },
    startAgent(command, workspace, callback, options) {
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
    agentRequiresTerminalController() {
      return true;
    },
    async sendInput(agentId, input, options) {
      calls.push({ type: 'sendInput', agentId, input, options });
      const agent = agents.get(agentId);
      if (agent && /[\r\n]/.test(String(input))) agent.terminalInputReceived = true;
      return { sent: true };
    },
    async clearAgentSessionBuffer(agentId, terminalControl) {
      calls.push({ type: 'clearAgentSessionBuffer', agentId, terminalControl });
      return { cleared: true, outputSeq: 7 };
    },
    async getAgentSessionText(agentId) {
      return `output for ${agentId}`;
    },
    async killAgent(agentId) {
      calls.push({ type: 'killAgent', agentId });
      agents.delete(agentId);
      events.emit('update');
    },
  };
  const terminalMutationCoordinator = {
    async runSystemMutation(agentId, operation, options) {
      if (browserControlled && options.allowWhileControlled !== true) {
        return { status: 'rejected', reason: 'terminal-controlled-by-browser' };
      }
      return operation({
        terminalControl: {
          kind: 'system',
          expectedRuntimeEpoch: options.expectedRuntimeEpoch,
        },
        expectedRuntimeEpoch: options.expectedRuntimeEpoch,
      });
    },
  };

  const app = express();
  app.use('/api/control', createControlRouter(agentManager, {
    initialInputTimeoutMs: 100,
    terminalMutationCoordinator,
  }));

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

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
    await delay(10);
    assert.strictEqual(
      calls.filter(call => call.type === 'sendInput').length,
      0,
      'initial Terminal input must not be guessed from a fixed startup delay',
    );
    const firstAgent = agents.get('agent-1');
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
        terminalControl: { kind: 'system', expectedRuntimeEpoch: 'epoch-1' },
      },
    });

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
    assert.strictEqual(calls.at(-1).options.terminalControl.expectedRuntimeEpoch, 'epoch-1');

    const cleared = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/clear`, {
      method: 'POST',
    });
    assert.strictEqual(cleared.response.status, 200);
    assert.strictEqual(cleared.body.outputSeq, 7);
    assert.strictEqual(calls.at(-1).type, 'clearAgentSessionBuffer');
    assert.strictEqual(calls.at(-1).terminalControl.expectedRuntimeEpoch, 'epoch-1');

    browserControlled = true;
    const rejectedInput = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: 'must not be sent\n' }),
    });
    assert.strictEqual(rejectedInput.response.status, 409);
    assert.strictEqual(rejectedInput.body.error, 'terminal-controlled-by-browser');
    const rejectedClear = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/clear`, {
      method: 'POST',
    });
    assert.strictEqual(rejectedClear.response.status, 409);
    browserControlled = false;

    const cancelledPromise = fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({ command: 'codex', task: 'must not race user input' }),
    });
    await delay(5);
    const cancelledAgent = agents.get('agent-2');
    cancelledAgent.terminalInputReceived = true;
    events.emit('update');
    const cancelled = await cancelledPromise;
    assert.strictEqual(cancelled.response.status, 409);
    assert.strictEqual(cancelled.body.code, 'terminal-already-used');
    assert(!calls.some(call => call.type === 'sendInput' && call.agentId === 'agent-2'));

    const replacedPromise = fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({ command: 'codex', task: 'must stay on one runtime' }),
    });
    await delay(5);
    const replacedAgent = agents.get('agent-3');
    replacedAgent.runtimeEpoch = 'epoch-3-replacement';
    events.emit('update');
    const replaced = await replacedPromise;
    assert.strictEqual(replaced.response.status, 409);
    assert.strictEqual(replaced.body.code, 'runtime-replaced');
    assert(!calls.some(call => call.type === 'sendInput' && call.agentId === 'agent-3'));

    const killed = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}`, {
      method: 'DELETE',
    });
    assert.strictEqual(killed.response.status, 200);
    assert.strictEqual(calls.at(-1).type, 'killAgent');

    console.log('✓ Control API serializes exact-runtime Terminal mutations and readiness-bound startup input');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
