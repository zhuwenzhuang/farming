const childProcess = require('child_process') as typeof import('child_process');
const crypto = require('crypto') as typeof import('crypto');
const fs = require('fs') as typeof import('fs');
const http = require('http') as typeof import('http');
const https = require('https') as typeof import('https');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const { readServerProcessIdentity } = require('./server-process-identity.cjs') as Pick<
  typeof import('./server-process-identity.cjs'),
  'readServerProcessIdentity'
>;
import * as storageLayout from './storage-layout.cjs';
import {
  ensurePackageInstallationDirectories,
  readCurrentPackagePointer,
  readPackageImageRef,
  resolvePackageInstallationContext,
} from './package-installation.cjs';
import type { PackageInstallationContext } from './package-installation.cjs';
import {
  commitUpdateOperationState,
  removeUpdateOperationState,
  UPDATE_STATE_LOCK_ERROR_CODE,
} from './update-operation-state.cjs';

interface ServerProcessIdentity {
  pid: number;
  processGroupId: number;
  startedAt: string;
  format: string;
}

interface StorageLayout {
  updateStateFile(configDir: string): string;
  updateLogFile(configDir: string): string;
  updateStagingDir(configDir: string): string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface DetectInstallMethodOptions {
  packagedRuntime?: boolean;
}

interface RequestOptions {
  accept?: string;
  headers?: Record<string, string>;
  authToken?: string;
  timeoutMs?: number;
}

interface NodeScriptInvocation {
  command: string;
  args: string[];
}

interface NpmVersionMetadata {
  dist?: {
    integrity?: unknown;
    unpackedSize?: unknown;
  };
}

interface NpmMetadata {
  'dist-tags'?: {
    latest?: unknown;
  };
  versions?: Record<string, NpmVersionMetadata | undefined>;
}

interface NpmVersion {
  version: string;
  assetName: string;
  assetSize: number;
  blockedReason: string;
  installable: true;
  available: boolean;
  integrity: string;
}

interface CheckOptions {
  force?: boolean;
  assetName?: unknown;
  observeOnly?: boolean;
}

interface RuntimeTarget {
  platform: string;
  arch: string;
}

interface CurrentVersion {
  releaseVersion: string;
  packageVersion: string;
  gitSha: unknown;
  compatibilityProfile: string;
  bundledGlibcRuntime: boolean;
  type: string;
  installDir: string;
}

interface UpdateInstallState extends JsonObject {
  format?: string;
  operationId?: string;
  phase: string;
  method?: string;
  version?: string;
  previousVersion?: string;
  packageName?: string;
  stagingPrefix?: string;
  stagingPackageRoot?: string;
  startedAt?: string;
  preparedAt?: string;
  restartingAt?: string;
  logPath?: string;
  error?: string;
  completedAt?: string;
  installationId?: string;
  installationRoot?: string;
  bootstrapPackageRoot?: string;
  runningImageId?: string;
  runningPackageRoot?: string;
  targetImageId?: string;
  targetPackageRoot?: string;
  targetIntegrity?: string;
  expectedCurrentImageId?: string;
}

interface NpmCache {
  checkedAt: number;
  source: string;
  metadata: NpmMetadata;
}

interface ProvenNpmUpdateTarget {
  proven: true;
  installationId: string;
  installationRoot: string;
  bootstrapPackageRoot: string;
  activePackageRoot: string;
}

interface UnprovenNpmUpdateTarget {
  proven: false;
  error: string;
}

type NpmUpdateTarget = ProvenNpmUpdateTarget | UnprovenNpmUpdateTarget;

type FetchJson = (url: string, options?: RequestOptions) => Promise<NpmMetadata>;

interface FarmingUpdateServiceOptions {
  rootDir?: string;
  installMethod?: string;
  packagedRuntime?: boolean;
  npmPackageName?: string;
  npmRegistryUrl?: string;
  npmPackageRoot?: string;
  packageInstallationsDir?: string;
  packageInstallationContext?: PackageInstallationContext;
  platform?: string;
  arch?: string;
  configDir?: string;
  now?: () => number;
  fetchJson?: FetchJson;
  execFile?: typeof childProcess.execFile;
  spawn?: SpawnProcess;
  updateStateFile?: string;
  updateLogFile?: string;
  updateStagingDir?: string;
}

interface SpawnedProcess {
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: import('child_process').SpawnOptions,
) => SpawnedProcess;

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (message) return String(message);
  }
  return String(error);
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const RESTART_RECOVERY_TIMEOUT_MS = 2 * 60 * 1000;
const ACTIVE_UPDATE_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINAL_UPDATE_RETENTION_MS = 24 * 60 * 60 * 1000;
const UPDATE_OPERATION_FORMAT = 'farming-update-operation-v1';
const NPM_PACKAGE_NAME = 'farming-code';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

