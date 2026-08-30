const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { hardStopConfigProcesses } = require('../config-process-ownership.cjs');
const { NativePtyHost } = require('../native-pty-host.cjs');
const { readServerProcessIdentity } = require('../server-process-identity.cjs');

async function waitFor(predicate, message, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function run() {
  if (process.platform === 'win32') {
    console.log('native PTY process ownership test skipped on Windows');
    return;
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-pty-descendant.'));
    const pidFile = path.join(configDir, 'descendant.pid');
    const host = new NativePtyHost({ configDir, exitOnShutdown: false });
    let processGroupId = 0;
    try {
      await host.createSession({
        agentId: 'descendant-terminal',
        command: '/bin/sh',
        args: [
          '-c',
          'trap "" TERM; (trap "" HUP TERM; while :; do sleep 60; done) & child=$!; printf "%s" "$child" > "$1"; wait "$child"',
          '--',
          pidFile,
        ],
        cwd: process.cwd(),
        env: process.env,
        cols: 80,
        rows: 24,
        shellIntegrationPrepared: true,
      });
      const session = host.sessions.get('descendant-terminal');
      assert(session?.processIdentity, 'Terminal must publish its exact process-group identity');
      processGroupId = session.processIdentity.processGroupId;
      await waitFor(() => fs.existsSync(pidFile), 'Terminal descendant pid was not published');
      const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
      const descendantIdentity = readServerProcessIdentity(descendantPid);
      assert.strictEqual(
        descendantIdentity?.processGroupId,
        processGroupId,
        'the fixture descendant must belong to the Terminal process group',
      );

      await host.killSession('descendant-terminal');
      await waitFor(
        () => readServerProcessIdentity(session.processIdentity.pid) === null,
        'Terminal leader did not exit after killSession',
      );
      assert.strictEqual(
        readServerProcessIdentity(descendantPid),
        null,
        'killing a Terminal must stop every descendant in its owned process group',
      );
    } finally {
      if (processGroupId) {
        try {
          process.kill(-processGroupId, 'SIGKILL');
        } catch {
          // The exact Terminal process group may already have exited.
        }
      }
      await host.dispose().catch(() => {});
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-pty-ownership.'));
  const host = new NativePtyHost({ configDir, exitOnShutdown: false });
  let terminalPid = 0;
  try {
    await host.createSession({
      agentId: 'hard-stop-terminal',
      command: '/bin/sh',
      args: ['-c', 'while :; do sleep 60; done'],
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      shellIntegrationPrepared: true,
    });

    const session = host.sessions.get('hard-stop-terminal');
    assert(session?.processIdentity, 'creating a Terminal must publish its exact process identity');
    terminalPid = session.processIdentity.pid;

    const stopped = await hardStopConfigProcesses(configDir);
    assert.strictEqual(stopped.refused, 0);
    assert.strictEqual(stopped.stopped, 1, 'hard stop must kill the Config-owned Terminal process group');
    assert.strictEqual(
      readServerProcessIdentity(terminalPid),
      null,
      'hard stop must return only after the Terminal process is gone',
    );
  } finally {
    await host.dispose().catch(() => {});
    if (terminalPid) {
      const identity = readServerProcessIdentity(terminalPid);
      if (identity) {
        try {
          process.kill(-identity.processGroupId, 'SIGKILL');
        } catch {
          // The exact test process may already have exited.
        }
      }
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('native PTY process ownership test passed');
}).catch(error => {
  console.error(error);
  process.exit(1);
});
