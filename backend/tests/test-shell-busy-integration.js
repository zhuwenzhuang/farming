const assert = require('assert');
const fs = require('fs');
const {
  MARKERS,
  applyShellBusyIntegration,
  cleanupShellBusyIntegration,
  parseShellBusyMarkers,
} = require('../shell-busy-integration');

function run() {
  const parsed = parseShellBusyMarkers(`a${MARKERS.busy}b${MARKERS.idle}c`, null);
  assert.strictEqual(parsed.data, 'abc');
  assert.strictEqual(parsed.markerSeen, true);
  assert.strictEqual(parsed.terminalBusy, false);
  assert.strictEqual(parsed.changed, true);

  const unchanged = parseShellBusyMarkers(MARKERS.idle, false);
  assert.strictEqual(unchanged.data, '');
  assert.strictEqual(unchanged.markerSeen, true);
  assert.strictEqual(unchanged.terminalBusy, false);
  assert.strictEqual(unchanged.changed, false);

  const partial = parseShellBusyMarkers('\x1b]133;Farming', null);
  assert.strictEqual(partial.data, '');
  assert.strictEqual(partial.pending, '\x1b]133;Farming');
  const resumed = parseShellBusyMarkers('ShellBusy=busy\x07visible', null, partial.pending);
  assert.strictEqual(resumed.data, 'visible');
  assert.strictEqual(resumed.terminalBusy, true);

  const statusParsed = parseShellBusyMarkers(
    'x\x1b]133;FarmingShellStatus=start\x07y\x1b]7;file://host/tmp/farming%20repo\x07z',
    null
  );
  assert.strictEqual(statusParsed.data, 'xyz');
  assert.strictEqual(statusParsed.markerSeen, true);
  assert.strictEqual(statusParsed.terminalBusy, true);
  assert.strictEqual(statusParsed.shellEvent, 'start');
  assert.strictEqual(statusParsed.cwd, '/tmp/farming repo');
  assert.strictEqual(statusParsed.statusMarkerSeen, true);
  assert.strictEqual(statusParsed.exitCodeSeen, true);
  assert.strictEqual(statusParsed.lastExitCode, null);

  const commandParsed = parseShellBusyMarkers(
    'x\x1b]133;FarmingShellStatus=start;cmd=git%20status%20--short%20%22%E4%B8%AD%E6%96%87%22\x07y',
    null
  );
  assert.strictEqual(commandParsed.data, 'xy');
  assert.strictEqual(commandParsed.terminalBusy, true);
  assert.strictEqual(commandParsed.shellEvent, 'start');
  assert.strictEqual(commandParsed.commandTextSeen, true);
  assert.strictEqual(commandParsed.shellCommand, 'git status --short "中文"');

  const finished = parseShellBusyMarkers(
    '\x1b]133;FarmingShellStatus=finish;exit=127\x07',
    true
  );
  assert.strictEqual(finished.data, '');
  assert.strictEqual(finished.terminalBusy, false);
  assert.strictEqual(finished.lastExitCode, 127);
  assert.strictEqual(finished.exitCodeSeen, true);

  const statusWinsOverLegacy = parseShellBusyMarkers(
    '\x1b]133;FarmingShellStatus=start\x07\x1b]133;FarmingShellBusy=idle\x07',
    null
  );
  assert.strictEqual(statusWinsOverLegacy.terminalBusy, true);
  assert.strictEqual(statusWinsOverLegacy.shellEvent, 'start');
  assert.strictEqual(statusWinsOverLegacy.statusMarkerSeen, true);
  assert.strictEqual(statusWinsOverLegacy.busyMarkerSeen, true);

  const partialStatus = parseShellBusyMarkers('\x1b]133;FarmingShellStatus=finish;ex', true);
  assert.strictEqual(partialStatus.data, '');
  assert.strictEqual(partialStatus.pending, '\x1b]133;FarmingShellStatus=finish;ex');
  const resumedStatus = parseShellBusyMarkers('it=0\x07visible', true, partialStatus.pending);
  assert.strictEqual(resumedStatus.data, 'visible');
  assert.strictEqual(resumedStatus.terminalBusy, false);
  assert.strictEqual(resumedStatus.lastExitCode, 0);

  const disabled = applyShellBusyIntegration({
    command: 'bash',
    args: [],
    category: 'other',
    env: { FARMING_SHELL_BUSY_INTEGRATION: '0' },
  });
  assert.strictEqual(disabled.shellBusyIntegration, undefined);

  const bashOptions = applyShellBusyIntegration({
    command: 'bash',
    args: ['--noprofile', '--norc', '-i'],
    category: 'other',
    env: {},
  });
  try {
    assert.deepStrictEqual(bashOptions.args.slice(0, 1), ['--rcfile']);
    assert.strictEqual(bashOptions.args[2], '-i');
    assert.strictEqual(bashOptions.env.FARMING_SHELL_INJECTION, '1');
    assert.strictEqual(bashOptions.env.FARMING_SHELL_LOGIN, undefined);
    assert.ok(fs.existsSync(bashOptions.args[1]));
    const bashRc = fs.readFileSync(bashOptions.args[1], 'utf8');
    assert.ok(bashRc.includes('Farming temporary shell busy integration'));
    assert.ok(bashRc.includes('FARMING_SHELL_INJECTION'));
    assert.ok(bashRc.includes('FARMING_SHELL_LOGIN'));
    assert.ok(bashRc.includes('. "$HOME/.bashrc"'));
    assert.ok(bashRc.includes('. "$HOME/.bash_profile"'));
    assert.ok(bashRc.includes('. "$HOME/.bash_login"'));
    assert.ok(bashRc.includes('. "$HOME/.profile"'));
    assert.ok(bashRc.includes('__farming_original_prompt_command=("${PROMPT_COMMAND[@]}")'));
    assert.ok(bashRc.includes('__farming_in_prompt'), 'bash integration should avoid marking its own prompt hook as busy');
    assert.ok(bashRc.includes('__farming_urlencode'));
    assert.ok(bashRc.includes('FarmingShellStatus=start;cmd=%s'));
    assert.ok(bashRc.includes('FarmingShellStatus=finish'));
    assert.ok(bashRc.includes('file://%s%s'));
  } finally {
    cleanupShellBusyIntegration(bashOptions.shellBusyIntegration);
  }

  const loginBashOptions = applyShellBusyIntegration({
    command: 'bash',
    args: ['--login'],
    category: 'other',
    env: {},
  });
  try {
    assert.deepStrictEqual(loginBashOptions.args.slice(0, 1), ['--rcfile']);
    assert.strictEqual(loginBashOptions.env.FARMING_SHELL_INJECTION, '1');
    assert.strictEqual(loginBashOptions.env.FARMING_SHELL_LOGIN, '1');
  } finally {
    cleanupShellBusyIntegration(loginBashOptions.shellBusyIntegration);
  }

  const zshOptions = applyShellBusyIntegration({
    command: 'zsh',
    args: ['-f', '-i'],
    category: 'other',
    env: {},
  });
  try {
    assert.deepStrictEqual(zshOptions.args, ['-i']);
    assert.ok(zshOptions.env.ZDOTDIR);
    assert.ok(zshOptions.env.USER_ZDOTDIR);
    assert.ok(fs.existsSync(`${zshOptions.env.ZDOTDIR}/.zshrc`));
    const zshRc = fs.readFileSync(`${zshOptions.env.ZDOTDIR}/.zshrc`, 'utf8');
    assert.ok(zshRc.includes('. "${USER_ZDOTDIR:-$HOME}/.zshrc"'));
    assert.ok(zshRc.includes('add-zsh-hook preexec __farming_shell_preexec'));
    assert.ok(zshRc.includes('add-zsh-hook precmd __farming_shell_precmd'));
    assert.ok(zshRc.includes('__farming_urlencode'));
    assert.ok(zshRc.includes('FarmingShellStatus=start;cmd=%s'));
    assert.ok(zshRc.includes('FarmingShellStatus=finish'));
  } finally {
    cleanupShellBusyIntegration(zshOptions.shellBusyIntegration);
  }

  console.log('✓ Shell busy integration stays isolated and strips private markers');
}

run();
