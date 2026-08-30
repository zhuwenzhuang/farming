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
  authAccessMode?: AuthAccessMode;
  headers: {
    authorization?: string | string[];
    cookie?: string;
    host?: string;
  };
  method?: string;
  url?: string;
}

type AuthAccessMode = 'none' | 'owner' | 'read-only';

interface AuthResponse {
  end(body?: string): void;
  setHeader(name: string, value: string): void;
  writeHead(statusCode: number, headers?: Record<string, string>): void;
}

type AuthNext = () => unknown;
type AuthMiddleware = (req: AuthRequest, res: AuthResponse, next: AuthNext) => unknown;

const LEGACY_COOKIE_NAME = 'farming_token';
const READ_ONLY_TOKEN_PREFIX = 'farming-ro-v1';
const SAFE_READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function authenticatedAccessScopeId(token: unknown, accessMode: AuthAccessMode): string {
  const credential = String(token || '');
  if (!credential && accessMode === 'read-only') {
    throw new Error('read-only access requires an exact authenticated credential');
  }
  return crypto
    .createHash('sha256')
    .update(credential || 'farming-owner-auth-disabled')
    .digest('base64url');
}

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

function fsErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

// O_NOFOLLOW exists on the supported server platforms (Linux and macOS).
// Where it is unavailable (Windows, which is not a supported server
// platform), an lstat refusal remains the best-effort guard.
function noFollowOpenFlag(): number {
  return fs.constants.O_NOFOLLOW || 0;
}

// Linux-only flag; Node does not export it. It pins an inode without any
// access-mode check and without following links.
const LINUX_O_PATH = 0x200000;

interface TokenFileIdentity {
  dev: number;
  ino: number;
}

interface SecuredTokenFile {
  descriptor: number;
  identity: TokenFileIdentity;
  uid: number;
}

function tokenFileNotRegularError(tokenFile: string, found: string): Error {
  return new Error(
    `Session token file ${tokenFile} must be a regular file, but it is ${found}. `
    + 'Farming refuses to read or write auth state through another path. '
    + 'Remove the file or replace it with a regular file, then start Farming again.',
  );
}

function tokenFileOwnershipError(tokenFile: string, fileUid: number, currentUid: number): Error {
  return new Error(
    `Session token file ${tokenFile} is owned by uid ${fileUid}, but Farming runs as uid ${currentUid}. `
    + 'Farming cannot prove ownership of this auth file. Remove the file or restore its owner, then start Farming again.',
  );
}

function currentEffectiveUid(): number {
  return typeof process.geteuid === 'function' ? process.geteuid() : -1;
}

function regularTokenFileIdentity(tokenFile: string, status: { dev: number; ino: number; isFile(): boolean }): TokenFileIdentity {
  if (!status.isFile()) throw tokenFileNotRegularError(tokenFile, 'a non-regular file');
  return { dev: status.dev, ino: status.ino };
}

