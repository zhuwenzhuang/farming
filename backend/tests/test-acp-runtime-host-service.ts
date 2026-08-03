const assert = require('assert');
const { EventEmitter } = require('events');

const { AcpRuntimeHostService, promptContentHash } = require('../acp-runtime-host-service.cts');

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.promptCalls = 0;
    this.cancelCalls = 0;
    this.promptCompletions = [];
    this.lastSummary = '**Exact assistant** [link](https://example.com)';
    this.lastGetSessionOptions = null;
  }

  bindingEpoch(agentId) {
    return this.sessions.get(agentId)?.bindingEpoch || '';
  }

  getSession(agentId, options) {
    this.lastGetSessionOptions = options;
    const session = this.sessions.get(agentId);
    if (!session) throw new Error('missing session');
    return {
      ...session,
      entries: [{ content: 'must-not-cross-live-host-events' }],
      transcriptTail: { entries: [] },
      updates: [{ large: true }],
    };
  }

  getSessionRequestOptions() {
    return { cwd: '/workspace', additionalDirectories: [], mcpServers: [] };
  }

  getTranscriptSession() {
    return {
      entries: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: this.lastSummary }],
        },
        { type: 'reasoning', content: [{ type: 'text', text: 'private reasoning' }] },
        { type: 'tool', content: [{ type: 'text', text: 'tool output' }] },
      ],
    };
  }

  async prepareAgent(options) {
    const session = {
      agentId: options.agentId,
      bindingEpoch: options.bindingEpoch,
      sessionId: options.sessionId,
      state: 'idle',
      supportsSteer: true,
      revision: 1,
    };
    this.sessions.set(options.agentId, session);
    this.emit('agent-runtime', session);
    return {
      sessionId: options.sessionId,
      historyMode: 'new',
      configOverrides: (options.configOverrides || []).filter(change => change.configId !== 'removed-fast'),
    };
  }

  submitMessage(
    agentId,
    _prompt,
    options: {
      delivery?: string;
      onTurnAdmitted?: (admission?: { previousState: string }) => void;
      onTurnSettled?: (settlement: { stopReason: string }) => void;
      onSubmitted?: (submission?: { steered: boolean }) => void;
    } = {},
  ) {
    this.promptCalls += 1;
    if (options.delivery === 'steer') {
      if (this.sessions.get(agentId)?.state !== 'working') {
        throw new Error('No active Codex turn to steer');
      }
      options.onSubmitted?.({ steered: true });
      return Promise.resolve({ steered: true });
    }
    const session = this.sessions.get(agentId);
    if (session.state === 'working' && options.delivery === 'prompt') {
      throw new Error('ACP Agent is not ready (working)');
    }
    if (session.state === 'working' && options.delivery !== 'prompt') {
      options.onSubmitted?.({ steered: true });
      return Promise.resolve({ steered: true });
    }
    options.onTurnAdmitted?.({ previousState: session.state });
    options.onSubmitted?.({ steered: false });
    session.state = 'working';
    session.revision += 1;
    this.emit('agent-runtime', session);
    return new Promise((resolve, reject) => {
      this.promptCompletions.push({ onTurnSettled: options.onTurnSettled, reject, resolve });
    });
  }

  emitIdleBeforePromptSettlement(agentId) {
    const session = this.sessions.get(agentId);
    session.state = 'idle';
    session.revision += 1;
    this.emit('agent-runtime', session);
  }

  settlePrompt(index, result, summary = '**Exact assistant** [link](https://example.com)') {
    const completion = this.promptCompletions[index];
    if (!completion) throw new Error(`missing prompt completion ${index}`);
    this.lastSummary = summary;
    completion.onTurnSettled?.({ stopReason: String(result?.stopReason || '') });
    completion.resolve(result);
  }

  failPrompt(index, error, summary = '') {
    const completion = this.promptCompletions[index];
    if (!completion) throw new Error(`missing prompt completion ${index}`);
    this.lastSummary = summary;
    completion.onTurnSettled?.({ stopReason: 'error' });
    completion.reject(error);
  }

  async cancel(agentId) {
    this.cancelCalls += 1;
    const session = this.sessions.get(agentId);
    session.state = 'interrupting';
    this.emit('agent-runtime', session);
    return { cancelled: true };
  }

  async unregisterAgentAndWait(agentId) {
    return this.sessions.delete(agentId);
  }
}

