const assert = require('assert');
const { AgentManager } = require('../agent-manager.cjs');
const { createTestAgentManager } = require('./helpers/test-acp-runtime.ts');

type ErrorWithCode = Error & { code?: string };

async function run() {
  let requestedScrollback: number | undefined;
  const manager = createTestAgentManager(AgentManager, {
    getWorkspace() {
      return process.cwd();
    },
    getHeartbeatInterval() {
      return 1000;
    }
  });

  try {
    manager.engineBridge.getEngine = () => ({
      async getSessionState(agentId, options) {
        requestedScrollback = options?.scrollback;
        if (agentId === 'terminal-codex') {
          return {
            output: 'terminal codex output',
            previewText: 'gpt-5.6-sol xhigh fast · /tmp/codex',
            startedAt: 124,
          };
        }
        if (agentId !== 'local-agent') return null;
        return {
          output: 'local output',
          renderOutput: 'local rendered tail',
          renderedScrollback: 200,
          scrollbackAvailable: 5000,
          previewText: 'local preview',
          startedAt: 123,
        };
      },
      getSessionSource() {
        return 'buffer';
      },
    });

    manager.agents.set('local-agent', {
      id: 'local-agent',
      command: 'claude',
      cwd: '/tmp/local',
      output: 'local output',
      previewText: 'local preview',
      engineName: 'local',
      status: 'running',
      startedAt: 123
    });
    manager.activityTracker.record('local-agent');

    const localView = await manager.getAgentSessionView('local-agent');
    assert.strictEqual(localView.agentId, 'local-agent');
    assert.strictEqual(localView.engineName, 'local');
    assert.strictEqual(localView.sessionSource, 'buffer');
    assert.strictEqual(localView.output, 'local output');
    assert.strictEqual(localView.previewText, 'local preview');
    assert.strictEqual(localView.startedAt, 123);

    const shallowLocalView = await manager.getAgentSessionView('local-agent', { scrollback: 200 });
    assert.strictEqual(requestedScrollback, 200);
    assert.strictEqual(shallowLocalView.output, 'local rendered tail');
    assert.strictEqual(shallowLocalView.renderOutput, 'local rendered tail');
    assert.strictEqual(shallowLocalView.renderedScrollback, 200);
    assert.strictEqual(shallowLocalView.scrollbackAvailable, 5000);

    manager.agents.set('terminal-codex', {
      id: 'terminal-codex',
      command: 'codex',
      cwd: '/tmp/codex',
      output: 'terminal codex output',
      previewText: 'gpt-5.6-sol xhigh fast · /tmp/codex',
      engineName: 'local',
      status: 'running',
      agentRuntimeMode: 'terminal',
      providerSessionProvider: 'codex',
      startedAt: 124,
    });
    manager.activityTracker.record('terminal-codex');

    const terminalCodexView = await manager.getAgentSessionView('terminal-codex');
    assert.deepStrictEqual(terminalCodexView.codexTerminalProfile, {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      serviceTier: 'priority',
      source: 'terminal-footer',
    });
    assert.deepStrictEqual(
      manager.getState().agents.find(agent => agent.id === 'terminal-codex').codexTerminalProfile,
      terminalCodexView.codexTerminalProfile,
      'initial state should expose the same live Terminal profile as the session view'
    );
    const focusedPreview = manager.getPreviewPayload('terminal-codex');
    const enumeratedPreview = manager.getPreviewPayloads().find(preview => preview.agentId === 'terminal-codex');
    assert.deepStrictEqual(enumeratedPreview, focusedPreview);
    assert.deepStrictEqual(focusedPreview?.codexTerminalProfile, terminalCodexView.codexTerminalProfile);
    assert.strictEqual(manager.getPreviewPayload('missing-agent'), null);
    manager.agents.set('no-preview', { id: 'no-preview' });
    assert.strictEqual(manager.getPreviewPayload('no-preview'), null);
    manager.agents.get('terminal-codex').previewText = 'Select Model and Effort\n  1. gpt-5.5\n  2. gpt-5.6-sol';
    assert.deepStrictEqual(
      manager.getState().agents.find(agent => agent.id === 'terminal-codex').codexTerminalProfile,
      terminalCodexView.codexTerminalProfile,
      'a transient Terminal menu should keep the last confirmed profile instead of flashing the launch default'
    );

    const missingView = await manager.getAgentSessionView('missing-agent');
    assert.strictEqual(missingView, null);

    let updateCount = 0;
    manager.onUpdate(() => {
      updateCount += 1;
    });
    manager.engineBridge.getEngine = () => ({
      async getSessionState() {
        throw new Error('Session not available');
      },
    });
    manager.agents.set('missing-session-view', {
      id: 'missing-session-view',
      command: 'bash',
      cwd: '/tmp/missing',
      output: 'last visible output',
      previewText: 'last preview',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
      startedAt: 456,
    });
    manager.activityTracker.record('missing-session-view');

    const originalConsoleError = console.error;
    const consoleErrors = [];
    console.error = (...args) => {
      consoleErrors.push(args);
    };
    let deadView;
    try {
      deadView = await manager.getAgentSessionView('missing-session-view');
    } finally {
      console.error = originalConsoleError;
    }

    const deadAgent = manager.agents.get('missing-session-view');
    assert.strictEqual(deadAgent.status, 'dead');
    assert.strictEqual(deadAgent.engineStatus, 'dead');
    assert.strictEqual(deadAgent.terminalBusy, false);
    assert.strictEqual(deadView.status, 'dead');
    assert.strictEqual(deadView.terminalBusy, false);
    assert.match(deadView.output, /Session not available/);
    assert.strictEqual(typeof deadView.exitedAt, 'number');
    assert.strictEqual(updateCount, 1, 'missing session view should notify the UI once');
    assert.strictEqual(consoleErrors.length, 1, 'missing session view should still be logged once');

    updateCount = 0;
    manager.engineBridge.getEngine = () => ({
      async getSessionState() {
        const error: ErrorWithCode = new Error(
          'Native PTY host is not reachable ENOENT. See /tmp/native-pty-host.log.',
        );
        error.code = 'ENOENT';
        throw error;
      },
    });
    manager.agents.set('native-host-missing-view', {
      id: 'native-host-missing-view',
      command: 'bash',
      cwd: '/tmp/native-missing',
      output: 'last native output',
      previewText: 'last native preview',
      engineName: 'native',
      status: 'running',
      terminalBusy: true,
      startedAt: 654,
    });
    manager.activityTracker.record('native-host-missing-view');

    console.error = (...args) => {
      consoleErrors.push(args);
    };
    let nativeHostMissingView;
    try {
      nativeHostMissingView = await manager.getAgentSessionView('native-host-missing-view');
    } finally {
      console.error = originalConsoleError;
    }
    const nativeHostMissingAgent = manager.agents.get('native-host-missing-view');
    assert.strictEqual(nativeHostMissingAgent.status, 'dead');
    assert.strictEqual(nativeHostMissingAgent.engineStatus, 'dead');
    assert.strictEqual(nativeHostMissingAgent.terminalBusy, false);
    assert.strictEqual(nativeHostMissingView.status, 'dead');
    assert.strictEqual(nativeHostMissingView.terminalBusy, false);
    assert.match(nativeHostMissingView.output, /Native PTY host is not reachable ENOENT/);
    assert.strictEqual(updateCount, 1, 'native host connection failure should notify the UI once');
    assert.strictEqual(consoleErrors.length, 2, 'native host connection failure should still be logged once');

    updateCount = 0;
    manager.engineBridge.getEngine = () => ({
      async getSessionState() {
        return null;
      },
    });
    manager.agents.set('null-session-view', {
      id: 'null-session-view',
      command: 'bash',
      cwd: '/tmp/null',
      output: 'last null output',
      previewText: 'last null preview',
      engineName: 'local',
      status: 'running',
      terminalBusy: true,
      startedAt: 789,
    });
    manager.activityTracker.record('null-session-view');

    const nullView = await manager.getAgentSessionView('null-session-view');
    const nullAgent = manager.agents.get('null-session-view');
    assert.strictEqual(nullAgent.status, 'dead');
    assert.strictEqual(nullAgent.engineStatus, 'dead');
    assert.strictEqual(nullAgent.terminalBusy, false);
    assert.strictEqual(nullView.status, 'dead');
    assert.strictEqual(nullView.terminalBusy, false);
    assert.match(nullView.output, /Session not available/);
    assert.strictEqual(typeof nullView.exitedAt, 'number');
    assert.strictEqual(updateCount, 1, 'null session view should notify the UI once');

    updateCount = 0;
    manager.agents.set('pending-session-view', {
      id: 'pending-session-view',
      command: 'bash',
      cwd: '/tmp/pending',
      output: 'starting output',
      engineName: 'local',
      status: 'pending',
      terminalBusy: null,
    });
    manager.activityTracker.record('pending-session-view');

    const pendingView = await manager.getAgentSessionView('pending-session-view');
    const pendingAgent = manager.agents.get('pending-session-view');
    assert.strictEqual(pendingAgent.status, 'pending');
    assert.strictEqual(pendingView.status, 'pending');
    assert.strictEqual(pendingView.output, 'starting output');
    assert.strictEqual(updateCount, 0, 'pending session view should not be marked dead on an early empty read');

    console.log('✓ AgentManager session view model works for local states');
  } finally {
    manager.heartbeatScheduler.stop();
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
