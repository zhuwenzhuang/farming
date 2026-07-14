const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  AcpClientFileSystem,
  AcpClientTerminalManager,
} = require('../acp/client-services');

async function run() {
  const packageJson = require('../../package.json');
  assert(
    packageJson.files.includes('backend/acp/'),
    'the npm package must include ACP client service modules required at runtime',
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-client-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-outside-'));
  const binding = {
    agentId: 'agent-services',
    sessionId: 'session-services',
    cwd: root,
    env: process.env,
  };
  const request = extra => ({ sessionId: binding.sessionId, ...extra });
  const files = new AcpClientFileSystem({ maxFileBytes: 1024 });
  const terminals = new AcpClientTerminalManager();
  const waitForOutput = async (terminalId, pattern) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const snapshot = terminals.output(binding, request({ terminalId }));
      if (pattern.test(snapshot.output)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ACP terminal output: ${pattern}`);
  };

  try {
    const file = path.join(root, 'sample.txt');
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    assert.deepStrictEqual(await files.readTextFile(binding, request({ path: file })), {
      content: 'one\ntwo\nthree\n',
    });
    assert.deepStrictEqual(await files.readTextFile(binding, request({ path: file, line: 2, limit: 2 })), {
      content: 'two\nthree',
    });
    await files.writeTextFile(binding, request({ path: file, content: 'updated' }));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'updated');
    await files.writeTextFile(binding, request({ path: path.join(root, 'new.txt'), content: 'created' }));
    assert.strictEqual(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'created');
    await assert.rejects(
      files.readTextFile(binding, request({ path: path.join(outside, 'missing.txt') })),
      /outside the Agent workspace/,
    );
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');
    const symlink = path.join(root, 'outside-link.txt');
    fs.symlinkSync(outsideFile, symlink);
    await assert.rejects(files.readTextFile(binding, request({ path: symlink })), /outside the Agent workspace/);
    await assert.rejects(
      files.writeTextFile(binding, { sessionId: 'wrong', path: file, content: 'bad' }),
      /does not match the active session/,
    );

    const created = await terminals.create(binding, request({
      command: process.execPath,
      args: ['-e', "process.stdout.write('hello '); process.stderr.write('world')"],
      cwd: root,
    }));
    assert.match(created.terminalId, /^acp-terminal-/);
    assert.deepStrictEqual(
      await terminals.waitForExit(binding, request({ terminalId: created.terminalId })),
      { exitCode: 0, signal: null },
    );
    const output = terminals.output(binding, request({ terminalId: created.terminalId }));
    assert.match(output.output, /hello /);
    assert.match(output.output, /world/);
    assert.deepStrictEqual(output.exitStatus, { exitCode: 0, signal: null });
    terminals.release(binding, request({ terminalId: created.terminalId }));
    assert.throws(
      () => terminals.output(binding, request({ terminalId: created.terminalId })),
      /released/,
    );
    const display = terminals.display(created.terminalId);
    assert.match(display.output, /hello/);
    assert.strictEqual(display.command, process.execPath);
    assert.deepStrictEqual(display.args, ['-e', "process.stdout.write('hello '); process.stderr.write('world')"]);
    assert.strictEqual(display.cwd, fs.realpathSync(root));
    assert.strictEqual(display.released, true);
    assert.strictEqual(display.exitStatus.exitCode, 0);
    assert(Number.isFinite(display.startedAt));
    assert(Number.isFinite(display.endedAt));
    assert(display.durationMs >= 0);
    assert.strictEqual(display.interactive, true);

    const interactive = await terminals.create(binding, request({
      command: process.execPath,
      args: ['-e', "process.stdin.setEncoding('utf8'); process.stdout.write('ready>'); process.stdin.once('data', value => { process.stdout.write('echo:' + value.trim()); process.exit(0); })"],
    }));
    await waitForOutput(interactive.terminalId, /ready>/);
    terminals.resize(binding, request({ terminalId: interactive.terminalId, cols: 100, rows: 30 }));
    terminals.input(binding, request({ terminalId: interactive.terminalId, input: 'hello ACP\r' }));
    await terminals.waitForExit(binding, request({ terminalId: interactive.terminalId }));
    assert.match(terminals.output(binding, request({ terminalId: interactive.terminalId })).output, /echo:hello ACP/);

    const truncated = await terminals.create(binding, request({
      command: process.execPath,
      args: ['-e', "process.stdout.write('前缀-' + 'x'.repeat(200) + '-结尾')"],
      outputByteLimit: 32,
    }));
    await terminals.waitForExit(binding, request({ terminalId: truncated.terminalId }));
    const bounded = terminals.output(binding, request({ terminalId: truncated.terminalId }));
    assert.strictEqual(bounded.truncated, true);
    assert(Buffer.byteLength(bounded.output, 'utf8') <= 32);
    assert(!bounded.output.includes('\ufffd'));
    assert.match(bounded.output, /结尾$/);

    const longRunning = await terminals.create(binding, request({
      command: process.execPath,
      args: ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
    }));
    terminals.kill(binding, request({ terminalId: longRunning.terminalId }));
    const killedExit = await terminals.waitForExit(binding, request({ terminalId: longRunning.terminalId }));
    assert(killedExit.signal || killedExit.exitCode !== 0);
    const killedDisplay = terminals.display(longRunning.terminalId);
    assert(killedDisplay.exitStatus);
    assert(Number.isFinite(killedDisplay.endedAt));

    await assert.rejects(
      terminals.create(binding, request({ command: process.execPath, cwd: outside })),
      /outside the Agent workspace/,
    );
  } finally {
    terminals.cleanupAgent(binding.agentId);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }

  console.log('ACP client filesystem and terminal tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
