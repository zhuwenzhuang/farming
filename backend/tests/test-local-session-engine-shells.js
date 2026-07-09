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
  assert.strictEqual(bashOptions.env.PS1, undefined, 'bash shell agents should preserve the user prompt by default');
  assert.strictEqual(bashOptions.env.FARMING_SHELL_INJECTION, '1');
  assert.strictEqual(bashOptions.env.FARMING_SHELL_LOGIN, undefined);
  const bashRc = fs.readFileSync(bashOptions.args[1], 'utf8');
  assert.ok(bashRc.includes('. "$HOME/.bashrc"'), 'bash shell agents should load the user bashrc before installing markers');
  assert.ok(bashRc.includes('FARMING_SHELL_LOGIN'), 'bash shell integration should support login-shell profile loading only when requested');
  assert.ok(bashRc.includes('PROMPT_COMMAND=__farming_shell_prompt'));
  assert.ok(bashRc.includes('__farming_original_prompt_command=("${PROMPT_COMMAND[@]}")'));
  assert.strictEqual(bashOptions.env.BASH_SILENCE_DEPRECATION_WARNING, '1');
  cleanupShellBusyIntegration(bashOptions.shellBusyIntegration);

  const controlledBashOptions = normalizeShellSessionOptions({
    command: 'bash',
    args: [],
    category: 'other',
    env: {
      FARMING_SHELL_CONTROLLED_PROMPT: '1',
      PS1: 'inherited prompt',
      PROMPT_COMMAND: 'echo inherited hook',
    }
  });
  assert.ok(controlledBashOptions.env.PS1.includes('│'), 'explicit controlled bash sessions should use the compact prompt');
  assert.strictEqual(controlledBashOptions.env.PROMPT_COMMAND, undefined, 'controlled bash sessions should not retain an inherited prompt hook');
  const controlledBashRc = fs.readFileSync(controlledBashOptions.args[1], 'utf8');
  assert.ok(!controlledBashRc.includes('. "$HOME/.bashrc"'), 'controlled bash sessions should skip user startup files');
  cleanupShellBusyIntegration(controlledBashOptions.shellBusyIntegration);

  const absoluteBashOptions = normalizeShellSessionOptions({
    command: '/bin/bash',
    args: [],
    category: 'other',
    env: {}
  });
  assert.strictEqual(absoluteBashOptions.args[0], '--rcfile', 'absolute bash executable paths should keep the temporary integration rcfile');
  assert.strictEqual(absoluteBashOptions.args[2], '-i');
  assert.strictEqual(absoluteBashOptions.env.PS1, undefined);
  cleanupShellBusyIntegration(absoluteBashOptions.shellBusyIntegration);

  const loginBashOptions = normalizeShellSessionOptions({
    command: 'bash',
    args: ['-l'],
    category: 'other',
    env: {}
  });
  assert.strictEqual(loginBashOptions.args[0], '--rcfile', 'login bash shell agents should still use the integration rcfile');
  assert.strictEqual(loginBashOptions.env.FARMING_SHELL_INJECTION, '1');
  assert.strictEqual(loginBashOptions.env.FARMING_SHELL_LOGIN, '1');
  const loginBashRc = fs.readFileSync(loginBashOptions.args[1], 'utf8');
  assert.ok(loginBashRc.includes('. "$HOME/.bash_profile"'), 'explicit login bash should load the user login profile');
  cleanupShellBusyIntegration(loginBashOptions.shellBusyIntegration);

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
  const anonymousBashRc = fs.readFileSync(anonymousBashOptions.args[1], 'utf8');
  assert.ok(!anonymousBashRc.includes('. "$HOME/.bashrc"'), 'anonymous bash prompt should not source private shell startup files');
  cleanupShellBusyIntegration(anonymousBashOptions.shellBusyIntegration);

  const zshOptions = normalizeShellSessionOptions({
    command: 'zsh',
    args: [],
    category: 'other',
    env: {}
  });

  assert.deepStrictEqual(zshOptions.args, ['-i'], 'zsh shell agents should use an isolated ZDOTDIR integration rcfile');
  assert.ok(zshOptions.env.ZDOTDIR, 'zsh shell agents should point at a temporary ZDOTDIR');
  assert.strictEqual(zshOptions.env.PROMPT, undefined, 'zsh shell agents should preserve the user prompt by default');
  assert.strictEqual(zshOptions.env.PS1, undefined);
  const zshRc = fs.readFileSync(`${zshOptions.env.ZDOTDIR}/.zshrc`, 'utf8');
  const zshEnv = fs.readFileSync(`${zshOptions.env.ZDOTDIR}/.zshenv`, 'utf8');
  const zshProfile = fs.readFileSync(`${zshOptions.env.ZDOTDIR}/.zprofile`, 'utf8');
  const zshLogin = fs.readFileSync(`${zshOptions.env.ZDOTDIR}/.zlogin`, 'utf8');
  assert.ok(zshRc.includes('. "${USER_ZDOTDIR:-$HOME}/.zshrc"'), 'zsh shell agents should load the user zshrc before installing markers');
  assert.ok(zshEnv.includes('.zshenv'), 'zsh shell agents should bridge the user zshenv like VS Code');
  assert.ok(zshProfile.includes('.zprofile'), 'zsh shell agents should bridge the user zprofile like VS Code');
  assert.ok(zshLogin.includes('.zlogin'), 'zsh shell agents should bridge the user zlogin like VS Code');
  assert.ok(!zshEnv.includes('no_global_rcs'), 'zsh shell agents should not disable global startup files');
  assert.ok(zshRc.includes('add-zsh-hook preexec __farming_shell_preexec'));
  assert.ok(zshRc.includes('add-zsh-hook precmd __farming_shell_precmd'));
  cleanupShellBusyIntegration(zshOptions.shellBusyIntegration);

  const controlledZshOptions = normalizeShellSessionOptions({
    command: 'zsh',
    args: [],
    category: 'other',
    env: {
      FARMING_SHELL_CONTROLLED_PROMPT: '1',
      PROMPT: 'inherited prompt',
      RPROMPT: 'inherited right prompt',
    }
  });
  assert.ok(controlledZshOptions.env.PROMPT.includes('│'), 'explicit controlled zsh sessions should use the compact prompt');
  assert.strictEqual(controlledZshOptions.env.RPROMPT, undefined, 'controlled zsh sessions should not retain an inherited right prompt');
  const controlledZshRc = fs.readFileSync(`${controlledZshOptions.env.ZDOTDIR}/.zshrc`, 'utf8');
  assert.ok(!controlledZshRc.includes('. "${USER_ZDOTDIR:-$HOME}/.zshrc"'), 'controlled zsh sessions should skip user startup files');
  cleanupShellBusyIntegration(controlledZshOptions.shellBusyIntegration);

  const loginZshOptions = normalizeShellSessionOptions({
    command: 'zsh',
    args: ['-l'],
    category: 'other',
    env: {},
  });
  assert.deepStrictEqual(loginZshOptions.args, ['-il'], 'login zsh should preserve login startup while installing integration');
  cleanupShellBusyIntegration(loginZshOptions.shellBusyIntegration);

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