function readJsonFile(filePath: string): JsonObject | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as JsonObject;
  } catch {
    return null;
  }
}

function normalizeVersion(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withoutPrefix = raw
    .replace(/^refs\/tags\//i, '')
    .replace(/^farming[-_]/i, '')
    .replace(/^v/i, '');
  const match = withoutPrefix.match(/\d+(?:\.\d+)*/);
  return match ? match[0] : withoutPrefix;
}

function versionParts(value: unknown): number[] {
  const normalized = normalizeVersion(value);
  if (!normalized) return [];
  return normalized.split('.').map(part => Number(part)).filter(part => Number.isFinite(part));
}

function compareVersions(left: unknown, right: unknown): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function detectInstallMethod(rootDir: string, options: DetectInstallMethodOptions = {}): string {
  if (options.packagedRuntime) return 'standalone-cli';
  const release = readJsonFile(path.join(rootDir, 'RELEASE.json')) || {};
  if (release.updateMethod === 'npm') return 'npm';
  if (release.type) return String(release.type);
  if (fs.existsSync(path.join(rootDir, '.farming.pid')) || fs.existsSync(path.join(rootDir, '.farming-launcher.sh'))) {
    return 'app-bundle';
  }
  const pkg = readJsonFile(path.join(rootDir, 'package.json')) || {};
  if (pkg.name === NPM_PACKAGE_NAME && !fs.existsSync(path.join(rootDir, '.git'))) return 'npm';
  return 'source';
}

function installMethodBlockedReason(method: string): string {
  if (method === 'source') return 'Source checkouts update through Git, not the in-app updater';
  if (method === 'source-deploy') return 'Source deployments update through their deployment workflow, not the in-app updater';
  if (method === 'app-bundle') return 'App bundles update by reinstalling a release package or switching to npm';
  if (method === 'standalone-cli') return 'Standalone CLI updates must reinstall the matching release asset';
  return `In-app updates require an npm installation; reinstall ${method || 'this installation'} through npm`;
}

function hasComparableVersion(value: unknown): boolean {
  return versionParts(value).length > 0;
}

function normalizePlatform(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'darwin' || raw === 'macos' || raw === 'macosx' || raw === 'osx') return 'darwin';
  if (raw === 'linux') return 'linux';
  return raw;
}

function normalizeArch(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'x64' || raw === 'amd64' || raw === 'x86_64') return 'x64';
  if (raw === 'arm64' || raw === 'aarch64') return 'arm64';
  return raw;
}

function requestWithRedirects(
  url: string,
  options: RequestOptions = {},
  redirectCount = 0,
  authOrigin: string | false | null = null,
): Promise<import('http').IncomingMessage> {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`too many redirects for ${url}`));
  }

  return new Promise<import('http').IncomingMessage>((resolve, reject) => {
    const parsed = new URL(url);
    const allowedAuthOrigin = authOrigin === false ? '' : (authOrigin || parsed.origin);
    const sameAuthOrigin = Boolean(allowedAuthOrigin) && parsed.origin === allowedAuthOrigin;
    const client = parsed.protocol === 'http:' ? http : https;
    const headers: Record<string, string> = {
      'User-Agent': 'Farming-Update-Check',
      Accept: options.accept || 'application/json',
      ...(options.headers || {}),
    };
    if (!sameAuthOrigin) {
      delete headers.Authorization;
      delete headers.authorization;
    } else if (options.authToken) {
      headers.Authorization = `Bearer ${options.authToken}`;
    }

    const request = client.get(parsed, { headers }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const nextUrl = new URL(location, parsed).toString();
        const nextParsed = new URL(nextUrl);
        const nextOptions = { ...options };
        if (nextParsed.origin !== allowedAuthOrigin) {
          // Update-source tokens are scoped to the configured origin. Never
          // forward them to a redirect target on another origin.
          delete nextOptions.authToken;
          if (nextOptions.headers) {
            nextOptions.headers = { ...nextOptions.headers };
            delete nextOptions.headers.Authorization;
            delete nextOptions.headers.authorization;
          }
        }
        requestWithRedirects(
          nextUrl,
          nextOptions,
          redirectCount + 1,
          nextParsed.origin === allowedAuthOrigin ? allowedAuthOrigin : false,
        ).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`request failed with HTTP ${status}`));
        return;
      }
      resolve(response);
    });
    request.on('error', reject);
    request.setTimeout(options.timeoutMs || 30_000, () => {
      request.destroy(new Error(`request timed out for ${url}`));
    });
  });
}

async function requestJson(url: string, options: RequestOptions = {}): Promise<NpmMetadata> {
  const response = await requestWithRedirects(url, options);
  const chunks = [];
  for await (const chunk of response) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as NpmMetadata;
}

