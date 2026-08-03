const assert = require('assert');
const {
  capabilityCredentialDigest,
  createCapabilityCredential,
  verifyCapabilityCredential,
} = require('../agent-cli-capability-credentials.cjs');

const first = createCapabilityCredential();
const second = createCapabilityCredential();
assert.match(first.token, /^[A-Za-z0-9_-]{40,}$/);
assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
assert.notStrictEqual(first.token, second.token);
assert.notStrictEqual(first.digest, second.digest);
assert.strictEqual(capabilityCredentialDigest(first.token), first.digest);
assert.strictEqual(verifyCapabilityCredential(first.token, first.digest), true);
assert.strictEqual(verifyCapabilityCredential(second.token, first.digest), false);
assert.strictEqual(verifyCapabilityCredential('', first.digest), false);
assert.strictEqual(verifyCapabilityCredential(first.token, ''), false);

console.log('Agent CLI capability credential tests passed');
