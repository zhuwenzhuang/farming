const assert = require('assert');
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

async function run() {
  const calls = [];
  const agents = new Map();
  const agentManager = {
    getState() {
      return {
        mainAgentId: 'agent-main',
        agents: Array.from(agents.values()),
      };
    },
    startAgent(command, workspace, callback, options) {
      calls.push({ type: 'startAgent', command, workspace, options });
      const id = `agent-${calls.length}`;
      agents.set(id, {
        id,
        command,
        cwd: workspace,
        status: 'running',
        parentAgentId: options.parentAgentId,
        task: options.task,
      });
      callback(id);
    },
    async sendInput(agentId, input) {
      calls.push({ type: 'sendInput', agentId, input });
    },
    async clearAgentSessionBuffer(agentId) {
      calls.push({ type: 'clearAgentSessionBuffer', agentId });
      return { cleared: true, outputSeq: 7 };
    },
    async getAgentSessionText(agentId) {
      return `output for ${agentId}`;
    },
    async killAgent(agentId) {
      calls.push({ type: 'killAgent', agentId });
      agents.delete(agentId);
    },
  };

  const app = express();
  app.use('/api/control', createControlRouter(agentManager, {
    initialInputDelayMs: 20,
  }));

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const created = await fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({
        command: 'claude',
        workspace: '/repo',
        task: 'Inspect optimizer bugs',
        parentAgentId: 'agent-main',
        agentRuntimeMode: 'acp',
        acpHistoryMode: 'resume',
      }),
    });

    assert.strictEqual(created.response.status, 201);
    assert.strictEqual(created.body.scheduledInitialInput, true);
    assert.strictEqual(calls[0].command, 'claude');
    assert.strictEqual(calls[0].workspace, '/repo');
    assert.strictEqual(calls[0].options.wantsMain, false);
    assert.strictEqual(calls[0].options.parentAgentId, 'agent-main');
    assert.strictEqual(calls[0].options.source, 'control-cli');
    assert.strictEqual(calls[0].options.agentRuntimeMode, 'acp');
    assert.strictEqual(calls[0].options.acpHistoryMode, 'resume');

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepStrictEqual(calls[1], {
      type: 'sendInput',
      agentId: created.body.agentId,
      input: 'Inspect optimizer bugs\r',
    });

    const list = await fetchJson(baseUrl, '/api/control/agents?parent=agent-main');
    assert.strictEqual(list.response.status, 200);
    assert.strictEqual(list.body.agents.length, 1);
    assert.strictEqual(list.body.agents[0].parentAgentId, 'agent-main');

    const output = await fetch(`${baseUrl}/api/control/agents/${created.body.agentId}/output?tail=7`);
    assert.strictEqual(output.status, 200);
    assert.strictEqual(await output.text(), 'agent-1');

    const sent = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input: 'continue\n' }),
    });
    assert.strictEqual(sent.response.status, 200);
    assert.deepStrictEqual(calls[2], {
      type: 'sendInput',
      agentId: created.body.agentId,
      input: 'continue\n',
    });

    const cleared = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/clear`, {
      method: 'POST',
    });
    assert.strictEqual(cleared.response.status, 200);
    assert.strictEqual(cleared.body.success, true);
    assert.strictEqual(cleared.body.outputSeq, 7);
    assert.deepStrictEqual(calls[3], {
      type: 'clearAgentSessionBuffer',
      agentId: created.body.agentId,
    });

    const killed = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}`, {
      method: 'DELETE',
    });
    assert.strictEqual(killed.response.status, 200);
    assert.deepStrictEqual(calls[4], {
      type: 'killAgent',
      agentId: created.body.agentId,
    });

    const doomed = await fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST',
      body: JSON.stringify({
        command: 'codex',
        workspace: '/repo',
        task: 'should not be sent after delete',
      }),
    });
    assert.strictEqual(doomed.response.status, 201);
    const deletedDoomed = await fetchJson(baseUrl, `/api/control/agents/${doomed.body.agentId}`, {
      method: 'DELETE',
    });
    assert.strictEqual(deletedDoomed.response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert(
      !calls.some(call => (
        call.type === 'sendInput' &&
        call.agentId === doomed.body.agentId
      )),
      'deleted agents should not receive delayed initial input'
    );

    console.log('✓ Control API exposes child agent lifecycle primitives');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
