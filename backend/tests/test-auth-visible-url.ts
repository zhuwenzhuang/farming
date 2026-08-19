const assert = require('assert');
const {
  getStartupAccessToken,
  rememberStartupAccessToken,
} = require('../../src/lib/auth-url.ts');

rememberStartupAccessToken('https://farming.example/farming/?token=private&view=code#agent');
assert.strictEqual(
  getStartupAccessToken(),
  'private',
  'the loaded application must retain its startup credential in memory for authenticated reconnects',
);

assert.strictEqual(
  new URL('https://farming.example/farming/?token=private&view=code#agent').searchParams.get('token'),
  getStartupAccessToken(),
  'the owner startup credential must remain available in the visible URL for reload and app handoff',
);

console.log('auth visible URL tests passed');
