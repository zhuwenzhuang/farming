const assert = require('assert');
const AgentManager = require('../agent-manager');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const manager = new AgentManager({
    getWorkspace() {
      return '/tmp';
    },
    getHeartbeatInterval() {
      return 1000;
    },
  });

  const calls = [];
  manager.engineBridge.getEngine = () => ({
    async sendInput(agentId, input) {
      calls.push({ agentId, input });
      if (calls.length === 1) {
        await sleep(20);
      }
    },
  });

  try {
    manager.agents.set('agent-input', {
      id: 'agent-input',
      command: 'codex',
      cwd: '/tmp',
      engineName: 'local',
      status: 'running',
    });

    await Promise.all([
      manager.sendInput('agent-input', [{ type: 'paste', text: 'A' }, '\r']),
      manager.sendInput('agent-input', [{ type: 'paste', text: 'B' }, '\r']),
    ]);

    assert.deepStrictEqual(calls, [
      { agentId: 'agent-input', input: [{ type: 'paste', text: 'A' }, '\r'] },
      { agentId: 'agent-input', input: [{ type: 'paste', text: 'B' }, '\r'] },
    ], 'each composer input transaction should stay atomic in the per-agent queue');

    const profileCalls = [];
    const profileInputReceivedStates = [];
    let profilePreview = '• Service tier set to default\n\n› Ask Codex\n\ngpt-5.5 xhigh · /tmp';
    manager.engineBridge.getEngine = () => ({
      async getSessionState() {
        return {
          status: 'running',
          previewText: profilePreview,
          output: profilePreview,
          renderOutput: profilePreview,
        };
      },
      async sendInput(agentId, input) {
        profileCalls.push({ agentId, input });
        profileInputReceivedStates.push(manager.agents.get(agentId)?.terminalInputReceived === true);
        if (Array.isArray(input) && input[0]?.text === '/model') {
          profilePreview = [
            'Select Model and Effort',
            '  1. gpt-5.5',
            '  8. gpt-5.6-sol',
          ].join('\n');
        } else if (input === '8') {
          profilePreview = [
            'Select Reasoning Level for gpt-5.6-sol',
            '  1. Low',
            '  4. Extra high',
          ].join('\n');
        } else if (input === '4') {
          profilePreview = '• Service tier set to default\n\n• Model changed to gpt-5.6-sol xhigh\n\ngpt-5.6-sol xhigh · /tmp';
        } else if (Array.isArray(input) && input[0]?.text === '/fast on') {
          // Leave the confirmation pending. The next user input must be
          // accepted after the complete direct command, without waiting for
          // this output to arrive.
        } else if (Array.isArray(input) && input[0]?.text === 'after profile') {
          profilePreview += '\n• Fast mode is on.';
        }
      },
    });
    manager.agents.set('agent-profile', {
      id: 'agent-profile',
      command: 'codex resume test-session',
      cwd: '/tmp',
      engineName: 'local',
      status: 'running',
      agentRuntimeMode: 'terminal',
      terminalInputReceived: false,
    });
    const profilePreviews = [];
    manager.onSessionPreview(preview => profilePreviews.push(preview));

    await Promise.all([
      manager.setCodexTerminalProfile('agent-profile', {
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        serviceTier: 'priority',
      }),
      manager.sendInput('agent-profile', [{ type: 'paste', text: 'after profile' }, '\r']),
    ]);
    assert.deepStrictEqual(profileCalls.map(call => call.input), [
      [{ type: 'paste', text: '/model' }, '\r'],
      '8',
      '4',
      [{ type: 'paste', text: '/fast on' }, '\r'],
      [{ type: 'paste', text: 'after profile' }, '\r'],
    ], 'later Terminal input should wait for model menus but not for direct Fast confirmation');
    assert.deepStrictEqual(
      profileInputReceivedStates,
      [false, false, false, false, true],
      'Farming-owned model menu input should keep a fresh Terminal eligible for ACP Chat, while submitted user input is fenced before an ambiguous PTY response'
    );
    assert.strictEqual(
      manager.agents.get('agent-profile').terminalInputReceived,
      true,
      'accepted user input after the profile change should mark the Terminal used'
    );
    assert.deepStrictEqual(
      {
        model: profilePreviews.at(-1)?.codexTerminalProfile?.model,
        reasoningEffort: profilePreviews.at(-1)?.codexTerminalProfile?.reasoningEffort,
        serviceTier: profilePreviews.at(-1)?.codexTerminalProfile?.serviceTier,
      },
      {
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
        serviceTier: 'priority',
      },
      'a confirmed Terminal profile should be published immediately instead of waiting for another PTY preview'
    );

    const profileUpdateOrder = [];
    let finishFirstProfile;
    manager.setCodexTerminalProfileNow = async (agentId, profile, options) => {
      profileUpdateOrder.push(`start:${profile.model}`);
      options.onInputSafe();
      if (profile.model === 'first') {
        await new Promise(resolve => {
          finishFirstProfile = resolve;
        });
      }
      profileUpdateOrder.push(`finish:${profile.model}`);
      return profile;
    };
    const firstProfile = manager.setCodexTerminalProfile('agent-profile', { model: 'first' });
    const secondProfile = manager.setCodexTerminalProfile('agent-profile', { model: 'second' });
    await sleep(0);
    assert.deepStrictEqual(profileUpdateOrder, [
      'start:first',
    ], 'a second profile transaction must not start while the first confirmation is pending');
    finishFirstProfile();
    await Promise.all([firstProfile, secondProfile]);
    assert.deepStrictEqual(profileUpdateOrder, [
      'start:first',
      'finish:first',
      'start:second',
      'finish:second',
    ], 'profile transactions should remain serialized even after ordinary input is released');

    manager.agents.set('agent-focus-protocol', {
      id: 'agent-focus-protocol',
      command: 'codex',
      cwd: '/tmp',
      engineName: 'local',
      status: 'running',
      agentRuntimeMode: 'terminal',
      terminalInputReceived: false,
    });
    const originalObserveProviderSession = manager.providerSessionService.observe.bind(manager.providerSessionService);
    const observedStateChanges = [];
    const agentUpdates = [];
    manager.on('agent-update', update => agentUpdates.push(update));
    manager.providerSessionService.observe = (agentId, options) => {
      observedStateChanges.push({ agentId, options });
    };
    await manager.sendInput('agent-focus-protocol', '\x1b[I');
    await manager.sendInput('agent-focus-protocol', '\x1b[O');
    await manager.sendInput('agent-focus-protocol', '\x1b[>0;276;0c');
    await manager.sendInput('agent-focus-protocol', '\x1b[A');
    await manager.sendInput('agent-focus-protocol', 'draft text');
    await manager.sendInput('agent-focus-protocol', '\x1b[200~line one\nline two\x1b[201~');
    assert.strictEqual(
      manager.agents.get('agent-focus-protocol').terminalInputReceived,
      false,
      'terminal protocol traffic, navigation, and unsubmitted draft text should keep a fresh Terminal switchable'
    );
    assert.deepStrictEqual(
      observedStateChanges,
      [],
      'terminal protocol traffic, navigation, and unsubmitted draft text should not trigger provider session observation'
    );
    await manager.sendInput('agent-focus-protocol', '\r');
    assert.strictEqual(
      manager.agents.get('agent-focus-protocol').terminalInputReceived,
      true,
      'submitting Terminal input should mark the session used until a resumable provider session is available'
    );
    assert.deepStrictEqual(
      observedStateChanges,
      [{ agentId: 'agent-focus-protocol', options: { force: true } }],
      'submitting Terminal input should trigger provider session observation once'
    );
    assert.deepStrictEqual(agentUpdates, [{
      agentId: 'agent-focus-protocol',
      patch: { terminalInputReceived: true },
    }], 'the first accepted input should publish only the changed Agent field');
    manager.providerSessionService.observe = originalObserveProviderSession;

    manager.agents.set('agent-ambiguous-input', {
      id: 'agent-ambiguous-input',
      command: 'codex',
      cwd: '/tmp',
      engineName: 'local',
      status: 'running',
      agentRuntimeMode: 'terminal',
      providerSessionProvider: 'codex',
      providerSessionId: 'tmp_uuid_ambiguous-input',
      providerSessionTemporary: true,
      terminalInputReceived: false,
    });
    manager.engineBridge.getEngine = () => ({
      async sendInput() {
        throw new Error('simulated lost PTY response after write');
      },
    });
    await manager.sendInput('agent-ambiguous-input', '\r');
    assert.strictEqual(
      manager.agents.get('agent-ambiguous-input').terminalInputReceived,
      true,
      'an uncertain input result must fail closed after the PTY may have accepted the submission',
    );

    manager.agents.set('agent-display-events', {
      id: 'agent-display-events',
      command: 'claude --resume claude-session',
      cwd: '/tmp',
      output: '',
      engineName: 'local',
      status: 'running',
      providerSessionProvider: 'claude',
      providerSessionId: 'claude-session',
      providerSessionTitle: '',
      runtimeEpoch: 'epoch-display',
      lastOutputSeq: 0,
      stateRevision: 0,
    });
    const displayEventStateChanges = [];
    const worktreeRefreshes = [];
    manager.providerSessionService.observe = (agentId, options) => {
      displayEventStateChanges.push({ agentId, options });
    };
    const originalRefreshAgentWorktree = manager.refreshAgentWorktree.bind(manager);
    manager.refreshAgentWorktree = async (agentId, workspace) => {
      worktreeRefreshes.push({ agentId, workspace });
      return false;
    };
    manager.engineBridge.emit('session-output', {
      sessionId: 'agent-display-events',
      data: 'streamed output',
      engineName: 'local',
      runtimeEpoch: 'epoch-display',
      outputSeq: 1,
      stateRevision: 1,
    });
    manager.engineBridge.emit('session-transition', {
      sessionId: 'agent-display-events',
      engineName: 'local',
      kind: 'resize',
      runtimeEpoch: 'epoch-display',
      outputSeq: 1,
      stateRevision: 2,
      cols: 100,
      rows: 30,
    });
    manager.engineBridge.emit('session-sync', {
      sessionId: 'agent-display-events',
      output: 'synced screen',
      engineName: 'local',
      runtimeEpoch: 'epoch-display',
      outputSeq: 2,
      stateRevision: 3,
    });
    manager.engineBridge.emit('session-preview', {
      sessionId: 'agent-display-events',
      previewText: 'preview text',
      cols: 100,
      rows: 30,
      title: 'display title',
      runtimeEpoch: 'epoch-display',
    });
    manager.engineBridge.emit('session-title', {
      sessionId: 'agent-display-events',
      title: 'new display title',
      runtimeEpoch: 'epoch-display',
    });
    manager.engineBridge.emit('session-activity', {
      sessionId: 'agent-display-events',
      lastActivityAt: Date.now(),
      runtimeEpoch: 'epoch-display',
    });
    manager.engineBridge.emit('session-busy-state', {
      sessionId: 'agent-display-events',
      terminalBusy: true,
      cwd: '/tmp/display-events',
      runtimeEpoch: 'epoch-display',
    });
    assert.deepStrictEqual(
      displayEventStateChanges,
      [],
      'terminal display, activity, and shell status events should not scan provider session history'
    );
    assert.deepStrictEqual(
      worktreeRefreshes,
      [{ agentId: 'agent-display-events', workspace: '/tmp/display-events' }],
      'cwd changes may refresh worktree metadata without triggering provider session scans'
    );
    assert.strictEqual(agentUpdates.at(-1).agentId, 'agent-display-events');
    assert.strictEqual(agentUpdates.at(-1).patch.terminalBusy, true);
    assert.strictEqual(agentUpdates.at(-1).patch.shellCwd, '/tmp/display-events');

    manager.engineBridge.emit('session-started', {
      sessionId: 'agent-display-events',
      status: 'running',
      startedAt: Date.now(),
      runtimeEpoch: 'epoch-display',
      outputSeq: 2,
      stateRevision: 4,
    });
    assert.deepStrictEqual(
      displayEventStateChanges,
      [{ agentId: 'agent-display-events', options: { force: true } }],
      'session identity tracking should still run for structural session start events'
    );
    manager.providerSessionService.observe = originalObserveProviderSession;
    manager.refreshAgentWorktree = originalRefreshAgentWorktree;

    const readDeltas = [];
    let fullStateUpdates = 0;
    manager.on('agent-read', update => readDeltas.push(update));
    manager.onUpdate(() => {
      fullStateUpdates += 1;
    });
    manager.agents.set('agent-read-delta', {
      id: 'agent-read-delta',
      command: 'bash',
      cwd: '/tmp',
      engineName: 'local',
      status: 'running',
      attentionSeq: 3,
      readAttentionSeq: 2,
      unread: true,
      runtimeEpoch: 'epoch-read',
      lastOutputSeq: 9,
      readOutputEpoch: 'epoch-read',
      readOutputSeq: 8,
    });
    const readResult = manager.updateAgentFlags('agent-read-delta', {
      unread: false,
      readOutputEpoch: 'epoch-read',
      readOutputSeq: 9,
    });
    assert.strictEqual(readResult.changed, true, 'advancing a read cursor should report a real state change');
    assert.strictEqual(readResult.requiresState, false, 'a read cursor does not require a full Agent-list replacement');
    assert.strictEqual(fullStateUpdates, 0, 'a read cursor should publish a narrow delta instead of a full state update');
    assert.deepStrictEqual(readDeltas, [{
      agentId: 'agent-read-delta',
      unread: false,
      attentionSeq: 3,
      readAttentionSeq: 3,
      readOutputEpoch: 'epoch-read',
      readOutputSeq: 9,
    }], 'a read cursor should publish the exact lightweight Agent delta');

    let unavailableCalls = 0;
    let updateCount = 0;
    manager.onUpdate(() => {
      updateCount += 1;
    });
    manager.engineBridge.getEngine = () => ({
      async sendInput() {
        unavailableCalls += 1;
        throw new Error('Session not available');
      },
    });
    manager.agents.set('agent-missing-session', {
      id: 'agent-missing-session',
      command: 'bash',
      cwd: '/tmp',
      output: 'still visible',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
    });

    const originalConsoleError = console.error;
    const consoleErrors = [];
    console.error = (...args) => {
      consoleErrors.push(args);
    };
    try {
      await manager.sendInput('agent-missing-session', 'echo lost\r');
    } finally {
      console.error = originalConsoleError;
    }

    const missingSessionAgent = manager.agents.get('agent-missing-session');
    assert.strictEqual(
      unavailableCalls,
      1,
      'ambiguous terminal input failure must not replay input before declaring the terminal dead'
    );
    assert.strictEqual(missingSessionAgent.status, 'dead');
    assert.strictEqual(missingSessionAgent.engineStatus, 'dead');
    assert.strictEqual(missingSessionAgent.terminalBusy, false);
    assert.match(missingSessionAgent.output, /Session not available/);
    assert.strictEqual(typeof missingSessionAgent.exitedAt, 'number');
    assert.strictEqual(updateCount, 1, 'marking a missing terminal session dead should notify the UI once');
    assert.strictEqual(consoleErrors.length, 1, 'the missing-session input failure should be logged once');

    console.log('test-agent-manager-input-queue passed');
  } finally {
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
