const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storageLayout = require('../storage-layout');
const ThemeManager = require('../theme-manager');

function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-storage-layout-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-storage-home-'));
  const previousHome = process.env.HOME;
  const previousConfigDir = process.env.FARMING_CONFIG_DIR;

  try {
    process.env.HOME = homeDir;
    delete process.env.FARMING_CONFIG_DIR;

    assert.strictEqual(storageLayout.farmingConfigDir({ HOME: homeDir }), path.join(homeDir, '.farming'));
    assert.strictEqual(storageLayout.settingsFile(configDir), path.join(configDir, 'settings.json'));
    assert.strictEqual(storageLayout.themeSettingsFile(configDir), path.join(configDir, 'theme-settings.json'));
    assert.strictEqual(storageLayout.sessionTokenFile(configDir), path.join(configDir, '.session-token'));
    assert.strictEqual(storageLayout.sessionsDir(configDir), path.join(configDir, 'sessions'));
    assert.strictEqual(storageLayout.sessionIndexFile(configDir), path.join(configDir, 'sessions', 'index.json'));
    assert.strictEqual(storageLayout.historyDir(configDir), path.join(configDir, 'history'));
    assert.strictEqual(storageLayout.runHistoryFile(configDir), path.join(configDir, 'history', 'runs.json'));
    assert.strictEqual(storageLayout.reviewStateFile(configDir), path.join(configDir, 'history', 'review-state.json'));
    assert.strictEqual(
      storageLayout.usageHistoryCacheFile(configDir),
      path.join(configDir, 'history', 'usage-history-v2.sqlite3'),
    );
    assert.strictEqual(storageLayout.serverPidFile(configDir), path.join(configDir, 'farming-server.pid'));
    assert.strictEqual(storageLayout.serverStateFile(configDir), path.join(configDir, 'farming-server.json'));
    assert.strictEqual(storageLayout.serverLogFile(configDir), path.join(configDir, 'farming-server.log'));
    assert.strictEqual(storageLayout.nativePtyHostLogFile(configDir), path.join(configDir, 'native-pty-host.log'));
    assert.strictEqual(storageLayout.updateStateFile(configDir), path.join(configDir, 'farming-update.json'));
    assert.strictEqual(storageLayout.updateLogFile(configDir), path.join(configDir, 'farming-update.log'));
    assert.strictEqual(storageLayout.farmingNetInstancesFile(configDir), path.join(configDir, 'instances.json'));
    assert.strictEqual(storageLayout.farmingNetServerStateFile(configDir), path.join(configDir, 'farming-net-server.json'));
    assert.strictEqual(storageLayout.farmingNetServerLogFile(configDir), path.join(configDir, 'farming-net-server.log'));
    assert.strictEqual(
      storageLayout.farmingNetSigningPrivateKeyFile(configDir),
      path.join(configDir, 'signing-private-key.pem'),
    );
    assert.strictEqual(
      storageLayout.farmingNetSigningPublicKeyFile(configDir),
      path.join(configDir, 'signing-public-key.pem'),
    );
    assert.strictEqual(storageLayout.farmingNetTrustFile(configDir), path.join(configDir, 'farming-net-trust.json'));

    const manager = new ThemeManager({ configDir });
    manager.availableThemes = [{ id: 'terminal', defaultSettings: { crtEffects: false } }];
    assert.strictEqual(manager.updateThemeSettings('terminal', { crtEffects: true }), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(storageLayout.themeSettingsFile(configDir), 'utf8')), {
      terminal: { crtEffects: true },
    });
    assert.strictEqual(manager.updateThemeSettings('terminal', { settings: { crtEffects: false } }), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(storageLayout.themeSettingsFile(configDir), 'utf8')), {
      terminal: { crtEffects: false },
    });
    assert.strictEqual(
      fs.existsSync(path.join(homeDir, '.farming', 'theme-settings.json')),
      false,
      'ThemeManager should not leak settings into the default home config dir when configDir is provided',
    );

    process.env.FARMING_CONFIG_DIR = configDir;
    const envManager = new ThemeManager();
    assert.strictEqual(envManager.themeSettingsFile, storageLayout.themeSettingsFile(configDir));

    console.log('test-storage-layout passed');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfigDir === undefined) delete process.env.FARMING_CONFIG_DIR;
    else process.env.FARMING_CONFIG_DIR = previousConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

run();
