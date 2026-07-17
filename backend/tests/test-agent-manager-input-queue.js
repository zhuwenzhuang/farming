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
      [false, false, false, false, false],
      'Farming-owned model menu input should keep a fresh Terminal eligible for ACP Chat, and user input should be marked only after the PTY accepts it'
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
    await manager.sendInput('agent-focus-protocol', '\r');
    assert.strictEqual(
      manager.agents.get('agent-focus-protocol').terminalInputReceived,
      true,
      'submitting Terminal input should mark the session used until a resumable provider session is available'
    );

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
