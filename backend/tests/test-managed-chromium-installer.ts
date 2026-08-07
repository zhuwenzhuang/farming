const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storageLayout = require('../storage-layout.cjs');
const {
  CHROMIUM_DOWNLOADS,
  GOOGLE_METADATA_URL,
  MANIFEST_FORMAT,
  NPMMIRROR_ARCHIVE_ROOT,
  NPMMIRROR_METADATA_URL,
  PINNED_CHROMIUM_VERSION,
  ManagedChromiumInstaller,
  downloadFile,
  findBrowserExecutable,
  installFromNpmMirror,
  probeChromiumInstallSources,
} = require('../../extensions/browser/backend/managed-chromium-installer.cjs');

function writeFakeChrome(rootDir, platform = 'linux') {
  const relativePath = platform === 'darwin'
    ? path.join(
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    )
    : platform === 'win32'
      ? path.join('chrome-win64', 'chrome.exe')
      : path.join('chrome-linux64', 'chrome');
  const executablePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, 'fake chrome');
  fs.chmodSync(executablePath, 0o755);
  return executablePath;
}

function installerOptions(configDir, overrides = {}) {
  return {
    configDir,
    platform: 'linux',
    arch: 'x64',
    musl: false,
    env: {
      HOME: path.join(configDir, 'unrelated-home'),
      FARMING_AGENT_BROWSER_BIN: '/managed/agent-browser',
    },
    verifyAgentBrowser: async executablePath => ({
      valid: executablePath === '/managed/agent-browser',
    }),
    verifyBrowser: async executablePath => {
      assert.strictEqual(fs.existsSync(executablePath), true);
      return 'Google Chrome for Testing 151.0.7922.47';
    },
    resolveInstallSources: async () => [{
      id: 'google',
      label: 'Google Chrome for Testing',
      kind: 'agent-browser',
    }],
    ...overrides,
  };
}

