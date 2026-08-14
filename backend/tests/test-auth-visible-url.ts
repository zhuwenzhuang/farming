const assert = require('assert');
const {
  getStartupAccessToken,
  rememberStartupAccessToken,
  visibleUrlWithoutToken,
} = require('../../src/lib/auth-url.ts');

rememberStartupAccessToken('https://farming.example/farming/?token=private&view=code#agent');
assert.strictEqual(
  getStartupAccessToken(),
  'private',
  'the loaded application must retain its startup credential in memory for authenticated reconnects',
);

assert.strictEqual(
  visibleUrlWithoutToken('https://farming.example/farming/?token=private&view=code#agent'),
  '/farming/?view=code#agent',
  'the loaded application must remove the owner token without losing other navigation state',
);
assert.strictEqual(
  visibleUrlWithoutToken('https://farming.example/farming/?view=code#agent'),
  null,
  'a token-free URL must not create a redundant history entry',
);

console.log('auth visible URL tests passed');
