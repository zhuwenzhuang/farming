const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

const {
  inferAgentTerminalState,
  isAgentTurnActive,
  isCodexAgentWorking,
} = importTsModule('src/components/code/agent-working-state.ts');

function codexAgent(overrides = {}) {
  return {
    id: 'agent-codex',
    command: 'codex',
    cwd: '/tmp/farming',
    output: '',
    previewText: '',
    status: 'running',
    isMain: false,
    activityLevel: 'warm',
    lastActivity: Date.now(),
    attentionScore: 0,
    isZombie: false,
    ...overrides,
  };
}

function claudeAgent(overrides = {}) {
  return {
    ...codexAgent({
      id: 'agent-claude',
      command: 'claude',
    }),
    ...overrides,
  };
}

function run() {
  assert.strictEqual(
    isCodexAgentWorking(codexAgent({
      previewText: '• Done\n\n› Improve documentation\n\ngpt-5.5 xhigh fast · ~/git/farming',
      output: 'Working (2m 04s • esc to interrupt)\nold buffered status',
    })),
    false,
    'Codex should not stay active because old buffered output contains Working'
  );

  assert.strictEqual(
    isCodexAgentWorking(codexAgent({
      previewText: 'Working (58s • esc to interrupt)\nRunning git push origin feature',
    })),
    true,
    'Codex should be active while the current terminal viewport shows an interruptible turn'
  );

  assert.strictEqual(
    isCodexAgentWorking(codexAgent({
      previewText: [
        '› 你好',
        '',
        '• Working (2s • esc to interrupt)',
        '',
        '› Explain this codebase',
        'gpt-5.5 xhigh · /home/farming-user/example-project',
      ].join('\n'),
    })),
    false,
    'Codex should be idle when a later prompt footer follows an old Working line in the current viewport'
  );

  assert.strictEqual(
    isCodexAgentWorking(codexAgent({
      previewText: [
        '› 你好',
        '',
        '• Working (2s • esc to interrupt)',
        '',
        '› Explain this codebase',
        'gpt-5.5 xhigh · /home/farming-user/example-project',
      ].join('\n'),
      sessionTitle: '\u283c farming',
    })),
    true,
    'Codex should stay interruptible when the terminal title still shows a spinner'
  );

  assert.strictEqual(
    isCodexAgentWorking(codexAgent({
      previewText: [
        '› 我是说一些样例代码',
        '',
        '• Working (14s • esc to interrupt)',
        '',
        '› Write tests for @filename',
        'gpt-5.5 high · /srv/example/projects/matrix',
      ].join('\n'),
    })),
    false,
    'Recovered Codex sessions should not treat stale Working text above an idle footer as active'
  );

  assert.strictEqual(
    isCodexAgentWorking(codexAgent({
      previewText: '',
      output: 'Working (12s • esc to interrupt)\n\nComplete\n\ngpt-5.5 xhigh fast · ~/git/farming',
    })),
    false,
    'Codex fallback output tail should treat a later idle footer as not active'
  );

  assert.strictEqual(
    isCodexAgentWorking(codexAgent({
      previewText: [
        '⚠ Falling back from WebSockets to HTTPS transport. stream disconnected before completion: IO error: Connection reset by peer',
        '',
        '■ stream disconnected before completion: Your input exceeds the context window of this model. Please adjust your input and try again.',
        '',
        '› Run /review on my current changes',
        'gpt-5.5 high · /srv/example/projects/matrix        Goal blocked (/goal resume)',
      ].join('\n'),
    })),
    false,
    'Codex should not show an active turn spinner after a context-window failure blocks the goal'
  );

  assert.strictEqual(
    isCodexAgentWorking(codexAgent({
      previewText: '⚠ Falling back from WebSockets to HTTPS transport. stream disconnected before completion: IO error: Connection reset by peer',
    })),
    true,
    'Codex can still be treated as active during a transient transport fallback before a terminal blocked state appears'
  );

  assert.strictEqual(
    isAgentTurnActive(codexAgent({ status: 'stopped', previewText: 'Working (1s • esc to interrupt)' })),
    false,
    'Stopped Codex agents should never show an active turn spinner'
  );

  assert.strictEqual(
    isAgentTurnActive(codexAgent({ command: 'bash', previewText: 'Working (1s • esc to interrupt)' })),
    true,
    'Bash-launched Codex TUIs should be inferred from terminal output instead of launch command'
  );

  assert.deepStrictEqual(
    pickTerminalState(codexAgent({
      terminalStatus: {
        kind: 'claude',
        activity: 'busy',
        busy: true,
        cwd: '/tmp/farming',
        title: 'Claude Code',
        source: 'terminal-text',
      },
      command: 'bash',
      previewText: '$ ',
    })),
    {
      kind: 'claude',
      kindSource: 'terminal-status',
      turnActive: true,
      terminalBusy: true,
    },
    'Structured terminal status should take precedence over launch command and stale viewport text'
  );

  assert.deepStrictEqual(
    pickTerminalState(codexAgent({
      terminalStatus: {
        kind: 'shell',
        activity: 'idle',
        busy: false,
        cwd: '/tmp/farming',
        title: '',
        source: 'shell-status-marker',
      },
      command: 'zsh',
      terminalBusy: true,
      previewText: '$ ',
    })),
    {
      kind: 'shell',
      kindSource: 'terminal-status',
      turnActive: false,
      terminalBusy: false,
    },
    'Structured idle terminal status should override stale legacy terminalBusy=true'
  );

  assert.deepStrictEqual(
    pickTerminalState(codexAgent({
      command: 'bash',
      previewText: '› Explain this codebase\ngpt-5.5 xhigh fast · ~/git/farming',
    })),
    {
      kind: 'codex',
      kindSource: 'terminal-output',
      turnActive: false,
      terminalBusy: false,
    },
    'Codex idle footer should make a bash-launched terminal behave like a Codex agent'
  );

  assert.deepStrictEqual(
    pickTerminalState(codexAgent({
      command: 'codex',
      previewText: '$ ',
    })),
    {
      kind: 'shell',
      kindSource: 'terminal-output',
      turnActive: false,
      terminalBusy: false,
    },
    'A shell prompt in the current viewport should override a stale Codex launch command'
  );

  assert.deepStrictEqual(
    pickTerminalState(codexAgent({
      command: 'bash',
      previewText: 'Thinking...\nPress Esc to interrupt',
    })),
    {
      kind: 'claude',
      kindSource: 'terminal-output',
      turnActive: true,
      terminalBusy: false,
    },
    'Claude activity should be inferred from the current terminal output even when launched from bash'
  );

  assert.deepStrictEqual(
    pickTerminalState(codexAgent({
      command: 'zsh',
      terminalBusy: true,
      previewText: '$ npm test',
    })),
    {
      kind: 'shell',
      kindSource: 'terminal-busy',
      turnActive: true,
      terminalBusy: true,
    },
    'Shell busy markers should identify a running user command when no coding-agent TUI is visible'
  );

  assert.strictEqual(
    isAgentTurnActive(claudeAgent({
      previewText: 'Done\n$ ',
      output: 'old line: press esc to interrupt',
    })),
    false,
    'Claude should not stay active because old buffered output contains interrupt text'
  );

  assert.strictEqual(
    isAgentTurnActive(claudeAgent({ previewText: 'Thinking...\npress esc to interrupt' })),
    true,
    'Claude should be active while the current viewport shows interrupt text'
  );

  console.log('✓ Codex agent working state is scoped to the current terminal view');
}

function pickTerminalState(agent) {
  const state = inferAgentTerminalState(agent);
  return {
    kind: state.kind,
    kindSource: state.kindSource,
    turnActive: state.turnActive,
    terminalBusy: state.terminalBusy,
  };
}

run();
