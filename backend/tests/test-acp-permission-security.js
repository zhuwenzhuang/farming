const assert = require('assert');
const { permissionSecurityWarnings, scanUnicode } = require('../acp/permission-security');

function request(networkHosts = [], writePaths = []) {
  return {
    toolCall: {
      _meta: {
        sandbox_authorization: {
          network_hosts: networkHosts,
          write_paths: writePaths,
        },
      },
    },
  };
}

assert.deepStrictEqual(scanUnicode('github.com'), []);
assert.strictEqual(scanUnicode('g\u0456thub.com')[0].kind, 'confusable');
assert.strictEqual(scanUnicode('safe\u202Etxt.exe')[0].kind, 'bidi-control');
assert.strictEqual(scanUnicode('git\u200Bhub.com')[0].kind, 'invisible');
assert.strictEqual(scanUnicode('\u0430bc\u0430').length, 1);

const punycode = permissionSecurityWarnings(request(['*.xn--pple-43d.com']));
assert.strictEqual(punycode.length, 1);
assert.strictEqual(punycode[0].displayValue, '*.\u0430pple.com');
assert.strictEqual(punycode[0].characters[0].codePoint, 'U+0430');

const pathWarning = permissionSecurityWarnings(request([], ['/tmp/safe\u200Bname']));
assert.strictEqual(pathWarning[0].targetType, 'path');
assert.strictEqual(pathWarning[0].characters[0].description, 'zero-width space');

console.log('ACP permission security tests passed');
