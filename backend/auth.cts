const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
import {
  createPoeticToken,
  createPoeticTokenChallenge,
  generatePoeticToken,
  getPoeticTokenEntropyBits,
  type CreatedPoeticToken,
  type PoeticTokenChallenge,
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
  appearance?: unknown | (() => unknown);
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
    accept?: string | string[];
    authorization?: string | string[];
    cookie?: string;
    host?: string;
    'x-farming-auth-probe'?: string | string[];
  };
  method?: string;
  url?: string;
}

type AuthAccessMode = 'none' | 'owner' | 'read-only';
type AuthGateAppearance = 'light' | 'dark' | 'paper' | 'system';

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

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeAuthGateAppearance(value: unknown): AuthGateAppearance {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'light' || normalized === 'dark' || normalized === 'paper') {
    return normalized;
  }
  return 'system';
}

let cachedFallbackLogoDataUri: string | null = null;
function loadFallbackLogoDataUri(): string {
  if (cachedFallbackLogoDataUri !== null) return cachedFallbackLogoDataUri;
  const candidates = [
    path.resolve(__dirname, '..', 'public', 'farming-2', 'logo-64.png'),
    path.resolve(__dirname, '..', 'dist', 'farming-2', 'logo-64.png'),
    path.resolve(__dirname, '..', 'public', 'farming-2', 'app-icon-v2-180.png'),
    path.resolve(__dirname, '..', 'dist', 'farming-2', 'app-icon-v2-180.png'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const bytes = fs.readFileSync(candidate);
        cachedFallbackLogoDataUri = `data:image/png;base64,${bytes.toString('base64')}`;
        return cachedFallbackLogoDataUri;
      }
    } catch {
      // Ignore unreadable icon candidate and try next.
    }
  }
  cachedFallbackLogoDataUri = '';
  return cachedFallbackLogoDataUri;
}

