const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const { TokenAuth, farmingAuthCookieName } = require('../auth.cjs');
const {
  canonicalConfigDir,
  configInstanceFingerprint,
} = require('../config-instance.cjs');
const { ConfigManager } = require('../config-manager.cjs');
const {
  buildServerEnv,
  canonicalizeServerConfigDir,
} = require('../farming-app-cli.cjs');
const {
  nativePtyHostPrivateSocketPath,
  nativePtyHostSocketPath,
} = require('../native-pty-host-path.cjs');
const { dependencyCacheDir } = require('../runtime-dependency-manager.cjs');
const storageLayout = require('../storage-layout.cjs');
const {
  namespaceForResource,
} = require('../../extensions/browser/backend/agent-browser-runtime.cjs');
const {
  BrowserResourceManager,
} = require('../../extensions/browser/backend/browser-resource-manager.cjs');
const {
  ComputerResourceManager,
} = require('../../extensions/computer/backend/computer-resource-manager.cjs');
const {
  IsolatedBrowserProvider,
} = require('../../extensions/computer/backend/isolated-browser-provider.cjs');

const CLI = path.join(__dirname, '..', 'farming-app-cli.cjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('test port did not resolve to an IPv4 address'));
        return;
      }
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd: path.join(__dirname, '..', '..'),
      env,
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout || ''), stderr: String(stderr || '') }));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function requestWithToken(port: number, token: string): Promise<{
  status: number | undefined;
  setCookie: string;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      method: 'GET',
      path: `/farming/?token=${encodeURIComponent(token)}`,
      port,
      timeout: 5_000,
    }, response => {
      response.resume();
      response.once('end', () => resolve({
        status: response.statusCode,
        setCookie: String(response.headers['set-cookie']?.[0] || ''),
      }));
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('server request timed out')));
    request.end();
  });
}

