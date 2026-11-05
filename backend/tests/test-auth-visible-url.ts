const assert = require('assert');
const {
  getCurrentAccessToken,
  getStartupSearch,
  rememberStartupAccessToken,
} = require('../../src/lib/auth-url.ts');

rememberStartupAccessToken('https://farming.example/farming/?token=private&view=code#agent');
assert.strictEqual(
  getCurrentAccessToken('https://farming.example/farming/?token=private'),
  'private',
  'authenticated reconnects should read the current URL credential',
);

assert.strictEqual(
  new URL('https://farming.example/farming/?token=private&view=code#agent').searchParams.get('token'),
  getCurrentAccessToken('https://farming.example/farming/?token=private'),
  'the owner startup credential must remain available in the visible URL for reload and app handoff',
);
assert.strictEqual(
  getStartupSearch(),
  '?token=private&view=code',
  'startup navigation should keep its original query snapshot after the visible URL is cleaned',
);

assert.strictEqual(getCurrentAccessToken('https://farming.example/farming/?token=rotated'), 'rotated');
assert.strictEqual(getCurrentAccessToken('https://farming.example/farming/'), '');
const encodedToken = '春水&山月+#=?';
assert.strictEqual(getCurrentAccessToken(`https://farming.example/farming/?${new URLSearchParams({ token: encodedToken })}`), encodedToken);
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
try {
  const location = new URL('https://farming.example/custom/farm/?token=original');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __FARMING_BASE_PATH__: '/custom/farm', location },
  });
  const { appNavigationPath, appPath } = require('../../src/lib/base-path.ts');
  for (const token of ['original', encodedToken, 'rotated']) {
    location.search = new URLSearchParams({ token }).toString();
    assert.strictEqual(getCurrentAccessToken(), token);
    for (const pathname of ['/crt/', '/code/', '/review']) {
      const destination = new URL(appNavigationPath(`${pathname}?agent=agent-1#view`), location);
      assert.strictEqual(destination.pathname, `/custom/farm${pathname}`);
      assert.strictEqual(destination.searchParams.get('token'), token);
      assert.strictEqual(destination.searchParams.get('agent'), 'agent-1');
      assert.strictEqual(destination.hash, '#view');
    }
    assert.strictEqual(appPath('/api/settings'), '/custom/farm/api/settings');
  }
  location.search = '';
  assert.strictEqual(appNavigationPath('/code/'), '/custom/farm/code/');
} finally {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}
console.log('auth visible URL tests passed');
