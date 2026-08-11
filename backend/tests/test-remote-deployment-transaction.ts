const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '../..');
const activator = path.join(projectRoot, 'scripts', 'activate-remote-release.sh');
const daemonSecretSentinel = 'farming-deploy-daemon-secret-sentinel';

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
  fs.writeFileSync(
    path.join(bundleRoot, 'node_modules', 'node-pty', 'index.js'),
    options.invalidNodePty ? 'throw new Error("invalid node-pty fixture")\n' : 'module.exports = {}\n',
  );
  fs.writeFileSync(path.join(bundleRoot, 'bin', 'farming'), `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const command = args[0];
const configIndex = args.indexOf('--config-dir');
const configDir = configIndex >= 0 ? args[configIndex + 1] : process.env.HOME + '/.farming';
fs.mkdirSync(configDir, { recursive: true });
const events = path.join(configDir, 'fixture-events.log');
fs.appendFileSync(events, command + ':' + process.cwd() + '\\n');
if (command === 'runtime') process.exit(0);
if (command === 'stop') {
  fs.rmSync(path.join(configDir, 'farming-server.pid'), { force: true });
  process.exit(0);
}
if (command === 'daemon') {
  fs.writeFileSync(path.join(configDir, 'farming-server.pid'), String(process.pid));
  ${options.daemonStateValue === undefined
    ? ''
    : `fs.writeFileSync(path.join(configDir, 'durable-state.txt'), ${JSON.stringify(options.daemonStateValue)});`}
  process.stdout.write(${JSON.stringify(options.daemonStdout || '')});
  process.stderr.write(${JSON.stringify(options.daemonStderr || '')});
  process.exit(${options.startExitCode || 0});
}
process.exit(1);
`);
  fs.writeFileSync(
    path.join(bundleRoot, 'scripts', 'smoke-deployed-server.mjs'),
    `const args = process.argv.slice(2)
const tokenIndex = args.indexOf('--token-file')
if (tokenIndex >= 0 && !args[tokenIndex + 1]) process.exit(98)
process.exit(${options.smokeExitCode || 0})\n`,
  );
  const archive = path.join(root, `artifact-${options.gitSha.slice(0, 8)}.tar.gz`);
  const packed = spawnSync('tar', ['-czf', archive, '-C', root, path.basename(bundleRoot)], {
    encoding: 'utf8',
  });
  assert.strictEqual(packed.status, 0, packed.stderr);
  return {
    archive,
    checksum: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
  };
}

