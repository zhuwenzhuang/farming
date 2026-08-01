const crypto = require('crypto');
const fs = require('fs');
import {
  createPoeticToken,
  generatePoeticToken,
  getPoeticTokenEntropyBits,
  type CreatedPoeticToken,
} from './haiku-token.cjs';

interface FarmingNetPassVerifierLike {
  verify(pass: unknown): { valid: boolean };
}

import { FarmingNetPassVerifier, PASS_QUERY_PARAM } from './farming-net-pass.cjs';
import { configInstanceFingerprint } from './config-instance.cjs';

interface PoeticTokenInfo extends Omit<CreatedPoeticToken, 'locale' | 'style'> {
  locale?: CreatedPoeticToken['locale'];
  style: CreatedPoeticToken['style'] | 'configured' | 'persisted';
}

import * as storageLayout from './storage-layout.cjs';

interface TokenAuthOptions {
  basePath?: string;
  cookieName?: unknown;
  cookiePath?: unknown;
  disabled?: boolean;
  env?: NodeJS.ProcessEnv;
  farmingDir?: string;
  farmingNetPassVerifier?: FarmingNetPassVerifierLike | false;
  farmingNetTrustFile?: string;
  redirectQueryToken?: boolean;
  timeZone?: string;
  token?: unknown;
  tokenLocale?: unknown;
}

interface AuthRequest {
  headers: {
    authorization?: string | string[];
    cookie?: string;
    host?: string;
  };
  method?: string;
  url?: string;
}

interface AuthResponse {
  end(body?: string): void;
  setHeader(name: string, value: string): void;
  writeHead(statusCode: number, headers?: Record<string, string>): void;
}

type AuthNext = () => unknown;
type AuthMiddleware = (req: AuthRequest, res: AuthResponse, next: AuthNext) => unknown;

const LEGACY_COOKIE_NAME = 'farming_token';

function normalizeBasePath(basePath: unknown): string {
  const normalized = String(basePath || '');
  if (!normalized || normalized === '/') return '';
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function isTruthyEnv(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function encodeCookieToken(token: unknown): string {
  return encodeURIComponent(String(token));
}

function decodeCookieToken(token: string): string {
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

function encodeBearerTokenForTransport(token: unknown): string {
  return Buffer.from(String(token), 'utf8').toString('base64url');
}

function bearerAuthorizationHeader(token: unknown): string {
  return `Bearer ${encodeBearerTokenForTransport(token)}`;
}

function decodeBearerTokenFromTransport(credential: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(credential)) return null;
  try {
    const decoded = Buffer.from(credential, 'base64url').toString('utf8');
    return encodeBearerTokenForTransport(decoded) === credential ? decoded : null;
  } catch {
    return null;
  }
}

function normalizeCookieName(value: unknown, fallback: string): string {
  const cookieName = String(value || '').trim();
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName) ? cookieName : fallback;
}

function normalizeCookiePath(value: unknown): string {
  const cookiePath = String(value || '/').trim();
  if (!cookiePath.startsWith('/') || /[;\r\n]/.test(cookiePath)) return '/';
  return cookiePath;
}

function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function farmingAuthCookieName(configDir: string): string {
  return `${LEGACY_COOKIE_NAME}_${configInstanceFingerprint(configDir)}`;
}

function readExistingTokenFile(tokenFile: string): string {
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    return token || '';
  } catch {
    return '';
  }
}

class TokenAuth {
  disabled: boolean;
  basePath: string;
  authStatusPath: string;
  cookieName: string;
  cookiePath: string;
  legacyCookieReadCompatible: boolean;
  redirectQueryToken: boolean;
  tokenFile: string;
  token: string;
  tokenInfo: PoeticTokenInfo | null;
  farmingNetPassVerifier: FarmingNetPassVerifierLike | null;

