const crypto = require('crypto');
const fs = require('fs');
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
    this.disabled = options.disabled === true || isTruthyEnv(process.env.FARMING_DISABLE_AUTH);
    this.basePath = normalizeBasePath(options.basePath || '/');
    this.authStatusPath = this.basePath ? `${this.basePath}/api/auth/status` : '/api/auth/status';
    this.tokenFile = '';
    this.token = '';
    this.tokenInfo = null;

    if (this.disabled) {
      return;
    }

    const farmingDir = options.farmingDir || storageLayout.farmingConfigDir();
    if (!fs.existsSync(farmingDir)) {
      fs.mkdirSync(farmingDir, { recursive: true });
    }
    this.tokenFile = storageLayout.sessionTokenFile(farmingDir);
    const configuredToken = String(options.token || process.env.FARMING_TOKEN || '').trim();
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
      this.tokenInfo = createPoeticToken({ locale: options.tokenLocale, env: options.env, timeZone: options.timeZone });
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

    const cookies = req.headers.cookie || '';
    const match = cookies.match(/(?:^|;\s*)farming_token=([^;]+)/);
    if (match) return decodeCookieToken(match[1]);

    return null;
  }

  middleware() {
    return (req, res, next) => {
      if (this.disabled) return next();

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // Allow auth status endpoint without authentication
      if (url.pathname === this.authStatusPath) {
        return next();
      }

      const token = this.extractToken(req);

      // URL has token query param -> validate, set cookie, redirect
      if (url.searchParams.has('token')) {
        if (token && this.verify(token)) {
          res.setHeader('Set-Cookie',
            `farming_token=${encodeCookieToken(this.token)}; Path=/; HttpOnly; SameSite=Lax`);
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
