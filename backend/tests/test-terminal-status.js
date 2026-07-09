const assert = require('assert');
const { deriveTerminalStatus } = require('../terminal-status');

function run() {
  assert.deepStrictEqual(
    deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      title: 'Claude Code',
      previewText: 'Thinking...\nPress Esc to interrupt',
      terminalBusy: null,
    }),
    {
      kind: 'claude',
      activity: 'busy',
      busy: true,
      cwd: '/repo',
      title: 'Claude Code',
      lastExitCode: null,
      source: 'terminal-text',
    },
    'terminal status should infer Claude busy state from terminal UI text'
  );

  assert.deepStrictEqual(
    deriveTerminalStatus({
      command: 'zsh',
      cwd: '/repo',
      title: '',
      previewText: '$ ',
      terminalBusy: false,
    }),
    {
      kind: 'shell',
      activity: 'idle',
      busy: false,
      cwd: '/repo',
      title: '',
      lastExitCode: null,
      source: 'shell-busy-marker',
    },
    'terminal status should prefer shell busy markers when available'
  );

  assert.deepStrictEqual(
    deriveTerminalStatus({
      command: 'zsh',
      cwd: '/repo/subdir',
      title: '',
      previewText: '$ ',
      terminalBusy: false,
      shellLastEvent: 'finish',
      shellLastExitCode: 2,
    }),
    {
      kind: 'shell',
      activity: 'idle',
      busy: false,
      cwd: '/repo/subdir',
      title: '',
      lastExitCode: 2,
      source: 'shell-status-marker',
    },
    'terminal status should expose shell status marker cwd and exit code'
  );

  assert.deepStrictEqual(
    deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      title: '',
      previewText: 'git status --short',
      terminalBusy: true,
      shellLastEvent: 'start',
      shellCommand: 'git status --short',
      shellLastCommand: 'npm test',
      shellCommandStartedAt: 1000,
      shellLastCommandDurationMs: 3400,
    }),
    {
      kind: 'shell',
      activity: 'busy',
      busy: true,
      cwd: '/repo',
      title: '',
      lastExitCode: null,
      source: 'shell-status-marker',
      runningCommand: 'git status --short',
      runningCommandStartedAt: 1000,
      lastCommand: 'npm test',
      lastCommandDurationMs: 3400,
    },
    'terminal status should expose structured shell command metadata when available'
  );

  assert.deepStrictEqual(
    deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      title: 'codex helper output',
      previewText: 'codex mentioned inside a shell command\n$ ',
      terminalBusy: false,
      shellLastEvent: 'finish',
      shellLastExitCode: 0,
    }),
    {
      kind: 'shell',
      activity: 'idle',
      busy: false,
      cwd: '/repo',
      title: 'codex helper output',
      lastExitCode: 0,
      source: 'shell-status-marker',
    },
    'shell status markers should beat incidental coding-agent words in the terminal text'
  );

  assert.deepStrictEqual(
    deriveTerminalStatus({
      command: 'bash',
      cwd: '/home/admin',
      title: '',
      previewText: '/home/admin $ ',
      terminalBusy: true,
      shellLastEvent: 'start',
    }),
    {
      kind: 'shell',
      activity: 'idle',
      busy: false,
      cwd: '/home/admin',
      title: '',
      lastExitCode: null,
      source: 'shell-prompt-fallback',
    },
    'shell prompt text should override a stale busy marker'
  );

  const qoderIdleStatus = deriveTerminalStatus({
    command: 'qodercli',
    cwd: '/repo',
    title: '◇  Ready (repo)',
    previewText: [
      '> 你好',
      'Thinking',
      '│ The user said hello.',
      '▪ 你好！有什么可以帮你的？',
      'Shift+Tab to Accept Edits',
      '>   Type your message or @path/to/file',
      'Auto Model · ctx 14% · ~/repo',
    ].join('\n'),
    terminalBusy: null,
  });
  assert.deepStrictEqual(
    { activity: qoderIdleStatus.activity, busy: qoderIdleStatus.busy },
    { activity: 'idle', busy: false },
    'Qoder input prompt should override stale Thinking text from a completed turn'
  );

  const qoderActiveStatus = deriveTerminalStatus({
    command: 'qodercli',
    cwd: '/repo',
    title: '◇  Ready (repo)',
    previewText: [
      '> Run the tests',
      '⣙ Reading files (1s · esc to cancel)',
      '>   Type your message or @path/to/file',
      'Auto Model · ctx 14% · ~/repo',
    ].join('\n'),
    terminalBusy: null,
  });
  assert.deepStrictEqual(
    { activity: qoderActiveStatus.activity, busy: qoderActiveStatus.busy },
    { activity: 'busy', busy: true },
    'Qoder live activity marker should stay busy even while the input prompt is visible'
  );

  const qoderApprovalStatus = deriveTerminalStatus({
    command: 'qodercli',
    cwd: '/repo',
    title: '◇  Ready (repo)',
    previewText: [
      'Thinking',
      'Permission Required',
      'Allow this command to run?',
      '❯ 1. Allow once',
      '  2. Always allow "sleep"',
      '  3. Reject and type something',
      '  4. No',
    ].join('\n'),
    terminalBusy: null,
  });
  assert.deepStrictEqual(
    { activity: qoderApprovalStatus.activity, busy: qoderApprovalStatus.busy },
    { activity: 'idle', busy: false },
    'Qoder permission prompts should wait for attention instead of inheriting stale Thinking activity'
  );

  const openCodeIdleStatus = deriveTerminalStatus({
    command: 'opencode',
    cwd: '/repo',
    title: 'OC | status audit',
    previewText: [
      'Claude and Codex both expose thinking and working states.',
      'The phrase esc to interrupt can appear in the completed answer.',
      '┃  Build · Big Pickle OpenCode Zen                       ~/repo:main',
      '18.2K (9%)  ctrl+p commands    • OpenCode 1.17.15',
    ].join('\n'),
    terminalBusy: null,
  });
  assert.deepStrictEqual(
    { kind: openCodeIdleStatus.kind, activity: openCodeIdleStatus.activity, busy: openCodeIdleStatus.busy },
    { kind: 'process', activity: 'idle', busy: false },
    'OpenCode completed output should not change provider kind or keep the turn busy'
  );

  const openCodeActiveStatus = deriveTerminalStatus({
    command: 'opencode',
    cwd: '/repo',
    title: 'OC | status audit',
    previewText: [
      '┃  Build · Big Pickle OpenCode Zen                       ~/repo:main',
      '■■■⭝⭝⭝⭝⭝  esc interrupt  18.2K (9%)  • OpenCode 1.17.15',
    ].join('\n'),
    terminalBusy: null,
  });
  assert.deepStrictEqual(
    { kind: openCodeActiveStatus.kind, activity: openCodeActiveStatus.activity, busy: openCodeActiveStatus.busy },
    { kind: 'process', activity: 'busy', busy: true },
    'OpenCode footer interrupt affordance should identify an active turn'
  );

  const qwenAuthStatus = deriveTerminalStatus({
    command: 'qwen',
    cwd: '/repo',
    title: 'Qwen - repo',
    previewText: '│ › Qwen OAuth\n│   API Key',
    terminalBusy: null,
  });
  assert.deepStrictEqual(
    { kind: qwenAuthStatus.kind, activity: qwenAuthStatus.activity, busy: qwenAuthStatus.busy },
    { kind: 'process', activity: 'idle', busy: false },
    'Qwen selectors should not be mistaken for a Codex prompt'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'qwen',
      cwd: '/repo',
      title: 'Qwen - repo',
      previewText: '⣙ Reading files (1s · esc to cancel)',
      terminalBusy: null,
    })),
    { kind: 'process', activity: 'busy', busy: true },
    'Qwen loading rows should identify an active turn without relying on Thinking text'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'codex',
      cwd: '/repo',
      previewText: [
        'Working (2s • esc to interrupt)',
        '› Explain this codebase',
        'gpt-5.5 xhigh · ~/repo',
      ].join('\n'),
      terminalBusy: null,
    })),
    { kind: 'codex', activity: 'idle', busy: false },
    'A newer Codex idle footer should override stale Working text'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      previewText: [
        'Working (2s • esc to interrupt)',
        '› Explain this codebase',
        'gpt-5.5 xhigh · ~/repo',
      ].join('\n'),
      terminalBusy: true,
      shellLastEvent: 'start',
    })),
    { kind: 'codex', activity: 'idle', busy: false },
    'Shell markers should not keep an idle nested Codex turn busy'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'aider',
      cwd: '/repo',
      previewText: 'The worker is thinking about the working tree.',
      terminalBusy: null,
    })),
    { kind: 'process', activity: 'unknown', busy: false },
    'Unknown process agents should not become busy from ordinary prose'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      previewText: 'gpt-5.5 xhigh · ~/repo\n$ npm test\nrunning tests',
      terminalBusy: true,
      shellLastEvent: 'start',
      shellCommand: 'npm test',
    })),
    { kind: 'shell', activity: 'busy', busy: true },
    'A current ordinary shell command should override stale Codex footer evidence'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      previewText: [
        'gpt-5.5 xhigh · ~/repo',
        'Thinking...',
        'Press Esc to interrupt',
      ].join('\n'),
      terminalBusy: true,
      shellLastEvent: 'start',
      shellCommand: 'claude',
    })),
    { kind: 'claude', activity: 'busy', busy: true },
    'A newer nested Claude turn should override stale Codex evidence in the same shell'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'codex',
      cwd: '/repo',
      previewText: [
        'Goal blocked: input exceeds the context window',
        'Working (1s • esc to interrupt)',
      ].join('\n'),
      terminalBusy: null,
    })),
    { kind: 'codex', activity: 'busy', busy: true },
    'A new Codex Working state should override an older blocked message'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'opencode',
      cwd: '/repo',
      title: 'OC | answer',
      previewText: [
        'In OpenCode, use esc to interrupt a running turn.',
        '┃ Build · Big Pickle OpenCode Zen  ~/repo:main',
        '20K (10%)  • OpenCode 1.17.15',
      ].join('\n'),
      terminalBusy: null,
    })),
    { kind: 'process', activity: 'idle', busy: false },
    'OpenCode prose that mentions its shortcut should not look like the running footer'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'opencode',
      cwd: '/repo',
      title: 'OC | active',
      previewText: [
        '■■■⭝⭝⭝⭝⭝  esc interrupt',
        '20K (10%)  • OpenCode 1.17.15',
      ].join('\n'),
      terminalBusy: null,
    })),
    { kind: 'process', activity: 'busy', busy: true },
    'A wrapped OpenCode running footer should stay busy'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'claude',
      cwd: '/repo',
      previewText: '• Press Esc to interrupt is the shortcut described above.\n❯',
      terminalBusy: null,
    })),
    { kind: 'claude', activity: 'idle', busy: false },
    'Claude completed prose should not be confused with its live interrupt affordance'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'node worker.js',
      cwd: '/repo',
      previewText: '• Press Esc to interrupt is documented here.',
      terminalBusy: null,
    })),
    { kind: 'process', activity: 'unknown', busy: false },
    'Unknown processes should not become Claude from a markdown shortcut bullet'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'qodercli',
      cwd: '/repo',
      title: '✦ Working… (repo)',
      previewText: '> Type your message or @path/to/file',
      terminalBusy: null,
    })),
    { kind: 'process', activity: 'busy', busy: true },
    'Qoder busy runtime titles should supplement a missing loading row'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'qodercli',
      cwd: '/repo',
      title: '✋ Action Required (repo)',
      previewText: '⣙ stale spinner\nesc to cancel, 1s\nAllow this command to run?',
      terminalBusy: null,
    })),
    { kind: 'process', activity: 'idle', busy: false },
    'Qoder action-required titles should stop computing activity even with stale loading text'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'qwen',
      cwd: '/repo',
      title: 'Qwen - repo',
      previewText: '⣙ Reading files\n(1s · 按 esc 取消)',
      terminalBusy: null,
    })),
    { kind: 'process', activity: 'busy', busy: true },
    'Qwen localized loading controls should work when narrow layouts wrap onto the next line'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      previewText: 'waiting for batch #',
      terminalBusy: true,
      shellLastEvent: 'start',
      shellCommand: 'batch-worker',
    })),
    { kind: 'shell', activity: 'busy', busy: true },
    'Ordinary output ending in # should not look like a shell prompt'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      title: '◇ Ready (repo)',
      previewText: 'Thinking\n> Type your message or @path/to/file',
      terminalBusy: true,
      shellLastEvent: 'start',
      shellCommand: 'qodercli',
    })),
    { kind: 'process', activity: 'idle', busy: false },
    'A nested idle Qoder prompt should override the outer shell busy marker'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      previewText: 'older output\nWorking (2s • esc to interrupt)',
      terminalBusy: null,
    })),
    { kind: 'codex', activity: 'busy', busy: true },
    'A Codex Working row should not become Claude because line offsets differ'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'claude',
      cwd: '/repo',
      previewText: 'Press Esc to interrupt - shortcut described above.',
      terminalBusy: null,
    })),
    { kind: 'claude', activity: 'idle', busy: false },
    'Claude shortcut prose should not match the standalone live control'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'claude',
      cwd: '/repo',
      previewText: '* Thinking about docs (press Esc to interrupt is the shortcut)',
      terminalBusy: null,
    })),
    { kind: 'claude', activity: 'idle', busy: false },
    'Markdown bullets should not look like Claude spinner rows'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'claude',
      cwd: '/repo',
      previewText: '✻ Sautéing… (2s · esc to interrupt)',
      terminalBusy: null,
    })),
    { kind: 'claude', activity: 'busy', busy: true },
    'Claude spinner rows with elapsed time should remain active'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      previewText: '$\nrunning\nstill running',
      terminalBusy: true,
      shellLastEvent: 'start',
    })),
    { kind: 'shell', activity: 'busy', busy: true },
    'An older shell prompt should not override newer command output'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      previewText: 'batch#',
      terminalBusy: true,
      shellLastEvent: 'start',
    })),
    { kind: 'shell', activity: 'busy', busy: true },
    'An output token ending in # should not count as a shell prompt'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'opencode',
      cwd: '/repo',
      previewText: [
        '■■■⭝⭝⭝  esc interrupt  • OpenCode 1.17.15',
        'The answer is now complete.',
        '20K (10%)  • OpenCode 1.17.15',
      ].join('\n'),
      terminalBusy: null,
    })),
    { kind: 'process', activity: 'idle', busy: false },
    'The latest OpenCode footer should override an older active footer'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'aider',
      cwd: '/repo',
      previewText: 'Press Esc to interrupt',
      terminalBusy: null,
    })),
    { kind: 'process', activity: 'unknown', busy: false },
    'Generic coding agents should stay unknown without their own live signal'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      title: '✦ Indexing repository',
      previewText: '> Type your message or @path/to/file',
      terminalBusy: true,
    })),
    { kind: 'process', activity: 'busy', busy: true },
    'Recovered nested Qoder sessions should use their strong runtime title without shellCommand metadata'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      title: 'OC | active',
      previewText: '■■■⭝⭝⭝  esc interrupt\n20K (10%)  • OpenCode 1.17.15',
      terminalBusy: true,
    })),
    { kind: 'process', activity: 'busy', busy: true },
    'Recovered nested OpenCode sessions should use their strong runtime title without shellCommand metadata'
  );

  assert.deepStrictEqual(
    pickStatus(deriveTerminalStatus({
      command: 'bash',
      cwd: '/repo',
      title: 'Qwen - repo',
      previewText: '⣙ Reading files\n(1s · 按 esc 取消)',
      terminalBusy: true,
    })),
    { kind: 'process', activity: 'busy', busy: true },
    'Recovered nested Qwen sessions should use their strong runtime title without shellCommand metadata'
  );

  assert.strictEqual(
    deriveTerminalStatus({
      command: 'python3 server.py',
      status: 'exited',
      previewText: 'server stopped',
    }).activity,
    'exited',
    'exited terminal status should be explicit'
  );

  console.log('✓ Terminal status derives structured activity from terminal signals');
}

function pickStatus(status) {
  return {
    kind: status.kind,
    activity: status.activity,
    busy: status.busy,
  };
}

run();