function nodeScriptInvocation(
  nodePath: string,
  scriptPath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeScriptInvocation {
  if (env.FARMING_NODE_LD && env.FARMING_NODE_LIBRARY_PATH) {
    return {
      command: env.FARMING_NODE_LD,
      args: ['--library-path', env.FARMING_NODE_LIBRARY_PATH, nodePath, scriptPath],
    };
  }
  return { command: nodePath, args: [scriptPath] };
}

function npmPackageMetadataUrl(registryUrl: unknown, packageName: unknown): string {
  const registry = String(registryUrl || DEFAULT_NPM_REGISTRY).replace(/\/+$/, '');
  return `${registry}/${encodeURIComponent(String(packageName)).replace(/^%40/, '@')}`;
}

function normalizePathForCompare(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function npmPackageRoot(npmRoot: string, packageName: unknown): string {
  return path.join(npmRoot, ...String(packageName || '').split('/').filter(Boolean));
}

function npmPrefixForPackageRoot(packageRoot: string, packageName: unknown): string {
  const segments = String(packageName || '').split('/').filter(Boolean);
  if (!path.isAbsolute(packageRoot) || segments.length === 0) return '';
  let npmRoot = packageRoot;
  for (let index = 0; index < segments.length; index += 1) npmRoot = path.dirname(npmRoot);
  return path.dirname(path.dirname(npmRoot));
}

function readNpmGlobalRoot(
  npmCommand: string,
  npmPrefix: string,
  execFile: typeof childProcess.execFile = childProcess.execFile,
): Promise<string> {
  const args = ['root', '--global'];
  if (npmPrefix) args.push('--prefix', npmPrefix);
  return new Promise<string>((resolve, reject) => {
    execFile(npmCommand, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const root = String(stdout || '').split(/\r?\n/).map(value => value.trim()).find(Boolean);
      if (!root) {
        reject(new Error('npm root --global returned no path'));
        return;
      }
      resolve(root);
    });
  });
}

function npmVersionsFromMetadata(metadata: NpmMetadata | null | undefined, currentVersion: unknown): NpmVersion[] {
  const versionMetadata = metadata?.versions;
  const versions = versionMetadata && typeof versionMetadata === 'object'
    ? Object.keys(versionMetadata)
    : [];
  return versions
    .filter(version => hasComparableVersion(version) && !version.includes('-'))
    .filter(version => !hasComparableVersion(currentVersion) || compareVersions(version, currentVersion) >= 0)
    .sort((left, right) => compareVersions(right, left))
    .map(version => ({
      version,
      assetName: version,
      assetSize: Number(versionMetadata?.[version]?.dist?.unpackedSize as string | number | undefined || 0),
      blockedReason: '',
      installable: true,
      available: compareVersions(version, currentVersion) > 0,
      integrity: String(versionMetadata?.[version]?.dist?.integrity || '').trim(),
    }));
}

class FarmingUpdateService {
  rootDir: string;
  installMethod: string;
  npmPackageName: string;
  npmRegistryUrl: string;
  npmPackageRoot: string;
  packageInstallation: PackageInstallationContext | null;
  runtime: RuntimeTarget | null;
  configDir: string;
  now: () => number;
  fetchJson: FetchJson;
  spawn: SpawnProcess;
  npmCache: NpmCache | null;
  installState: UpdateInstallState;
  installStartPromise: Promise<UpdateInstallState> | null;
  updateStateFile: string;
  updateLogFile: string;
  updateStagingDir: string;

  constructor(options: FarmingUpdateServiceOptions = {}) {
    this.rootDir = options.rootDir || path.join(__dirname, '..');
    this.installMethod = options.installMethod || detectInstallMethod(this.rootDir, {
      packagedRuntime: options.packagedRuntime === true,
    });
    this.npmPackageName = options.npmPackageName || NPM_PACKAGE_NAME;
    this.npmRegistryUrl = options.npmRegistryUrl || process.env.FARMING_NPM_REGISTRY || DEFAULT_NPM_REGISTRY;
    this.npmPackageRoot = options.npmPackageRoot || process.env.FARMING_ACTIVE_PACKAGE_ROOT
      || process.env.FARMING_MANAGED_PACKAGE_ROOT || this.rootDir;
    this.packageInstallation = options.packageInstallationContext || resolvePackageInstallationContext(
      this.npmPackageRoot,
      {
        ...process.env,
        ...(options.packageInstallationsDir
          ? { FARMING_PACKAGE_INSTALLATIONS_DIR: options.packageInstallationsDir }
          : {}),
      },
    );
    this.runtime = options.platform || options.arch
      ? {
        platform: normalizePlatform(options.platform || process.platform),
        arch: normalizeArch(options.arch || process.arch),
      }
      : null;
    this.configDir = options.configDir || path.join(os.homedir(), '.farming');
    this.now = options.now || (() => Date.now());
    this.fetchJson = options.fetchJson || requestJson;
    this.spawn = options.spawn || childProcess.spawn;
    this.npmCache = null;
    this.installState = { phase: 'idle' };
    this.installStartPromise = null;
    this.updateStateFile = options.updateStateFile || storageLayout.updateStateFile(this.configDir);
    this.updateLogFile = options.updateLogFile || storageLayout.updateLogFile(this.configDir);
    this.updateStagingDir = options.updateStagingDir
      || this.packageInstallation?.stagingDir
      || storageLayout.updateStagingDir(this.configDir);
  }

  currentVersion(): CurrentVersion {
    const release = readJsonFile(path.join(this.rootDir, 'RELEASE.json')) || {};
    const pkg = readJsonFile(path.join(this.rootDir, 'package.json')) || {};
    const packageVersion = String(release.packageVersion || pkg.version || '');
    const releaseVersion = String(release.releaseVersion || normalizeVersion(packageVersion) || '');
    return {
      releaseVersion,
      packageVersion,
      gitSha: release.gitSha || '',
      compatibilityProfile: String(release.compatibilityProfile || ''),
      bundledGlibcRuntime: release.bundledGlibcRuntime === true,
      type: this.installMethod,
      installDir: this.rootDir,
    };
  }

  currentInstallState(options: { commit?: boolean } = {}): UpdateInstallState {
    const commit = options.commit !== false;
    const clear = () => commit ? this.clearInstallState() : { phase: 'idle' };
    const persist = <T extends UpdateInstallState>(state: T): T => (
      commit ? this.persistInstallState(state) : state
    );
    const persisted = readJsonFile(this.updateStateFile);
    const current = this.currentVersion();
    const currentVersion = normalizeVersion(current.releaseVersion || current.packageVersion);
    if (!persisted) return clear();
    const state = persisted as UpdateInstallState;
    if (state.method !== this.installMethod) return clear();

    const isCurrentFormat = state.format === UPDATE_OPERATION_FORMAT
      && typeof state.operationId === 'string'
      && state.operationId.length > 0;
    if (!isCurrentFormat && state.phase !== 'restarting') return clear();

    const normalized = isCurrentFormat ? state : {
      ...state,
      format: UPDATE_OPERATION_FORMAT,
      operationId: crypto.randomUUID(),
    };
    if (
      normalized.installationId
      && (!this.packageInstallation || normalized.installationId !== this.packageInstallation.installationId)
    ) return clear();

    const targetVersion = normalizeVersion(normalized.version);
    const previousVersion = normalizeVersion(normalized.previousVersion);
    if (normalized.phase === 'restarting') {
      if (
        hasComparableVersion(currentVersion)
        && hasComparableVersion(targetVersion)
        && currentVersion === targetVersion
      ) {
        return persist({
          ...normalized,
          phase: 'succeeded',
          error: '',
          completedAt: new Date(this.now()).toISOString(),
        });
      }
      if (
        currentVersion
        && (
          (previousVersion && currentVersion !== previousVersion)
          || (!previousVersion && hasComparableVersion(targetVersion) && compareVersions(currentVersion, targetVersion) > 0)
        )
      ) return clear();
      const restartingAt = Date.parse(String(
        normalized.restartingAt || normalized.preparedAt || normalized.startedAt || '',
      ));
      if (!Number.isFinite(restartingAt) || this.now() - restartingAt >= RESTART_RECOVERY_TIMEOUT_MS) {
        return persist({
          ...normalized,
          phase: 'failed',
          error: `Farming did not restart into version ${targetVersion || normalized.version || 'unknown'} within 2 minutes; retry the update`,
          completedAt: new Date(this.now()).toISOString(),
        });
      }
      return isCurrentFormat ? normalized : persist(normalized);
    }

    if (normalized.phase === 'rolling-back') {
      if (currentVersion && previousVersion && currentVersion === previousVersion) {
        return persist({
          ...normalized,
          phase: 'rolled-back',
          version: previousVersion,
          completedAt: new Date(this.now()).toISOString(),
        });
      }
      if (currentVersion && targetVersion && currentVersion !== targetVersion) return clear();
      const startedAt = Date.parse(String(normalized.restartingAt || normalized.startedAt || ''));
      if (!Number.isFinite(startedAt) || this.now() - startedAt >= RESTART_RECOVERY_TIMEOUT_MS) {
        return persist({
          ...normalized,
          phase: 'failed',
          error: normalized.error || 'Farming rollback did not complete within 2 minutes; restart Farming manually',
          completedAt: new Date(this.now()).toISOString(),
        });
      }
      return normalized;
    }

    if (['installing', 'preparing-runtimes'].includes(normalized.phase)) {
      if (previousVersion && currentVersion && previousVersion !== currentVersion) return clear();
      const startedAt = Date.parse(String(normalized.startedAt || ''));
      if (!Number.isFinite(startedAt)) return clear();
      if (this.now() - startedAt >= ACTIVE_UPDATE_TIMEOUT_MS) {
        return persist({
          ...normalized,
          phase: 'failed',
          error: 'Farming update preparation did not complete within 30 minutes; retry the update',
          completedAt: new Date(this.now()).toISOString(),
        });
      }
      return normalized;
    }

    if (normalized.phase === 'ready-to-restart') {
      if (!previousVersion || !currentVersion || previousVersion !== currentVersion) return clear();
      const expectedCurrentImageId = String(normalized.expectedCurrentImageId || '').trim();
      if (expectedCurrentImageId && this.packageInstallation) {
        const selectedPointer = readCurrentPackagePointer(this.packageInstallation);
        if (!selectedPointer || selectedPointer.imageId !== expectedCurrentImageId) return clear();
      }
      return normalized;
    }

    if (['succeeded', 'failed', 'rolled-back'].includes(normalized.phase)) {
      const completedAt = Date.parse(String(normalized.completedAt || ''));
      const resultVersion = normalizeVersion(normalized.version);
      const versionStillRelevant = normalized.phase === 'failed'
        ? Boolean(currentVersion && (currentVersion === previousVersion || currentVersion === resultVersion))
        : Boolean(currentVersion && currentVersion === resultVersion);
      if (
        !versionStillRelevant
        || !Number.isFinite(completedAt)
        || this.now() - completedAt >= TERMINAL_UPDATE_RETENTION_MS
      ) return clear();
      return normalized;
    }

    return clear();
  }

  clearInstallState(): UpdateInstallState {
    try {
      // Removal shares the update-state claim with conditional helper commits
      // and authoritative persists, so a clear cannot race a concurrent write.
      // Zero timeout: the Server makes a single non-waiting claim attempt and
      // performs no lock-contention polling or sleep; the attempt count is
      // explicitly bounded (brief synchronous filesystem/inspection work
      // remains).
      removeUpdateOperationState(this.updateStateFile, { lockTimeoutMs: 0 });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === UPDATE_STATE_LOCK_ERROR_CODE) {
        // Lock contention or timeout is not a read-only Config. Reporting
        // idle while the disk state is still owned would lie about the
        // update, so surface the bounded failure instead.
        throw error;
      }
      if (!['EROFS', 'EACCES', 'EPERM', 'ENOENT'].includes(code)) throw error;
      // A read-only Config still presents authoritative runtime/package state.
    }
    this.installState = { phase: 'idle' };
    return this.installState;
  }

  persistInstallState<T extends UpdateInstallState>(state: T): T {
    const persisted = state.phase === 'idle' ? state : {
      ...state,
      format: UPDATE_OPERATION_FORMAT,
      operationId: state.operationId || crypto.randomUUID(),
    };
    fs.mkdirSync(this.configDir, { recursive: true });
    // The Server is the authoritative writer: it persists without an
    // ownership condition, but under the same exclusive claim the helpers
    // use, so a detached helper can never publish between the Server's
    // ownership decision and this publication. Zero timeout: a single
    // non-waiting claim attempt; contention fails visibly. The precise
    // property is no lock-contention polling or sleep with a bounded attempt
    // count; the attempt still performs a few synchronous filesystem and
    // process-inspection steps, so it blocks briefly but boundedly.
    commitUpdateOperationState(this.updateStateFile, null, persisted as Record<string, unknown>, { lockTimeoutMs: 0 });
    // In-memory state follows the disk only after the committed write, so a
    // lock failure never desynchronizes the Server from persisted state.
    this.installState = persisted;
    return persisted as T;
  }

  async npmMetadata(options: CheckOptions = {}): Promise<NpmMetadata> {
    const source = npmPackageMetadataUrl(this.npmRegistryUrl, this.npmPackageName);
    if (!options.force && this.npmCache && this.npmCache.source === source && this.now() - this.npmCache.checkedAt < CACHE_TTL_MS) {
      return this.npmCache.metadata;
    }
    const metadata = await this.fetchJson(source, { accept: 'application/json' });
    this.npmCache = { checkedAt: this.now(), source, metadata };
    return metadata;
  }

  async npmStatus(options: CheckOptions = {}) {
    const observeOnly = options.observeOnly === true;
    const current = this.currentVersion();
    const currentVersion = normalizeVersion(current.releaseVersion || current.packageVersion);
    const metadata = await this.npmMetadata({
      ...options,
      force: observeOnly ? false : options.force,
    });
    const target = await this.npmUpdateTarget({ ensureDirectories: !observeOnly });
    const versions = npmVersionsFromMetadata(metadata, currentVersion);
    const registryLatestVersion = normalizeVersion(metadata && metadata['dist-tags'] && metadata['dist-tags'].latest);
    const latestVersion = [currentVersion, registryLatestVersion, versions[0]?.version || '']
      .filter(hasComparableVersion)
      .sort((left, right) => compareVersions(right, left))[0] || '';
    const requestedVersion = normalizeVersion(options.assetName);
    const selected = versions.find(version => version.version === requestedVersion)
      || versions.find(version => version.available)
      || versions.find(version => version.version === currentVersion)
      || versions[0]
      || null;
    const blockedReason = target.proven ? '' : target.error;
    const available = Boolean(selected && selected.available && target.proven);
    return {
      method: 'npm',
      current,
      latest: {
        version: latestVersion,
        tag: latestVersion ? `v${latestVersion}` : '',
        name: latestVersion ? `${this.npmPackageName}@${latestVersion}` : '',
        publishedAt: '',
        assetName: latestVersion,
        assetSize: 0,
        blockedReason,
        source: npmPackageMetadataUrl(this.npmRegistryUrl, this.npmPackageName),
      },
      selected: {
        version: selected?.version || '',
        assetName: selected?.assetName || '',
        assetSize: selected?.assetSize || 0,
        blockedReason: selected?.blockedReason || blockedReason,
        integrity: selected?.integrity || '',
      },
      versions,
      runtime: this.runtime,
      target,
      available,
      installable: Boolean(selected && target.proven),
      checkedAt: new Date(this.now()).toISOString(),
      state: this.currentInstallState({ commit: !observeOnly }),
    };
  }

  async npmUpdateTarget(options: { ensureDirectories?: boolean } = {}): Promise<NpmUpdateTarget> {
    const runningPackageRoot = String(this.npmPackageRoot || '').trim();
    const installation = this.packageInstallation;
    if (!path.isAbsolute(runningPackageRoot) || !installation) {
      return {
        proven: false,
        error: 'npm update target could not be proven: the running package has no managed installation identity',
      };
    }
    if (normalizePathForCompare(runningPackageRoot) !== normalizePathForCompare(installation.activePackageRoot)) {
      return {
        proven: false,
        error: 'npm update target does not match the active immutable package identity',
      };
    }
    if (options.ensureDirectories !== false) ensurePackageInstallationDirectories(installation);
    return {
      proven: true,
      installationId: installation.installationId,
      installationRoot: installation.installationRoot,
      bootstrapPackageRoot: installation.bootstrapPackageRoot,
      activePackageRoot: installation.activePackageRoot,
    };
  }

  unsupportedStatus(options: CheckOptions = {}) {
    const current = this.currentVersion();
    const reason = installMethodBlockedReason(this.installMethod);
    return {
      method: this.installMethod,
      current,
      latest: {
        version: '',
        tag: '',
        name: '',
        publishedAt: '',
        assetName: '',
        assetSize: 0,
        blockedReason: reason,
        source: '',
      },
      selected: { version: '', assetName: '', assetSize: 0, blockedReason: reason },
      versions: [],
      runtime: this.runtime,
      available: false,
      installable: false,
      checkedAt: new Date(this.now()).toISOString(),
      state: this.currentInstallState({ commit: options.observeOnly !== true }),
    };
  }

  async check(options: CheckOptions = {}) {
    if (this.installMethod === 'npm') return this.npmStatus(options);
    return this.unsupportedStatus(options);
  }

  async startInstall(options: CheckOptions = {}): Promise<UpdateInstallState> {
    if (this.installStartPromise) return this.installStartPromise;
    const startPromise = this.startInstallUnreserved(options);
    this.installStartPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.installStartPromise === startPromise) this.installStartPromise = null;
    }
  }

  async startInstallUnreserved(options: CheckOptions = {}): Promise<UpdateInstallState> {
    const currentState = this.currentInstallState();
    if (['downloading', 'extracting', 'installing', 'restarting', 'rolling-back'].includes(currentState.phase)) {
      return currentState;
    }
    if (currentState.phase === 'ready-to-restart') return currentState;

    if (this.installMethod === 'npm') return this.startNpmInstall(options);
    throw new Error(installMethodBlockedReason(this.installMethod));
  }

  async startNpmInstall(options: CheckOptions = {}): Promise<UpdateInstallState> {
    const status = await this.npmStatus({ force: true, assetName: options.assetName });
    if (!status.available) {
      if (status.installable) return this.clearInstallState();
      return this.persistInstallState({
        method: 'npm',
        phase: 'failed',
        version: status.selected.version,
        previousVersion: status.current.releaseVersion || status.current.packageVersion,
        error: status.selected.blockedReason || 'No installable npm update is available',
        completedAt: new Date(this.now()).toISOString(),
      });
    }
    const target = status.target as ProvenNpmUpdateTarget;
    const targetIntegrity = String(status.selected.integrity || '').trim();
    if (!targetIntegrity) {
      return this.persistInstallState({
        method: 'npm',
        phase: 'failed',
        version: status.selected.version,
        previousVersion: status.current.releaseVersion || status.current.packageVersion,
        error: 'npm update metadata did not provide package integrity',
        completedAt: new Date(this.now()).toISOString(),
      });
    }

    const startedAt = new Date(this.now()).toISOString();
    const operationId = crypto.randomUUID();
    fs.mkdirSync(this.updateStagingDir, { recursive: true });
    const stagingPrefix = fs.mkdtempSync(path.join(this.updateStagingDir, `npm-${status.selected.version}.`));
    const stagingPackageRoot = npmPackageRoot(
      path.join(stagingPrefix, 'lib', 'node_modules'),
      this.npmPackageName,
    );
    const state = this.persistInstallState({
      method: 'npm',
      operationId,
      phase: 'installing',
      version: status.selected.version,
      previousVersion: status.current.releaseVersion || status.current.packageVersion,
      packageName: this.npmPackageName,
      stagingPrefix,
      stagingPackageRoot,
      startedAt,
      logPath: this.updateLogFile,
      targetIntegrity,
      installationId: target.installationId,
      installationRoot: target.installationRoot,
      bootstrapPackageRoot: target.bootstrapPackageRoot,
      runningPackageRoot: target.activePackageRoot,
    });
    const helperPath = path.join(__dirname, 'npm-update-helper.cjs');
    const nodePath = process.env.FARMING_NODE_BIN || process.execPath;
    const payload = {
      action: 'prepare',
      operationId,
      packageName: this.npmPackageName,
      targetVersion: status.selected.version,
      previousVersion: status.current.releaseVersion || status.current.packageVersion,
      targetIntegrity,
      startedAt,
      stateFile: this.updateStateFile,
      logPath: this.updateLogFile,
      activePackageRoot: target.activePackageRoot,
      installationId: target.installationId,
      installationRoot: target.installationRoot,
      bootstrapPackageRoot: target.bootstrapPackageRoot,
      nodePath,
      npmCommand: process.env.FARMING_NPM_COMMAND || 'npm',
      stagingPrefix,
      stagingPackageRoot,
      npmFallbackRegistryUrl: this.npmRegistryUrl,
      serverPid: process.pid,
      configDir: this.configDir,
      port: process.env.FARMING_PORT || process.env.PORT || '6694',
      basePath: process.env.FARMING_BASE_PATH || '/farming',
      serverHome: process.env.FARMING_SERVER_HOME || '',
      disableAuth: /^(1|true|yes|on)$/i.test(String(process.env.FARMING_DISABLE_AUTH || '')),
    };
    const helperInvocation = nodeScriptInvocation(nodePath, helperPath);
    const spawnOptions: import('child_process').SpawnOptions = {
      cwd: this.configDir,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        FARMING_NPM_UPDATE_PAYLOAD: JSON.stringify(payload),
      },
    };
    let child;
    try {
      child = this.spawn(helperInvocation.command, helperInvocation.args, spawnOptions);
    } catch (error: unknown) {
      fs.rmSync(stagingPrefix, { recursive: true, force: true });
      this.persistInstallState({
        ...state,
        phase: 'failed',
        error: errorMessage(error),
        completedAt: new Date(this.now()).toISOString(),
      });
      throw error;
    }
    if (child && typeof child.once === 'function') {
      child.once('error', (error: Error) => {
        fs.rmSync(stagingPrefix, { recursive: true, force: true });
        this.persistInstallState({
          ...state,
          phase: 'failed',
          error: errorMessage(error),
          completedAt: new Date(this.now()).toISOString(),
        });
      });
    }
    if (child && typeof child.unref === 'function') child.unref();
    return state;
  }

  async applyPreparedUpdate(): Promise<UpdateInstallState> {
    if (this.installStartPromise) return this.installStartPromise;
    const applyPromise = this.applyPreparedUpdateUnreserved();
    this.installStartPromise = applyPromise;
    try {
      return await applyPromise;
    } finally {
      if (this.installStartPromise === applyPromise) this.installStartPromise = null;
    }
  }

  async applyPreparedUpdateUnreserved(): Promise<UpdateInstallState> {
    if (this.installMethod !== 'npm') {
      throw new Error(installMethodBlockedReason(this.installMethod));
    }
    const prepared = this.currentInstallState();
    if (prepared.phase !== 'ready-to-restart') {
      throw new Error('No prepared Farming update is ready to restart');
    }
    const current = this.currentVersion();
    const currentVersion = normalizeVersion(current.releaseVersion || current.packageVersion);
    if (normalizeVersion(prepared.previousVersion) !== currentVersion) {
      const error = 'Prepared update no longer matches the running Farming version';
      this.persistInstallState({ ...prepared, phase: 'failed', error, completedAt: new Date(this.now()).toISOString() });
      throw new Error(error);
    }

    const nodePath = process.env.FARMING_NODE_BIN || process.execPath;
    const serverProcessIdentity = await readServerProcessIdentity(process.pid);
    if (!serverProcessIdentity) {
      throw new Error('Running Farming server process identity could not be verified');
    }
    const target = await this.npmUpdateTarget();
    if (!target.proven) throw new Error(target.error);
    if (
      prepared.installationId !== target.installationId
      || normalizePathForCompare(String(prepared.installationRoot || '')) !== normalizePathForCompare(target.installationRoot)
      || !path.isAbsolute(String(prepared.targetPackageRoot || ''))
      || !path.isAbsolute(String(prepared.runningPackageRoot || ''))
      || !String(prepared.targetImageId || '').trim()
      || !String(prepared.runningImageId || '').trim()
    ) throw new Error('Prepared npm update is missing its immutable package identity');
    const targetImage = readPackageImageRef(String(prepared.targetPackageRoot));
    const runningImage = readPackageImageRef(String(prepared.runningPackageRoot));
    if (
      !targetImage
      || targetImage.imageId !== prepared.targetImageId
      || normalizeVersion(targetImage.version) !== normalizeVersion(prepared.version)
    ) throw new Error('Prepared npm update image is no longer available; prepare it again');
    if (
      !runningImage
      || runningImage.imageId !== prepared.runningImageId
      || normalizeVersion(runningImage.version) !== currentVersion
    ) throw new Error('Prepared npm rollback image no longer matches the running Farming version');
    const selectedPointer = readCurrentPackagePointer(this.packageInstallation!);
    const expectedCurrentImageId = String(prepared.expectedCurrentImageId || selectedPointer?.imageId || '').trim();
    if (!expectedCurrentImageId) throw new Error('Prepared npm update has no current package selection proof');
    const helperPath = path.join(__dirname, 'npm-update-helper.cjs');
    const restartingAt = new Date(this.now()).toISOString();
    const payload = {
      action: 'apply',
      operationId: prepared.operationId,
      packageName: this.npmPackageName,
      targetVersion: prepared.version,
      previousVersion: prepared.previousVersion,
      targetIntegrity: prepared.targetIntegrity,
      startedAt: prepared.startedAt,
      preparedAt: prepared.preparedAt,
      restartingAt,
      stateFile: this.updateStateFile,
      logPath: prepared.logPath || this.updateLogFile,
      activePackageRoot: target.activePackageRoot,
      installationId: target.installationId,
      installationRoot: target.installationRoot,
      bootstrapPackageRoot: target.bootstrapPackageRoot,
      runningPackageRoot: runningImage.packageRoot,
      runningImageId: runningImage.imageId,
      targetPackageRoot: targetImage.packageRoot,
      targetImageId: targetImage.imageId,
      expectedCurrentImageId,
      nodePath,
      serverPid: process.pid,
      serverProcessIdentity,
      configDir: this.configDir,
      port: process.env.FARMING_PORT || process.env.PORT || '6694',
      basePath: process.env.FARMING_BASE_PATH || '/farming',
      serverHome: process.env.FARMING_SERVER_HOME || '',
      disableAuth: /^(1|true|yes|on)$/i.test(String(process.env.FARMING_DISABLE_AUTH || '')),
    };
    const env = { ...process.env, FARMING_NPM_UPDATE_PAYLOAD: JSON.stringify(payload) };

    const state = this.persistInstallState({ ...prepared, phase: 'restarting', restartingAt, error: '' });
    const helperInvocation = nodeScriptInvocation(nodePath, helperPath);
    const spawnOptions: import('child_process').SpawnOptions = {
      cwd: this.configDir,
      detached: true,
      stdio: 'ignore',
      env,
    };
    const restorePreparedState = (error: Error): UpdateInstallState => this.persistInstallState({
      ...prepared,
      phase: 'ready-to-restart',
      error: errorMessage(error),
    });
    let child;
    try {
      child = this.spawn(helperInvocation.command, helperInvocation.args, spawnOptions);
    } catch (error: unknown) {
      restorePreparedState(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (child && typeof child.once === 'function') child.once('error', restorePreparedState);
    if (child && typeof child.unref === 'function') child.unref();
    return state;
  }

}

export {
  FarmingUpdateService,
  compareVersions,
  detectInstallMethod,
  normalizeVersion,
  npmPackageMetadataUrl,
  npmPrefixForPackageRoot,
  npmPackageRoot,
  npmVersionsFromMetadata,
  readNpmGlobalRoot,
};
