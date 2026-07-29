const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storageLayout = require('../storage-layout');
const {
  MANIFEST_FORMAT,
  ManagedChromiumInstaller,
  findBrowserExecutable,
} = require('../../extensions/browser/backend/managed-chromium-installer');

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
  await testAgentBrowserUpgradeRequiresMatchingChromium();
  console.log('managed Chromium installer tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