async function testInstallPublishesOnlyAfterVerification() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-chromium-'));
  let installCalls = 0;
  let releaseInstall;
  const installGate = new Promise(resolve => { releaseInstall = resolve; });
  let installStarted;
  const installStartedGate = new Promise(resolve => { installStarted = resolve; });
  const installer = new ManagedChromiumInstaller(installerOptions(configDir, {
    runInstallCommand: async (_binary, args, options) => {
      installCalls += 1;
      assert.deepStrictEqual(args, ['install']);
      assert.strictEqual(
        options.env.PLAYWRIGHT_BROWSERS_PATH.startsWith(
          storageLayout.managedChromiumRootDir(configDir),
        ),
        true,
      );
      assert.strictEqual(
        options.env.HOME.startsWith(options.env.PLAYWRIGHT_BROWSERS_PATH),
        true,
      );
      writeFakeChrome(options.env.PLAYWRIGHT_BROWSERS_PATH);
      installStarted();
      await installGate;
    },
  }));

  try {
    assert.deepStrictEqual(installer.status(), {
      state: 'absent',
      agentBrowserVersion: '0.32.3',
      installedVersion: '',
      updateAvailable: false,
      error: '',
    });
    const first = installer.install();
    const second = installer.install();
    await installStartedGate;
    let crossProcessWaitStarted;
    const crossProcessWaitGate = new Promise(resolve => { crossProcessWaitStarted = resolve; });
    const secondInstaller = new ManagedChromiumInstaller(installerOptions(configDir, {
      runInstallCommand: async () => {
        throw new Error('a joined installer must not start a second download');
      },
      wait: async () => {
        crossProcessWaitStarted();
        await new Promise(resolve => setImmediate(resolve));
      },
    }));
    const crossProcessJoin = secondInstaller.install();
    await crossProcessWaitGate;
    assert.strictEqual(installer.status().state, 'installing');
    assert.strictEqual(secondInstaller.status().state, 'installing');
    assert.strictEqual(fs.existsSync(installer.targetDir()), false);
    releaseInstall();
    const [result, joinedResult, crossProcessResult] = await Promise.all([
      first,
      second,
      crossProcessJoin,
    ]);
    assert.strictEqual(joinedResult.state, 'ready');
    assert.strictEqual(crossProcessResult.state, 'ready');
    assert.strictEqual(installCalls, 1);
    assert.strictEqual(result.state, 'ready');
    assert.strictEqual(installer.status().state, 'ready');
    const option = installer.browserOption();
    assert.strictEqual(option.kind, 'managed-chromium');
    assert.strictEqual(option.path.startsWith(installer.targetDir()), true);
    assert.strictEqual(findBrowserExecutable(installer.targetDir(), { platform: 'linux' }), option.path);
    const manifest = JSON.parse(fs.readFileSync(installer.manifestFile(), 'utf8'));
    assert.strictEqual(manifest.format, MANIFEST_FORMAT);
    assert.strictEqual(manifest.agentBrowserVersion, '0.32.3');
    assert.strictEqual(manifest.platformKey, 'linux-x64');
    assert.strictEqual(manifest.downloadSource, 'google');
    assert.strictEqual(fs.existsSync(path.join(installer.targetDir(), '.home')), false);
    assert.strictEqual(fs.existsSync(path.join(configDir, 'unrelated-home')), false);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testFailureDoesNotPublishAndCanRetry() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-chromium-failure-'));
  let fail = true;
  const installer = new ManagedChromiumInstaller(installerOptions(configDir, {
    runInstallCommand: async (_binary, _args, options) => {
      writeFakeChrome(options.env.PLAYWRIGHT_BROWSERS_PATH);
      if (fail) throw new Error('download interrupted');
    },
  }));

  try {
    await assert.rejects(installer.install(), /download interrupted/);
    assert.strictEqual(installer.status().state, 'failed');
    assert.match(installer.status().error, /download interrupted/);
    assert.strictEqual(fs.existsSync(installer.targetDir()), false);
    const parentEntries = fs.readdirSync(path.dirname(installer.targetDir()));
    assert.deepStrictEqual(parentEntries.filter(name => name.startsWith('.staging-')), []);

    fail = false;
    assert.strictEqual((await installer.install()).state, 'ready');
    assert.strictEqual(installer.status().error, '');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testNetworkProbeKeepsPinnedMirrorArtifact() {
  for (const artifact of Object.values(CHROMIUM_DOWNLOADS) as Array<{ sha256: string }>) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  }
  const requested = [];
  const sources = await probeChromiumInstallSources({
    platform: 'linux',
    arch: 'x64',
    fetchJson: async url => {
      requested.push(url);
      if (url === GOOGLE_METADATA_URL) throw new Error('official source blocked');
      assert.strictEqual(url, NPMMIRROR_METADATA_URL);
      return { channels: { Stable: { version: '999.0.0.0' } } };
    },
  });

  assert.deepStrictEqual(
    requested.sort(),
    [GOOGLE_METADATA_URL, NPMMIRROR_METADATA_URL].sort(),
  );
  assert.strictEqual(sources[0].id, 'npmmirror');
  assert.strictEqual(sources[0].version, PINNED_CHROMIUM_VERSION);
  assert.strictEqual(sources[0].sha256, CHROMIUM_DOWNLOADS['linux-x64'].sha256);
  assert.strictEqual(sources[0].available, true);
  assert.strictEqual(sources[1].id, 'google');
  assert.strictEqual(sources[1].available, false);
}

async function testMirrorUsesPinnedArchiveAndDigest() {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-chromium-mirror-'));
  let downloadedUrl = '';
  let expectedSha256 = '';
  try {
    await installFromNpmMirror({}, destination, {
      platform: 'darwin',
      arch: 'arm64',
      downloadFile: async (url, archivePath, sha256) => {
        downloadedUrl = url;
        expectedSha256 = sha256;
        fs.writeFileSync(archivePath, 'fake archive');
      },
      extractArchive: async (_archivePath, options) => {
        writeFakeChrome(options.dir, 'darwin');
      },
    });
    assert.strictEqual(
      downloadedUrl,
      `${NPMMIRROR_ARCHIVE_ROOT}/${PINNED_CHROMIUM_VERSION}/mac-arm64/chrome-mac-arm64.zip`,
    );
    assert.strictEqual(expectedSha256, CHROMIUM_DOWNLOADS['darwin-arm64'].sha256);
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

async function testDownloadRejectsUntrustedArchive() {
  const destination = path.join(os.tmpdir(), `farming-chromium-download-${crypto.randomUUID()}`);
  const payload = Buffer.from('chromium archive');
  const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');
  await downloadFile('https://example.test/chrome.zip', destination, expectedSha256, {
    fetchImpl: async () => new Response(payload),
  });
  assert.deepStrictEqual(fs.readFileSync(destination), payload);
  fs.rmSync(destination, { force: true });

  await assert.rejects(
    downloadFile('https://example.test/chrome.zip', destination, '0'.repeat(64), {
      fetchImpl: async () => new Response(payload),
    }),
    error => error.code === 'CHROMIUM_INTEGRITY_FAILED',
  );
  assert.strictEqual(fs.existsSync(destination), false);
}

async function testFailedSourceContinuesWithVerifiedMirror() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-chromium-sources-'));
  const attempts = [];
  const installer = new ManagedChromiumInstaller(installerOptions(configDir, {
    resolveInstallSources: async () => [
      { id: 'google', label: 'Google Chrome for Testing', kind: 'agent-browser' },
      {
        id: 'npmmirror',
        label: 'npmmirror',
        kind: 'mirror',
        version: PINNED_CHROMIUM_VERSION,
        sha256: CHROMIUM_DOWNLOADS['linux-x64'].sha256,
      },
    ],
    runInstallCommand: async () => {
      attempts.push('google');
      throw new Error('official source reset the connection');
    },
    installFromMirror: async (_source, destination) => {
      attempts.push('npmmirror');
      writeFakeChrome(destination);
    },
  }));

  try {
    assert.strictEqual((await installer.install()).state, 'ready');
    assert.deepStrictEqual(attempts, ['google', 'npmmirror']);
    const manifest = JSON.parse(fs.readFileSync(installer.manifestFile(), 'utf8'));
    assert.strictEqual(manifest.downloadSource, 'npmmirror');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testUnprovenInstallerExitStopsFallback() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-chromium-unproven-'));
  let mirrorStarted = false;
  const installer = new ManagedChromiumInstaller(installerOptions(configDir, {
    resolveInstallSources: async () => [
      { id: 'google', label: 'Google Chrome for Testing', kind: 'agent-browser' },
      { id: 'npmmirror', label: 'npmmirror', kind: 'mirror' },
    ],
    runInstallCommand: async () => {
      const error = Object.assign(new Error('installer exit could not be proven'), {
        cleanupUnproven: true,
      });
      throw error;
    },
    installFromMirror: async () => {
      mirrorStarted = true;
    },
  }));

  try {
    await assert.rejects(installer.install(), /exit could not be proven/);
    assert.strictEqual(mirrorStarted, false);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testAgentBrowserUpgradeRequiresMatchingChromium() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-chromium-upgrade-'));
  const install = async version => {
    const installer = new ManagedChromiumInstaller(installerOptions(configDir, {
      agentBrowserVersion: version,
      runInstallCommand: async (_binary, _args, options) => {
        writeFakeChrome(options.env.PLAYWRIGHT_BROWSERS_PATH);
      },
    }));
    await installer.install();
    return installer;
  };

  try {
    await install('0.31.1');
    const current = new ManagedChromiumInstaller(installerOptions(configDir, {
      runInstallCommand: async (_binary, _args, options) => {
        writeFakeChrome(options.env.PLAYWRIGHT_BROWSERS_PATH);
      },
    }));
    assert.deepStrictEqual(current.status(), {
      state: 'absent',
      agentBrowserVersion: '0.32.3',
      installedVersion: '0.31.1',
      updateAvailable: true,
      error: '',
    });
    assert.strictEqual(current.browserOption(), null);
    await current.install();
    assert.strictEqual(current.status().state, 'ready');
    assert.strictEqual(
      fs.existsSync(storageLayout.managedChromiumVersionDir(
        configDir,
        '0.31.1',
        'linux-x64',
      )),
      true,
      'the old version remains available until a separately funded pruning policy removes it',
    );
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function run() {
  await testInstallPublishesOnlyAfterVerification();
  await testFailureDoesNotPublishAndCanRetry();
  await testNetworkProbeKeepsPinnedMirrorArtifact();
  await testMirrorUsesPinnedArchiveAndDigest();
  await testDownloadRejectsUntrustedArchive();
  await testFailedSourceContinuesWithVerifiedMirror();
  await testUnprovenInstallerExitStopsFallback();
  await testAgentBrowserUpgradeRequiresMatchingChromium();
  console.log('managed Chromium installer tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