function activate(fixture, gitSha, remoteDir, configDir) {
  let expectedSelection = 'none';
  if (fs.existsSync(remoteDir)) {
    const stat = fs.statSync(remoteDir);
    if (fs.lstatSync(remoteDir).isSymbolicLink()) {
      const marker = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(remoteDir), '.farming-deployment.json'), 'utf8'));
      expectedSelection = `image:${marker.gitSha || 'legacy'}:${marker.sha256 || marker.imageId || 'unknown'}`;
    } else if (stat.isDirectory()) {
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
    '--disable-auth',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: path.dirname(configDir) },
  });
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function run() {
  if (process.platform !== 'linux' || !commandExists('flock')) {
    console.log('✓ remote deployment transaction test requires Linux flock (skipped)');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-remote-deploy.'));
  const remoteDir = path.join(root, 'farming');
  const configDir = path.join(root, 'config');
  try {
    const absentConfigDir = path.join(root, 'absent-config');
    const absentConfigSnapshot = path.join(root, '.absent-config.farming-deploy-backup-old-image');
    fs.mkdirSync(absentConfigSnapshot);
    const absentConfigSha = '0'.repeat(40);
    const blockedAbsentConfig = writeFixtureBundle(root, { gitSha: absentConfigSha });
    const blockedAbsentConfigResult = activate(
      blockedAbsentConfig,
      absentConfigSha,
      remoteDir,
      absentConfigDir,
    );
    assert.notStrictEqual(blockedAbsentConfigResult.status, 0);
    assert.match(blockedAbsentConfigResult.stderr, /Config snapshot from an earlier deployment/);
    assert(!fs.existsSync(absentConfigDir), 'snapshot refusal must not recreate a missing Config directory');
    fs.rmSync(absentConfigSnapshot, { recursive: true, force: true });

    const firstSha = '1'.repeat(40);
    const first = writeFixtureBundle(root, {
      gitSha: firstSha,
      daemonStdout: `${daemonSecretSentinel}\n`,
    });
    const firstResult = activate(first, firstSha, remoteDir, configDir);
    assert.strictEqual(firstResult.status, 0, firstResult.stderr);
    assert.doesNotMatch(`${firstResult.stdout}\n${firstResult.stderr}`, new RegExp(daemonSecretSentinel));
    const successLines = firstResult.stdout.trim().split('\n');
    const success = JSON.parse(successLines[successLines.length - 1]);
    assert.strictEqual(success.ok, true);
    assert.strictEqual(success.gitSha, firstSha);
    const firstImage = fs.realpathSync(remoteDir);
    assert.match(firstImage, /111111111111-/);

    const unresolvedSnapshot = path.join(root, '.config.farming-deploy-backup-old-image');
    fs.mkdirSync(unresolvedSnapshot);
    const eventsBeforeSnapshotRefusal = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
    const blockedBySnapshotSha = 'a'.repeat(40);
    const blockedBySnapshot = writeFixtureBundle(root, { gitSha: blockedBySnapshotSha });
    const blockedBySnapshotResult = activate(
      blockedBySnapshot,
      blockedBySnapshotSha,
      remoteDir,
      configDir,
    );
    assert.notStrictEqual(blockedBySnapshotResult.status, 0);
    assert.match(blockedBySnapshotResult.stderr, /Config snapshot from an earlier deployment/);
    assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
    assert(fs.existsSync(unresolvedSnapshot), 'an unresolved earlier snapshot must remain untouched');
    assert.strictEqual(
      fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8'),
      eventsBeforeSnapshotRefusal,
      'an unresolved snapshot must block every Config mutation, including runtime preparation and stop',
    );
    fs.rmSync(unresolvedSnapshot, { recursive: true, force: true });

    const secondSha = '2'.repeat(40);
    const failingStart = writeFixtureBundle(root, {
      gitSha: secondSha,
      daemonStderr: `${daemonSecretSentinel}\n`,
      startExitCode: 7,
    });
    const failedStartResult = activate(failingStart, secondSha, remoteDir, configDir);
    assert.notStrictEqual(failedStartResult.status, 0);
    assert.match(
      failedStartResult.stderr,
      /Farming Server startup failed; inspect the Config-owned farming-server\.log on the target\./,
    );
    assert.match(failedStartResult.stderr, /previous image was restored/i);
    assert.doesNotMatch(
      `${failedStartResult.stdout}\n${failedStartResult.stderr}`,
      new RegExp(daemonSecretSentinel),
    );
    assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
    const eventsAfterStartRollback = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
    assert(eventsAfterStartRollback.split('\n').filter(line => line.startsWith(`daemon:${firstImage}`)).length >= 2);

    const thirdSha = '3'.repeat(40);
    fs.writeFileSync(path.join(configDir, 'durable-state.txt'), 'state-owned-by-previous-image');
    const failingSmoke = writeFixtureBundle(root, {
      gitSha: thirdSha,
      smokeExitCode: 7,
      daemonStateValue: 'state-migrated-by-failed-image',
    });
    const failedResult = activate(failingSmoke, thirdSha, remoteDir, configDir);
    assert.notStrictEqual(failedResult.status, 0);
    assert.match(failedResult.stderr, /previous image was restored/i);
    assert.doesNotMatch(`${failedResult.stdout}\n${failedResult.stderr}`, new RegExp(daemonSecretSentinel));
    assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
    assert.strictEqual(
      fs.readFileSync(path.join(configDir, 'durable-state.txt'), 'utf8'),
      'state-owned-by-previous-image',
      'rollback must restore Config state from before the failed image started',
    );
    const eventsAfterRollback = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
    assert(eventsAfterRollback.split('\n').filter(line => line.startsWith(`daemon:${firstImage}`)).length >= 2);

    const eventsBeforePreflight = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
    const fourthSha = '4'.repeat(40);
    const invalidNative = writeFixtureBundle(root, { gitSha: fourthSha, invalidNodePty: true });
    const preflightResult = activate(invalidNative, fourthSha, remoteDir, configDir);
    assert.notStrictEqual(preflightResult.status, 0);
    assert.match(preflightResult.stderr, /invalid node-pty fixture/);
    assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
    assert.strictEqual(fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8'), eventsBeforePreflight);

    const lockFile = `${remoteDir}.deploy/deploy.lock`;
    const readyFile = path.join(root, 'lock-ready');
    const lockHolder = spawn('flock', [lockFile, 'bash', '-c', `touch '${readyFile}'; sleep 5`], {
      stdio: 'ignore',
    });
    try {
      await waitForFile(readyFile);
      const fifthSha = '5'.repeat(40);
      const blocked = writeFixtureBundle(root, { gitSha: fifthSha });
      const blockedResult = activate(blocked, fifthSha, remoteDir, configDir);
      assert.notStrictEqual(blockedResult.status, 0);
      assert.match(blockedResult.stderr, /Another Farming deployment is active/);
      assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
    } finally {
      lockHolder.kill('SIGTERM');
    }

    console.log('✓ remote deployment uses immutable activation, preflight, locking, and rollback');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
