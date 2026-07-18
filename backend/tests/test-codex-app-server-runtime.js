const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentManager = require('../agent-manager');
const { CodexAppServerRuntime } = require('../codex-app-server-runtime');

function createMockAppServerConnectionFactory() {
  const messages = [];
  const connections = new Set();
  const pendingServerRequests = new Map();
  let goal = null;
  let ready = false;
  let failThreadReads = false;

  class MockConnection {
    constructor() {
      this.subscribers = new Set();
      connections.add(this);
    }

    subscribe(handler) {
      this.subscribers.add(handler);
      return () => this.subscribers.delete(handler);
    }

    async connect() {
      if (!ready) throw new Error('connect ENOENT mock Codex App Server socket');
      return this;
    }

    async request(method, params) {
      const message = { method, params };
      messages.push(message);
      if (method === 'thread/start') return { result: { thread: { id: 'thread-new' } } };
      if (method === 'thread/resume') return { result: { thread: { id: params.threadId } } };
      if (method === 'thread/read') {
        if (failThreadReads) throw new Error('mock thread/read failed');
        return { result: { thread: { id: params.threadId, turns: [] } } };
      }
      if (method === 'turn/start') {
        const notification = {
          kind: 'notification',
          payload: { method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'turn-1' } } },
        };
        this.subscribers.forEach(handler => handler(notification));
        return { result: { turn: { id: 'turn-1' } } };
      }
      if (method === 'turn/steer') return { result: { turnId: params.expectedTurnId } };
      if (method === 'turn/interrupt') return { result: {} };
      if (method === 'thread/settings/update') return { result: {} };
      if (method === 'thread/goal/get') return { result: { goal } };
      if (method === 'thread/goal/set') {
        goal = {
          threadId: params.threadId,
          objective: params.objective || (goal && goal.objective) || '',
          status: params.status || (goal && goal.status) || 'active',
          tokenBudget: Object.prototype.hasOwnProperty.call(params, 'tokenBudget') ? params.tokenBudget : null,
          tokensUsed: 12,
          timeUsedSeconds: 34,
          createdAt: 1,
          updatedAt: 2,
        };
        this.subscribers.forEach(handler => handler({
          kind: 'notification',
          payload: { method: 'thread/goal/updated', params: { threadId: params.threadId, goal } },
        }));
        return { result: { goal } };
      }
      if (method === 'thread/goal/clear') {
        goal = null;
        this.subscribers.forEach(handler => handler({
          kind: 'notification',
          payload: { method: 'thread/goal/cleared', params: { threadId: params.threadId } },
        }));
        return { result: {} };
      }
      throw new Error(`Unexpected mock method: ${method}`);
    }

    resolveServerRequest(requestId, result) {
      const request = pendingServerRequests.get(String(requestId));
      if (!request) throw new Error('mock server request is not pending');
      pendingServerRequests.delete(String(requestId));
      messages.push({ method: 'server-request/resolve', requestId, result });
      return { id: request.id, resolved: true };
    }

    rejectServerRequest(requestId, error) {
      const request = pendingServerRequests.get(String(requestId));
      if (!request) throw new Error('mock server request is not pending');
      pendingServerRequests.delete(String(requestId));
      messages.push({ method: 'server-request/reject', requestId, error });
      return { id: request.id, rejected: true };
    }

    close() { connections.delete(this); }
  }

  return {
    messages,
    createConnection() { return new MockConnection(); },
    markReady() { ready = true; },
    setThreadReadFailure(value) { failThreadReads = value === true; },
    emitServerRequest(request) {
      pendingServerRequests.set(String(request.id), request);
      connections.forEach(connection => connection.subscribers.forEach(handler => handler({ kind: 'server-request', payload: request })));
    },
    emitNotification(message) {
      connections.forEach(connection => connection.subscribers.forEach(handler => handler({ kind: 'notification', payload: message })));
    },
  };
}

