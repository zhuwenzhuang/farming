import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const { readServerProcessIdentity, serverStateFile } = require('../farming-app-cli.cjs');
const { registerConfigProcessGroup } = require('../config-process-ownership.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-review-lifecycle-'));
  const configDir = path.join(root, 'config');
  const repo = path.join(root, 'repo');
  const env = { ...process.env, FARMING_CONFIG_DIR: configDir, FARMING_BASE_PATH: '/review-test',
    FARMING_DISABLE_AUTH: '1', FARMING_SESSION_ENGINE: 'local', FARMING_SKIP_RUNTIME_PREPARE: '1',
    FARMING_START_STABILITY_MS: '0', NODE_ENV: 'test' };
  for (const key of ['FARMING_CONTROL_URL', 'FARMING_TOKEN_FILE', 'FARMING_PORT', 'PORT',
    'FARMING_AGENT_ID', 'FARMING_RUN_SERVER']) delete env[key];
  const cli = (args: string[], overrides: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/farming', ...args], {
      cwd: path.resolve(__dirname, '../..'), env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => { clearTimeout(deadline); resolve({ code, output }); });
  });
  let agent: ChildProcess | undefined;
  try {
    fs.mkdirSync(configDir);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '/dev/null']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Review Test', '-c', 'user.email=review@example.com',
      'commit', '--allow-empty', '-qm', 'base']);
    const args = ['review', repo, 'HEAD', 'now', '--no-open'];
    const first = await cli(args);
    assert.equal(first.code, 0, first.output);
    const stateText = fs.readFileSync(serverStateFile(configDir), 'utf8');
    const state = JSON.parse(stateText);
    assert.match(first.output, new RegExp(`127\\.0\\.0\\.1:${state.port}/review-test/review\\?`));

    // An owned runtime represents the Agent invoking Review. Restarting this
    // Config would kill both the Server and this process, as in the regression.
    agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); console.log("ready")'],
      { detached: true, env, stdio: ['ignore', 'pipe', 'ignore'] });
    await once(agent.stdout!, 'data');
    const identity = readServerProcessIdentity(agent.pid);
    assert(identity);
    registerConfigProcessGroup(configDir, 'acp-provider', identity);

    const assertPreserved = () => {
      assert.equal(fs.readFileSync(serverStateFile(configDir), 'utf8'), stateText);
      assert.deepEqual(readServerProcessIdentity(state.pid), state.processIdentity);
      assert.deepEqual(readServerProcessIdentity(agent!.pid), identity);
    };
    for (const result of await Promise.all([cli(args), cli(args)])) {
      assert.equal(result.code, 0, result.output);
      assert.doesNotMatch(result.output, /restarting|Stopping|Starting Farming/);
      assert.match(result.output, new RegExp(`127\\.0\\.0\\.1:${state.port}/review-test/review\\?`));
    }
    assertPreserved();
    for (const flags of [['--port', String(state.port === 65535 ? 65534 : state.port + 1)], ['--base-path', '/wrong']]) {
      const result = await cli([...args, ...flags]);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /endpoint options do not match/);
      assertPreserved();
    }
    fs.writeFileSync(path.join(configDir, '.session-token'), 'test-only-wrong-mode');
    const failedReadiness = await cli(args, { FARMING_DISABLE_AUTH: '0', FARMING_START_TIMEOUT_MS: '100' });
    assert.equal(failedReadiness.code, 1, failedReadiness.output);
    assert.match(failedReadiness.output, /authentication before timeout/);
    assertPreserved();

    fs.writeFileSync(serverStateFile(configDir), JSON.stringify({ ...state,
      processIdentity: { ...state.processIdentity, startedAt: 'wrong-start' } }));
    try {
      const rejected = await cli(args);
      assert.equal(rejected.code, 1, rejected.output);
      assert.match(rejected.output, /Refusing to reuse.*identity does not match/);
      assert.deepEqual(readServerProcessIdentity(state.pid), state.processIdentity);
      assert.deepEqual(readServerProcessIdentity(agent.pid), identity);
    } finally {
      fs.writeFileSync(serverStateFile(configDir), stateText);
    }
    console.log('Review starts only an absent Server and preserves Server/Agent identities on reuse, concurrency and failure');
  } finally {
    try {
      const stopped = await cli(['stop']);
      assert.equal(stopped.code, 0, stopped.output);
    } finally {
      if (agent && agent.exitCode === null && agent.signalCode === null) {
        const exited = once(agent, 'exit');
        agent.kill('SIGKILL');
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
