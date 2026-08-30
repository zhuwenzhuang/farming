const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '../..');
const activator = path.join(projectRoot, 'scripts', 'activate-remote-release.sh');

function commandExists(command) {
  return spawnSync('bash', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function writeFixtureBundle(root, options) {
  const bundleRoot = path.join(root, `bundle-${options.gitSha.slice(0, 8)}`);
  fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, 'node_modules', 'node-pty'), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, 'RELEASE.json'), `${JSON.stringify({
    type: 'app-bundle',
    releaseVersion: '9.9.9',
    packageVersion: '9.9.9',
    gitSha: options.gitSha,
    dirty: false,
    platform: 'linux',
    arch: 'x64',
    updateMethod: 'app-bundle',
    bundledNodeModules: true,
    bundledGlibcRuntime: false,
  })}\n`);
  fs.writeFileSync(path.join(bundleRoot, 'node_modules', 'node-pty', 'index.js'), 'module.exports = {}\n');
  fs.writeFileSync(path.join(bundleRoot, 'bin', 'farming'), `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const command = args[0];
const configIndex = args.indexOf('--config-dir');
const configDir = configIndex >= 0 ? args[configIndex + 1] : process.env.HOME + '/.farming';
fs.mkdirSync(configDir, { recursive: true });
if (command === 'runtime') process.exit(0);
if (command === 'stop') process.exit(0);
if (command === 'daemon') {
  fs.writeFileSync(path.join(configDir, 'farming-server.pid'), String(process.pid));
  process.exit(0);
}
process.exit(1);
`);
  fs.writeFileSync(path.join(bundleRoot, 'scripts', 'smoke-deployed-server.mjs'), 'process.exit(0)\n');
  const archive = path.join(root, `artifact-${options.gitSha.slice(0, 8)}.tar.gz`);
  const packed = spawnSync('tar', ['-czf', archive, '-C', root, path.basename(bundleRoot)], { encoding: 'utf8' });
  assert.strictEqual(packed.status, 0, packed.stderr);
  return { archive, checksum: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') };
}

