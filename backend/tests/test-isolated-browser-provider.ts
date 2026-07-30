const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  ISOLATED_BROWSER_IMAGE,
  IsolatedBrowserProvider,
} = require('../../extensions/computer/backend/isolated-browser-provider.cjs');

const CONTAINER_ID = 'b'.repeat(64);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

async function run() {
  let cdpReady = false;
  const cdp = http.createServer((_request, response) => {
    response.statusCode = cdpReady ? 200 : 503;
    response.end(cdpReady ? '{"Browser":"Chromium"}' : 'starting');
  });
  const port = await listen(cdp);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-isolated-browser-provider-'));
  let exists = false;
  let running = false;
  let portPublished = true;
  let stopShouldFail = false;
  let removeShouldFail = false;
  let labels = {};
  const calls = [];
  const docker = async args => {
    calls.push([...args]);
    if (args[0] === 'version') return { stdout: '26.1\n', stderr: '' };
    if (args[0] === 'image' && args[1] === 'inspect') {
      assert.strictEqual(args[2], ISOLATED_BROWSER_IMAGE);
      return { stdout: 'sha256:image\n', stderr: '' };
    }
    if (args[0] === 'manifest') return { stdout: '{}\n', stderr: '' };
    if (args[0] === 'pull') return { stdout: 'pulled\n', stderr: '' };
    if (args[0] === 'run') return { stdout: 'Chromium 140.0\n', stderr: '' };
    if (args[0] === 'ps') return { stdout: '', stderr: '' };
    if (args[0] === 'create') {
      exists = true;
      labels = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== '--label') continue;
        const [key, ...value] = args[index + 1].split('=');
        labels[key] = value.join('=');
      }
      return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    }
    if (args[0] === 'inspect') {
      if (!exists) throw new Error('No such container');
      return {
        stdout: JSON.stringify([{
          Id: CONTAINER_ID,
          Config: { Labels: labels },
          State: { Running: running },
          NetworkSettings: {
            Ports: {
              '9223/tcp': portPublished
                ? [{ HostIp: '127.0.0.1', HostPort: String(port) }]
                : [],
            },
          },
        }]),
        stderr: '',
      };
    }
    if (args[0] === 'start') {
      running = true;
      return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    }
    if (args[0] === 'stop') {
      if (stopShouldFail) throw new Error('Docker stop failed');
      running = false;
      cdpReady = false;
      return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    }
    if (args[0] === 'rm') {
      if (removeShouldFail) throw new Error('Docker rm failed');
      exists = false;
      return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    }
    if (args[0] === 'exec') {
      if (args.some(value => String(value).includes('urllib.request')) && !cdpReady) {
        throw new Error('CDP is not ready');
      }
      if (args.includes('/usr/bin/chromium')) cdpReady = true;
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };

  const provider = new IsolatedBrowserProvider({
    configDir,
    dockerRunner: docker,
  });
  try {
    assert.strictEqual((await provider.capability()).available, true);
    await provider.prepare();
    const first = await provider.acquire({ ownerKey: 'agent:one' });
    assert.strictEqual(first.cdpUrl, `http://127.0.0.1:${port}`);
    assert.strictEqual(running, true);
    assert(calls.some(args => args[0] === 'create' && args.includes('127.0.0.1::9223')));
    assert(calls.some(args => args[0] === 'exec' && args.includes('/usr/bin/chromium')));
    assert(calls.some(args => args[0] === 'exec' && args.includes('python3')));

    portPublished = false;
    await assert.rejects(
      provider.acquire({ ownerKey: 'agent:one' }),
      error => error.code === 'ISOLATED_BROWSER_PORT_MISSING',
    );
    assert.strictEqual(provider.leases.get('agent:one'), 1);
    portPublished = true;

    const joined = await provider.acquire({ ownerKey: 'agent:one' });
    assert.strictEqual(joined.leaseKey, first.leaseKey);
    await provider.release(first.leaseKey);
    assert.strictEqual(running, true, 'the joined lease keeps the isolated Browser running');
    stopShouldFail = true;
    await assert.rejects(provider.release(first.leaseKey), /Docker stop failed/);
    assert.strictEqual(
      provider.leases.get('agent:one'),
      1,
      'a failed final stop must retain the exact lease for retry',
    );
    stopShouldFail = false;
    await provider.release(first.leaseKey);
    assert.strictEqual(running, false);

    await provider.deleteOwner('agent:one');
    assert.strictEqual(exists, false);

    const compatibleProvider = new IsolatedBrowserProvider({
      configDir,
      dockerRunner: docker,
      getSettings: () => ({ computerCompatibilityMode: true }),
    });
    await compatibleProvider.capability();
    const compatible = await compatibleProvider.acquire({ ownerKey: 'agent:legacy' });
    assert(calls.some(args =>
      args[0] === 'create'
      && args.includes('seccomp=unconfined')
      && args.includes('farming.dev/compatibility=legacy-seccomp')
    ));
    removeShouldFail = true;
    await assert.rejects(compatibleProvider.deleteOwner('agent:legacy'), /Docker rm failed/);
    assert.strictEqual(
      compatibleProvider.leases.get('agent:legacy'),
      1,
      'failed removal must retain the exact owner lease for retry',
    );
    assert.strictEqual(exists, true);
    removeShouldFail = false;
    await compatibleProvider.deleteOwner('agent:legacy');
    assert.strictEqual(compatibleProvider.leases.has(compatible.leaseKey), false);
    console.log('Isolated Browser provider lifecycle regression test passed.');
  } finally {
    await close(cdp);
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
