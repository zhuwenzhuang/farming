const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { hardStopConfigProcesses } = require('../config-process-ownership.cjs');
const { NativePtyHost } = require('../native-pty-host.cjs');
const { readServerProcessIdentity } = require('../server-process-identity.cjs');

async function run() {
  if (process.platform === 'win32') {
    console.log('native PTY process ownership test skipped on Windows');
    return;
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
