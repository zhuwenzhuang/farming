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

  const finished = parseShellBusyMarkers(
    '\x1b]133;FarmingShellStatus=finish;exit=127\x07',
    true
  );
  assert.strictEqual(finished.data, '');
  assert.strictEqual(finished.terminalBusy, false);
  assert.strictEqual(finished.lastExitCode, 127);

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
    assert.ok(fs.existsSync(bashOptions.args[1]));
    const bashRc = fs.readFileSync(bashOptions.args[1], 'utf8');
    assert.ok(bashRc.includes('Farming temporary shell busy integration'));
    assert.ok(bashRc.includes('FarmingShellStatus=finish'));
    assert.ok(bashRc.includes('file://%s%s'));
  } finally {
    cleanupShellBusyIntegration(bashOptions.shellBusyIntegration);
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
    assert.ok(fs.existsSync(`${zshOptions.env.ZDOTDIR}/.zshrc`));
    const zshRc = fs.readFileSync(`${zshOptions.env.ZDOTDIR}/.zshrc`, 'utf8');
    assert.ok(zshRc.includes('preexec()'));
    assert.ok(zshRc.includes('precmd()'));
    assert.ok(zshRc.includes('FarmingShellStatus=finish'));
  } finally {
    cleanupShellBusyIntegration(zshOptions.shellBusyIntegration);
  }

  console.log('✓ Shell busy integration stays isolated and strips private markers');
}

run();