function testConfig(mode, codexHome = path.join(os.tmpdir(), 'farming-codex-home')) {
  return {
    farmingDir: os.tmpdir(),
    getWorkspace() { return os.tmpdir(); },
    getHeartbeatInterval() { return 60_000; },
    getDangerouslySkipAgentPermissionsByDefault() { return false; },
    getAgentLaunchProfiles() { return {}; },
    getCodexApprovalMode() { return 'approve'; },
    getCodexModelPreset() { return 'gpt-5.5:xhigh'; },
    getCodexModel() { return 'gpt-5.5'; },
    getCodexReasoningEffort() { return 'xhigh'; },
    getCodexServiceTier() { return 'default'; },
    getCodexRuntimeMode() { return mode; },
    getAgentHome() { return { id: 'default', path: codexHome }; },
  };
}

async function run() {
  // Keep the Unix-domain socket below macOS's short socket-path limit while
  // staying inside the repository's writable local-artifact directory.
  const testTempDir = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(testTempDir, { recursive: true });
  const root = await fs.promises.mkdtemp(path.join(testTempDir, 'as-'));
  const codexHome = path.join(root, 'c');
  const mock = createMockAppServerConnectionFactory();
  const spawned = [];
  const runtimeEvents = [];
  const runtime = new CodexAppServerRuntime({
    connectTimeoutMs: 1200,
    retryDelayMs: 10,
    createConnection: () => mock.createConnection(),
    spawnAppServer(command, args, options) {
      spawned.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      mock.markReady();
      return child;
    },
  });
  runtime.on('agent-runtime', event => runtimeEvents.push(event));

  try {
    const prepared = await runtime.prepareAgent({
      agentId: 'agent-one',
      codexHome,
      executable: 'codex-test',
      env: { PATH: process.env.PATH },
      cwd: root,
      workspaceRoot: root,
      approvalMode: 'approve',
      model: 'gpt-test',
      reasoningEffort: 'high',
      serviceTier: 'default',
    });
    assert.strictEqual(prepared.threadId, 'thread-new');
    assert.strictEqual(prepared.cliArgs, undefined, 'App Server mode must not expose CLI observer launch arguments');
    assert.deepStrictEqual(spawned[0].args, ['app-server', '--listen', 'unix://']);
    assert.strictEqual(spawned.length, 1, 'the first connection should spawn one managed App Server');

    const started = await runtime.submitComposerMessage({
      agentId: 'agent-one',
      message: 'first structured message',
    });
    assert.deepStrictEqual(started, { kind: 'start', threadId: 'thread-new', turnId: 'turn-1' });
    mock.emitNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-new', turnId: 'turn-1', delta: 'structured reply' },
    });
    const steered = await runtime.submitComposerMessage({
      agentId: 'agent-one',
      message: 'continue this turn',
    });
    assert.deepStrictEqual(steered, { kind: 'steer', threadId: 'thread-new', turnId: 'turn-1' });
    assert.strictEqual(await runtime.interruptAgent('agent-one'), true);
    const updatedPermissions = await runtime.updateAgentPermissionMode({
      agentId: 'agent-one',
      approvalMode: 'full',
    });
    assert.deepStrictEqual(updatedPermissions, { threadId: 'thread-new' });
    assert(mock.messages.some(message => (
      message.method === 'thread/settings/update'
      && message.params.threadId === 'thread-new'
      && message.params.approvalPolicy === 'never'
      && message.params.sandboxPolicy?.type === 'dangerFullAccess'
    )));
    assert(runtimeEvents.some(event => event.agentId === 'agent-one' && event.permissionMode === 'full'));
    mock.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-new', turn: { id: 'turn-1', status: 'completed' } },
    });
    const structuredTranscript = runtime.getAgentTranscript('agent-one');
    assert.strictEqual(structuredTranscript.source, 'codex-app-server');
    assert.strictEqual(structuredTranscript.turns.length, 1);
    assert.strictEqual(structuredTranscript.turns[0].userMessage, 'first structured message');
    assert.strictEqual(structuredTranscript.turns[0].finalMessage, 'structured reply');
    runtime.maxTranscriptEvents = 3;
    for (let index = 0; index < 4; index += 1) {
      mock.emitNotification({
        method: 'configWarning',
        params: { threadId: 'thread-new', message: `warning ${index + 1}` },
      });
    }
    while (runtime.transcriptRefreshes.get('agent-one')) {
      await runtime.transcriptRefreshes.get('agent-one');
    }
    assert.strictEqual(runtime.transcripts.get('agent-one').events[0].method, 'thread/read');
    assert(runtime.transcripts.get('agent-one').events.length <= 3, 'transcript refresh should replace an oversized event log with a fresh snapshot');
    assert(mock.messages.filter(message => message.method === 'thread/read').length >= 2, 'transcript compaction should read a new App Server snapshot');
    runtime.maxTranscriptEvents = 2;
    mock.setThreadReadFailure(true);
    for (let index = 0; index < 5; index += 1) {
      mock.emitNotification({
        method: 'configWarning',
        params: { threadId: 'thread-new', message: `failed refresh warning ${index + 1}` },
      });
    }
    await runtime.transcriptRefreshes.get('agent-one');
    assert.strictEqual(runtime.transcriptRefreshes.has('agent-one'), false, 'a failed snapshot refresh must not spin in a retry loop');
    assert.strictEqual(runtime.getAgentTranscript('agent-one').truncated, true, 'fallback truncation must be reported explicitly');
    assert(runtime.transcripts.get('agent-one').events.length <= 4, 'failed snapshot refreshes must still keep memory bounded');
    mock.setThreadReadFailure(false);
    runtime.maxTranscriptEvents = 12_000;
    const resumed = await runtime.prepareAgent({
      agentId: 'agent-two',
      codexHome,
      executable: 'codex-test',
      env: { PATH: process.env.PATH },
      cwd: root,
      workspaceRoot: root,
      resumeThreadId: 'thread-existing',
    });
    assert.strictEqual(resumed.threadId, 'thread-existing');
    assert.strictEqual(spawned.length, 1, 'agents in one Codex home should reuse one App Server');
    assert(mock.messages.some(message => message.method === 'thread/start'));
    assert(mock.messages.some(message => message.method === 'thread/resume' && message.params.threadId === 'thread-existing'));
    assert(mock.messages.some(message => message.method === 'turn/start' && message.params.input[0].text === 'first structured message'));
    assert(mock.messages.some(message => message.method === 'turn/steer' && message.params.expectedTurnId === 'turn-1'));
    assert(mock.messages.some(message => message.method === 'turn/interrupt' && message.params.turnId === 'turn-1'));
    assert(runtimeEvents.some(event => event.agentId === 'agent-one' && event.state === 'working'));
    const savedGoal = await runtime.setAgentGoal({
      agentId: 'agent-one',
      objective: 'ship native goal controls',
      status: 'active',
      tokenBudget: 1000,
    });
    assert.strictEqual(savedGoal.objective, 'ship native goal controls');
    assert.strictEqual(savedGoal.tokenBudget, 1000);
    assert.strictEqual((await runtime.getAgentGoal({ agentId: 'agent-one' })).status, 'active');
    assert(runtimeEvents.some(event => event.agentId === 'agent-one' && event.goal && event.goal.objective === 'ship native goal controls'));
    await runtime.clearAgentGoal({ agentId: 'agent-one' });
    assert(runtimeEvents.some(event => event.agentId === 'agent-one' && Object.prototype.hasOwnProperty.call(event, 'goal') && event.goal === null));

    mock.emitServerRequest({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-new', command: 'npm test' },
    });
    const rejectedApprovalEvent = runtimeEvents.find(event => event.agentId === 'agent-one' && event.notice && event.notice.kind === 'approval-rejected');
    assert.strictEqual(rejectedApprovalEvent.notice.method, 'item/commandExecution/requestApproval');
    assert(mock.messages.some(message => message.method === 'server-request/reject' && message.requestId === 'approval-1'));

    mock.emitServerRequest({
      id: 'input-1',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-new', questions: [{ id: 'choice', question: 'Pick one' }] },
    });
    const pendingEvent = runtimeEvents.find(event => event.agentId === 'agent-one' && event.pendingRequestId === 'input-1');
    assert.deepStrictEqual(pendingEvent.pendingRequest, {
      id: 'input-1',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-new', questions: [{ id: 'choice', question: 'Pick one' }] },
      receivedAt: pendingEvent.pendingRequest.receivedAt,
    });
    runtime.resolveAgentServerRequest('agent-one', 'input-1', { answers: { choice: { answers: ['yes'] } } });
    assert(mock.messages.some(message => (
      message.method === 'server-request/resolve'
      && message.result
      && message.result.answers.choice.answers[0] === 'yes'
    )));
    assert(!runtimeEvents.some(event => event.agentId === 'agent-one' && event.pendingRequestId === 'approval-1'), 'approval requests should not become pending in Chat');
    assert.deepStrictEqual(rejectedApprovalEvent.notice, {
      id: 'notice-approval-1',
      kind: 'approval-rejected',
      method: 'item/commandExecution/requestApproval',
      message: rejectedApprovalEvent.notice.message,
      receivedAt: rejectedApprovalEvent.notice.receivedAt,
    });
    assert.strictEqual(typeof rejectedApprovalEvent.notice.receivedAt, 'string');
    assert.strictEqual(typeof rejectedApprovalEvent.notice.message, 'string');

    const serializedNotice = rejectedApprovalEvent.notice;
    assert(serializedNotice.message.includes('Permission request'));

    const calls = [];
    const cliRuntime = new EventEmitter();
    cliRuntime.prepareAgent = async () => {
      throw new Error('CLI mode must not prepare App Server');
    };
    cliRuntime.submitComposerMessage = async () => {
      throw new Error('CLI mode must not send structured Composer messages');
    };
    cliRuntime.dispose = () => {};
    const manager = new AgentManager(testConfig('app-server'), { codexAppServerRuntime: cliRuntime });
    const engine = {
      async createSession(payload) { calls.push({ kind: 'create', payload }); },
      async sendInput(agentId, input) { calls.push({ kind: 'input', agentId, input }); },
      async updateSessionMetadata() {},
    };
    manager.engineBridge.resolve = () => ({ engineName: 'test', spec: { category: 'coding' }, engine });
    manager.engineBridge.getEngine = () => engine;
    try {
      const agentId = await manager.startAgent('codex', root, null, { wantsMain: false, codexRuntimeMode: 'cli' });
      assert(agentId, 'an explicit Terminal choice should still start a Codex terminal');
      assert.strictEqual(calls[0].payload.metadata.codexRuntimeMode, 'cli', 'the per-launch Terminal choice must override the global App Server default');
      assert(!calls[0].payload.args.includes('resume'), 'CLI mode keeps the normal launch arguments');
      await manager.sendComposerMessage(agentId, 'terminal compatibility message');
      assert.deepStrictEqual(calls[1], {
        kind: 'input',
        agentId,
        input: [{ type: 'paste', text: 'terminal compatibility message' }, '\r'],
      });
    } finally {
      await manager.dispose({ preserveTerminalHost: false });
    }

    const appServerCalls = [];
    const managedRuntime = new EventEmitter();
    managedRuntime.prepareAgent = async options => {
      appServerCalls.push({ kind: 'prepare', options });
      return {
        threadId: 'thread-managed',
        resumed: false,
        endpoint: 'unix:///tmp/farming-managed.sock',
        cliArgs: ['resume', '-C', root, 'thread-managed'],
      };
    };
    managedRuntime.submitComposerMessage = async options => {
      appServerCalls.push({ kind: 'composer', options });
      return { kind: 'start', threadId: 'thread-managed', turnId: 'turn-managed' };
    };
    managedRuntime.interruptAgent = async agentId => {
      appServerCalls.push({ kind: 'interrupt', agentId });
      return true;
    };
    managedRuntime.updateAgentPermissionMode = async options => {
      appServerCalls.push({ kind: 'permission-update', options });
      return { threadId: 'thread-managed' };
    };
    managedRuntime.resolveAgentServerRequest = (agentId, requestId, result) => {
      appServerCalls.push({ kind: 'resolve-request', agentId, requestId, result });
      return { id: requestId, resolved: true };
    };
    managedRuntime.getAgentGoal = async options => {
      appServerCalls.push({ kind: 'goal-get', options });
      return null;
    };
    managedRuntime.setAgentGoal = async options => {
      appServerCalls.push({ kind: 'goal-set', options });
      return {
        threadId: options.threadId,
        objective: options.objective,
        status: options.status,
        tokenBudget: options.tokenBudget,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      };
    };
    managedRuntime.clearAgentGoal = async options => {
      appServerCalls.push({ kind: 'goal-clear', options });
      return null;
    };
    managedRuntime.rejectAgentServerRequest = (agentId, requestId, error) => {
      appServerCalls.push({ kind: 'reject-request', agentId, requestId, error });
      return { id: requestId, rejected: true };
    };
    managedRuntime.unregisterAgent = () => {};
    managedRuntime.dispose = () => {};
    const managedManager = new AgentManager(testConfig('app-server', root), { codexAppServerRuntime: managedRuntime });
    const managedEngineCalls = [];
    const managedEngine = {
      async createSession(payload) { managedEngineCalls.push({ kind: 'create', payload }); },
      async sendInput(agentId, input) { managedEngineCalls.push({ kind: 'input', agentId, input }); },
      async resizeSession() { return { resized: false }; },
      async updateSessionMetadata() {},
    };
    managedManager.engineBridge.resolve = () => ({ engineName: 'test', spec: { category: 'coding' }, engine: managedEngine });
    managedManager.engineBridge.getEngine = () => managedEngine;
    try {
      const agentId = await managedManager.startAgent('codex', root, null, { wantsMain: false });
      assert(agentId, 'App Server mode should create a Composer-ready Codex agent');
      assert.strictEqual(managedEngineCalls.length, 0, 'a brand-new empty thread is not resumable until its first turn');
      managedManager.engineBridge.emit('session-error', {
        sessionId: agentId,
        error: new Error('Session not available'),
      });
      assert.strictEqual(managedManager.agents.get(agentId).status, 'running', 'a deferred App Server terminal is not a dead Agent');
      await managedManager.resizeAgentSession(agentId, 120, 40);
      assert.strictEqual(managedManager.agents.get(agentId).status, 'running', 'a terminal resize must not kill a deferred App Server Agent');
      managedManager.agents.get(agentId).startedAt = Date.now() - 10_000;
      assert.strictEqual(managedManager.shouldDeferMissingEngineSession(managedManager.agents.get(agentId)), true);
      managedManager.markAgentSessionDead(agentId, 'Session not available');
      assert.strictEqual(managedManager.agents.get(agentId).status, 'running', 'deferred App Server state must survive every terminal missing-session path');
      managedManager.engineBridge.emit('session-exited', { sessionId: agentId, code: 'unknown' });
      assert.strictEqual(managedManager.agents.get(agentId).status, 'running', 'a stale PTY exit must not stop a deferred App Server Agent');
      await managedManager.sendComposerMessage(agentId, 'structured manager message');
      assert.strictEqual(managedEngineCalls.length, 0, 'App Server mode must not create a CLI observer');
      const appServerPermission = await managedManager.syncCodexTerminalPermissionMode(agentId, 'full');
      assert.strictEqual(appServerPermission.error, undefined);
      assert.strictEqual(appServerPermission.updated, true);
      assert.strictEqual(appServerPermission.restarted, undefined);
      assert.strictEqual(appServerPermission.restartedAgentId, undefined);
      assert.strictEqual(managedManager.agents.has(agentId), true, 'App Server permission updates keep the existing Agent');
      assert.strictEqual(managedManager.agents.get(agentId).launchPermissionMode, 'full');
      assert.strictEqual(appServerCalls.filter(call => call.kind === 'prepare').length, 1, 'permission updates must not re-create the App Server thread');
      assert(appServerCalls.some(call => (
        call.kind === 'permission-update'
        && call.options.agentId === agentId
        && call.options.approvalMode === 'full'
      )));
      const providerSession = managedManager.getAgentProviderSession(agentId);
      assert.strictEqual(providerSession.provider, 'codex');
      assert.strictEqual(providerSession.runtimeBinding.kind, 'app-server');
      assert(providerSession.codexAppServerHomePath, 'App Server provider session should expose its runtime home');
      assert.notStrictEqual(
        providerSession.codexAppServerHomePath,
        providerSession.providerHomePath,
        'transcript reads must be able to use the isolated runtime home'
      );
      managedManager.markAgentSessionDead(agentId, 'observer disappeared');
      assert.strictEqual(managedManager.agents.get(agentId).status, 'running', 'an App Server Agent has no terminal observer to define its lifecycle');
      await managedManager.resizeAgentSession(agentId, 121, 40);
      assert.strictEqual(managedManager.agents.get(agentId).status, 'running', 'a missing observer resize target must not kill an App Server Agent');
      await managedManager.interruptAgent(agentId);
      const inputCountBeforeFailedInterrupt = managedEngineCalls.filter(call => call.kind === 'input').length;
      managedRuntime.interruptAgent = async interruptAgentId => {
        appServerCalls.push({ kind: 'interrupt-failed', agentId: interruptAgentId });
        throw new Error('mock interrupt unavailable');
      };
      await managedManager.interruptAgent(agentId);
      assert.strictEqual(
        managedEngineCalls.filter(call => call.kind === 'input').length,
        inputCountBeforeFailedInterrupt,
        'App Server interrupt failure must not fall back to terminal input'
      );
      assert.match(
        managedManager.agents.get(agentId).codexAppServerError,
        /Codex App Server interrupt failed/
      );
      managedRuntime.emit('agent-runtime', {
        agentId,
        state: 'waiting-for-input',
        pendingRequestId: 'ask-1',
        pendingRequestMethod: 'item/fileChange/requestApproval',
        pendingRequest: {
          id: 'ask-1',
          method: 'item/fileChange/requestApproval',
          params: { threadId: 'thread-managed', reason: 'write a file' },
          receivedAt: new Date().toISOString(),
        },
      });
      managedManager.respondToCodexAppServerRequest(agentId, 'ask-1', { decision: 'accept' });
      managedRuntime.emit('agent-runtime', {
        agentId,
        notice: {
          id: 'notice-managed',
          kind: 'approval-rejected',
          method: 'item/fileChange/requestApproval',
          message: 'Permission request was declined in Chat.',
          receivedAt: new Date().toISOString(),
        },
      });
      assert.strictEqual(managedManager.getState().agents.find(agent => agent.id === agentId).runtimeBinding.notice.kind, 'approval-rejected');
      const managerGoal = await managedManager.setCodexAppServerGoal(agentId, {
        objective: 'manage the goal from chat',
        status: 'paused',
        tokenBudget: 500,
      });
      assert.strictEqual(managerGoal.objective, 'manage the goal from chat');
      assert.strictEqual(managedManager.getState().agents.find(agent => agent.id === agentId).runtimeBinding.goal.status, 'paused');
      await managedManager.getCodexAppServerGoal(agentId);
      await managedManager.clearCodexAppServerGoal(agentId);
      assert.strictEqual(managedManager.getState().agents.find(agent => agent.id === agentId).runtimeBinding.goal, null);
      assert.strictEqual(appServerCalls.filter(call => call.kind === 'prepare').length, 1);
      assert.strictEqual(appServerCalls.find(call => call.kind === 'composer').options.message, 'structured manager message');
      assert(appServerCalls.some(call => call.kind === 'interrupt' && call.agentId === agentId));
      assert(appServerCalls.some(call => call.kind === 'resolve-request' && call.requestId === 'ask-1' && call.result.decision === 'accept'));
      assert(appServerCalls.some(call => call.kind === 'goal-set' && call.options.objective === 'manage the goal from chat'));
      assert(appServerCalls.some(call => call.kind === 'goal-clear'));
      assert.strictEqual(managedEngineCalls.filter(call => call.kind === 'input').length, 0, 'App Server Composer input must not be pasted into the terminal');

      const legacyRecoveredAgent = managedManager.recoveredAgentRecord('legacy-codex', 'test', {
        command: 'codex',
        providerSessionProvider: 'codex',
        providerSessionId: 'legacy-thread',
      }, {});
      assert.strictEqual(
        legacyRecoveredAgent.codexRuntimeMode,
        'cli',
        'a persisted Codex session without runtime metadata must retain its historical CLI behavior'
      );
      const appServerRecoveredAgent = managedManager.recoveredAgentRecord('app-server-codex', 'test', {
        command: 'codex',
        provider: 'codex',
        providerSessionId: 'app-server-thread',
        codexRuntimeMode: 'app-server',
        codexAppServerHomePath: managedManager.agents.get(agentId).codexAppServerHomePath,
      }, {});
      assert.strictEqual(appServerRecoveredAgent.codexRuntimeMode, 'app-server');
      assert.strictEqual(
        appServerRecoveredAgent.providerSessionProvider,
        'codex',
        'persisted session-store provider records must restore the Codex provider'
      );
      assert.strictEqual(
        appServerRecoveredAgent.providerSessionKey,
        'agent-session:codex:app-server-thread'
      );
      const invalidAppServerRecoveredAgent = managedManager.recoveredAgentRecord('invalid-app-server-codex', 'test', {
        command: 'codex resume invalid-thread',
        provider: 'codex',
        providerSessionId: 'invalid-thread',
        codexRuntimeMode: 'app-server',
        codexAppServerHomePath: '',
        codexAppServerState: 'waiting-for-input',
        codexAppServerTurnId: 'turn-invalid',
        codexAppServerPendingRequestId: 'request-invalid',
        codexAppServerPendingRequest: { id: 'request-invalid' },
        codexCliObserverDeferred: true,
      }, {});
      assert.strictEqual(
        invalidAppServerRecoveredAgent.codexRuntimeMode,
        'cli',
        'a recovered App Server record without runtime home must be corrected back to terminal-owned CLI'
      );
      assert.strictEqual(invalidAppServerRecoveredAgent.codexAppServerHomePath, '');
      assert.strictEqual(invalidAppServerRecoveredAgent.codexAppServerState, '');
      assert.strictEqual(invalidAppServerRecoveredAgent.codexAppServerTurnId, '');
      assert.strictEqual(invalidAppServerRecoveredAgent.codexAppServerPendingRequestId, '');
      assert.strictEqual(invalidAppServerRecoveredAgent.codexAppServerPendingRequest, null);
      assert.strictEqual(invalidAppServerRecoveredAgent.codexCliObserverDeferred, false);
    } finally {
      await managedManager.dispose({ preserveTerminalHost: false });
    }

    console.log('✓ Codex App Server runtime isolates Agent homes and CLI mode remains terminal-owned');
  } finally {
    runtime.dispose();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
