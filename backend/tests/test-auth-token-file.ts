const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TokenAuth,
  authenticatedAccessScopeId,
  bearerAuthorizationHeader,
  encodeCookieToken,
  farmingAuthCookieName,
  getPoeticTokenEntropyBits,
} = require('../auth.cjs');

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
    const instanceCookieName = farmingAuthCookieName(configDir);

    assert.strictEqual(auth.getTokenFile(), path.join(configDir, '.session-token'));
    assert.strictEqual(auth.getCookieName(), instanceCookieName);
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
      auth.verifyWebSocket({
        url: '/farming/ws',
        headers: { authorization: bearerAuthorizationHeader(token) },
      }),
      true,
      'the UTF-8 token transport encoding should authenticate through a standard Bearer header'
    );
    assert.strictEqual(
      auth.verifyWebSocket({
        url: '/farming/ws',
        headers: { cookie: `other=1; ${instanceCookieName}=${encodeCookieToken(token)}` },
      }),
      true,
      'the config-scoped cookie with an encoded Chinese passphrase should verify'
    );
    assert.strictEqual(
      auth.verifyWebSocket({ url: '/farming/ws', headers: { cookie: `farming_token=${encodeCookieToken(token)}` } }),
      true,
      'the legacy cookie should remain a read-only authentication compatibility path'
    );
    assert.strictEqual(auth.verify(`${token}-wrong`), false);
    assert.strictEqual(auth.getTokenInfo().style, 'zh-classic-haiku');

    const readOnlyExpiresAt = Date.now() + 60_000;
    const readOnlyToken = auth.createReadOnlyToken({ expiresAt: readOnlyExpiresAt });
    const otherReadOnlyToken = auth.createReadOnlyToken({ expiresAt: readOnlyExpiresAt });
    assert.strictEqual(auth.verify(readOnlyToken), false, 'a share token must not become an owner token');
    assert.strictEqual(auth.verifyReadOnlyToken(readOnlyToken, readOnlyExpiresAt - 1), true);
    assert.strictEqual(auth.verifyReadOnlyToken(readOnlyToken, readOnlyExpiresAt), false);
    assert.strictEqual(auth.readOnlyTokenExpiresAt(readOnlyToken), readOnlyExpiresAt);
    assert.strictEqual(auth.accessForToken(token), 'owner');
    assert.strictEqual(auth.accessForToken(readOnlyToken), 'read-only');
    assert.strictEqual(auth.accessForToken(`${readOnlyToken}x`), 'none');
    assert.strictEqual(
      authenticatedAccessScopeId(readOnlyToken, 'read-only'),
      authenticatedAccessScopeId(readOnlyToken, 'read-only'),
      'the same authenticated credential must retain one stable preview scope across reconnects',
    );
    assert.notStrictEqual(
      authenticatedAccessScopeId(readOnlyToken, 'read-only'),
      authenticatedAccessScopeId(otherReadOnlyToken, 'read-only'),
      'distinct read-only credentials must receive distinct preview scopes',
    );
    assert.throws(
      () => authenticatedAccessScopeId('', 'read-only'),
      /exact authenticated credential/,
      'a read-only connection must never fall back to a shared anonymous preview scope',
    );
    assert.strictEqual(
      auth.webSocketAccess({
        url: `/farming/ws?token=${encodeURIComponent(readOnlyToken)}`,
        headers: {},
      }),
      'read-only',
    );

    let readOnlyRedirectStatus = 0;
    let readOnlyRedirectHeaders: Record<string, string | string[]> = {};
    auth.middleware()({
      headers: { host: 'localhost' },
      method: 'GET',
      url: `/farming/?agent=agent-1&token=${encodeURIComponent(readOnlyToken)}`,
    }, {
      end() {},
      setHeader(name, value) {
        readOnlyRedirectHeaders[name] = value;
      },
      writeHead(status, headers = {}) {
        readOnlyRedirectStatus = status;
        readOnlyRedirectHeaders = { ...readOnlyRedirectHeaders, ...headers };
      },
    }, () => {
      assert.fail('a read-only query credential should redirect after setting its cookie');
    });
    assert.strictEqual(readOnlyRedirectStatus, 302);
    assert.strictEqual(readOnlyRedirectHeaders.Location, '/farming/?agent=agent-1');
    assert.match(
      readOnlyRedirectHeaders['Set-Cookie'],
      new RegExp(`^${instanceCookieName}=${encodeCookieToken(readOnlyToken)}; Path=/farming;`),
    );

    let readOnlyGetNextCalled = false;
    auth.middleware()({
      headers: { cookie: `${instanceCookieName}=${encodeCookieToken(readOnlyToken)}`, host: 'localhost' },
      method: 'GET',
      url: '/farming/api/settings',
    }, {
      end() {
        assert.fail('a read-only GET should not end the response');
      },
      setHeader() {},
      writeHead() {
        assert.fail('a read-only GET should not write an error response');
      },
    }, () => {
      readOnlyGetNextCalled = true;
    });
    assert.strictEqual(readOnlyGetNextCalled, true);

    let readOnlyPostStatus = 0;
    let readOnlyPostBody = '';
    let readOnlyPostNextCalled = false;
    auth.middleware()({
      headers: { cookie: `${instanceCookieName}=${encodeCookieToken(readOnlyToken)}`, host: 'localhost' },
      method: 'POST',
      url: '/farming/api/settings',
    }, {
      end(body) {
        readOnlyPostBody = body || '';
      },
      setHeader() {},
      writeHead(status) {
        readOnlyPostStatus = status;
      },
    }, () => {
      readOnlyPostNextCalled = true;
    });
    assert.strictEqual(readOnlyPostStatus, 403);
    assert.match(readOnlyPostBody, /read-only/);
    assert.strictEqual(readOnlyPostNextCalled, false);

    const readOnlyReshareRequest: {
      authAccessMode?: 'read-only';
      headers: { cookie: string; host: string };
      method: string;
      url: string;
    } = {
      headers: { cookie: `${instanceCookieName}=${encodeCookieToken(readOnlyToken)}`, host: 'localhost' },
      method: 'POST',
      url: '/farming/api/share/qr-ticket',
    };
    let readOnlyReshareNextCalled = false;
    auth.middleware()(readOnlyReshareRequest, {
      end() {
        assert.fail('read-only re-sharing should not end the response');
      },
      setHeader() {},
      writeHead() {
        assert.fail('read-only re-sharing should not write an error response');
      },
    }, () => {
      readOnlyReshareNextCalled = true;
    });
    assert.strictEqual(readOnlyReshareNextCalled, true);
    assert.strictEqual(readOnlyReshareRequest.authAccessMode, 'read-only');

    let bearerNextCalled = false;
    auth.middleware()({
      headers: { authorization: bearerAuthorizationHeader(token), host: 'localhost' },
      method: 'GET',
      url: '/farming/api/settings',
    }, {
      end() {
        assert.fail('a valid Bearer token should not end the response');
      },
      setHeader() {},
      writeHead() {
        assert.fail('a valid Bearer token should not write an error response');
      },
    }, () => {
      bearerNextCalled = true;
    });
    assert.strictEqual(bearerNextCalled, true);

    const otherConfigDir = path.join(configDir, 'other-config');
    const otherAuth = new TokenAuth({
      basePath: '/farming',
      farmingDir: otherConfigDir,
      token,
    });
    assert.notStrictEqual(otherAuth.getCookieName(), instanceCookieName);
    assert.strictEqual(otherAuth.verifyWebSocket({
      url: '/farming/ws',
      headers: { cookie: `${instanceCookieName}=${encodeCookieToken(token)}` },
    }), false, 'another config instance cookie should not authenticate this instance');
    otherAuth.cleanup({ removeTokenFile: true });

    const configLink = path.join(configDir, 'config-link');
    fs.symlinkSync(configDir, configLink, 'dir');
    const linkedAuth = new TokenAuth({ basePath: '/farming', farmingDir: configLink });
    assert.strictEqual(
      linkedAuth.getCookieName(),
      instanceCookieName,
      'symlink and real paths for the same config directory should share one cookie identity'
    );

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
    let redirectHeaders: Record<string, string | string[]> = {};
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
    assert.strictEqual(netAuth.verifyWebSocket({
      headers: { cookie: 'farming_token=private-net-token' },
      url: '/farming-net/ws',
    }), false, 'an explicit custom cookie name should not enable Farming legacy-cookie compatibility');
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
    assert.strictEqual(targetAuth.verifyWebSocket({
      headers: { authorization: 'Bearer target-private-token' },
      url: '/farming/ws',
    }), true, 'header-safe configured tokens should also work as raw Bearer credentials');
    let passStatus = 0;
    let passHeaders: Record<string, string | string[]> = {};
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
    assert.match(
      passHeaders['Set-Cookie'],
      new RegExp(`^${targetAuth.getCookieName()}=target-private-token; Path=/farming;`),
    );
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