function readPid(configDir: string): number {
  try {
    return Number(fs.readFileSync(storageLayout.serverPidFile(configDir), 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

async function stopExactServer(configDir: string, port: number, env: NodeJS.ProcessEnv): Promise<void> {
  const pid = readPid(configDir);
  try {
    await runCli(['stop', '--config-dir', configDir, '--port', String(port)], env);
    return;
  } catch {
    if (pid <= 0) return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          resolve();
          return;
        }
      }
      if (Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function assertConfigOwnedPathsAreDisjoint(configA: string, configB: string): void {
  const pathsFor = (configDir: string) => [
    storageLayout.settingsFile(configDir),
    storageLayout.themeSettingsFile(configDir),
    storageLayout.sessionTokenFile(configDir),
    storageLayout.sessionIndexFile(configDir),
    storageLayout.acpCheckpointsDir(configDir),
    storageLayout.runHistoryFile(configDir),
    storageLayout.reviewStateFile(configDir),
    storageLayout.reviewSessionsFile(configDir),
    storageLayout.usageHistoryCacheFile(configDir),
    storageLayout.agentSessionInventoryCacheFile(configDir),
    storageLayout.agentExtensionInventoryCacheFile(configDir),
    storageLayout.browserResourcesFile(configDir),
    storageLayout.browserProfileDir(configDir, 'browser_same'),
    storageLayout.computerResourcesFile(configDir),
    storageLayout.runtimeDependenciesActiveFile(configDir),
    storageLayout.runtimeDependencyBindingFile(configDir, 'binding_same'),
    storageLayout.managedChromiumVersionDir(configDir, '1.0.0', 'test-platform'),
    storageLayout.farmingAgentBootstrapFile(configDir),
    storageLayout.serverPidFile(configDir),
    storageLayout.serverStateFile(configDir),
    storageLayout.serverOwnerFile(configDir),
    storageLayout.serverLogFile(configDir),
    storageLayout.nativePtyHostLogFile(configDir),
    storageLayout.nativePtyControllerGenerationFile(configDir),
    storageLayout.nativePtyRuntimeGenerationFile(configDir),
    storageLayout.updateStateFile(configDir),
    storageLayout.updateLogFile(configDir),
    storageLayout.updateStagingDir(configDir),
  ].map(candidate => path.resolve(candidate));

  const pathsA = pathsFor(configA);
  const pathsB = new Set(pathsFor(configB));
  for (const ownedPath of pathsA) {
    assert.strictEqual(pathsB.has(ownedPath), false, `Config-owned path leaked across instances: ${ownedPath}`);
    assert(
      ownedPath === configA || ownedPath.startsWith(`${configA}${path.sep}`),
      `Config-owned path escaped its instance root: ${ownedPath}`,
    );
  }
}

async function run(): Promise<void> {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-multi-config-isolation-'));
  const configAInput = path.join(fixtureRoot, 'config-a');
  const configBInput = path.join(fixtureRoot, 'config-b');
  const configALink = path.join(fixtureRoot, 'config-a-link');
  fs.mkdirSync(configAInput);
  fs.mkdirSync(configBInput);
  fs.symlinkSync(configAInput, configALink, process.platform === 'win32' ? 'junction' : 'dir');

  const configA = canonicalConfigDir(configAInput);
  const configB = canonicalConfigDir(configBInput);
  const portA = await freePort();
  const portB = await freePort();
  const testEnv = {
    ...process.env,
    FARMING_BASE_PATH: '/farming',
    FARMING_DISABLE_AUTH: '',
    FARMING_NATIVE_PTY_HOST_PERSIST: '0',
    FARMING_SKIP_RUNTIME_PREPARE: '1',
    FARMING_START_STABILITY_MS: '0',
    NODE_ENV: 'test',
  };
  let startedA = false;
  let startedB = false;

  try {
    assert.strictEqual(canonicalConfigDir(configALink), configA);
    assert.notStrictEqual(configA, configB);
    assert.strictEqual(configInstanceFingerprint(configALink), configInstanceFingerprint(configA));
    assert.notStrictEqual(configInstanceFingerprint(configA), configInstanceFingerprint(configB));

    const envA = canonicalizeServerConfigDir(buildServerEnv({}, {
      ...testEnv,
      FARMING_CONFIG_DIR: configALink,
      PORT: String(portA),
    }));
    const envB = canonicalizeServerConfigDir(buildServerEnv({}, {
      ...testEnv,
      FARMING_CONFIG_DIR: configB,
      PORT: String(portB),
    }));
    assert.strictEqual(envA.FARMING_CONFIG_DIR, configA);
    assert.strictEqual(envB.FARMING_CONFIG_DIR, configB);
    assert.notStrictEqual(envA.PORT, envB.PORT);

    assertConfigOwnedPathsAreDisjoint(configA, configB);
    assert.notStrictEqual(
      dependencyCacheDir(configA, 'agentBrowser', '1.0.0', 'test-platform'),
      dependencyCacheDir(configB, 'agentBrowser', '1.0.0', 'test-platform'),
    );

    const socketA = nativePtyHostSocketPath(configA);
    const socketB = nativePtyHostSocketPath(configB);
    assert.strictEqual(nativePtyHostSocketPath(configALink), socketA);
    assert.notStrictEqual(socketA, socketB);
    assert.notStrictEqual(
      nativePtyHostPrivateSocketPath(socketA, { pid: 100, nonce: 'same' }),
      nativePtyHostPrivateSocketPath(socketB, { pid: 100, nonce: 'same' }),
    );

    assert.strictEqual(
      namespaceForResource(configALink, 'browser_same', 1),
      namespaceForResource(configA, 'browser_same', 1),
    );
    assert.notStrictEqual(
      namespaceForResource(configA, 'browser_same', 1),
      namespaceForResource(configB, 'browser_same', 1),
    );

    const browserA = new BrowserResourceManager({ configDir: configALink });
    const browserB = new BrowserResourceManager({ configDir: configB });
    assert.strictEqual(browserA.configDir, configA);
    assert.notStrictEqual(browserA.store.file, browserB.store.file);

    const noDocker = async () => ({ stdout: '', stderr: '' });
    const computerA = new ComputerResourceManager({ configDir: configALink, dockerRunner: noDocker });
    const computerB = new ComputerResourceManager({ configDir: configB, dockerRunner: noDocker });
    assert.strictEqual(computerA.configFingerprint, configInstanceFingerprint(configA));
    assert.notStrictEqual(computerA.configFingerprint, computerB.configFingerprint);
    assert.notStrictEqual(
      computerA.containerName({ id: 'computer_same' }),
      computerB.containerName({ id: 'computer_same' }),
    );

    const installer = {
      browserOption: () => null,
      install: async () => ({}),
      status: () => ({}),
    };
    const isolatedA = new IsolatedBrowserProvider({
      configDir: configALink,
      computerResourceManager: computerA,
      chromiumInstaller: installer,
      dockerRunner: noDocker,
    });
    const isolatedB = new IsolatedBrowserProvider({
      configDir: configB,
      computerResourceManager: computerB,
      chromiumInstaller: installer,
      dockerRunner: noDocker,
    });
    assert.strictEqual(isolatedA.configFingerprint, computerA.configFingerprint);
    assert.notStrictEqual(isolatedA.configFingerprint, isolatedB.configFingerprint);

    const settingsA = new ConfigManager({ configDir: configA });
    const settingsB = new ConfigManager({ configDir: configB });
    settingsA.init();
    settingsB.init();
    settingsA.updateSettings({ language: 'zh' });
    assert.strictEqual(settingsA.getSettings().language, 'zh');
    assert.strictEqual(settingsB.getSettings().language, 'en');
    assert.notStrictEqual(settingsA.settingsFile, settingsB.settingsFile);

    const authA = new TokenAuth({ basePath: '/farming', farmingDir: configALink, token: 'token-a' });
    const authB = new TokenAuth({ basePath: '/farming', farmingDir: configB, token: 'token-b' });
    assert.strictEqual(authA.getCookieName(), farmingAuthCookieName(configA));
    assert.notStrictEqual(authA.getCookieName(), authB.getCookieName());
    assert.strictEqual(fs.readFileSync(storageLayout.sessionTokenFile(configA), 'utf8'), 'token-a');
    assert.strictEqual(fs.readFileSync(storageLayout.sessionTokenFile(configB), 'utf8'), 'token-b');

    await runCli([
      'daemon', '--config-dir', configALink, '--port', String(portA), '--base-path', '/farming',
    ], testEnv);
    startedA = true;
    await runCli([
      'daemon', '--config-dir', configB, '--port', String(portB), '--base-path', '/farming',
    ], testEnv);
    startedB = true;

    const stateA = JSON.parse(fs.readFileSync(storageLayout.serverStateFile(configA), 'utf8'));
    const stateB = JSON.parse(fs.readFileSync(storageLayout.serverStateFile(configB), 'utf8'));
    assert.strictEqual(stateA.configDir, configA);
    assert.strictEqual(stateB.configDir, configB);
    assert.strictEqual(stateA.port, portA);
    assert.strictEqual(stateB.port, portB);
    assert.notStrictEqual(stateA.pid, stateB.pid);

    const responseA = await requestWithToken(portA, 'token-a');
    const responseB = await requestWithToken(portB, 'token-b');
    assert.strictEqual(responseA.status, 200);
    assert.strictEqual(responseB.status, 200);
    assert.match(responseA.setCookie, new RegExp(`^${farmingAuthCookieName(configA)}=token-a; Path=/farming;`));
    assert.match(responseB.setCookie, new RegExp(`^${farmingAuthCookieName(configB)}=token-b; Path=/farming;`));
    assert.notStrictEqual(responseA.setCookie.split('=', 1)[0], responseB.setCookie.split('=', 1)[0]);

    console.log('test-multi-config-isolation passed');
  } finally {
    if (startedB || readPid(configB) > 0) await stopExactServer(configB, portB, testEnv);
    if (startedA || readPid(configA) > 0) await stopExactServer(configA, portA, testEnv);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error?.stderr || error);
  process.exitCode = 1;
});
