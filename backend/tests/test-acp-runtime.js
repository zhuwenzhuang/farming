const assert = require('assert');
const path = require('path');
const { AcpRuntime, autoPermissionResponse, codexAcpEnvironment, resolveAcpLaunch } = require('../acp-runtime');
const { AcpSessionState } = require('../acp-session-state');

async function run() {
  assert.strictEqual(resolveAcpLaunch('codex').version, '1.1.2');
  assert.strictEqual(resolveAcpLaunch('claude').version, '0.58.1');
  assert.deepStrictEqual(resolveAcpLaunch('opencode', { cwd: '/tmp/demo', executable: '/bin/opencode' }), {
    command: '/bin/opencode',
    args: ['acp', '--cwd', '/tmp/demo'],
    version: 'native',
  });
  assert.deepStrictEqual(resolveAcpLaunch('qoder', { executable: '/bin/qodercli' }), {
    command: '/bin/qodercli',
    args: ['--acp'],
    version: 'native',
  });
  assert.deepStrictEqual(autoPermissionResponse({
    options: [{ optionId: 'yes', kind: 'allow_once' }],
  }, 'full'), { outcome: { outcome: 'selected', optionId: 'yes' } });
  const codexEnv = codexAcpEnvironment({
    env: { KEEP: 'yes', CODEX_CONFIG: '{"existing":true}' },
    approvalMode: 'full',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    serviceTier: 'priority',
  });
  assert.strictEqual(codexEnv.KEEP, 'yes');
  assert.strictEqual(codexEnv.INITIAL_AGENT_MODE, 'agent-full-access');
  assert.deepStrictEqual(JSON.parse(codexEnv.CODEX_CONFIG), {
    existing: true,
    model: 'gpt-5.5',
    model_reasoning_effort: 'xhigh',
    service_tier: 'priority',
  });
  assert.strictEqual(codexAcpEnvironment({ env: {}, approvalMode: 'ask' }).INITIAL_AGENT_MODE, 'read-only');

  const state = new AcpSessionState({ provider: 'codex', sessionId: 's1', cwd: '/tmp' });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'hello' },
  } });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'one' },
  } });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: ' two' },
  } });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Test', status: 'pending',
  } });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'ok',
  } });
  const reduced = state.snapshot();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(reduced, 'updates'), false);
  assert.strictEqual(state.snapshot({}, { includeUpdates: true }).updates.length, 5);
  assert.strictEqual(reduced.version, 2);
  assert.strictEqual(reduced.entries.length, 3);
  assert.strictEqual(reduced.entries[1].content[0].text, 'one two');
  assert.strictEqual(reduced.entries[2].status, 'completed');
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'usage_update', used: 53_000, size: 200_000, cost: { amount: 0.045, currency: 'USD' },
  } });
  assert.deepStrictEqual(state.snapshot().usage, {
    sessionUpdate: 'usage_update', used: 53_000, size: 200_000, cost: { amount: 0.045, currency: 'USD' },
  });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'plan_update',
    plan: { type: 'items', planId: 'plan-1', entries: [{ content: 'Finish', status: 'in_progress' }] },
  } });
  assert.strictEqual(state.snapshot().entries.find(entry => entry.type === 'plan').plan.entries[0].content, 'Finish');
  state.beginPrompt('limited');
  state.completePrompt('max_tokens');
  assert.strictEqual(state.snapshot().entries.at(-1).content[0].text, 'limited');
  const sanitizedState = new AcpSessionState({ provider: 'codex', sessionId: 's2', cwd: '/tmp' });
  sanitizedState.apply({ sessionId: 's2', update: {
    sessionUpdate: 'user_message_chunk',
    messageId: 'u2',
    content: { type: 'text', text: '<environment_context>secret</environment_context>\nvisible' },
  } });
  assert.strictEqual(sanitizedState.snapshot().entries[0].content[0].text, 'visible');
  assert.strictEqual(sanitizedState.snapshot().entries[0].internal, false);
  sanitizedState.apply({ sessionId: 's2', update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'a2',
    content: {
      type: 'text',
      text: 'answer\n\n<oai-mem-citation>\n<citation_entries>MEMORY.md:1-2</citation_entries>\n<rollout_ids>thread-id</rollout_ids>\n</oai-mem-citation>',
    },
  } });
  assert.strictEqual(sanitizedState.snapshot().entries[1].content[0].text, 'answer');
  const heartbeatState = new AcpSessionState({ provider: 'codex', sessionId: 's3', cwd: '/tmp' });
  heartbeatState.apply({ sessionId: 's3', update: {
    sessionUpdate: 'user_message_chunk',
    messageId: 'heartbeat-user',
    content: { type: 'text', text: '<heartbeat><automation_id>ci-watch</automation_id></heartbeat>' },
  } });
  heartbeatState.apply({ sessionId: 's3', update: {
    sessionUpdate: 'tool_call', toolCallId: 'heartbeat-tool', title: 'Check CI', status: 'completed',
  } });
  const heartbeatSnapshot = heartbeatState.snapshot();
  assert.strictEqual(heartbeatSnapshot.entries[0].internal, true);
  assert.strictEqual(heartbeatSnapshot.entries[0].content[0].text, '');
  assert.strictEqual(heartbeatSnapshot.entries[1].internal, true);

  const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');
  const runtime = new AcpRuntime({
    resolveLaunch() {
      return { command: process.execPath, args: [fixture], version: 'test' };
    },
  });
  try {
    const emittedSessions = [];
    runtime.on('session', event => emittedSessions.push(event));
    const preparing = runtime.prepareAgent({
      agentId: 'agent-acp-new',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    const connectingSession = runtime.getSession('agent-acp-new');
    assert.strictEqual(connectingSession.state, 'connecting');
    assert.deepStrictEqual(connectingSession.entries, []);
    const prepared = await preparing;
    assert.strictEqual(prepared.sessionId, 'acp-new-session');
    assert.strictEqual(prepared.historyMode, 'new');
    const prompted = await runtime.prompt('agent-acp-new', 'hello ACP');
    assert.strictEqual(prompted.stopReason, 'end_turn');
    const session = runtime.getSession('agent-acp-new');
    assert.strictEqual(session.protocol, 'acp');
    assert.strictEqual(session.entries.find(item => item.type === 'tool').status, 'completed');
    assert.strictEqual(session.entries.find(item => item.role === 'assistant').content[0].text, 'ACP reply');
    assert(emittedSessions.length > 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(emittedSessions[0], 'session'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(session, 'updates'), false);
    assert(runtime.getSession('agent-acp-new', { includeUpdates: true }).updates.length > 0);
    const listed = await runtime.listSessions('agent-acp-new');
    assert.strictEqual(listed.sessions[0].sessionId, 'acp-new-session');
    assert.strictEqual((await runtime.forkSession('agent-acp-new')).sessionId, 'acp-fork-session');
    assert.deepStrictEqual(await runtime.setSessionMode('agent-acp-new', 'plan'), {
      sessionId: 'acp-new-session', modeId: 'plan',
    });
    const configured = await runtime.setSessionConfigOption('agent-acp-new', 'show-thinking', true);
    assert.strictEqual(configured.configOptions[0].currentValue, true);
    assert.deepStrictEqual(await runtime.deleteSession('agent-acp-new', 'old-session'), {
      deleted: true, sessionId: 'old-session',
    });

    const loaded = await runtime.prepareAgent({
      agentId: 'agent-acp-load',
      provider: 'opencode',
      cwd: process.cwd(),
      env: process.env,
      sessionId: 'existing-session',
      approvalMode: 'full',
    });
    assert.strictEqual(loaded.historyMode, 'load');
    const history = runtime.getSession('agent-acp-load');
    assert.strictEqual(history.entries.length, 2);
    assert.strictEqual(history.entries[0].content[0].text, 'historical question');
    assert.strictEqual(history.entries[1].content[0].text, 'historical answer');

    const delayedHistory = await runtime.prepareAgent({
      agentId: 'agent-acp-qoder-load',
      provider: 'qoder',
      cwd: process.cwd(),
      env: process.env,
      sessionId: 'delayed-history-session',
      approvalMode: 'full',
    });
    assert.strictEqual(delayedHistory.historyMode, 'load');
    const qoderHistory = runtime.getSession('agent-acp-qoder-load');
    assert.strictEqual(qoderHistory.entries.length, 2);
    assert.strictEqual(qoderHistory.entries[1].content[0].text, 'delayed historical answer');

    await runtime.prepareAgent({
      agentId: 'agent-acp-permission',
      provider: 'claude',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'approve',
    });
    const waiting = new Promise(resolve => {
      const listener = event => {
        if (event.agentId === 'agent-acp-permission' && event.state === 'waiting-for-permission') {
          runtime.off('agent-runtime', listener);
          resolve(event);
        }
      };
      runtime.on('agent-runtime', listener);
    });
    const permissionPrompt = runtime.prompt('agent-acp-permission', 'needs permission');
    const waitingEvent = await waiting;
    assert.strictEqual(waitingEvent.pendingPermission.options[0].optionId, 'allow');
    runtime.respondPermission(
      'agent-acp-permission',
      waitingEvent.pendingPermission.requestId,
      'allow'
    );
    assert.strictEqual((await permissionPrompt).stopReason, 'end_turn');

    const permissionBinding = runtime.bindings.get('agent-acp-permission');
    const request = {
      sessionId: 'acp-new-session',
      toolCall: { toolCallId: 'parallel-tool', title: 'Parallel request' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    };
    const firstPermission = runtime.requestPermission(permissionBinding, request);
    const secondPermission = runtime.requestPermission(permissionBinding, {
      ...request,
      toolCall: { toolCallId: 'parallel-tool-2', title: 'Second request' },
    });
    const pending = runtime.getSession('agent-acp-permission').pendingPermissions;
    assert.strictEqual(pending.length, 2);
    runtime.respondPermission('agent-acp-permission', pending[0].requestId, 'allow');
    assert.strictEqual(runtime.getSession('agent-acp-permission').state, 'waiting-for-permission');
    runtime.respondPermission('agent-acp-permission', pending[1].requestId, 'allow');
    assert.strictEqual(runtime.getSession('agent-acp-permission').state, 'working');
    await Promise.all([firstPermission, secondPermission]);

    const cancelledPermission = runtime.requestPermission(permissionBinding, request);
    assert.strictEqual(runtime.getSession('agent-acp-permission').pendingPermissions.length, 1);
    assert.strictEqual(await runtime.cancel('agent-acp-permission'), true);
    assert.strictEqual(runtime.getSession('agent-acp-permission').pendingPermissions.length, 0);
    assert.strictEqual(runtime.getSession('agent-acp-permission').state, 'interrupting');
    assert.deepStrictEqual(await cancelledPermission, { outcome: { outcome: 'cancelled' } });
  } finally {
    runtime.dispose();
  }

  console.log('ACP runtime tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