function renderAuthGateHtml(options: {
  appearance: AuthGateAppearance;
  basePath: string;
  challenge: PoeticTokenChallenge;
  nonce: string;
}): string {
  const { appearance, basePath, challenge, nonce } = options;
  const resolvedAppearance = appearance === 'system' ? 'light' : appearance;
  const colorScheme = appearance === 'system'
    ? 'light dark'
    : resolvedAppearance === 'dark'
      ? 'dark'
      : 'light';
  const themeColor = resolvedAppearance === 'dark'
    ? '#181818'
    : resolvedAppearance === 'paper'
      ? '#f9f8f4'
      : '#ffffff';
  const isWordMode = challenge.mode === 'word';
  const uiLocale = challenge.locale || (isWordMode ? 'en' : 'zh');
  const lang = uiLocale === 'ja' ? 'ja' : uiLocale === 'en' ? 'en' : 'zh-CN';
  const backspaceLabel = uiLocale === 'ja' ? '戻る' : uiLocale === 'en' ? 'Backspace' : '退格';
  const clearLabel = uiLocale === 'ja' ? 'クリア' : uiLocale === 'en' ? 'Clear' : '清空';
  const invalidLabel = uiLocale === 'ja' ? 'パスフレーズが無効です' : uiLocale === 'en' ? 'Invalid passphrase' : '口令无效';
  const slotsAriaLabel = uiLocale === 'ja' ? 'パスフレーズスロット' : uiLocale === 'en' ? 'Passphrase slots' : '口令槽';
  const poolAriaLabel = uiLocale === 'ja' ? '候補パネル' : uiLocale === 'en' ? 'Candidate word pool' : '候选字盘';
  const iconSrc = `${basePath || ''}/farming-2/app-icon-v2-180.png`;
  const faviconHref = `${basePath || ''}/farming-2/favicon-v3.ico`;
  const fallbackLogoDataUri = loadFallbackLogoDataUri();

  let firstEmptyAssigned = false;
  const rowsHtml = challenge.rows.map((row, rowIndex) => {
    const prefixCells = row.prefix.map(item => (
      `<span class="${isWordMode ? 'word-slot' : 'slot-cell'} prefilled" aria-hidden="true">${escapeHtml(item)}</span>`
    ));
    const fillableCells = Array.from({ length: row.fillableCount }, (_, colIndex) => {
      const isFirstEmpty = !firstEmptyAssigned;
      if (isFirstEmpty) firstEmptyAssigned = true;
      const stateClass = isFirstEmpty ? 'active' : 'empty';
      return `<button type="button" class="${isWordMode ? 'word-slot' : 'slot-cell'} fillable ${stateClass}" data-row="${rowIndex}" data-col="${colIndex}" aria-label="slot-${rowIndex}-${colIndex}"></button>`;
    });
    return `<div class="${isWordMode ? 'word-row' : 'poem-row'}">${prefixCells.concat(fillableCells).join('')}</div>`;
  }).join('');

  const poolHtml = challenge.pool.map((item, poolIndex) => (
    `<button type="button" class="${isWordMode ? 'word-tile' : 'pool-tile'}" data-pool-index="${poolIndex}">${escapeHtml(item)}</button>`
  )).join('');

  const serializedChallenge = JSON.stringify(challenge).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="${lang}" data-appearance-preference="${appearance}" data-appearance="${resolvedAppearance}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="${colorScheme}" />
  <meta name="theme-color" content="${themeColor}" />
  <link rel="icon" href="${escapeHtml(faviconHref)}" />
  <title>Farming</title>
  <style nonce="${nonce}">
    :root, [data-appearance="light"] {
      --code-bg-canvas: #ffffff;
      --code-bg-inset: #f0f2ef;
      --code-bg-raised: #ffffff;
      --code-active-item-surface: #eeeeec;
      --code-text: #24292f;
      --code-text-muted: #57606a;
      --code-text-subtle: #6e7781;
      --code-text-disabled: #afb8c1;
      --code-border: rgba(31, 35, 40, 0.12);
      --code-border-strong: rgba(31, 35, 40, 0.18);
      --code-border-subtle: rgba(31, 35, 40, 0.08);
      --code-accent: #0969da;
      --code-danger: #cf222e;
      --code-danger-soft: rgba(207, 34, 46, 0.1);
      --code-border-danger: rgba(207, 34, 46, 0.32);
      --code-diff-removed: #b4232d;
      --gate-slot-empty-border: rgba(31, 35, 40, 0.14);
      --gate-pool-border: rgba(31, 35, 40, 0.08);
    }
    [data-appearance="dark"] {
      --code-bg-canvas: #181818;
      --code-bg-inset: #222222;
      --code-bg-raised: #303030;
      --code-active-item-surface: #233648;
      --code-text: #ffffff;
      --code-text-muted: #d8d8d8;
      --code-text-subtle: #9b9b9b;
      --code-text-disabled: #6e7681;
      --code-border: #383838;
      --code-border-strong: #484848;
      --code-border-subtle: #2a2a2a;
      --code-accent: #339cff;
      --code-danger: #fa423e;
      --code-danger-soft: rgba(250, 66, 62, 0.14);
      --code-border-danger: rgba(248, 81, 73, 0.42);
      --code-diff-removed: #ff7b72;
      --gate-slot-empty-border: #383838;
      --gate-pool-border: #2a2a2a;
    }
    [data-appearance="paper"] {
      --code-bg-canvas: #f9f8f4;
      --code-bg-inset: #efede7;
      --code-bg-raised: #fffefa;
      --code-active-item-surface: #e6e5e1;
      --code-text: #282922;
      --code-text-muted: #68685f;
      --code-text-subtle: #77776d;
      --code-text-disabled: #aaa79d;
      --code-border: #dfdbd0;
      --code-border-strong: #cfc9bc;
      --code-border-subtle: #e5e1d6;
      --code-accent: #282922;
      --code-danger: #b4232f;
      --code-danger-soft: rgba(180, 35, 47, 0.09);
      --code-border-danger: rgba(180, 35, 47, 0.35);
      --code-diff-removed: #a33a3f;
      --gate-slot-empty-border: #d8d3c8;
      --gate-pool-border: transparent;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      user-select: none;
      background: var(--code-bg-canvas);
      color: var(--code-text);
    }
    body.code-mode {
      display: flex;
      flex-direction: column;
      overflow: auto;
    }
    .auth-viewport {
      flex: 1;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .auth-surface {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 22px;
      max-width: 100%;
    }
    .brand-header {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .brand-logo {
      width: 56px;
      height: 56px;
      display: block;
      border-radius: 14px;
      object-fit: cover;
    }
    .brand-title {
      margin: 0;
      font-size: 17px;
      font-weight: 500;
      letter-spacing: -0.018em;
      line-height: 1.2;
      color: var(--code-text);
    }
    .poem-slots, .word-slots {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 7px;
    }
    .poem-row, .word-row {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 6px;
    }
    .slot-cell {
      width: 36px;
      height: 36px;
      padding: 0;
      border-radius: 7px;
      display: grid;
      place-items: center;
      font-family: inherit;
      font-size: 15px;
      font-weight: 500;
      outline: none;
    }
    .word-slot {
      min-width: 72px;
      height: 32px;
      padding: 0 10px;
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      outline: none;
    }
    .slot-cell.prefilled, .word-slot.prefilled {
      background: var(--code-bg-inset);
      border: 1px solid var(--code-border);
      color: var(--code-text-muted);
      cursor: default;
    }
    .slot-cell.empty, .word-slot.empty {
      background: transparent;
      border: 1px dashed var(--gate-slot-empty-border);
      color: transparent;
      cursor: pointer;
    }
    .slot-cell.active, .word-slot.active {
      background: var(--code-bg-canvas);
      border: 1.5px solid var(--code-accent);
      color: var(--code-text);
      cursor: pointer;
    }
    .slot-cell.filled, .word-slot.filled {
      background: var(--code-bg-raised);
      border: 1px solid var(--code-border-strong);
      color: var(--code-text);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
      cursor: pointer;
    }
    .slot-cell.error, .word-slot.error {
      background: var(--code-danger-soft);
      border: 1px solid var(--code-border-danger);
      color: var(--code-diff-removed);
      cursor: pointer;
    }
    .status-line {
      min-height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: -10px 0;
      font-size: 12px;
      color: var(--code-danger);
    }
    .status-line[hidden] {
      display: none;
    }
    .char-pool {
      display: grid;
      grid-template-columns: repeat(${challenge.columns}, 36px);
      gap: 6px;
    }
    .word-pool {
      display: grid;
      grid-template-columns: repeat(${challenge.columns}, minmax(76px, 1fr));
      gap: 7px;
    }
    .pool-tile {
      width: 36px;
      height: 36px;
      padding: 0;
      border-radius: 7px;
      display: grid;
      place-items: center;
      font-family: inherit;
      font-size: 15px;
      font-weight: 450;
      background: var(--code-bg-inset);
      border: 1px solid var(--gate-pool-border);
      color: var(--code-text);
      cursor: pointer;
    }
    .word-tile {
      height: 32px;
      padding: 0 12px;
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: inherit;
      font-size: 13px;
      font-weight: 450;
      background: var(--code-bg-inset);
      border: 1px solid var(--gate-pool-border);
      color: var(--code-text);
      cursor: pointer;
    }
    .pool-tile:hover:not(.used), .word-tile:hover:not(.used) {
      background: var(--code-active-item-surface);
    }
    .pool-tile.used, .word-tile.used {
      background: transparent;
      border: 1px dashed var(--code-border-subtle);
      color: var(--code-text-disabled);
      opacity: 0.36;
      cursor: default;
    }
    .minor-actions {
      margin-top: -6px;
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 12px;
      color: var(--code-text-subtle);
    }
    .minor-action-btn {
      padding: 2px 4px;
      border: none;
      border-radius: 5px;
      background: transparent;
      font-family: inherit;
      font-size: 12px;
      color: var(--code-text-subtle);
      cursor: pointer;
    }
    .minor-action-btn:hover {
      background: var(--code-active-item-surface);
      color: var(--code-text);
    }
  </style>
</head>
<body class="code-mode" data-auth-gate="poetic-tap">
  <main class="auth-viewport">
    <section class="auth-surface">
      <header class="brand-header">
        <img id="brand-logo" class="brand-logo" src="${escapeHtml(iconSrc)}" data-fallback="${escapeHtml(fallbackLogoDataUri)}" alt="" />
        <h1 class="brand-title">Farming</h1>
      </header>

      <div id="token-slots" class="${isWordMode ? 'word-slots' : 'poem-slots'}" role="group" aria-label="${escapeHtml(slotsAriaLabel)}">
        ${rowsHtml}
      </div>

      <div id="status-line" class="status-line" role="status" aria-live="polite" hidden>${escapeHtml(invalidLabel)}</div>

      <div id="candidate-pool" class="${isWordMode ? 'word-pool' : 'char-pool'}" role="group" aria-label="${escapeHtml(poolAriaLabel)}">
        ${poolHtml}
      </div>

      <div class="minor-actions">
        <button type="button" id="btn-backspace" class="minor-action-btn">${escapeHtml(backspaceLabel)}</button>
        <span aria-hidden="true">·</span>
        <button type="button" id="btn-clear" class="minor-action-btn">${escapeHtml(clearLabel)}</button>
      </div>
    </section>
  </main>
  <script nonce="${nonce}">
    (function () {
      var root = document.documentElement;
      if (root.getAttribute('data-appearance-preference') === 'system' && window.matchMedia) {
        var media = window.matchMedia('(prefers-color-scheme: dark)');
        var syncAppearance = function () {
          root.setAttribute('data-appearance', media.matches ? 'dark' : 'light');
        };
        syncAppearance();
        if (typeof media.addEventListener === 'function') {
          media.addEventListener('change', syncAppearance);
        }
      }

      var logo = document.getElementById('brand-logo');
      if (logo) {
        logo.addEventListener('error', function () {
          var fallback = logo.getAttribute('data-fallback');
          if (fallback && logo.getAttribute('src') !== fallback) {
            logo.setAttribute('src', fallback);
          }
        });
      }

      var challenge = ${serializedChallenge};
      var slotButtons = Array.prototype.slice.call(document.querySelectorAll('.fillable'));
      var poolButtons = Array.prototype.slice.call(document.querySelectorAll('[data-pool-index]'));
      var statusLine = document.getElementById('status-line');
      var btnBackspace = document.getElementById('btn-backspace');
      var btnClear = document.getElementById('btn-clear');

      var slots = slotButtons.map(function () { return null; });
      var activeSlotIndex = 0;
      var hasError = false;
      var verifying = false;

      function findFirstEmptySlot() {
        for (var i = 0; i < slots.length; i += 1) {
          if (!slots[i]) return i;
        }
        return -1;
      }

      function render() {
        var usedPool = {};
        for (var i = 0; i < slots.length; i += 1) {
          if (slots[i]) usedPool[slots[i].poolIndex] = true;
        }
        var nextEmpty = findFirstEmptySlot();
        if (activeSlotIndex < 0 || activeSlotIndex >= slots.length || slots[activeSlotIndex]) {
          activeSlotIndex = nextEmpty;
        }

        for (var s = 0; s < slotButtons.length; s += 1) {
          var btn = slotButtons[s];
          var item = slots[s];
          btn.classList.remove('empty', 'active', 'filled', 'error');
          if (item) {
            btn.textContent = item.text;
            btn.classList.add(hasError ? 'error' : 'filled');
          } else {
            btn.textContent = '';
            btn.classList.add(!hasError && s === activeSlotIndex ? 'active' : 'empty');
          }
        }

        for (var p = 0; p < poolButtons.length; p += 1) {
          var poolBtn = poolButtons[p];
          var isUsed = Boolean(usedPool[p]);
          poolBtn.classList.toggle('used', isUsed);
          poolBtn.disabled = isUsed || verifying;
        }

        if (statusLine) {
          statusLine.hidden = !hasError;
        }
      }

      function assembleCandidateToken() {
        var cursor = 0;
        var rowStrings = challenge.rows.map(function (row) {
          var units = row.prefix.slice();
          for (var c = 0; c < row.fillableCount; c += 1) {
            var slotItem = slots[cursor];
            cursor += 1;
            units.push(slotItem ? slotItem.text : '');
          }
          return units.join(challenge.unitSeparator || '');
        });
        return rowStrings.join(challenge.separator);
      }

      function verifyCandidateToken(candidateToken) {
        if (!candidateToken || verifying) return;
        verifying = true;
        render();
        var probeUrl = new URL(window.location.href);
        probeUrl.searchParams.set('token', candidateToken);
        fetch(probeUrl.toString(), {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-Farming-Auth-Probe': '1'
          },
          credentials: 'same-origin'
        }).then(function (response) {
          verifying = false;
          if (response.ok) {
            var targetUrl = new URL(window.location.href);
            targetUrl.searchParams.set('token', candidateToken);
            window.location.replace(targetUrl.toString());
            return;
          }
          hasError = true;
          render();
        }).catch(function () {
          verifying = false;
          hasError = true;
          render();
        });
      }

      function handlePoolSelect(poolIndex) {
        if (verifying) return;
        for (var i = 0; i < slots.length; i += 1) {
          if (slots[i] && slots[i].poolIndex === poolIndex) return;
        }
        if (hasError) {
          hasError = false;
        }
        var targetSlot = (activeSlotIndex >= 0 && activeSlotIndex < slots.length && !slots[activeSlotIndex])
          ? activeSlotIndex
          : findFirstEmptySlot();
        if (targetSlot < 0) return;
        slots[targetSlot] = {
          poolIndex: poolIndex,
          text: challenge.pool[poolIndex]
        };
        activeSlotIndex = findFirstEmptySlot();
        render();
        if (findFirstEmptySlot() === -1) {
          verifyCandidateToken(assembleCandidateToken());
        }
      }

      function handleSlotClick(slotIndex) {
        if (verifying) return;
        if (slots[slotIndex]) {
          slots[slotIndex] = null;
          hasError = false;
          activeSlotIndex = slotIndex;
          render();
          return;
        }
        activeSlotIndex = slotIndex;
        render();
      }

      function handleBackspace() {
        if (verifying) return;
        hasError = false;
        for (var i = slots.length - 1; i >= 0; i -= 1) {
          if (slots[i]) {
            slots[i] = null;
            activeSlotIndex = i;
            render();
            return;
          }
        }
      }

      function handleClear() {
        if (verifying) return;
        hasError = false;
        for (var i = 0; i < slots.length; i += 1) {
          slots[i] = null;
        }
        activeSlotIndex = 0;
        render();
      }

      poolButtons.forEach(function (btn, index) {
        btn.addEventListener('click', function () {
          handlePoolSelect(index);
        });
      });

      slotButtons.forEach(function (btn, index) {
        btn.addEventListener('click', function () {
          handleSlotClick(index);
        });
      });

      if (btnBackspace) btnBackspace.addEventListener('click', handleBackspace);
      if (btnClear) btnClear.addEventListener('click', handleClear);

      window.addEventListener('keydown', function (event) {
        if (event.key === 'Backspace' || event.key === 'Delete') {
          event.preventDefault();
          handleBackspace();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          handleClear();
        }
      });

      window.addEventListener('paste', function (event) {
        var raw = event.clipboardData ? event.clipboardData.getData('text') : '';
        var trimmed = String(raw || '').trim();
        if (!trimmed) return;
        event.preventDefault();
        try {
          if (/^https?:\\/\\//i.test(trimmed)) {
            var parsed = new URL(trimmed);
            var urlToken = parsed.searchParams.get('token');
            if (urlToken) trimmed = urlToken.trim();
          }
        } catch (_err) {}
        verifyCandidateToken(trimmed);
      });

      render();
    })();
  </script>
</body>
</html>`;
}

class TokenAuth {
  appearanceSource: unknown | (() => unknown);
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
  tokenEnv: NodeJS.ProcessEnv;
  tokenLocale: unknown;
  tokenTimeZone: string | undefined;

  constructor(options: TokenAuthOptions = {}) {
    const authEnv = options.env || process.env;
    this.appearanceSource = options.appearance;
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
    this.tokenEnv = authEnv;
    this.tokenLocale = options.tokenLocale;
    this.tokenTimeZone = options.timeZone;

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
      const status = fs.fstatSync(descriptor);
      this.securedTokenFileIdentity = regularTokenFileIdentity(this.tokenFile, status);
    } catch (error) {
      const code = fsErrorCode(error);
      if (code === 'ELOOP') throw tokenFileNotRegularError(this.tokenFile, 'a symbolic link');
      if (code === 'EEXIST') {
        throw new Error(
          `Session token file ${this.tokenFile} appeared while Farming was starting. `
          + 'Verify that no other process claims this Config, then start Farming again.',
          { cause: error },
        );
      }
      if (code === 'ENOENT' && this.securedTokenFileIdentity) {
        throw new Error(
          `Session token file ${this.tokenFile} disappeared while Farming was starting; start Farming again`,
          { cause: error },
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

  persistRotatedToken(nextToken: string): void {
    if (!this.tokenFile || !this.securedTokenFileIdentity) {
      throw new Error('Session token file is unavailable; restart Farming before rotating the token');
    }

    const expectedIdentity = this.securedTokenFileIdentity;
    const expectedUid = currentEffectiveUid();
    const temporaryTokenFile = `${this.tokenFile}.rotate-${process.pid}-${crypto.randomBytes(9).toString('hex')}`;
    let descriptor = -1;
    let temporaryIdentity: TokenFileIdentity | null = null;
    try {
      const current = openExistingTokenFile(this.tokenFile);
      if (
        !current
        || current.identity.dev !== expectedIdentity.dev
        || current.identity.ino !== expectedIdentity.ino
        || expectedUid >= 0 && current.uid !== expectedUid
      ) {
        if (current) fs.closeSync(current.descriptor);
        throw new Error(
          `Session token file ${this.tokenFile} changed identity before rotation; restart Farming`,
        );
      }
      fs.closeSync(current.descriptor);

      descriptor = fs.openSync(
        temporaryTokenFile,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowOpenFlag(),
        0o600,
      );
      const buffer = Buffer.from(nextToken, 'utf8');
      let written = 0;
      while (written < buffer.length) {
        written += fs.writeSync(descriptor, buffer, written, buffer.length - written, written);
      }
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      const temporaryStatus = fs.fstatSync(descriptor);
      temporaryIdentity = regularTokenFileIdentity(temporaryTokenFile, temporaryStatus);
      if (expectedUid >= 0 && temporaryStatus.uid !== expectedUid) {
        throw tokenFileOwnershipError(temporaryTokenFile, temporaryStatus.uid, expectedUid);
      }
      fs.closeSync(descriptor);
      descriptor = -1;

      // Re-check immediately before the atomic replacement. A path swap must
      // fail closed instead of allowing a rotation to overwrite unknown state.
      const visible = openExistingTokenFile(this.tokenFile);
      if (
        !visible
        || visible.identity.dev !== expectedIdentity.dev
        || visible.identity.ino !== expectedIdentity.ino
        || expectedUid >= 0 && visible.uid !== expectedUid
      ) {
        if (visible) fs.closeSync(visible.descriptor);
        throw new Error(
          `Session token file ${this.tokenFile} changed identity during rotation; restart Farming`,
        );
      }
      fs.closeSync(visible.descriptor);

      fs.renameSync(temporaryTokenFile, this.tokenFile);
      this.securedTokenFileIdentity = temporaryIdentity;
    } catch (error) {
      if (descriptor >= 0) {
        fs.closeSync(descriptor);
        descriptor = -1;
      }
      try {
        fs.unlinkSync(temporaryTokenFile);
      } catch (cleanupError) {
        if (fsErrorCode(cleanupError) !== 'ENOENT') {
          throw new AggregateError(
            [error, cleanupError],
            `Token rotation failed and Farming could not remove ${temporaryTokenFile}`,
            { cause: cleanupError },
          );
        }
      }
      throw error;
    } finally {
      if (descriptor >= 0) fs.closeSync(descriptor);
    }
  }

  rotateToken(): string {
    if (this.disabled) {
      const error = new Error('Token rotation requires token authentication') as Error & { status?: number };
      error.status = 409;
      throw error;
    }
    if (this.tokenInfo?.style === 'configured') {
      const error = new Error('A token configured with FARMING_TOKEN cannot be rotated from the share panel') as Error & { status?: number };
      error.status = 409;
      throw error;
    }

    let nextInfo = createPoeticToken({
      locale: this.tokenLocale,
      env: this.tokenEnv,
      timeZone: this.tokenTimeZone,
    });
    while (nextInfo.token === this.token) {
      nextInfo = createPoeticToken({
        locale: this.tokenLocale,
        env: this.tokenEnv,
        timeZone: this.tokenTimeZone,
      });
    }
    this.persistRotatedToken(nextInfo.token);
    this.token = nextInfo.token;
    this.tokenInfo = nextInfo;
    return this.token;
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

  resolveAppearance(): AuthGateAppearance {
    try {
      const value = typeof this.appearanceSource === 'function'
        ? (this.appearanceSource as () => unknown)()
        : this.appearanceSource;
      return normalizeAuthGateAppearance(value);
    } catch {
      return 'system';
    }
  }

  isHtmlNavigationRequest(req: AuthRequest, url: URL): boolean {
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) return false;
    const probeHeader = req.headers['x-farming-auth-probe'];
    if (String(Array.isArray(probeHeader) ? probeHeader[0] : (probeHeader || '')).trim() === '1') {
      return false;
    }
    const acceptHeader = Array.isArray(req.headers.accept)
      ? req.headers.accept.join(',')
      : String(req.headers.accept || '');
    if (!/\btext\/html\b/i.test(acceptHeader)) return false;

    const pathname = url.pathname || '/';
    const apiPrefix = this.basePath ? `${this.basePath}/api` : '/api';
    if (
      pathname === '/api'
      || pathname.startsWith('/api/')
      || pathname === apiPrefix
      || pathname.startsWith(`${apiPrefix}/`)
    ) {
      return false;
    }

    const ext = path.extname(pathname).toLowerCase();
    if (ext && ext !== '.html' && ext !== '.htm') {
      return false;
    }
    return true;
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
      const probeHeader = req.headers['x-farming-auth-probe'];
      const isAuthProbe = String(Array.isArray(probeHeader) ? probeHeader[0] : (probeHeader || '')).trim() === '1';
      if (isAuthProbe && ['GET', 'HEAD'].includes(method)) {
        const probeAccessMode = this.accessForToken(token);
        if (token && probeAccessMode !== 'none') {
          this.setAccessCookie(res, token);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(401, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'Token required. Use the URL printed in terminal.' }));
        return;
      }

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

      if (this.isHtmlNavigationRequest(req, url)) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const html = renderAuthGateHtml({
          appearance: this.resolveAppearance(),
          basePath: this.basePath,
          challenge: createPoeticTokenChallenge(this.token),
          nonce,
        });
        res.writeHead(401, {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': [
            "default-src 'self'",
            "connect-src 'self'",
            "img-src 'self' data:",
            `style-src 'self' 'nonce-${nonce}'`,
            `script-src 'self' 'nonce-${nonce}'`,
            "base-uri 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
          ].join('; '),
          'Content-Type': 'text/html; charset=utf-8',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        });
        if (method === 'HEAD') {
          res.end();
        } else {
          res.end(html);
        }
        return;
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
  createPoeticTokenChallenge,
  decodeCookieToken,
  encodeCookieToken,
  farmingAuthCookieName,
  generatePoeticToken,
  getPoeticTokenEntropyBits,
};
