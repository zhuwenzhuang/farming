const crypto = require('crypto');
const fs = require('fs');
const { FarmingNetPassVerifier, PASS_QUERY_PARAM } = require('./farming-net-pass');
const { createPoeticToken, generatePoeticToken, getPoeticTokenEntropyBits } = require('./haiku-token');
const storageLayout = require('./storage-layout');

function normalizeBasePath(basePath) {
  if (!basePath || basePath === '/') return '';
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function encodeCookieToken(token) {
  return encodeURIComponent(token);
}

function decodeCookieToken(token) {
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

function normalizeCookieName(value) {
  const cookieName = String(value || '').trim();
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName) ? cookieName : 'farming_token';
}

function normalizeCookiePath(value) {
  const cookiePath = String(value || '/').trim();
  if (!cookiePath.startsWith('/') || /[;\r\n]/.test(cookiePath)) return '/';
  return cookiePath;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readExistingTokenFile(tokenFile) {
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    return token || '';
  } catch {
    return '';
  }
}

class TokenAuth {
  constructor(options = {}) {
    const authEnv = options.env || process.env;
    this.disabled = options.disabled === true || isTruthyEnv(authEnv.FARMING_DISABLE_AUTH);
    this.basePath = normalizeBasePath(options.basePath || '/');
    this.authStatusPath = this.basePath ? `${this.basePath}/api/auth/status` : '/api/auth/status';
    this.cookieName = normalizeCookieName(options.cookieName);
    this.cookiePath = normalizeCookiePath(options.cookiePath);
    this.redirectQueryToken = options.redirectQueryToken === true;
    this.tokenFile = '';
    this.token = '';
    this.tokenInfo = null;
    this.farmingNetPassVerifier = null;

    if (this.disabled) {
      return;
    }

    const farmingDir = options.farmingDir || storageLayout.farmingConfigDir();
    if (!fs.existsSync(farmingDir)) {
      fs.mkdirSync(farmingDir, { recursive: true });
    }
    this.tokenFile = storageLayout.sessionTokenFile(farmingDir);
    if (options.farmingNetPassVerifier !== false) {
      this.farmingNetPassVerifier = options.farmingNetPassVerifier || new FarmingNetPassVerifier({
        trustFile: options.farmingNetTrustFile || storageLayout.farmingNetTrustFile(farmingDir),
      });
    }
    const configuredTokenSource = Object.prototype.hasOwnProperty.call(options, 'token')
      ? options.token
      : authEnv.FARMING_TOKEN;
    const configuredToken = String(configuredTokenSource || '').trim();
    const existingToken = configuredToken ? '' : readExistingTokenFile(this.tokenFile);
    if (configuredToken) {
      this.token = configuredToken;
      this.tokenInfo = {
        token: configuredToken,
        style: 'configured',
        source: 'FARMING_TOKEN',
        entropyBits: 0,
      };
    } else if (existingToken) {
      this.token = existingToken;
      this.tokenInfo = {
        token: this.token,
        style: 'persisted',
        source: this.tokenFile,
        entropyBits: 0,
      };
    } else {
      this.tokenInfo = createPoeticToken({ locale: options.tokenLocale, env: authEnv, timeZone: options.timeZone });
      this.token = this.tokenInfo.token;
    }
    this.saveTokenFile();
  }

  saveTokenFile() {
    if (this.disabled || !this.tokenFile) return;
    fs.writeFileSync(this.tokenFile, this.token, { mode: 0o600 });
  }

  isEnabled() {
    return !this.disabled;
  }

  getToken() {
    return this.token;
  }

  getTokenFile() {
    return this.tokenFile;
  }

  getTokenInfo() {
    return this.tokenInfo;
  }

  getCookieName() {
    return this.cookieName;
  }

  verify(token) {
    if (this.disabled) return true;
    if (!token || !this.token) return false;
    try {
      const a = Buffer.from(token);
      const b = Buffer.from(this.token);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  extractToken(req) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;

    return this.extractCookieToken(req);
  }

  extractCookieToken(req) {
    const cookies = req.headers.cookie || '';
    const match = cookies.match(new RegExp(`(?:^|;\\s*)${escapeRegExp(this.cookieName)}=([^;]+)`));
    if (match) return decodeCookieToken(match[1]);

    return null;
  }

  setAuthenticatedCookie(res) {
    res.setHeader('Set-Cookie',
      `${this.cookieName}=${encodeCookieToken(this.token)}; Path=${this.cookiePath}; HttpOnly; SameSite=Lax`);
  }

  redirectWithoutQueryParameter(res, url, parameter) {
    url.searchParams.delete(parameter);
    const search = url.searchParams.toString();
    res.writeHead(302, {
      'Cache-Control': 'no-store',
      Location: `${url.pathname}${search ? `?${search}` : ''}`,
    });
    res.end();
  }

  middleware() {
    return (req, res, next) => {
      if (this.disabled) return next();

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // Allow auth status endpoint without authentication
      if (url.pathname === this.authStatusPath) {
        return next();
      }

      const method = String(req.method || 'GET').toUpperCase();
      if (['GET', 'HEAD'].includes(method) && url.searchParams.has(PASS_QUERY_PARAM)) {
        const pass = url.searchParams.get(PASS_QUERY_PARAM);
        const passResult = this.farmingNetPassVerifier
          ? this.farmingNetPassVerifier.verify(pass)
          : { valid: false };
        if (passResult.valid) {
          this.setAuthenticatedCookie(res);
          this.redirectWithoutQueryParameter(res, url, PASS_QUERY_PARAM);
          return;
        }
        const cookieToken = this.extractCookieToken(req);
        if (cookieToken && this.verify(cookieToken)) {
          this.redirectWithoutQueryParameter(res, url, PASS_QUERY_PARAM);
          return;
        }
      }

      const token = this.extractToken(req);

      // URL has token query param -> validate, set cookie, redirect
      if (url.searchParams.has('token')) {
        if (token && this.verify(token)) {
          this.setAuthenticatedCookie(res);
          if (this.redirectQueryToken && ['GET', 'HEAD'].includes(method)) {
            this.redirectWithoutQueryParameter(res, url, 'token');
            return;
          }
          return next();
        }
      }

      // Cookie-based verification
      if (token && this.verify(token)) {
        return next();
      }

      // Unauthorized
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token required. Use the URL printed in terminal.' }));
    };
  }

  verifyWebSocket(req) {
    if (this.disabled) return true;
    const token = this.extractToken(req);
    return token !== null && this.verify(token);
  }

  cleanup(options = {}) {
    if (options.removeTokenFile !== true) return;
    try {
      fs.unlinkSync(this.tokenFile);
    } catch {
      // ignore
    }
  }
}

module.exports = TokenAuth;
module.exports.generatePoeticToken = generatePoeticToken;
module.exports.getPoeticTokenEntropyBits = getPoeticTokenEntropyBits;
module.exports.encodeCookieToken = encodeCookieToken;
module.exports.decodeCookieToken = decodeCookieToken;
