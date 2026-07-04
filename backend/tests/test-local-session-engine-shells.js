const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeShellSessionOptions } = require('../local-session-engine');
const { cleanupShellBusyIntegration } = require('../shell-busy-integration');

function run() {
  const engineSource = fs.readFileSync(path.join(__dirname, '..', 'local-session-engine.js'), 'utf8');
  assert(
    engineSource.includes('loadPtyModule().spawn') &&
      !engineSource.includes("spawn('script'") &&
      !engineSource.includes('FARMING_FORCE_SCRIPT_PTY'),
    'local session engine should require native node-pty instead of adding a lower-quality PTY fallback'
  );

  const bashOptions = normalizeShellSessionOptions({
    command: 'bash',
    args: [],
    category: 'other',
    env: {}
  });

  assert.strictEqual(bashOptions.args[0], '--rcfile', 'bash shell agents should use a temporary integration rcfile');
  assert.strictEqual(bashOptions.args[2], '-i');
  assert.strictEqual(bashOptions.env.TERM, 'xterm-256color');
  assert.strictEqual(bashOptions.env.TERM_PROGRAM, 'farming');
  assert.strictEqual(bashOptions.env.COLORTERM, 'truecolor');
  assert.strictEqual(bashOptions.env.CLICOLOR, '1');
  assert.strictEqual(bashOptions.env.NO_COLOR, undefined);
  assert.ok(bashOptions.env.PS1.includes('\\[\\e[32m\\]\\u@\\h'));
  assert.ok(bashOptions.env.PS1.includes('\\[\\e[34m\\]\\w'));
  assert.ok(bashOptions.env.PS1.includes('\\[\\e[90m\\]['));
  assert.ok(bashOptions.env.PS1.includes('\\[\\e[90m\\]]'));
  assert.ok(!bashOptions.env.PS1.includes('\n'), 'bash prompt should stay compact instead of adding a terminal title row');
  assert.strictEqual(bashOptions.env.BASH_SILENCE_DEPRECATION_WARNING, '1');
  cleanupShellBusyIntegration(bashOptions.shellBusyIntegration);

  const absoluteBashOptions = normalizeShellSessionOptions({
    command: '/bin/bash',
    args: [],
    category: 'other',
    env: {}
  });
  assert.strictEqual(absoluteBashOptions.args[0], '--rcfile', 'absolute bash executable paths should keep the temporary integration rcfile');
  assert.strictEqual(absoluteBashOptions.args[2], '-i');
  assert.ok(absoluteBashOptions.env.PS1.includes('\\[\\e[90m\\]['));
  cleanupShellBusyIntegration(absoluteBashOptions.shellBusyIntegration);

  const anonymousBashOptions = normalizeShellSessionOptions({
    command: 'bash',
    args: [],
    category: 'other',
    env: {
      FARMING_ANONYMIZE_SHELL_PROMPT: '1'
    }
  });
  assert.ok(!anonymousBashOptions.env.PS1.includes('\\u@\\h'), 'anonymous bash prompt should hide user and host');
  assert.ok(!anonymousBashOptions.env.PS1.includes('\\w'), 'anonymous bash prompt should hide cwd');
  cleanupShellBusyIntegration(anonymousBashOptions.shellBusyIntegration);

  const zshOptions = normalizeShellSessionOptions({
    command: 'zsh',
    args: [],
    category: 'other',
    env: {}
  });

  assert.deepStrictEqual(zshOptions.args, ['-i'], 'zsh shell agents should use an isolated ZDOTDIR integration rcfile');
  assert.ok(zshOptions.env.ZDOTDIR, 'zsh shell agents should point at a temporary ZDOTDIR');
  assert.ok(zshOptions.env.PROMPT.includes('%F{2}%n@%m'));
  assert.ok(zshOptions.env.PROMPT.includes('%F{4}%~'));
  assert.ok(zshOptions.env.PROMPT.includes('%F{8}['));
  assert.ok(zshOptions.env.PROMPT.includes('%F{8}]'));
  assert.ok(!zshOptions.env.PROMPT.includes('\n'), 'zsh prompt should stay compact instead of adding a terminal title row');
  assert.strictEqual(zshOptions.env.PS1, zshOptions.env.PROMPT);
  cleanupShellBusyIntegration(zshOptions.shellBusyIntegration);

  const anonymousZshOptions = normalizeShellSessionOptions({
    command: 'zsh',
    args: [],
    category: 'other',
    env: {
      FARMING_ANONYMIZE_SHELL_PROMPT: '1'
    }
  });
  assert.ok(!anonymousZshOptions.env.PROMPT.includes('%n@%m'), 'anonymous zsh prompt should hide user and host');
  assert.ok(!anonymousZshOptions.env.PROMPT.includes('%~'), 'anonymous zsh prompt should hide cwd');
  cleanupShellBusyIntegration(anonymousZshOptions.shellBusyIntegration);

  const dumbTermOptions = normalizeShellSessionOptions({
    command: 'bash',
    args: [],
    category: 'other',
    env: {
      TERM: 'dumb',
      NO_COLOR: '1',
    }
  });
  assert.strictEqual(dumbTermOptions.env.TERM, 'xterm-256color', 'TERM=dumb should be upgraded for interactive agents');
  assert.strictEqual(dumbTermOptions.env.NO_COLOR, undefined, 'NO_COLOR should not leak into interactive agents');
  cleanupShellBusyIntegration(dumbTermOptions.shellBusyIntegration);

  const codingAgentOptions = normalizeShellSessionOptions({
    command: 'claude',
    args: ['--help'],
    category: 'coding',
    env: {
      SHELL: '/bin/zsh'
    }
  });

  assert.strictEqual(codingAgentOptions.command, 'claude', 'coding agents should run directly');
  assert.deepStrictEqual(
    codingAgentOptions.args,
    ['--help'],
    'coding agents should preserve explicit arguments'
  );

  console.log('✓ Local shell session normalization works');
}

run();
