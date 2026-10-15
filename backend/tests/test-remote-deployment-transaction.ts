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
if (command === 'runtime') {
  if (process.env.FIXTURE_LOW_SPACE_MARKER) fs.writeFileSync(process.env.FIXTURE_LOW_SPACE_MARKER, 'low');
  process.exit(0);
}
if (command === 'stop') {
  fs.rmSync(path.join(configDir, 'farming-server.pid'), { force: true });
  process.exit(0);
}
if (command === 'daemon') {
  fs.writeFileSync(path.join(configDir, 'farming-server.log'), 'private diagnostic fixture');
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
process.exit(process.env.FIXTURE_FAIL_SMOKE === '1' ? 7 : ${options.smokeExitCode || 0})\n`,
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

function activate(fixture, gitSha, remoteDir, configDir, extraEnv = {}) {
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
    env: { ...process.env, HOME: path.dirname(configDir), ...extraEnv },
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

function verifyArchiveScan(root) {
  const source = fs.readFileSync(activator, 'utf8');
  const scan = source.slice(source.indexOf('ARCHIVE_UNPACKED_BYTES='), source.indexOf('\nrun_node() {'));
  assert(scan.startsWith('ARCHIVE_UNPACKED_BYTES='));
  const fixture = path.join(root, 'scan-input');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'file with spaces'), '1234567');
  fs.symlinkSync('file with spaces', path.join(fixture, 'link'));
  fs.mkdirSync(path.join(fixture, 'nested', 'bin'), { recursive: true });
  fs.symlinkSync('../../file with spaces', path.join(fixture, 'nested', 'bin', 'tool'));
  fs.linkSync(path.join(fixture, 'file with spaces'), path.join(fixture, 'hard link'));
  fs.writeFileSync(path.join(fixture, 'quoted "name" \\ with\nnewline -> target'), '');
  const archive = path.join(root, 'scan.tar.gz');
  const scanArchive = () => spawnSync('bash', ['-c', `set -euo pipefail\n${scan}\nprintf '%s' "$ARCHIVE_UNPACKED_BYTES"`], {
    encoding: 'utf8', env: { ...process.env, ARTIFACT: archive },
  });
  for (const prefix of ['', '../', '/absolute/']) {
    const packed = spawnSync('tar', ['-czf', archive, ...(prefix ? ['--transform', `s,^,${prefix},`] : []), '-C', fixture, '.'], { encoding: 'utf8' });
    assert.strictEqual(packed.status, 0, packed.stderr);
    const result = scanArchive();
    if (!prefix) {
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, '7');
    } else {
      assert.notStrictEqual(result.status, 0, 'unsafe archive must fail before extraction');
      assert.match(result.stderr, /unsafe archive path/);
    }
  }
  // A failed tar must not be hidden by a successful downstream awk process.
  fs.writeFileSync(archive, 'not a gzip archive');
  assert.notStrictEqual(scanArchive().status, 0);
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
    verifyArchiveScan(root);
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
    const firstRedeployArchive = path.join(root, 'artifact-first-redeploy.tar.gz');
    fs.copyFileSync(first.archive, firstRedeployArchive);
    const firstRedeploy = { archive: firstRedeployArchive, checksum: first.checksum };
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
      /Farming Server startup failed; inspect the private farming-server-start\.log on the target\./,
    );
    assert.match(failedStartResult.stderr, /previous image was restored/i);
    assert.doesNotMatch(
      `${failedStartResult.stdout}\n${failedStartResult.stderr}`,
      new RegExp(daemonSecretSentinel),
    );
    assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
    assert(!fs.readdirSync(`${remoteDir}.deploy/images`).some(name => name.startsWith(secondSha.slice(0, 12))), 'reconciled failed-start image must be reclaimed');
    const startupEvidenceRoot = path.join(`${remoteDir}.deploy`, 'failures');
    const startupEvidenceImage = fs.readdirSync(startupEvidenceRoot).find(name => name.startsWith(secondSha.slice(0, 12)));
    const startupLog = path.join(startupEvidenceRoot, startupEvidenceImage, 'farming-server-start.log');
    assert.strictEqual(fs.readFileSync(startupLog, 'utf8'), `${daemonSecretSentinel}\n`);
    assert.strictEqual(fs.statSync(startupLog).mode & 0o777, 0o600);
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
    const failureEvidenceRoot = path.join(`${remoteDir}.deploy`, 'failures');
    const failureEvidenceImage = fs.readdirSync(failureEvidenceRoot).find(name => name.startsWith(thirdSha.slice(0, 12)));
    assert(failureEvidenceImage, 'rollback retains image-keyed diagnostic logs');
    const failureLog = path.join(failureEvidenceRoot, failureEvidenceImage, 'farming-server.log');
    assert.strictEqual(fs.readFileSync(failureLog, 'utf8'), 'private diagnostic fixture');
    assert.strictEqual(fs.statSync(failureLog).mode & 0o777, 0o600);
    assert.doesNotMatch(`${failedResult.stdout}\n${failedResult.stderr}`, new RegExp(daemonSecretSentinel));
    assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
    assert.strictEqual(
      fs.readFileSync(path.join(configDir, 'durable-state.txt'), 'utf8'),
      'state-owned-by-previous-image',
      'rollback must restore Config state from before the failed image started',
    );
    assert(!fs.readdirSync(`${remoteDir}.deploy/images`).some(name => name.startsWith(thirdSha.slice(0, 12))), 'reconciled failed-smoke image must be reclaimed');
    const eventsAfterRollback = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
    assert(eventsAfterRollback.split('\n').filter(line => line.startsWith(`daemon:${firstImage}`)).length >= 2);

    // A manual npm-managed launch can serve this Config from a newer package
    // than the install selection. Rollback must restart that exact package
    // rather than downgrading to the selected image, using exact Config and
    // process-identity ownership.
    const readProcessIdentity = pid => {
      const out = spawnSync('ps', ['-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart='], {
        encoding: 'utf8',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      });
      assert.strictEqual(out.status, 0, out.stderr);
      const match = out.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      assert(match, `unexpected ps output: ${out.stdout}`);
      return {
        format: 'ps-lstart-c-utc-v1',
        pid: Number(match[1]),
        processGroupId: Number(match[2]),
        startedAt: match[3].trim(),
      };
    };
    const canonicalConfig = fs.realpathSync(configDir);
    const otherConfigDir = path.join(root, 'other-config');
    fs.mkdirSync(otherConfigDir, { recursive: true });
    const npmRoot = path.join(root, 'npm-live', 'lib', 'node_modules', 'farming-code');
    const otherNpmRoot = path.join(root, 'npm-other', 'lib', 'node_modules', 'farming-code');
    for (const pkgRoot of [npmRoot, otherNpmRoot]) {
      fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(pkgRoot, 'backend'), { recursive: true });
      fs.copyFileSync(path.join(firstImage, 'bin', 'farming'), path.join(pkgRoot, 'bin', 'farming'));
      fs.writeFileSync(path.join(pkgRoot, 'backend', 'farming-app-cli.cjs'), 'setInterval(() => {}, 1000);\n');
    }
    const liveNpmServer = spawn(process.execPath, [path.join(npmRoot, 'backend', 'farming-app-cli.cjs')], {
      stdio: 'ignore',
      env: { ...process.env, FARMING_CONFIG_DIR: canonicalConfig },
    });
    const otherConfigServer = spawn(process.execPath, [path.join(otherNpmRoot, 'backend', 'farming-app-cli.cjs')], {
      stdio: 'ignore',
      env: { ...process.env, FARMING_CONFIG_DIR: fs.realpathSync(otherConfigDir) },
    });
    const legacyNpmServer = spawn(process.execPath, [path.join(npmRoot, 'backend', 'farming-app-cli.cjs')], {
      stdio: 'ignore',
    });
    const unidentifiedServer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      env: { ...process.env, FARMING_CONFIG_DIR: canonicalConfig },
    });
    const serverRecord = path.join(configDir, 'farming-server.json');
    try {
      await waitForFile(`/proc/${liveNpmServer.pid}/cmdline`);
      const liveNpmIdentity = readProcessIdentity(liveNpmServer.pid);
      fs.writeFileSync(serverRecord, JSON.stringify({
        pid: liveNpmServer.pid,
        configDir: canonicalConfig,
        processIdentity: liveNpmIdentity,
        port: 16694,
        basePath: '/farming',
      }));
      const eventsBeforeLiveRollback = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
      const liveSha = '6'.repeat(40);
      const liveFailing = writeFixtureBundle(root, { gitSha: liveSha, smokeExitCode: 7 });
      const liveResult = activate(liveFailing, liveSha, remoteDir, configDir);
      assert.notStrictEqual(liveResult.status, 0);
      assert.match(liveResult.stderr, /outside the install selection; rollback will restart that package/);
      assert.match(liveResult.stderr, /previously running Farming package was restored/);
      assert.strictEqual(fs.realpathSync(remoteDir), firstImage, 'rollback still restores the prior selection');
      const liveRollbackEvents = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8')
        .slice(eventsBeforeLiveRollback.length).split('\n');
      assert(liveRollbackEvents.includes(`daemon:${fs.realpathSync(npmRoot)}`), 'rollback restarts the live npm package');
      assert(!liveRollbackEvents.some(line => line.startsWith(`daemon:${firstImage}`)),
        'rollback must not downgrade the live Server to the selected image');

      // Redeploying the already-selected SHA (PREVIOUS_ROOT == IMAGE_ROOT) while
      // the live Server runs a different package must NOT take the in-place fast
      // path: a smoke failure must restore Config and restart the live npm package,
      // and a success must stop/checkpoint and switch the running Server to IMAGE_ROOT.
      fs.writeFileSync(path.join(configDir, 'durable-state.txt'), 'state-owned-by-live-npm');
      fs.writeFileSync(serverRecord, JSON.stringify({
        pid: liveNpmServer.pid,
        configDir: canonicalConfig,
        processIdentity: liveNpmIdentity,
        port: 16694,
        basePath: '/farming',
      }));
      const eventsBeforeSameShaFail = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
      const sameShaFailResult = activate(firstRedeploy, firstSha, remoteDir, configDir, { FIXTURE_FAIL_SMOKE: '1' });
      assert.notStrictEqual(sameShaFailResult.status, 0);
      assert.match(sameShaFailResult.stderr, /outside the install selection; rollback will restart that package/);
      assert.match(sameShaFailResult.stderr, /previously running Farming package was restored/);
      assert.strictEqual(fs.readFileSync(path.join(configDir, 'durable-state.txt'), 'utf8'), 'state-owned-by-live-npm');
      const sameShaFailEvents = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8')
        .slice(eventsBeforeSameShaFail.length).split('\n');
      assert(sameShaFailEvents.some(line => line.startsWith('stop:')), 'same-SHA redeploy over live npm package must stop before starting');
      assert(sameShaFailEvents.includes(`daemon:${fs.realpathSync(npmRoot)}`), 'same-SHA redeploy rollback must restart the live npm package');

      fs.writeFileSync(serverRecord, JSON.stringify({
        pid: liveNpmServer.pid,
        configDir: canonicalConfig,
        processIdentity: liveNpmIdentity,
        port: 16694,
        basePath: '/farming',
      }));
      const eventsBeforeSameShaOk = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
      const sameShaOkResult = activate(firstRedeploy, firstSha, remoteDir, configDir);
      assert.strictEqual(sameShaOkResult.status, 0, sameShaOkResult.stderr);
      const sameShaOkEvents = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8')
        .slice(eventsBeforeSameShaOk.length).split('\n');
      assert(sameShaOkEvents.some(line => line.startsWith('stop:')), 'same-SHA redeploy over live npm package must not skip stop');
      assert(sameShaOkEvents.includes(`daemon:${firstImage}`), 'same-SHA redeploy must start the selected image');

      // A stale PID reused by another same-user Farming instance (different
      // FARMING_CONFIG_DIR or mismatched startedAt/configDir) must never be
      // adopted as this Config's rollback package.
      await waitForFile(`/proc/${otherConfigServer.pid}/cmdline`);
      const otherIdentity = readProcessIdentity(otherConfigServer.pid);
      for (const staleRecord of [
        {
          pid: otherConfigServer.pid,
          configDir: canonicalConfig,
          processIdentity: { ...otherIdentity, startedAt: 'Thu Jan  1 00:00:00 1970' },
        },
        {
          pid: otherConfigServer.pid,
          configDir: fs.realpathSync(otherConfigDir),
          processIdentity: otherIdentity,
        },
        {
          pid: otherConfigServer.pid,
          configDir: canonicalConfig,
          processIdentity: otherIdentity,
        },
      ]) {
        fs.writeFileSync(serverRecord, JSON.stringify(staleRecord));
        const eventsBeforeStale = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
        const staleSha = '8'.repeat(40);
        const staleFailing = writeFixtureBundle(root, { gitSha: staleSha, smokeExitCode: 7 });
        const staleResult = activate(staleFailing, staleSha, remoteDir, configDir);
        assert.notStrictEqual(staleResult.status, 0);
        assert.doesNotMatch(staleResult.stderr, /outside the install selection/);
        assert.match(staleResult.stderr, /previous image was restored/i);
        const staleEvents = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8')
          .slice(eventsBeforeStale.length).split('\n');
        assert(!staleEvents.includes(`daemon:${fs.realpathSync(otherNpmRoot)}`),
          'stale or other-Config PID must never hijack rollback to another Config package');
        assert(staleEvents.includes(`daemon:${firstImage}`), 'rollback falls back to the selected image');
      }

      // A legacy record without processIdentity pointing to a live Server
      // outside the selection cannot prove Config ownership and must refuse before stop.
      await waitForFile(`/proc/${legacyNpmServer.pid}/cmdline`);
      fs.writeFileSync(serverRecord, JSON.stringify({ pid: legacyNpmServer.pid, configDir: canonicalConfig }));
      const eventsBeforeUnproven = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
      const unprovenSha = '9'.repeat(40);
      const unproven = writeFixtureBundle(root, { gitSha: unprovenSha });
      const unprovenResult = activate(unproven, unprovenSha, remoteDir, configDir);
      assert.notStrictEqual(unprovenResult.status, 0);
      assert.match(unprovenResult.stderr, /cannot prove it belongs to this Config; refusing to stop it/);
      assert(!fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8')
        .slice(eventsBeforeUnproven.length).includes('stop:'), 'unproven live package outside selection must refuse before stop');
      assert(!fs.readdirSync(`${remoteDir}.deploy/images`).some(name => name.startsWith(unprovenSha.slice(0, 12))));

      await waitForFile(`/proc/${unidentifiedServer.pid}/cmdline`);
      fs.writeFileSync(serverRecord, JSON.stringify({
        pid: unidentifiedServer.pid,
        configDir: canonicalConfig,
        processIdentity: readProcessIdentity(unidentifiedServer.pid),
      }));
      const eventsBeforeUnidentified = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
      const unidentifiedSha = '7'.repeat(40);
      const unidentified = writeFixtureBundle(root, { gitSha: unidentifiedSha });
      const unidentifiedResult = activate(unidentified, unidentifiedSha, remoteDir, configDir);
      assert.notStrictEqual(unidentifiedResult.status, 0);
      assert.match(unidentifiedResult.stderr, /unidentified package; refusing to stop it/);
      assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
      assert(!fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8')
        .slice(eventsBeforeUnidentified.length).includes('stop:'), 'an unidentified live package must refuse before stop');
      assert(!fs.readdirSync(`${remoteDir}.deploy/images`).some(name => name.startsWith(unidentifiedSha.slice(0, 12))));
    } finally {
      fs.rmSync(serverRecord, { force: true });
      liveNpmServer.kill('SIGKILL');
      otherConfigServer.kill('SIGKILL');
      legacyNpmServer.kill('SIGKILL');
      unidentifiedServer.kill('SIGKILL');
    }

    const eventsBeforePreflight = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
    const fourthSha = '4'.repeat(40);
    const invalidNative = writeFixtureBundle(root, { gitSha: fourthSha, invalidNodePty: true });
    const preflightResult = activate(invalidNative, fourthSha, remoteDir, configDir);
    assert.notStrictEqual(preflightResult.status, 0);
    assert.match(preflightResult.stderr, /invalid node-pty fixture/);
    assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
    assert.strictEqual(fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8'), eventsBeforePreflight);

    assert(!fs.readdirSync(`${remoteDir}.deploy/images`).some(name => name.startsWith(fourthSha.slice(0, 12))), 'failed native preflight image must be reclaimed');

    const stubDir = path.join(root, 'capacity-stubs');
    const lowMarker = path.join(root, 'low-space');
    fs.mkdirSync(stubDir);
    fs.writeFileSync(path.join(stubDir, 'df'), [
      '#!/usr/bin/env bash',
      `if [ -f '${lowMarker}' ]; then`,
      "  printf 'Filesystem 1B-blocks Used Available Capacity Mounted\\nfixture 100 100 0 100%% /\\n'",
      'else',
      '  exec /bin/df "$@"',
      'fi',
      '',
    ].join('\n'), { mode: 0o755 });
    const capacityEnv = { PATH: `${stubDir}:${process.env.PATH}` };
    const capacitySha = 'b'.repeat(40);
    const capacityFixture = writeFixtureBundle(root, { gitSha: capacitySha });
    const eventsBeforeCapacity = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8');
    fs.writeFileSync(lowMarker, 'low');
    const insufficient = activate(capacityFixture, capacitySha, remoteDir, configDir, capacityEnv);
    assert.notStrictEqual(insufficient.status, 0);
    assert.match(insufficient.stderr, /Insufficient disk space before preparation/);
    assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
    assert.strictEqual(fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8'), eventsBeforeCapacity,
      'capacity refusal must precede preparation and stop');
    fs.rmSync(lowMarker);
    const insufficientAfterPrepare = activate(capacityFixture, capacitySha, remoteDir, configDir, {
      ...capacityEnv, FIXTURE_LOW_SPACE_MARKER: lowMarker,
    });
    assert.notStrictEqual(insufficientAfterPrepare.status, 0);
    assert.match(insufficientAfterPrepare.stderr, /Insufficient disk space before Config checkpoint/);
    assert.strictEqual(fs.realpathSync(remoteDir), firstImage);
    const addedEvents = fs.readFileSync(path.join(configDir, 'fixture-events.log'), 'utf8').slice(eventsBeforeCapacity.length);
    assert.match(addedEvents, /^runtime:/);
    assert(!addedEvents.includes('stop:'), 'capacity lost during preparation must refuse before stop');
    assert(!fs.readdirSync(`${remoteDir}.deploy/images`).some(name => name.startsWith(capacitySha.slice(0, 12))),
      'capacity failure must not accumulate a prepared image');
    fs.rmSync(lowMarker);

    const lockFile = `${remoteDir}.deploy/deploy.lock`;
    const readyFile = path.join(root, 'lock-ready');
    const lockHolder = spawn('bash', ['-c', 'exec 9>"$1"; flock -n 9 || exit 1; exec "$2" -e "$3"',
      'fixture-lock', lockFile, process.execPath,
      `require('fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setInterval(() => {}, 1000);`], {
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
      const stopped = new Promise<void>((resolve, reject) => {
        if (lockHolder.exitCode !== null || lockHolder.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => reject(new Error('fixture lock holder did not exit')), 5_000);
        lockHolder.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      lockHolder.kill('SIGKILL');
      await stopped;
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