function activate(fixture, gitSha, remoteDir, configDir, extraEnv = {}) {
  let expectedSelection = 'none';
  if (fs.existsSync(remoteDir)) {
    if (fs.lstatSync(remoteDir).isSymbolicLink()) {
      const marker = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(remoteDir), '.farming-deployment.json'), 'utf8'));
      expectedSelection = `image:${marker.gitSha || 'legacy'}:${marker.sha256 || marker.imageId || 'unknown'}`;
    } else if (fs.statSync(remoteDir).isDirectory()) {
      const stat = fs.statSync(remoteDir);
      expectedSelection = `legacy:${stat.dev}:${stat.ino}`;
    }
  }
  return spawnSync('bash', [
    activator,
    '--artifact', fixture.archive,
    '--checksum', fixture.checksum,
    '--git-sha', gitSha,
    '--expected-selection', expectedSelection,
    '--remote-dir', remoteDir,
    '--config-dir', configDir,
    '--app-port', '16694',
    '--base-path', '/farming',
    '--smoke-agent', 'fixture',
    '--keep-images', '2',
    '--disable-auth',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: path.dirname(configDir), ...extraEnv },
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseSuccessLine(result) {
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

function childTerminated(child: MinimalChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Proves termination of the exact spawned child. Returns immediately when the
 * child already exited; otherwise attaches exit/error handling exactly once,
 * SIGKILLs the exact child, and fails hard when it does not exit within the
 * bounded window, so cleanup never removes a live process's working directory.
 */
async function waitForExit(child: MinimalChild, timeoutMs = 5_000): Promise<void> {
  if (childTerminated(child)) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = (error: Error) => finish(error);
    // Attach the listeners BEFORE observing state again: any termination after
    // this point is caught by the listeners, and any termination before it is
    // observed by the re-check immediately below, so no window is left unhandled.
    child.once('exit', onExit);
    child.once('error', onError);
    if (childTerminated(child)) {
      finish();
      return;
    }
    timer = setTimeout(() => {
      finish(new Error(
        `live reference process ${child.pid} did not exit within ${timeoutMs} ms of SIGKILL`,
      ));
    }, timeoutMs);
    if (!child.kill('SIGKILL') && childTerminated(child)) {
      // The signal was not delivered because the exact child terminated in the
      // window above; finish through the re-check instead of waiting for an
      // exit event that may already have been emitted.
      finish();
    }
  });
  if (!childTerminated(child)) {
    throw new Error(`live reference process ${child.pid} emitted exit without a termination code`);
  }
}

/** Minimal live-child contract shared by real ChildProcess handles and fakes. */
interface MinimalChild extends NodeJS.EventEmitter {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface FakeChild extends MinimalChild {
  killCalls: number;
}

interface FakeChildBehavior {
  killResult: boolean;
  terminateOnKill: boolean;
  emitExitOnKill: boolean;
}

/**
 * Live-reference scenario: retention keeps images referenced by already-running
 * same-user processes whose command lines carry image-root-qualified paths, and
 * still prunes images proven unreferenced outside the recency budget.
 */
async function runLiveReferences() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-remote-retention.'));
  const remoteDir = path.join(root, 'farming');
  const configDir = path.join(root, 'config');
  const imagesDir = `${remoteDir}.deploy/images`;
  let liveProcess = null;
  try {
    // Deploy image A. Image roots are addressed through the deployment's own
    // ${IMAGES_DIR} path, exactly as they appear in live process command lines.
    const shaA = '1'.repeat(40);
    const resultA = activate(writeFixtureBundle(root, { gitSha: shaA }), shaA, remoteDir, configDir);
    assert.strictEqual(resultA.status, 0, resultA.stderr);
    const imageA = path.join(imagesDir, path.basename(fs.realpathSync(remoteDir)));

    // Another live Config instance runs its Server from image A. Real Servers
    // carry image-root-qualified command-line arguments (CLI entrypoint, bundled
    // glibc loader, backend entrypoints); the fixture mirrors that shape.
    liveProcess = spawn('node', [
      '-e',
      'setInterval(() => {}, 1000)',
      path.join(imageA, 'bin', 'farming'),
    ], { cwd: imageA, stdio: 'ignore' });
    await delay(300);
    assert.strictEqual(liveProcess.exitCode, null, 'live reference process must stay running');

    // Deploy B, C, D. The --keep-images recency budget counts the current and
    // previous images, so with --keep-images 2 only the current and previous
    // images survive by recency; A and B fall outside the budget.
    const shaB = '2'.repeat(40);
    const resultB = activate(writeFixtureBundle(root, { gitSha: shaB }), shaB, remoteDir, configDir);
    assert.strictEqual(resultB.status, 0, resultB.stderr);
    const imageB = path.join(imagesDir, path.basename(fs.realpathSync(remoteDir)));
    await delay(50);
    const shaC = '3'.repeat(40);
    const resultC = activate(writeFixtureBundle(root, { gitSha: shaC }), shaC, remoteDir, configDir);
    assert.strictEqual(resultC.status, 0, resultC.stderr);
    const imageC = path.join(imagesDir, path.basename(fs.realpathSync(remoteDir)));
    await delay(50);
    const shaD = '4'.repeat(40);
    const resultD = activate(writeFixtureBundle(root, { gitSha: shaD }), shaD, remoteDir, configDir);
    assert.strictEqual(resultD.status, 0, resultD.stderr);
    const imageD = path.join(imagesDir, path.basename(fs.realpathSync(remoteDir)));
    const successD = parseSuccessLine(resultD);
    assert.strictEqual(successD.cleanupWarning, false, resultD.stderr);
    assert.notStrictEqual(imageA, imageD);

    // Image A is still referenced by the live process: retention must keep it.
    assert.ok(fs.existsSync(imageA), 'live-referenced image A must be retained');
    // Image B is unreferenced and outside the recency budget: retention prunes it.
    assert.ok(!fs.existsSync(imageB), 'unreferenced image B must be pruned');
    // Current and previous images are intact.
    assert.ok(fs.existsSync(imageC), 'previous image C must be retained');
    assert.ok(fs.existsSync(imageD), 'current image D must be retained');

    // Release the live reference; the next deployment prunes A too.
    await waitForExit(liveProcess);
    assert.ok(childTerminated(liveProcess), 'released live reference must be provably terminated');
    liveProcess = null;
    const shaE = '5'.repeat(40);
    const resultE = activate(writeFixtureBundle(root, { gitSha: shaE }), shaE, remoteDir, configDir);
    assert.strictEqual(resultE.status, 0, resultE.stderr);
    const imageE = path.join(imagesDir, path.basename(fs.realpathSync(remoteDir)));
    assert.ok(!fs.existsSync(imageA), 'image A must be pruned once its live reference exits');
    assert.ok(!fs.existsSync(imageC), 'image C must be pruned once outside the recency budget');
    assert.ok(fs.existsSync(imageD), 'previous image D must be retained');
    assert.ok(fs.existsSync(imageE), 'current image E must be retained');
    const remaining = fs.readdirSync(imagesDir).sort();
    assert.deepStrictEqual(remaining, [path.basename(imageD), path.basename(imageE)].sort());

    console.log('✓ remote image retention preserves live Config references and prunes proven-unreferenced images');
  } finally {
    if (liveProcess) {
      await waitForExit(liveProcess);
      assert.ok(childTerminated(liveProcess), 'finally must confirm termination before removing the fixture tree');
    }
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!fs.existsSync(root), 'retention fixture tree must be removed');
  }
}

/**
 * Uncertainty scenario: when live-reference evidence cannot be proven, cleanup
 * must delete nothing, emit the warning, and report cleanupWarning=true. The
 * seam is test-local: a PATH-shadowing `node` stub that fails only the exact
 * retention-helper invocation shape (`node - <...deploy/images>`), passing
 * every other node call through to the real runtime. This exercises the real
 * production fallback (`|| LIVE_REFERENCE_OUTPUT="UNCERTAIN"`) without any
 * production-visible knob; production always scans /proc.
 */
