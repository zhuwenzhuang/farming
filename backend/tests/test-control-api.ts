const assert = require('assert');
const EventEmitter = require('events');
const express = require('express');
const { createControlRouter, waitForTerminalInputReadiness } = require('../control-api.cjs');
const { terminalInputToPtyString } = require('../input-parts.cjs');

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
  let stateReads = 0;
  const mountedProjects = new Set<string>();
  let projectMountFailure = '';
  let projectRollbackFailure = '';
  let startedProjectWorkspace = '';

  const mountAttempts: string[] = [];
  const durableCreateResults = new Map();
  const agentManager = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    getState() {
      stateReads += 1;
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
        source: options.source,
        cwd: workspace,
        projectWorkspace: startedProjectWorkspace,
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
        runtimeBinding: { kind: options.agentRuntimeMode === 'chat' || options.agentRuntimeMode === 'acp' ? 'acp' : 'terminal' },
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
    async sendComposerMessage(agentId, input, options) {
      calls.push({ type: 'sendComposerMessage', agentId, input, options });
      return { accepted: true };
    },
    async clearAgentSessionBuffer(agentId, options) {
      calls.push({ type: 'clearAgentSessionBuffer', agentId, options });
      return { cleared: true, outputSeq: 7 };
    },
    setAgentAdaptiveTitle(agentId, title) {
      calls.push({ type: 'setAgentAdaptiveTitle', agentId, title });
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
    async archiveAgent(agentId, options) {
      calls.push({ type: 'archiveAgent', agentId, options });
      if (projectRollbackFailure) return { error: projectRollbackFailure };
      agents.get(agentId).archived = true;
      agents.get(agentId).status = 'stopped';
      return {};
    },
    async requestKillAgent(agentId, options = {}) {
      await this.whenRecovered();
      const result = await this.killAgent(agentId, options);
      return { result, completion: Promise.resolve(result) };
    },
    lifecycleJournalService: {
      recordCreateRequestResult(agentId, requestId, result) {
        if (createResultPersistenceFailure) {
          return { error: createResultPersistenceFailure };
        }
        durableCreateResults.set(requestId, { agentId, result });
        return { agentId, operationId: 'aop_1', result };
      },
    },
  };
  const app = express();
  app.use('/api/control', createControlRouter(agentManager, {
    initialInputTimeoutMs: 100,
    mountProjectWorkspace(workspace) {
      mountAttempts.push(workspace);
      if (projectMountFailure) throw new Error(projectMountFailure);
      mountedProjects.add(workspace);
    },
  }));

  const server = await new Promise<HttpServer>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    // Native screen projections can become ready without a full inventory
    // update or title change. Startup must consume that authoritative event.
    const readinessEvents = new EventEmitter();
    const startupAgent = {
      id: 'preview-only-startup', command: 'codex', status: 'running',
      startedAt: 71, runtimeEpoch: 'startup-epoch', previewText: 'starting runtime',
      terminalBusy: null, terminalInputReceived: false,
    };
    const startupManager = {
      on: readinessEvents.on.bind(readinessEvents), off: readinessEvents.off.bind(readinessEvents),
      getState: () => ({ agents: [startupAgent] }),
    };
    const startup = (timeoutMs = 100) => waitForTerminalInputReadiness(startupManager, startupAgent.id, {
      expectedStartedAt: 71, expectedRuntimeEpoch: 'startup-epoch', timeoutMs,
    });
    const listenersGone = () => {
      assert.strictEqual(readinessEvents.listenerCount('update'), 0);
      assert.strictEqual(readinessEvents.listenerCount('session-preview-update'), 0);
    };
    let previewSettled = false;
    const previewOnly = startup().then(result => { previewSettled = true; return result; });
    readinessEvents.emit('update');
    await Promise.resolve();
    startupAgent.previewText = 'Fake Codex handoff ready\n› \n\ngpt-5.6-terra medium · ~/workspace';
    readinessEvents.emit('session-preview-update', { agentId: 'another-agent' });
    await Promise.resolve();
    assert.strictEqual(previewSettled, false, 'unrelated preview must not admit target startup input');
    readinessEvents.emit('session-preview-update', { agentId: startupAgent.id });
    assert.deepStrictEqual(await previewOnly, { expectedStartedAt: 71, expectedRuntimeEpoch: 'startup-epoch' });
    listenersGone();

    startupAgent.previewText = 'starting runtime';
    const startupReplaced = startup();
    const replacedCheck = assert.rejects(startupReplaced, { code: 'runtime-replaced' });
    startupAgent.previewText = 'gpt-5.6-terra medium · ~/workspace';
    startupAgent.runtimeEpoch = 'replacement-epoch';
    readinessEvents.emit('session-preview-update', { agentId: startupAgent.id });
    await replacedCheck;
    listenersGone();

    startupAgent.runtimeEpoch = 'startup-epoch';
    startupAgent.previewText = 'starting runtime';
    await assert.rejects(startup(10), { code: 'initial-input-timeout' });
    listenersGone();

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
    // This negative assertion spans the former startup-delay window: creating
    // an Agent alone must never cause task input before authoritative readiness.
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
      input: [{ type: 'paste', text: 'Inspect optimizer bugs' }, '\r'],
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

    const stateReadsBeforeTitle = stateReads;
    const titled = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/title`, {
      method: 'POST',
      body: JSON.stringify({
        title: '  Diagnose ACP titles  ',
      }),
    });
    assert.strictEqual(titled.response.status, 200);
    assert.strictEqual(titled.body.adaptiveTitle, 'Diagnose ACP titles');
    assert.strictEqual(agents.get(created.body.agentId).adaptiveTitle, 'Diagnose ACP titles');
    assert.strictEqual(
      stateReads,
      stateReadsBeforeTitle,
      'the title endpoint should delegate exact Agent lookup instead of materializing full state',
    );

    const renamedAgain = await fetchJson(baseUrl, `/api/control/agents/${created.body.agentId}/title`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Agent-name routed title', token: 'ignored-legacy-token' }),
    });
    assert.strictEqual(renamedAgain.response.status, 200);
    assert.strictEqual(renamedAgain.body.adaptiveTitle, 'Agent-name routed title');

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
        source: 'deployment-smoke',
        additionalDirectories: ['/shared'],
        mcpServers: [{ name: 'docs', command: '/bin/docs-mcp', args: [], env: [] }],
      }),
    });
    assert.strictEqual(chatCreated.response.status, 201);
    assert.strictEqual(chatCreated.body.initialInputDelivered, false);
    assert.strictEqual(calls.at(-1).type, 'startAgent');
    assert.strictEqual(calls.at(-1).options.agentRuntimeMode, 'chat');
    assert.strictEqual(calls.at(-1).options.source, 'deployment-smoke');
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

    startedProjectWorkspace = '/retained-project';
    const mounted = await fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST', body: JSON.stringify({ command: 'codex', workspace: '/retained-project/subdirectory' }),
    });
    assert.strictEqual(mounted.response.status, 201);
    assert(mountedProjects.has('/retained-project'));
    await fetchJson(baseUrl, `/api/control/agents/${mounted.body.agentId}`, { method: 'DELETE' });
    assert(mountedProjects.has('/retained-project'), 'removing the last Agent must retain Project membership');

    assert.strictEqual(mountedProjects.has('/retained-project/subdirectory'), false, 'mount the authoritative Project boundary');
    startedProjectWorkspace = '';
    const sourceSessionKey = 'agent-session:codex:~2~work~source-session';
    agents.set('handoff-source', {
      id: 'handoff-source', command: 'codex', cwd: '/source/repo/subdir',
      projectWorkspace: '/source/repo', providerSessionKey: sourceSessionKey,
      providerHomePath: '/homes/work', providerSessionTemporary: false,
    });
    const handoffRequest = {
      method: 'POST', body: JSON.stringify({
        command: 'claude', workspace: '/ignored', providerHomeId: 'personal',
        agentRuntimeMode: 'chat', handoffSourceSessionKey: sourceSessionKey,
        requestId: 'handoff-test',
      }),
    };
    const handoffResponses = await Promise.all([
      fetchJson(baseUrl, '/api/control/agents', handoffRequest),
      fetchJson(baseUrl, '/api/control/agents', handoffRequest),
    ]);
    assert(handoffResponses.every(result => result.response.status === 201), JSON.stringify(handoffResponses.map(result => result.body)));
    assert.strictEqual(handoffResponses[0].body.agentId, handoffResponses[1].body.agentId);
    const handoffStart = calls.findLast(call => call.type === 'startAgent');
    assert.strictEqual(handoffStart.command, 'claude');
    assert.strictEqual(handoffStart.workspace, '/source/repo/subdir');
    assert.strictEqual(handoffStart.options.providerHomeId, 'personal');
    assert.strictEqual(handoffStart.options.projectWorkspace, '/source/repo');
    assert.strictEqual(handoffStart.options.parentAgentId, 'handoff-source');
    const handoffInputs = calls.filter(call => call.type === 'sendComposerMessage');
    assert.strictEqual(handoffInputs.length, 1, 'concurrent handoff must send the reading prompt once');
    assert.deepStrictEqual(handoffInputs[0].options, { requestId: 'handoff-test', delivery: 'prompt' });
    const handoffContent = handoffInputs[0].input[0];
    assert.deepStrictEqual(handoffContent._meta.farmingHandoff, { version: 1, sourceSessionKey });
    assert.match(handoffContent.text, /primary language/);
    assert.match(handoffContent.text, /wait for the user/);
    assert.match(handoffContent.text, /read-only/);
    assert.match(handoffContent.text, /source-session/);
    assert.doesNotMatch(handoffContent.text, /quota|token|exhaust/i);
    await fetchJson(baseUrl, '/api/control/agents', handoffRequest);
    assert.strictEqual(calls.filter(call => call.type === 'sendComposerMessage').length, 1);
    const terminalHandoffId = `agent-${nextAgent + 1}`;
    const terminalHandoffRequest = {
      method: 'POST', body: JSON.stringify({
        ...JSON.parse(handoffRequest.body), command: 'codex', agentRuntimeMode: 'terminal', requestId: 'terminal-handoff',
      }),
    };
    const terminalHandoffPromise = fetchJson(baseUrl, '/api/control/agents', terminalHandoffRequest);
    const terminalHandoffAgent = await waitForValue(() => agents.get(terminalHandoffId));
    assert(!calls.some(call => call.type === 'sendInput' && call.agentId === terminalHandoffId));
    terminalHandoffAgent.previewText = '› Ask Codex\n\ngpt-5.6-sol xhigh · /source/repo/subdir';
    terminalHandoffAgent.terminalStatus = { kind: 'codex', activity: 'idle', source: 'terminal-text' };
    terminalHandoffAgent.stateRevision = 1;
    events.emit('update');
    const terminalHandoff = await terminalHandoffPromise;
    assert.strictEqual(terminalHandoff.response.status, 201);
    assert.strictEqual(terminalHandoff.body.inputMode, 'terminal');
    await fetchJson(baseUrl, '/api/control/agents', terminalHandoffRequest);
    const terminalHandoffInputs = calls.filter(call => call.type === 'sendInput' && call.agentId === terminalHandoffId);
    assert.strictEqual(terminalHandoffInputs.length, 1);
    assert.deepStrictEqual(terminalHandoffInputs[0].input, [
      { type: 'paste', text: handoffContent.text }, '\r',
    ], 'multiline handoff must use the Composer paste-and-submit protocol');
    assert.strictEqual(
      terminalInputToPtyString(terminalHandoffInputs[0].input),
      `\x1b[200~${handoffContent.text}\x1b[201~\r`,
      'the submit key must be outside the paste so the CLI cannot absorb it into its draft',
    );
    const startsBeforeRejectedHandoff = calls.filter(call => call.type === 'startAgent').length;
    for (const patch of [
      { command: 'bash' }, { handoffSourceSessionKey: 'missing' }, { initialInput: 'execute now' },
    ]) {
      const rejected = await fetchJson(baseUrl, '/api/control/agents', {
        method: 'POST', body: JSON.stringify({ ...JSON.parse(handoffRequest.body), requestId: 'invalid-handoff', ...patch }),
      });
      assert.strictEqual(rejected.response.status, 400);
    }
    assert.strictEqual(calls.filter(call => call.type === 'startAgent').length, startsBeforeRejectedHandoff);
    agents.get('handoff-source').providerSessionTemporary = true;
    const unconfirmed = await fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST', body: JSON.stringify({ ...JSON.parse(handoffRequest.body), requestId: 'unconfirmed-handoff' }),
    });
    assert.strictEqual(unconfirmed.response.status, 400);
    agents.delete('handoff-source');
    projectMountFailure = 'Project membership disk failure';
    const mountsBeforeSmoke = mountAttempts.length;
    const smoke = await fetchJson(baseUrl, '/api/control/agents', {
      method: 'POST', body: JSON.stringify({
        command: 'codex', workspace: '/internal-deployment-smoke', source: 'deployment-smoke',
      }),
    });
    assert.strictEqual(smoke.response.status, 201, 'hidden deployment probes must not mount a Project');
    assert.strictEqual(mountAttempts.length, mountsBeforeSmoke);
    assert.strictEqual(mountedProjects.has('/internal-deployment-smoke'), false);
    await fetchJson(baseUrl, `/api/control/agents/${smoke.body.agentId}`, { method: 'DELETE' });

    for (const rollbackFailure of ['', 'runtime cleanup failed']) {
      projectRollbackFailure = rollbackFailure;
      const requestId = `mount-failed-${rollbackFailure ? 'rollback' : 'clean'}`;
      const request = { method: 'POST', body: JSON.stringify({
        command: 'codex', workspace: '/failed-project', task: 'must not deliver', requestId,
      }) };
      const inputsBefore = calls.filter(call => call.type === 'sendInput').length;
      const failed = await fetchJson(baseUrl, '/api/control/agents', request);
      assert.strictEqual(failed.response.status, 500);
      assert.strictEqual(failed.body.code, 'project-mount-failed');
      assert.strictEqual(failed.body.initialInputDelivered, false);
      assert.strictEqual(agents.get(failed.body.agentId).archived === true, !rollbackFailure);
      assert.strictEqual(calls.filter(call => call.type === 'sendInput').length, inputsBefore);
      assert.deepStrictEqual(calls.findLast(call => call.type === 'archiveAgent').options, {
        reason: 'project-mount-failed', recordHistory: false, requireEngineExit: true, scheduleProviderArchive: false,
      });
      if (rollbackFailure) assert.match(failed.body.error, /Rollback failed: runtime cleanup failed/);
      const attemptsBefore = mountAttempts.length;
      const replay = await fetchJson(baseUrl, '/api/control/agents', request);
      assert.deepStrictEqual(replay.body, failed.body);
      assert.strictEqual(mountAttempts.length, attemptsBefore, 'deduplicated Create must not repeat the failed mount');
    }

    console.log('✓ Control API serializes exact-runtime Terminal mutations and readiness-bound startup input');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
