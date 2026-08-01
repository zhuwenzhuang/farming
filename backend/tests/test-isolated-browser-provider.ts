const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  LEGACY_ISOLATED_BROWSER_IMAGE_DIGEST,
  IsolatedBrowserProvider,
} = require('../../extensions/computer/backend/isolated-browser-provider.cjs');
const { configInstanceFingerprint } = require('../config-instance.cjs');

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-isolated-browser-provider-'));
  const computerCalls = {
    acquire: [],
    prepared: 0,
    released: [],
    verified: [],
  };
  const computerResourceManager = {
    async capability() {
      return {
        available: true,
        dockerAvailable: true,
        imageReady: true,
        image: 'trycua/xfce-cua:test@sha256:computer',
        imageDigest: 'sha256:computer',
        compatibilityMode: false,
        error: '',
      };
    },
    async prepare() {
      computerCalls.prepared += 1;
    },
    async acquireBrowser(input) {
      computerCalls.acquire.push(input);
      return { cdpUrl: 'http://127.0.0.1:49223', leaseKey: 'computer_1' };
    },
    async releaseBrowser(leaseKey) {
      computerCalls.released.push(leaseKey);
    },
    async verifyBrowserExecutable(executablePath) {
      computerCalls.verified.push(executablePath);
      return 'Chromium 140';
    },
  };
  let chromiumReady = false;
  let chromiumInstallCount = 0;
  const chromiumInstaller = {
    status() {
      return {
        state: chromiumReady ? 'ready' : 'absent',
        error: '',
      };
    },
    browserOption() {
      return chromiumReady
        ? { kind: 'managed-chromium', path: '/tmp/farming/chrome' }
        : null;
    },
    async install() {
      chromiumInstallCount += 1;
      chromiumReady = true;
    },
  };
  const legacyId = 'b'.repeat(64);
  let legacyExists = true;
  let legacyRunning = true;
  const dockerCalls = [];
  const docker = async args => {
    dockerCalls.push([...args]);
    if (args[0] === 'ps') return { stdout: legacyExists ? `${legacyId}\n` : '', stderr: '' };
    if (args[0] === 'inspect') {
      return {
        stdout: JSON.stringify([{
          Id: legacyId,
          Config: {
            Labels: {
              'farming.dev/kind': 'isolated-browser',
              'farming.dev/config': crypto.createHash('sha256')
                .update(configDir)
                .digest('hex')
                .slice(0, 12),
              'farming.dev/image-digest': LEGACY_ISOLATED_BROWSER_IMAGE_DIGEST,
            },
          },
          State: { Running: legacyRunning },
        }]),
        stderr: '',
      };
    }
    if (args[0] === 'stop') {
      legacyRunning = false;
      return { stdout: legacyId, stderr: '' };
    }
    if (args[0] === 'rm') {
      legacyExists = false;
      return { stdout: legacyId, stderr: '' };
    }
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };

  const provider = new IsolatedBrowserProvider({
    configDir,
    computerResourceManager,
    chromiumInstaller,
    dockerRunner: docker,
  });
  try {
    const absent = await provider.capability();
    assert.strictEqual(absent.available, false);
    assert.strictEqual(absent.imageReady, false);

    await provider.prepare();
    assert.strictEqual(computerCalls.prepared, 1);
    assert.strictEqual(chromiumInstallCount, 1);
    assert.strictEqual((await provider.capability()).available, true);

    await assert.rejects(
      provider.acquire({ ownerKey: 'agent:one' }),
      error => error.code === 'ISOLATED_BROWSER_AGENT_OWNER_REQUIRED',
    );
    const acquired = await provider.acquire({
      ownerKey: 'agent:one',
      ownerAgentId: 'agent_one',
      projectRootId: 'root_one',
      workspace: '/tmp/project-one',
    });
    assert.deepStrictEqual(acquired, {
      cdpUrl: 'http://127.0.0.1:49223',
      leaseKey: 'computer_1',
    });
    assert.deepStrictEqual(computerCalls.acquire, [{
      ownerAgentId: 'agent_one',
      projectRootId: 'root_one',
      workspace: '/tmp/project-one',
      executablePath: '/tmp/farming/chrome',
    }]);
    await provider.release(acquired.leaseKey);
    assert.deepStrictEqual(computerCalls.released, ['computer_1']);
    await provider.deleteOwner('agent:one');

    await provider.recover();
    assert.strictEqual(legacyExists, false);
    assert(dockerCalls.some(args =>
      args[0] === 'ps'
      && args.includes(`label=farming.dev/config=${configInstanceFingerprint(configDir)}`)
    ));
    assert(dockerCalls.some(args =>
      args[0] === 'ps'
      && args.includes(`label=farming.dev/config=${crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 12)}`)
    ));
    assert(dockerCalls.some(args => args[0] === 'stop' && args.includes(legacyId)));
    assert(dockerCalls.some(args => args[0] === 'rm' && args.includes(legacyId)));
    console.log('Isolated Browser uses the visible Agent Computer regression test passed.');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