async function main() {
  const runtime = new FakeRuntime();
  const service = new AcpRuntimeHostService({ runtime });
  const serviceEvents = [];
  service.on('event', event => serviceEvents.push(event));
  const first = { id: 'server-a', generation: 1 };
  const second = { id: 'server-b', generation: 2 };
  await service.registerController(first);
  await service.prepareAgent(first, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    sessionId: 'session-1',
    configOverrides: [
      { configId: 'model', value: 'gpt-current' },
      { configId: 'removed-fast', value: true },
    ],
  });
  const preparedBinding = service.state.binding('agent-1');
  assert.strictEqual(preparedBinding.entries, undefined);
  assert.strictEqual(preparedBinding.transcriptTail, undefined);
  assert.strictEqual(preparedBinding.updates, undefined);
  assert.deepStrictEqual(runtime.lastGetSessionOptions, { includeEntries: false, includeUpdates: false });
  assert.deepStrictEqual(preparedBinding.sessionRequestOptions.configOverrides, [
    { configId: 'model', value: 'gpt-current' },
  ]);
  assert.deepStrictEqual(service.recover().configOverrides, [{
    agentId: 'agent-1',
    sessionId: 'session-1',
    configOverrides: [{ configId: 'model', value: 'gpt-current' }],
  }]);

  const prompt = service.submitPrompt(first, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'prompt-1',
    contentHash: promptContentHash([{ type: 'text', text: 'work' }]),
    prompt: [{ type: 'text', text: 'work' }],
  });
  assert(
    serviceEvents.some(event => event.type === 'prompt-operation' && event.payload.status === 'provider-owned'),
    'provider ownership must be broadcast directly from onSubmitted without waiting for a session update',
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(service.state.binding('agent-1').state, 'working');
  assert.strictEqual(service.state.binding('agent-1').turnHandle, 'binding-1:1');

  service.disconnectController(first);
  await service.registerController(second);
  runtime.emitIdleBeforePromptSettlement('agent-1');
  assert.strictEqual(
    service.state.binding('agent-1').state,
    'working',
    'an early runtime idle event must not release Host Turn admission before settlement',
  );
  const successor = service.submitPrompt(second, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'prompt-successor',
    contentHash: promptContentHash([{ type: 'text', text: 'successor' }]),
    prompt: [{ type: 'text', text: 'successor' }],
  });
  assert.strictEqual(service.state.binding('agent-1').state, 'working');
  assert.strictEqual(service.state.binding('agent-1').turnHandle, 'binding-1:2');
  const steerRequest = {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'steer-1',
    contentHash: promptContentHash([{ type: 'text', text: 'follow up' }], 'steer'),
    delivery: 'steer',
    prompt: [{ type: 'text', text: 'follow up' }],
  };
  assert.strictEqual((await service.submitPrompt(second, steerRequest)).steered, true);
  assert.strictEqual((await service.submitPrompt(second, steerRequest)).steered, true);
  assert.strictEqual(runtime.promptCalls, 3, 'duplicate steer must join one provider mutation');
  const joined = service.submitPrompt(second, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'prompt-1',
    contentHash: promptContentHash([{ type: 'text', text: 'work' }]),
    prompt: [{ type: 'text', text: 'work' }],
  });
  assert.strictEqual(runtime.promptCalls, 3);

  runtime.settlePrompt(0, { stopReason: 'end_turn' });
  const [result, joinedResult] = await Promise.all([prompt, joined]);
  assert.strictEqual(result.stopReason, 'end_turn');
  assert.strictEqual(joinedResult.stopReason, 'end_turn');
  assert.strictEqual(
    service.state.binding('agent-1').turnHandle,
    'binding-1:2',
    'predecessor settlement must not clear a successor Turn',
  );
  assert.strictEqual(service.state.binding('agent-1').state, 'working');
  assert.strictEqual(service.state.binding('agent-1').lastSettledTurnHandle, 'binding-1:1');
  runtime.emitIdleBeforePromptSettlement('agent-1');
  runtime.settlePrompt(1, { stopReason: 'end_turn' });
  assert.strictEqual((await successor).stopReason, 'end_turn');
  assert.strictEqual(service.state.binding('agent-1').state, 'idle');
  assert.strictEqual(service.state.binding('agent-1').turnHandle, undefined);
  assert.strictEqual(service.state.binding('agent-1').lastSettledTurnSummary, 'Exact assistant link');

  await service.prepareAgent(second, {
    agentId: 'agent-late-predecessor',
    bindingEpoch: 'binding-late',
    sessionId: 'session-late',
  });
  const latePredecessor = service.submitPrompt(second, {
    agentId: 'agent-late-predecessor',
    bindingEpoch: 'binding-late',
    clientPromptId: 'late-predecessor',
    contentHash: promptContentHash([{ type: 'text', text: 'predecessor' }]),
    prompt: [{ type: 'text', text: 'predecessor' }],
  });
  runtime.emitIdleBeforePromptSettlement('agent-late-predecessor');
  const earlySuccessor = service.submitPrompt(second, {
    agentId: 'agent-late-predecessor',
    bindingEpoch: 'binding-late',
    clientPromptId: 'early-successor',
    contentHash: promptContentHash([{ type: 'text', text: 'successor' }]),
    prompt: [{ type: 'text', text: 'successor' }],
  });
  runtime.emitIdleBeforePromptSettlement('agent-late-predecessor');
  runtime.settlePrompt(3, { stopReason: 'end_turn' }, 'Successor exact answer');
  assert.strictEqual((await earlySuccessor).stopReason, 'end_turn');
  runtime.settlePrompt(2, { stopReason: 'max_tokens' }, 'Stale predecessor answer');
  assert.strictEqual((await latePredecessor).stopReason, 'max_tokens');
  const lateBinding = service.state.binding('agent-late-predecessor');
  assert.strictEqual(lateBinding.state, 'idle');
  assert.strictEqual(lateBinding.stopReason, 'end_turn');
  assert.strictEqual(lateBinding.lastSettledTurnHandle, 'binding-late:2');
  assert.strictEqual(lateBinding.lastSettledTurnSummary, 'Successor exact answer');

  await service.prepareAgent(second, {
    agentId: 'agent-late-error',
    bindingEpoch: 'binding-late-error',
    sessionId: 'session-late-error',
  });
  const lateFailure = service.submitPrompt(second, {
    agentId: 'agent-late-error',
    bindingEpoch: 'binding-late-error',
    clientPromptId: 'late-failure',
    contentHash: promptContentHash([{ type: 'text', text: 'old failure' }]),
    prompt: [{ type: 'text', text: 'old failure' }],
  });
  runtime.emitIdleBeforePromptSettlement('agent-late-error');
  const successfulAfterFailure = service.submitPrompt(second, {
    agentId: 'agent-late-error',
    bindingEpoch: 'binding-late-error',
    clientPromptId: 'success-after-failure',
    contentHash: promptContentHash([{ type: 'text', text: 'new success' }]),
    prompt: [{ type: 'text', text: 'new success' }],
  });
  runtime.emitIdleBeforePromptSettlement('agent-late-error');
  runtime.settlePrompt(5, { stopReason: 'end_turn' }, 'New success answer');
  await successfulAfterFailure;
  runtime.failPrompt(4, new Error('late provider failure'), 'Old partial answer');
  await assert.rejects(lateFailure, /late provider failure/);
  const lateErrorBinding = service.state.binding('agent-late-error');
  assert.strictEqual(lateErrorBinding.state, 'idle');
  assert.strictEqual(lateErrorBinding.stopReason, 'end_turn');
  assert.strictEqual(lateErrorBinding.lastSettledTurnHandle, 'binding-late-error:2');
  assert.strictEqual(lateErrorBinding.lastSettledTurnSummary, 'New success answer');

  runtime.emit('config-overrides', {
    agentId: 'agent-1',
    configOverrides: [{ configId: 'service_tier', value: 'fast' }],
  });
  const recovered = service.recover();
  assert.strictEqual(recovered.configOverrides[0].configOverrides[0].value, 'fast');

  await assert.rejects(
    service.submitPrompt(second, {
      agentId: 'agent-1',
      bindingEpoch: 'binding-1',
      clientPromptId: 'forged-hash',
      contentHash: 'forged',
      prompt: [{ type: 'text', text: 'different' }],
    }),
    /content hash does not match/,
  );
  assert.strictEqual(runtime.promptCalls, 7, 'a forged controller hash must fail before provider admission');

  assert.strictEqual(await service.unregisterAgentAndWait(second, 'agent-1'), true);
  assert.strictEqual(await service.unregisterAgentAndWait(second, 'agent-late-predecessor'), true);
  assert.strictEqual(await service.unregisterAgentAndWait(second, 'agent-late-error'), true);
  const afterRemoval = service.recover();
  assert.strictEqual(afterRemoval.bindings.length, 0);
  assert.strictEqual(afterRemoval.promptOperations.length, 0);
  assert.strictEqual(afterRemoval.cancelOperations.length, 0);
  assert.strictEqual(afterRemoval.configOverrides.length, 0);

  console.log('ACP runtime host service tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
