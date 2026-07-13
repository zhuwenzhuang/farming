const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const NativeSessionEngine = require('../native-session-engine');
const NativePtyHost = require('../native-pty-host');
const { nativePtyHostSocketPath } = require('../native-pty-host-path');

const SHELL_PROFILE_PROBE_TIMEOUT_MS = 10_000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(read, label, timeoutMs = SHELL_PROFILE_PROBE_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runShellProfileProbe(engine, sessionId, command, args, home, probe, expectedOutput) {
  await engine.createSession({
    agentId: sessionId,
    command,
    args,
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH, TERM: 'xterm-256color' },
    category: 'other',
    cols: 100,
    rows: 30,
  });
  await engine.sendInput(sessionId, `${probe}\n`);
  return waitFor(async () => {
    const state = await engine.getSessionState(sessionId);
    return state && state.output.includes(expectedOutput) ? state : null;
  }, `${command} profile probe`);
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-shell-profile-config-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-shell-profile-home-'));
  const socketPath = nativePtyHostSocketPath(configDir);
  fs.writeFileSync(path.join(home, '.bash_profile'), [
    'export FARMING_TEST_BASH_PROFILE=loaded',
    "PS1='bash-profile> '",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(home, '.bashrc'), 'export FARMING_TEST_BASH_RC=loaded\n');
  fs.writeFileSync(path.join(home, '.zshenv'), 'export FARMING_TEST_ZSHENV=loaded\n');
  fs.writeFileSync(path.join(home, '.zprofile'), 'export FARMING_TEST_ZPROFILE=loaded\n');
  fs.writeFileSync(path.join(home, '.zshrc'), [
    'export FARMING_TEST_ZSHRC=loaded',
    "PROMPT='zsh-rc> '",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(home, '.zlogin'), 'export FARMING_TEST_ZLOGIN=loaded\n');

  const host = new NativePtyHost({ configDir, socketPath });
  await host.start();
  const engine = new NativeSessionEngine({ configDir, socketPath });
  try {
    const bashState = await runShellProfileProbe(
      engine,
      'native-shell-bash-profile',
      'bash',
      ['-l'],
      home,
      "printf 'FARMING_PROFILE_PROBE bash=%s rc=%s prompt=%s\\n' \"${FARMING_TEST_BASH_PROFILE-unset}\" \"${FARMING_TEST_BASH_RC-unset}\" \"$PS1\"",
      'FARMING_PROFILE_PROBE bash=loaded'
    );
    assert.match(bashState.output, /FARMING_PROFILE_PROBE bash=loaded rc=unset prompt=bash-profile>/);

    const zshState = await runShellProfileProbe(
      engine,
      'native-shell-zsh-profile',
      'zsh',
      ['-l'],
      home,
      "printf 'FARMING_PROFILE_PROBE zshenv=%s zprofile=%s zshrc=%s zlogin=%s prompt=%s\\n' \"${FARMING_TEST_ZSHENV-unset}\" \"${FARMING_TEST_ZPROFILE-unset}\" \"${FARMING_TEST_ZSHRC-unset}\" \"${FARMING_TEST_ZLOGIN-unset}\" \"$PROMPT\"",
      'FARMING_PROFILE_PROBE zshenv=loaded'
    );
    assert.match(zshState.output, /FARMING_PROFILE_PROBE zshenv=loaded zprofile=loaded zshrc=loaded zlogin=loaded prompt=zsh-rc>/);

    console.log('✓ Native shell sessions load VS Code-style user startup profiles');
  } finally {
    await engine.killSession('native-shell-bash-profile').catch(() => {});
    await engine.killSession('native-shell-zsh-profile').catch(() => {});
    engine.dispose();
    await host.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
