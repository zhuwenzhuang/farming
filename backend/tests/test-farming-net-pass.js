const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createFarmingNetPass,
  FarmingNetPassVerifier,
  loadOrCreateFarmingNetSigningIdentity,
  writeFarmingNetTrust,
} = require('../farming-net-pass');

function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-net-pass-'));
  const privateKeyFile = path.join(configDir, 'signing-private-key.pem');
  const publicKeyFile = path.join(configDir, 'signing-public-key.pem');
  const trustFile = path.join(configDir, 'farming-net-trust.json');

  try {
    const identity = loadOrCreateFarmingNetSigningIdentity({ privateKeyFile, publicKeyFile });
    assert.match(identity.issuer, /^fnet_[A-Za-z0-9_-]{24}$/);
    assert.strictEqual(fs.statSync(privateKeyFile).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(publicKeyFile).mode & 0o777, 0o600);

    const restartedIdentity = loadOrCreateFarmingNetSigningIdentity({ privateKeyFile, publicKeyFile });
    assert.strictEqual(restartedIdentity.issuer, identity.issuer, 'the portal identity must persist across restarts');

    writeFarmingNetTrust(trustFile, {
      audience: 'local-mac',
      issuers: [{ id: identity.issuer, name: 'Private portal', publicKey: identity.publicKeyPem }],
    });
    assert.strictEqual(fs.statSync(trustFile).mode & 0o777, 0o600);

    const nowMs = 1_800_000_000_000;
    const pass = createFarmingNetPass(identity, {
      audience: 'local-mac',
      nowMs,
      subject: 'owner',
      ttlSeconds: 30,
    });
    const verifier = new FarmingNetPassVerifier({ trustFile });
    const accepted = verifier.verify(pass, { nowMs: nowMs + 1_000 });
    assert.strictEqual(accepted.valid, true);
    assert.strictEqual(accepted.payload.aud, 'local-mac');
    assert.strictEqual(accepted.payload.sub, 'owner');
    assert.deepStrictEqual(verifier.verify(pass, { nowMs: nowMs + 2_000 }), {
      valid: false,
      reason: 'replayed',
    });

    const wrongAudienceTrust = path.join(configDir, 'wrong-audience.json');
    writeFarmingNetTrust(wrongAudienceTrust, {
      audience: 'ssh4',
      issuers: [{ id: identity.issuer, publicKey: identity.publicKeyPem }],
    });
    assert.deepStrictEqual(
      new FarmingNetPassVerifier({ trustFile: wrongAudienceTrust }).verify(pass, { nowMs: nowMs + 1_000 }),
      { valid: false, reason: 'wrong_audience' },
    );

    const segments = pass.split('.');
    segments[1] = `${segments[1].slice(0, -1)}${segments[1].endsWith('A') ? 'B' : 'A'}`;
    assert.strictEqual(
      new FarmingNetPassVerifier({ trustFile }).verify(segments.join('.'), { nowMs: nowMs + 1_000 }).valid,
      false,
      'a modified payload must fail verification',
    );
    assert.deepStrictEqual(
      new FarmingNetPassVerifier({ trustFile }).verify(pass, { nowMs: nowMs + 31_000 }),
      { valid: false, reason: 'expired' },
    );

    console.log('test-farming-net-pass passed');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run();