async function runUncertainCleanup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-remote-retention-uncertain.'));
  const remoteDir = path.join(root, 'farming');
  const configDir = path.join(root, 'config');
  const imagesDir = `${remoteDir}.deploy/images`;
  const stubDir = path.join(root, 'node-stub');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'node'), [
    '#!/usr/bin/env bash',
    '# Fail only the retention live-reference helper: `node - <...deploy/images>`.',
    'if [ "${1:-}" = "-" ] && [ "$#" -eq 2 ]; then',
    '  case "${2:-}" in',
    '    *.deploy/images) exit 1 ;;',
    '  esac',
    'fi',
    `exec "${process.execPath}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const uncertainEnv = { PATH: `${stubDir}:${process.env.PATH}` };
  try {
    const shas = ['6'.repeat(40), '7'.repeat(40), '8'.repeat(40), '9'.repeat(40)];
    let lastResult = null;
    for (const gitSha of shas) {
      lastResult = activate(writeFixtureBundle(root, { gitSha }), gitSha, remoteDir, configDir, uncertainEnv);
      assert.strictEqual(lastResult.status, 0, lastResult.stderr);
      await delay(50);
    }
    // The recency budget would normally prune the two oldest images; uncertain
    // live-reference evidence must delete nothing.
    const remaining = fs.readdirSync(imagesDir).sort();
    assert.strictEqual(
      remaining.length,
      shas.length,
      `uncertain cleanup must delete nothing: ${remaining.join(', ')}`,
    );
    assert.match(lastResult.stderr, /live image references could not be proven/);
    const success = parseSuccessLine(lastResult);
    assert.strictEqual(success.ok, true);
    assert.strictEqual(success.cleanupWarning, true, 'uncertain cleanup must report cleanupWarning=true');
    console.log('✓ uncertain live-reference evidence skips remote image cleanup entirely');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!fs.existsSync(root), 'uncertain-cleanup fixture tree must be removed');
  }
}

/**
 * Deterministic termination-proof contract for waitForExit, covering the exact
 * paths the retention cleanup depends on: already-terminated children return
 * without signalling, running children are SIGKILLed and confirmed, and a child
 * that terminates in the observation window (kill returns false, exit already
 * emitted) resolves through the re-check instead of running out the timeout.
 */
async function runTerminationProofContract() {
  // Already-terminated real child: waitForExit returns immediately and never signals.
  const exited = spawn('node', ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise<void>((resolve) => exited.once('exit', () => resolve()));
  assert.ok(childTerminated(exited));
  const alreadyDoneAt = Date.now();
  await waitForExit(exited, 5_000);
  assert.ok(Date.now() - alreadyDoneAt < 1_000, 'already-terminated child must return immediately');

  // Running real child: SIGKILL is delivered and termination is confirmed.
  const running = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await delay(100);
  assert.strictEqual(running.exitCode, null);
  await waitForExit(running, 5_000);
  assert.ok(childTerminated(running), 'running child must be provably terminated');
  assert.strictEqual(running.signalCode, 'SIGKILL');

  // Fake-child determinism for the observation-window race: kill returns false
  // because the child terminated between the initial check and signalling, and
  // its exit event was already emitted. The re-check must resolve this instead
  // of waiting out the bounded timer.
  function makeFakeChild(behavior: FakeChildBehavior): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.pid = 999999;
    child.exitCode = null;
    child.signalCode = null;
    child.killCalls = 0;
    child.kill = () => {
      child.killCalls += 1;
      if (behavior.terminateOnKill) {
        child.exitCode = 0;
        if (behavior.emitExitOnKill) child.emit('exit');
      }
      return behavior.killResult;
    };
    return child;
  }

  const fakeExited = makeFakeChild({ killResult: true, terminateOnKill: false, emitExitOnKill: false });
  fakeExited.exitCode = 3;
  await waitForExit(fakeExited, 3_000);
  assert.strictEqual(fakeExited.killCalls, 0, 'already-terminated child must never be signalled');

  const fakeRunning = makeFakeChild({ killResult: true, terminateOnKill: true, emitExitOnKill: true });
  await waitForExit(fakeRunning, 3_000);
  assert.strictEqual(fakeRunning.killCalls, 1);
  assert.ok(childTerminated(fakeRunning));

  const fakeRace = makeFakeChild({ killResult: false, terminateOnKill: true, emitExitOnKill: false });
  const raceStartedAt = Date.now();
  await waitForExit(fakeRace, 3_000);
  assert.ok(childTerminated(fakeRace));
  assert.ok(
    Date.now() - raceStartedAt < 1_000,
    'termination during the observation window must resolve via re-check, not the bounded timeout',
  );

  console.log('✓ retention cleanup proves exact child termination before removing fixtures');
}

async function run() {
  if (process.platform !== 'linux' || !commandExists('flock')) {
    console.log('✓ remote deployment image retention test requires Linux flock (skipped)');
    return;
  }
  await runTerminationProofContract();
  await runLiveReferences();
  await runUncertainCleanup();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