function assertVisibleTokenFileNotLink(tokenFile: string): void {
  let status;
  try {
    status = fs.lstatSync(tokenFile);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (status.isSymbolicLink()) throw tokenFileNotRegularError(tokenFile, 'a symbolic link');
  if (!status.isFile()) throw tokenFileNotRegularError(tokenFile, 'a non-regular file');
}

// Opens the existing session token file and returns a descriptor pinned to
// one exact inode. Every later mode, read, and write operation uses that
// descriptor (or its kernel-owned /proc/self/fd alias), so a racing swap of
// the visible path — for example replacing the file with a symlink — can
// never redirect securing, reading, or writing to another file.
function openExistingTokenFile(tokenFile: string): SecuredTokenFile | null {
  if (!noFollowOpenFlag()) {
    // Platform without O_NOFOLLOW: the lstat refusal is the only available
    // link check. Farming servers run on Linux and macOS, where the open
    // below refuses links atomically.
    assertVisibleTokenFileNotLink(tokenFile);
  }
  let descriptor = -1;
  try {
    descriptor = fs.openSync(tokenFile, fs.constants.O_RDONLY | noFollowOpenFlag());
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw tokenFileNotRegularError(tokenFile, 'a symbolic link');
    if (code === 'EISDIR') throw tokenFileNotRegularError(tokenFile, 'a directory');
    if (code === 'ENXIO') throw tokenFileNotRegularError(tokenFile, 'a non-regular file');
    if (code === 'EACCES' || code === 'EPERM') return openOwnedButUnreadableTokenFile(tokenFile);
    throw error;
  }
  try {
    const status = fs.fstatSync(descriptor);
    const identity = regularTokenFileIdentity(tokenFile, status);
    return { descriptor, identity, uid: status.uid };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

// A token file owned by this user may still deny a read open because its
// mode lacks the owner read bit (for example 0o000). Its mode must be
// repaired without any path-based operation that could act on a swapped-in
// file. Platform support:
// - Linux: pin the inode with O_PATH|O_NOFOLLOW, repair the mode through
//   the kernel-owned /proc/self/fd alias, then reopen the pinned inode.
// - macOS and other platforms: no swap-safe repair primitive exists for an
//   unreadable file, so fail closed with explicit repair instructions.
function openOwnedButUnreadableTokenFile(tokenFile: string): SecuredTokenFile | null {
  const currentUid = currentEffectiveUid();
  if (process.platform === 'linux') {
    let pathDescriptor = -1;
    try {
      pathDescriptor = fs.openSync(tokenFile, LINUX_O_PATH | noFollowOpenFlag());
    } catch (error) {
      const code = fsErrorCode(error);
      if (code === 'ENOENT') return null;
      if (code === 'ELOOP') throw tokenFileNotRegularError(tokenFile, 'a symbolic link');
      throw error;
    }
    try {
      const status = fs.fstatSync(pathDescriptor);
      const identity = regularTokenFileIdentity(tokenFile, status);
      if (currentUid >= 0 && status.uid !== currentUid) {
        throw tokenFileOwnershipError(tokenFile, status.uid, currentUid);
      }
      // chmod through /proc/self/fd targets the pinned inode itself; it
      // cannot be redirected by replacing the visible path.
      fs.chmodSync(`/proc/self/fd/${pathDescriptor}`, 0o600);
      const descriptor = fs.openSync(`/proc/self/fd/${pathDescriptor}`, fs.constants.O_RDONLY);
      try {
        const reopened = fs.fstatSync(descriptor);
        const reopenedIdentity = regularTokenFileIdentity(tokenFile, reopened);
        if (reopenedIdentity.dev !== identity.dev || reopenedIdentity.ino !== identity.ino) {
          throw new Error(
            `Session token file ${tokenFile} changed identity while it was being secured; start Farming again`,
          );
        }
        return { descriptor, identity: reopenedIdentity, uid: reopened.uid };
      } catch (error) {
        fs.closeSync(descriptor);
        throw error;
      }
    } finally {
      fs.closeSync(pathDescriptor);
    }
  }
  throw new Error(
    `Session token file ${tokenFile} exists but cannot be read, and Farming cannot safely repair it on this platform. `
    + 'Restore its owner permissions (mode 0600) or remove it, then start Farming again.',
  );
}

// Secures an existing session token file to owner-only mode and reads its
// persisted token through one pinned inode. Returns an empty token and null
// identity when the file does not exist yet.
function secureAndReadExistingTokenFile(tokenFile: string): { token: string; identity: TokenFileIdentity | null } {
  const opened = openExistingTokenFile(tokenFile);
  if (!opened) return { token: '', identity: null };
  try {
    const currentUid = currentEffectiveUid();
    if (currentUid >= 0 && opened.uid !== currentUid) {
      throw tokenFileOwnershipError(tokenFile, opened.uid, currentUid);
    }
    try {
      fs.fchmodSync(opened.descriptor, 0o600);
    } catch (error) {
      const code = fsErrorCode(error);
      if (code === 'EPERM' || code === 'EACCES') {
        throw new Error(
          `Session token file ${tokenFile} could not be secured (file uid ${opened.uid}, current uid ${currentUid}). `
          + 'Farming cannot prove ownership of this auth file. Remove the file or restore its owner, then start Farming again.',
          { cause: error },
        );
      }
      throw error;
    }
    const size = fs.fstatSync(opened.descriptor).size;
    if (size > 64 * 1024) {
      throw new Error(
        `Session token file ${tokenFile} is ${size} bytes; expected a small Farming token file. `
        + 'Remove the file or restore it, then start Farming again.',
      );
    }
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const bytes = fs.readSync(opened.descriptor, buffer, read, size - read, read);
      if (bytes === 0) break;
      read += bytes;
    }
    // The visible path must still name the exact inode that was secured and
    // read; otherwise later path-based consumers (for example the CLI) would
    // observe different auth state than this startup loaded.
    let visible = null;
    try {
      visible = fs.lstatSync(tokenFile);
    } catch (error) {
      if (fsErrorCode(error) !== 'ENOENT') throw error;
    }
    if (
      !visible
      || visible.isSymbolicLink()
      || visible.dev !== opened.identity.dev
      || visible.ino !== opened.identity.ino
    ) {
      throw new Error(
        `Session token file ${tokenFile} changed identity while it was being read; start Farming again`,
      );
    }
    return { token: buffer.subarray(0, read).toString('utf8').trim(), identity: opened.identity };
  } finally {
    fs.closeSync(opened.descriptor);
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
  securedTokenFileIdentity: TokenFileIdentity | null;

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
    this.securedTokenFileIdentity = null;

    if (this.disabled) {
      return;
    }

    this.tokenFile = storageLayout.sessionTokenFile(farmingDir);
    const securedExistingToken = secureAndReadExistingTokenFile(this.tokenFile);
    this.securedTokenFileIdentity = securedExistingToken.identity;
    if (options.farmingNetPassVerifier !== false) {
      this.farmingNetPassVerifier = options.farmingNetPassVerifier || new FarmingNetPassVerifier({
        trustFile: options.farmingNetTrustFile || storageLayout.farmingNetTrustFile(farmingDir),
      });
    }
    const configuredTokenSource = Object.prototype.hasOwnProperty.call(options, 'token')
      ? options.token
      : authEnv.FARMING_TOKEN;
    const configuredToken = String(configuredTokenSource || '').trim();
    const existingToken = configuredToken ? '' : securedExistingToken.token;
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
    // Write through one descriptor pinned by an open that never follows
    // links. For a file secured during startup, open without O_TRUNC first:
    // the identity and owner are verified before anything is truncated, so a
    // racing swap of the visible path cannot get another file truncated or
    // overwritten. A file that did not exist at startup is created with
    // O_EXCL so a racing creation fails closed instead of being clobbered.
    let descriptor = -1;
    try {
      if (this.securedTokenFileIdentity) {
        descriptor = fs.openSync(this.tokenFile, fs.constants.O_WRONLY | noFollowOpenFlag());
        const status = fs.fstatSync(descriptor);
        if (!status.isFile()) {
          throw tokenFileNotRegularError(this.tokenFile, status.isDirectory() ? 'a directory' : 'a non-regular file');
        }
        if (status.dev !== this.securedTokenFileIdentity.dev || status.ino !== this.securedTokenFileIdentity.ino) {
          throw new Error(
            `Session token file ${this.tokenFile} changed identity between securing and writing; start Farming again`,
          );
        }
        const currentUid = currentEffectiveUid();
        if (currentUid >= 0 && status.uid !== currentUid) {
          throw tokenFileOwnershipError(this.tokenFile, status.uid, currentUid);
        }
        fs.ftruncateSync(descriptor, 0);
      } else {
        descriptor = fs.openSync(
          this.tokenFile,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowOpenFlag(),
          0o600,
        );
      }
      fs.writeSync(descriptor, this.token);
      fs.fchmodSync(descriptor, 0o600);
    } catch (error) {
      const code = fsErrorCode(error);
      if (code === 'ELOOP') throw tokenFileNotRegularError(this.tokenFile, 'a symbolic link');
      if (code === 'EEXIST') {
        throw new Error(
          `Session token file ${this.tokenFile} appeared while Farming was starting. `
          + 'Verify that no other process claims this Config, then start Farming again.',
        );
      }
      if (code === 'ENOENT' && this.securedTokenFileIdentity) {
        throw new Error(
          `Session token file ${this.tokenFile} disappeared while Farming was starting; start Farming again`,
        );
      }
      throw error;
    } finally {
      if (descriptor >= 0) fs.closeSync(descriptor);
    }
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

  createReadOnlyToken(options: { expiresAt: number }): string {
    if (this.disabled || !this.token) {
      throw new Error('Read-only sharing requires token authentication');
    }
    const expiresAt = Math.floor(Number(options.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('Read-only share expiry must be in the future');
    }
    const payload = [
      READ_ONLY_TOKEN_PREFIX,
      expiresAt.toString(36),
      crypto.randomBytes(18).toString('base64url'),
    ].join('.');
    const signature = crypto.createHmac('sha256', this.token).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  verifyReadOnlyToken(token: unknown, now = Date.now()): boolean {
    if (this.disabled || !this.token || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== READ_ONLY_TOKEN_PREFIX) return false;
    const expiresAt = Number.parseInt(parts[1], 36);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
    const payload = parts.slice(0, 3).join('.');
    const expected = crypto.createHmac('sha256', this.token).update(payload).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(parts[3], 'base64url');
    } catch {
      return false;
    }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  readOnlyTokenExpiresAt(token: unknown): number | null {
    if (!this.verifyReadOnlyToken(token)) return null;
    const expiresAt = Number.parseInt(String(token).split('.')[1], 36);
    return Number.isFinite(expiresAt) ? expiresAt : null;
  }

  accessForToken(token: unknown): AuthAccessMode {
    if (this.disabled) return 'owner';
    if (this.verify(token)) return 'owner';
    if (this.verifyReadOnlyToken(token)) return 'read-only';
    return 'none';
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
    if (this.accessForToken(credential) !== 'none') return credential;
    const decoded = decodeBearerTokenFromTransport(credential);
    return decoded && this.accessForToken(decoded) !== 'none' ? decoded : credential;
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

  setAccessCookie(res: Pick<AuthResponse, 'setHeader'>, token: unknown): void {
    res.setHeader('Set-Cookie',
      `${this.cookieName}=${encodeCookieToken(token)}; Path=${this.cookiePath}; HttpOnly; SameSite=Lax`);
  }

  setAuthenticatedCookie(res: Pick<AuthResponse, 'setHeader'>): void {
    this.setAccessCookie(res, this.token);
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
      const authorize = (accessMode: AuthAccessMode) => {
        const shareTicketPath = this.basePath
          ? `${this.basePath}/api/share/qr-ticket`
          : '/api/share/qr-ticket';
        const readOnlyShareMutation = (
          method === 'POST' && url.pathname === shareTicketPath
        ) || (
          method === 'DELETE' && url.pathname.startsWith(`${shareTicketPath}/`)
        );
        if (
          accessMode === 'read-only'
          && !SAFE_READ_ONLY_METHODS.has(method)
          && !readOnlyShareMutation
        ) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'This Farming share is read-only.' }));
          return;
        }
        req.authAccessMode = accessMode;
        return next();
      };

      // URL has token query param -> validate, set cookie, redirect
      if (url.searchParams.has('token')) {
        const accessMode = this.accessForToken(token);
        if (token && accessMode !== 'none') {
          this.setAccessCookie(res, token);
          if (
            ['GET', 'HEAD'].includes(method)
            && (this.redirectQueryToken || accessMode === 'read-only')
          ) {
            this.redirectWithoutQueryParameter(res, url, 'token');
            return;
          }
          return authorize(accessMode);
        }
      }

      // Cookie-based verification
      const accessMode = this.accessForToken(token);
      if (accessMode !== 'none') {
        return authorize(accessMode);
      }

      // Unauthorized
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token required. Use the URL printed in terminal.' }));
    };
  }

  verifyWebSocket(req: AuthRequest): boolean {
    return this.webSocketAccess(req) !== 'none';
  }

  webSocketAccess(req: AuthRequest): AuthAccessMode {
    if (this.disabled) return 'owner';
    return this.accessForToken(this.extractToken(req));
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
  type AuthAccessMode,
  TokenAuth,
  authenticatedAccessScopeId,
  bearerAuthorizationHeader,
  decodeCookieToken,
  encodeCookieToken,
  farmingAuthCookieName,
  generatePoeticToken,
  getPoeticTokenEntropyBits,
};