  constructor(options: TokenAuthOptions = {}) {
    const authEnv = options.env || process.env;
    this.disabled = options.disabled === true || isTruthyEnv(authEnv.FARMING_DISABLE_AUTH);
    this.basePath = normalizeBasePath(options.basePath || '/');
    this.authStatusPath = this.basePath ? `${this.basePath}/api/auth/status` : '/api/auth/status';
    const farmingDir = options.farmingDir || storageLayout.farmingConfigDir(authEnv);
    if (!this.disabled && !fs.existsSync(farmingDir)) {
      fs.mkdirSync(farmingDir, { recursive: true });
    }
    const explicitCookieName = normalizeCookieName(options.cookieName, '');
    this.cookieName = explicitCookieName || farmingAuthCookieName(farmingDir);
    this.cookiePath = normalizeCookiePath(options.cookiePath ?? (this.basePath || '/'));
    this.legacyCookieReadCompatible = !explicitCookieName;
    this.redirectQueryToken = options.redirectQueryToken === true;
    this.tokenFile = '';
    this.token = '';
    this.tokenInfo = null;
    this.farmingNetPassVerifier = null;

    if (this.disabled) {
      return;
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

  saveTokenFile(): void {
    if (this.disabled || !this.tokenFile) return;
    fs.writeFileSync(this.tokenFile, this.token, { mode: 0o600 });
  }

  isEnabled(): boolean {
    return !this.disabled;
  }

  getToken(): string {
    return this.token;
  }

  getTokenFile(): string {
    return this.tokenFile;
  }

  getTokenInfo(): PoeticTokenInfo | null {
    return this.tokenInfo;
  }

  getCookieName(): string {
    return this.cookieName;
  }

  verify(token: unknown): boolean {
    if (this.disabled) return true;
    if (!token || !this.token) return false;
    try {
      const a = Buffer.from(String(token));
      const b = Buffer.from(this.token);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  extractToken(req: AuthRequest): string | null {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;

    const bearerToken = this.extractBearerToken(req);
    if (bearerToken !== null) return bearerToken;

    return this.extractCookieToken(req);
  }

  extractBearerToken(req: AuthRequest): string | null {
    const authorization = req.headers.authorization;
    if (authorization === undefined) return null;
    if (typeof authorization !== 'string') return '';
    if (!/^\s*Bearer(?:\s|$)/i.test(authorization)) return null;

    const match = authorization.match(/^\s*Bearer\s+([^\s]+)\s*$/i);
    if (!match) return '';
    const credential = match[1];
    if (this.verify(credential)) return credential;
    const decoded = decodeBearerTokenFromTransport(credential);
    return decoded && this.verify(decoded) ? decoded : credential;
  }

  extractCookieToken(req: AuthRequest): string | null {
    const cookies = req.headers.cookie || '';
    const match = cookies.match(new RegExp(`(?:^|;\\s*)${escapeRegExp(this.cookieName)}=([^;]+)`));
    if (match) return decodeCookieToken(match[1]);

    if (this.legacyCookieReadCompatible && this.cookieName !== LEGACY_COOKIE_NAME) {
      const legacyMatch = cookies.match(new RegExp(`(?:^|;\\s*)${LEGACY_COOKIE_NAME}=([^;]+)`));
      if (legacyMatch) return decodeCookieToken(legacyMatch[1]);
    }

    return null;
  }

  setAuthenticatedCookie(res: Pick<AuthResponse, 'setHeader'>): void {
    res.setHeader('Set-Cookie',
      `${this.cookieName}=${encodeCookieToken(this.token)}; Path=${this.cookiePath}; HttpOnly; SameSite=Lax`);
  }

  redirectWithoutQueryParameter(res: AuthResponse, url: URL, parameter: string): void {
    url.searchParams.delete(parameter);
    const search = url.searchParams.toString();
    res.writeHead(302, {
      'Cache-Control': 'no-store',
      Location: `${url.pathname}${search ? `?${search}` : ''}`,
    });
    res.end();
  }

  middleware(): AuthMiddleware {
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

  verifyWebSocket(req: AuthRequest): boolean {
    if (this.disabled) return true;
    const token = this.extractToken(req);
    return token !== null && this.verify(token);
  }

  cleanup(options: { removeTokenFile?: boolean } = {}): void {
    if (options.removeTokenFile !== true) return;
    try {
      fs.unlinkSync(this.tokenFile);
    } catch {
      // ignore
    }
  }
}

export {
  TokenAuth,
  bearerAuthorizationHeader,
  decodeCookieToken,
  encodeCookieToken,
  farmingAuthCookieName,
  generatePoeticToken,
  getPoeticTokenEntropyBits,
};
