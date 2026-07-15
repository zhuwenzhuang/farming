const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createFarmingNetServer } = require('../farming-net-server');
const { FarmingNetPassVerifier, PASS_QUERY_PARAM, writeFarmingNetTrust } = require('../farming-net-pass');
const { writeFarmingNetRegistry } = require('../farming-net-registry');

function request(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      headers,
      host: '127.0.0.1',
      method: 'GET',
      path: requestPath,
      port,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
        status: res.statusCode,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-net-server-'));
  const projectRoot = path.resolve(__dirname, '..', '..');
  writeFarmingNetRegistry(path.join(configDir, 'instances.json'), {
    title: 'Private Farms',
    subtitle: 'One place',
    instances: [{
      id: 'example',
      name: 'Example',
      federated: true,
      endpoints: [{
        label: 'Open example',
        primary: true,
        scope: 'remote',
        url: 'https://example.test/farming/?token=must-not-leak',
      }],
    }],
  });

  const service = createFarmingNetServer({
    basePath: '/farming-net',
    configDir,
    env: {
      FARMING_NET_TOKEN: 'net-test-token',
      HOME: configDir,
    },
    packageVersion: 'test',
    projectRoot,
  });

  try {
    await new Promise((resolve, reject) => {
      service.server.once('error', reject);
      service.server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = service.server.address();

    const authStatus = await request(port, '/farming-net/api/auth/status');
    assert.strictEqual(authStatus.status, 200);
    assert.deepStrictEqual(JSON.parse(authStatus.body), { authRequired: true });

    const unauthorized = await request(port, '/farming-net/');
    assert.strictEqual(unauthorized.status, 401);

    const login = await request(port, '/farming-net/?view=all&token=net-test-token');
    assert.strictEqual(login.status, 302);
    assert.strictEqual(login.headers.location, '/farming-net/?view=all');
    assert.match(login.headers['set-cookie'][0], /^farming_net_token=net-test-token; Path=\/farming-net;/);

    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const index = await request(port, '/farming-net/', { Cookie: cookie });
    assert.strictEqual(index.status, 200);
    assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(index.body, /<title>Farming Net<\/title>/);

    const registry = await request(port, '/farming-net/api/instances', { Cookie: cookie });
    assert.strictEqual(registry.status, 200);
    const parsed = JSON.parse(registry.body);
    assert.strictEqual(parsed.title, 'Private Farms');
    assert.strictEqual(parsed.instances.length, 1);
    assert.strictEqual(parsed.instances[0].endpoints[0].url, 'https://example.test/farming/');
    assert.strictEqual(parsed.instances[0].endpoints[0].launchUrl, '/farming-net/open/example/0');
    assert.doesNotMatch(registry.body, /must-not-leak/);

    const open = await request(port, '/farming-net/open/example/0', { Cookie: cookie });
    assert.strictEqual(open.status, 302);
    assert.strictEqual(open.headers['cache-control'], 'no-store');
    const targetUrl = new URL(open.headers.location);
    assert.strictEqual(`${targetUrl.origin}${targetUrl.pathname}`, 'https://example.test/farming/');
    const pass = targetUrl.searchParams.get(PASS_QUERY_PARAM);
    assert(pass, 'federated portal links should carry a signed short-lived pass');
    assert.strictEqual(targetUrl.searchParams.has('token'), false);
    const trustFile = path.join(configDir, 'target-trust.json');
    writeFarmingNetTrust(trustFile, {
      audience: 'example',
      issuers: [{
        id: service.signingIdentity.issuer,
        publicKey: service.signingIdentity.publicKeyPem,
      }],
    });
    assert.strictEqual(new FarmingNetPassVerifier({ trustFile }).verify(pass).valid, true);

    const missingOpen = await request(port, '/farming-net/open/example/9', { Cookie: cookie });
    assert.strictEqual(missingOpen.status, 404);

    const status = await request(port, '/farming-net/api/status', { Cookie: cookie });
    assert.deepStrictEqual(JSON.parse(status.body), {
      name: 'Farming Net',
      version: 'test',
      basePath: '/farming-net',
    });

    const missing = await request(port, '/farming-net/missing', { Cookie: cookie });
    assert.strictEqual(missing.status, 404);

    assert.strictEqual(fs.existsSync(path.join(configDir, 'farming-net-server.json')), true);
    assert.strictEqual(fs.existsSync(path.join(configDir, 'signing-private-key.pem')), true);
    console.log('test-farming-net-server passed');
  } finally {
    await new Promise(resolve => service.server.close(resolve));
    assert.strictEqual(fs.existsSync(path.join(configDir, 'farming-net-server.json')), false);
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
