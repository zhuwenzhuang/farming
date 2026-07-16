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
        serviceTier: 'default',
      }),
      manager.sendInput('agent-profile', [{ type: 'paste', text: 'after profile' }, '\r']),
    ]);
    assert.deepStrictEqual(profileCalls.map(call => call.input), [
      [{ type: 'paste', text: '/model' }, '\r'],
      '8',
      '4',
      [{ type: 'paste', text: 'after profile' }, '\r'],
    ], 'later Terminal input should remain queued until Codex confirms the live model profile');
    assert.deepStrictEqual(
      profileInputReceivedStates,
      [false, false, false, true],
      'Farming-owned model menu input should keep a fresh Terminal eligible for ACP Chat while later user input marks it used'
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
        serviceTier: 'default',
      },
      'a confirmed Terminal profile should be published immediately instead of waiting for another PTY preview'
    );

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
      7,
      'session-not-available input should retry the configured short delays before declaring the terminal dead'
    );
    assert.strictEqual(missingSessionAgent.status, 'dead');
    assert.strictEqual(missingSessionAgent.engineStatus, 'dead');
    assert.strictEqual(missingSessionAgent.terminalBusy, false);
    assert.match(missingSessionAgent.output, /Session not available/);
    assert.strictEqual(typeof missingSessionAgent.exitedAt, 'number');
    assert.strictEqual(updateCount, 1, 'marking a missing terminal session dead should notify the UI once');
    assert.strictEqual(consoleErrors.length, 1, 'the exhausted missing-session input should still be logged once');

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
