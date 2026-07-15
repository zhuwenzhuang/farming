const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TokenAuth = require('../auth');
const { encodeCookieToken, getPoeticTokenEntropyBits } = require('../auth');

function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-auth-'));
  const previousConfigDir = process.env.FARMING_CONFIG_DIR;
  const previousDisableAuth = process.env.FARMING_DISABLE_AUTH;
  const previousTokenLocale = process.env.FARMING_TOKEN_LOCALE;
  const previousToken = process.env.FARMING_TOKEN;
  process.env.FARMING_CONFIG_DIR = configDir;
  delete process.env.FARMING_DISABLE_AUTH;
  delete process.env.FARMING_TOKEN;
  process.env.FARMING_TOKEN_LOCALE = 'zh';

  try {
    const auth = new TokenAuth({ basePath: '/farming' });
    const token = auth.getToken();

    assert.strictEqual(auth.getTokenFile(), path.join(configDir, '.session-token'));
    assert.strictEqual(fs.readFileSync(auth.getTokenFile(), 'utf8'), token);
    assert(token.length < 64, 'haiku token should be shorter than the old 64-char hex token');
    assert.match(token, /^[\u4e00-\u9fa5-]+$/, 'poetic token should use Chinese poetic words');
    assert.deepStrictEqual(
      token.split('-').map(part => Array.from(part).length),
      [5, 7, 5],
      'poetic token should read like a compact 5-7-5 haiku'
    );
    assert(getPoeticTokenEntropyBits() >= 85, '5-7-5 token should keep at least 85 bits of random entropy');
    assert.strictEqual(auth.verify(token), true);
    assert.strictEqual(auth.verifyWebSocket({ url: `/farming/ws?token=${encodeURIComponent(token)}`, headers: {} }), true);
    assert.strictEqual(
      auth.verifyWebSocket({ url: '/farming/ws', headers: { cookie: `other=1; farming_token=${encodeCookieToken(token)}` } }),
      true,
      'cookie token with encoded Chinese passphrase should verify'
    );
    assert.strictEqual(auth.verify(`${token}-wrong`), false);
    assert.strictEqual(auth.getTokenInfo().style, 'zh-classic-haiku');

    process.env.FARMING_TOKEN_LOCALE = 'auto';
    const restartedAuth = new TokenAuth({ basePath: '/farming', farmingDir: configDir, timeZone: 'Asia/Tokyo' });
    assert.strictEqual(restartedAuth.getToken(), token);
    assert.strictEqual(restartedAuth.getTokenInfo().style, 'persisted');
    assert.strictEqual(restartedAuth.verify(token), true);
    assert.strictEqual(fs.readFileSync(restartedAuth.getTokenFile(), 'utf8'), token);

    process.env.FARMING_TOKEN = 'fixed-token-for-deploy';
    const configuredAuth = new TokenAuth({ basePath: '/farming', farmingDir: configDir });
    assert.strictEqual(configuredAuth.getToken(), 'fixed-token-for-deploy');
    assert.strictEqual(configuredAuth.getTokenInfo().style, 'configured');
    assert.strictEqual(configuredAuth.verify('fixed-token-for-deploy'), true);
    configuredAuth.cleanup({ removeTokenFile: true });
    delete process.env.FARMING_TOKEN;

    const netConfigDir = path.join(configDir, 'net');
    const netAuth = new TokenAuth({
      basePath: '/farming-net',
      cookieName: 'farming_net_token',
      cookiePath: '/farming-net',
      farmingDir: netConfigDir,
      redirectQueryToken: true,
      token: 'private-net-token',
    });
    assert.strictEqual(netAuth.getCookieName(), 'farming_net_token');
    let redirectStatus = 0;
    let redirectHeaders = {};
    let redirectEnded = false;
    let redirectNextCalled = false;
    netAuth.middleware()({
      headers: { host: 'net.example' },
      method: 'GET',
      url: '/farming-net/?mode=compact&token=private-net-token',
    }, {
      end() {
        redirectEnded = true;
      },
      setHeader(name, value) {
        redirectHeaders[name] = value;
      },
      writeHead(status, headers = {}) {
        redirectStatus = status;
        redirectHeaders = { ...redirectHeaders, ...headers };
      },
    }, () => {
      redirectNextCalled = true;
    });
    assert.strictEqual(redirectStatus, 302);
    assert.strictEqual(redirectHeaders.Location, '/farming-net/?mode=compact');
    assert.match(redirectHeaders['Set-Cookie'], /^farming_net_token=private-net-token; Path=\/farming-net;/);
    assert.strictEqual(redirectEnded, true);
    assert.strictEqual(redirectNextCalled, false);
    assert.strictEqual(netAuth.verifyWebSocket({
      headers: { cookie: 'farming_token=wrong; farming_net_token=private-net-token' },
      url: '/farming-net/ws',
    }), true);
    netAuth.cleanup({ removeTokenFile: true });

    const targetDir = path.join(configDir, 'federated-target');
    const targetAuth = new TokenAuth({
      basePath: '/farming',
      farmingDir: targetDir,
      farmingNetPassVerifier: {
        verify(pass) {
          return { valid: pass === 'single-use-pass' };
        },
      },
      token: 'target-private-token',
    });
    let passStatus = 0;
    let passHeaders = {};
    let passEnded = false;
    targetAuth.middleware()({
      headers: { host: 'target.example' },
      method: 'GET',
      url: '/farming/?mode=compact&farming_net_pass=single-use-pass',
    }, {
      end() {
        passEnded = true;
      },
      setHeader(name, value) {
        passHeaders[name] = value;
      },
      writeHead(status, headers = {}) {
        passStatus = status;
        passHeaders = { ...passHeaders, ...headers };
      },
    }, () => {
      assert.fail('a valid Farming Net pass should redirect before reaching the application');
    });
    assert.strictEqual(passStatus, 302);
    assert.strictEqual(passHeaders.Location, '/farming/?mode=compact');
    assert.strictEqual(passHeaders['Cache-Control'], 'no-store');
    assert.match(passHeaders['Set-Cookie'], /^farming_token=target-private-token; Path=\//);
    assert.strictEqual(passEnded, true);
    targetAuth.cleanup({ removeTokenFile: true });

    process.env.FARMING_TOKEN_LOCALE = 'auto';
    const japaneseAuth = new TokenAuth({ basePath: '/farming', farmingDir: configDir, timeZone: 'Asia/Tokyo' });
    assert.strictEqual(japaneseAuth.getTokenInfo().style, 'zh-japan-haiku');
    assert.match(japaneseAuth.getToken(), /^[\u4e00-\u9fa5-]+$/);
    japaneseAuth.cleanup({ removeTokenFile: true });

    auth.cleanup({ removeTokenFile: true });
    assert(!fs.existsSync(auth.getTokenFile()), 'cleanup should remove the configured token file');

    const disabledAuth = new TokenAuth({ basePath: '/farming', disabled: true });
    assert.strictEqual(disabledAuth.isEnabled(), false);
    assert.strictEqual(disabledAuth.getToken(), '');
    assert.strictEqual(disabledAuth.getTokenFile(), '');
    assert.strictEqual(disabledAuth.verifyWebSocket({ url: '/farming/ws', headers: {} }), true);
    disabledAuth.cleanup({ removeTokenFile: true });

    console.log('✓ TokenAuth stores session token under FARMING_CONFIG_DIR when provided');
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.FARMING_CONFIG_DIR;
    } else {
      process.env.FARMING_CONFIG_DIR = previousConfigDir;
    }
    if (previousDisableAuth === undefined) {
      delete process.env.FARMING_DISABLE_AUTH;
    } else {
      process.env.FARMING_DISABLE_AUTH = previousDisableAuth;
    }
    if (previousTokenLocale === undefined) {
      delete process.env.FARMING_TOKEN_LOCALE;
    } else {
      process.env.FARMING_TOKEN_LOCALE = previousTokenLocale;
    }
    if (previousToken === undefined) {
      delete process.env.FARMING_TOKEN;
    } else {
      process.env.FARMING_TOKEN = previousToken;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run();
