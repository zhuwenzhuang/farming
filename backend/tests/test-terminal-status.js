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

run();
