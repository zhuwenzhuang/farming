import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  execFile,
  execFileSync,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from 'child_process';
import { pipeline } from 'stream/promises';
import { Readable, Transform, type TransformCallback } from 'stream';
import * as tar from 'tar';

interface StorageLayout {
  farmingConfigDir(env?: NodeJS.ProcessEnv): string;
  runtimeDependenciesDir(configDir: string): string;
  runtimeDependenciesActiveFile(configDir: string): string;
  runtimeDependencyBindingFile(configDir: string, bindingId: string): string;
  runtimeDependencyBindingsDir(configDir: string): string;
  runtimeDependenciesLockDir(configDir: string): string;
}

interface RuntimeExecutableInvocation {
  command: string;
  args: string[];
}

interface RuntimeArtifact {
  url: string;
  integrity: string;
  size?: number;
  archive?: string;
  archiveEntry?: string;
  archivePrefix?: string;
  entry: string;
}

interface RuntimeDependencyManifestEntry {
  version: string;
  reportedVersion?: string;
  managedProbe?: boolean;
  probe?: {
    args?: string[];
  };
  artifacts: Record<string, RuntimeArtifact>;
}

interface RuntimeDependencyManifest {
  schemaVersion: number;
  manifestId: string;
  dependencies: Record<string, RuntimeDependencyManifestEntry>;
}

interface RuntimeDependencySourceConfig {
  authoritativeNpmRegistry: string;
  defaultNpmMirror?: string;
}

const PREPARED_RUNTIME_SEED_ENV = 'FARMING_RUNTIME_SEED_DIR';
const RUNTIME_DOWNLOAD_POLICY_ENV = 'FARMING_RUNTIME_DOWNLOAD_POLICY';

interface RuntimeDependencyDefinition {
  id: string;
  envKeys: readonly string[];
  commands: readonly string[];
  allowSystem?: boolean;
}

interface RuntimePlatformOptions {
  platform?: string;
  arch?: string;
  platformKey?: string;
  musl?: boolean;
}

interface ResolvedRuntime {
  id: string;
  version: string;
  reportedVersion?: string;
  platformKey?: string;
  source: 'managed' | 'system';
  executablePath: string;
}

interface ExecutableVerification {
  valid: boolean;
  version: string;
  output: string;
  error: string;
}

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

export type ExecFileImplementation = (
  command: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => unknown;

type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  url: string;
}

interface DownloadRetry {
  error: string;
  nextUrl: string;
  url: string;
}

export interface RuntimeDependencyProgress {
  dependencyId: string;
  message?: string;
  phase: 'download' | 'ready' | 'retry' | 'verify';
  receivedBytes?: number;
  source?: 'managed' | 'system';
  totalBytes?: number;
  version: string;
}

interface DownloadOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchImplementation;
  mirrorLookupTimeoutMs?: number;
  downloadTimeoutMs?: number;
  onDownloadProgress?: (progress: DownloadProgress) => void;
  onDownloadRetry?: (retry: DownloadRetry) => void;
}

interface LockOptions {
  token?: string;
  lockTimeoutMs?: number;
  lockPollMs?: number;
  wait?: (ms: number) => Promise<void>;
}

interface VerifyExecutableOptions {
  execFile?: ExecFileImplementation;
  args?: string[];
  useConfiguredLoader?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  timeoutMs?: number;
}

type InstallRuntime = (
  configDir: string,
  definition: RuntimeDependencyDefinition,
  platformKey: string,
  options: RuntimeManagerOptions,
) => Promise<ResolvedRuntime>;

interface RuntimeManagerOptions extends RuntimePlatformOptions, DownloadOptions, LockOptions {
  activate?: boolean;
  configDir?: string;
  dependencyIds?: readonly string[];
  installRuntime?: InstallRuntime;
  onProgress?: (progress: RuntimeDependencyProgress) => void;
  retainedBindings?: number;
}

interface ActiveRuntimeDependency {
  version: string;
  platformKey?: string;
  source: 'managed' | 'system';
  executablePath: string;
}

interface ActiveRuntimeManifest {
  schemaVersion: number;
  bindingId?: string;
  manifestId: string;
  platformKey: string;
  dependencies: Record<string, ActiveRuntimeDependency>;
  preparedAt: string;
}

interface RuntimeCacheRecord {
  schemaVersion: number;
  manifestId: string;
  id: string;
  version: string;
  platformKey: string;
  integrity: string;
  entry: string;
  executableSha256: string;
  installedAt: string;
}

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

interface MirrorMetadata {
  version?: string;
  dist?: {
    integrity?: string;
    tarball?: string;
  };
}

interface ProcessReport {
  header?: {
    glibcVersionRuntime?: string;
  };
}

import * as storageLayout from './storage-layout.cjs';
import { runtimeExecutableInvocation } from './runtime-executable-invocation.cjs';

const MANIFEST = require('./data/runtime-dependency-manifest.json') as RuntimeDependencyManifest;
const SOURCE_CONFIG = require('./data/runtime-dependency-sources.json') as RuntimeDependencySourceConfig;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MIRROR_LOOKUP_TIMEOUT_MS = 3_000;
const LOCK_TIMEOUT_MS = 180_000;
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 100;
const DEFAULT_RETAINED_BINDINGS = 3;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUTHORITATIVE_NPM_ORIGIN = new URL(SOURCE_CONFIG.authoritativeNpmRegistry).origin;

const DEPENDENCIES: readonly RuntimeDependencyDefinition[] = Object.freeze([
  {
    id: 'codex',
    envKeys: ['FARMING_CODEX_BIN', 'CODEX_PATH'],
    commands: ['codex'],
  },
  {
    id: 'claude',
    envKeys: ['FARMING_CLAUDE_BIN', 'CLAUDE_CODE_EXECUTABLE'],
    commands: ['claude'],
  },
  {
    id: 'agentBrowser',
    envKeys: ['FARMING_AGENT_BROWSER_BIN', 'FARMING_AGENT_BROWSER_EXECUTABLE'],
    commands: ['agent-browser'],
    allowSystem: false,
  },
]);

const DEPENDENCY_BY_ID = new Map(DEPENDENCIES.map(definition => [definition.id, definition]));

function notifyProgress<T>(listener: ((value: T) => void) | undefined, value: T): void {
  if (!listener) return;
  try {
    listener(value);
  } catch {
    // Progress is observational and must never affect dependency preparation.
  }
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}

function errorName(error: unknown): string {
  if (!error || typeof error !== 'object' || !('name' in error)) return '';
  return typeof error.name === 'string' ? error.name : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeSegment(value: unknown, label: string): string {
  const text = String(value || '').trim();
  if (!SAFE_SEGMENT.test(text) || text === '.' || text === '..') {
    throw new Error(`Invalid runtime dependency ${label}`);
  }
  return text;
}

function safeRelative(value: unknown, label = 'entry'): string {
  const text = String(value || '').replace(/\\/g, '/');
  if (
    !text
    || path.posix.isAbsolute(text)
    || text.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid runtime dependency ${label}`);
  }
  return text;
}

function selectedDependencyDefinitions(ids: readonly string[] | undefined): RuntimeDependencyDefinition[] {
  if (ids === undefined) return [...DEPENDENCIES];
  const requested = new Set(ids.map(id => safeSegment(id, 'id')));
  for (const id of requested) {
    if (!DEPENDENCY_BY_ID.has(id)) throw new Error(`Unknown runtime dependency: ${id}`);
  }
  return DEPENDENCIES.filter(definition => requested.has(definition.id));
}

function runtimeBindingId(manifestId: string, platformKey: string): string {
  return `${safeSegment(manifestId, 'manifest id')}.${safeSegment(platformKey, 'platform key')}`;
}

function normalizeRuntimeBinding(value: ActiveRuntimeManifest | null): ActiveRuntimeManifest | null {
  if (!value || !SAFE_SEGMENT.test(String(value.manifestId || ''))) return null;
  if (!SAFE_SEGMENT.test(String(value.platformKey || ''))) return null;
  if (!value.dependencies || typeof value.dependencies !== 'object') return null;
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    bindingId: SAFE_SEGMENT.test(String(value.bindingId || ''))
      ? String(value.bindingId)
      : String(value.manifestId),
    manifestId: String(value.manifestId),
    platformKey: String(value.platformKey),
    dependencies: value.dependencies,
    preparedAt: String(value.preparedAt || ''),
  };
}

function readRuntimeBinding(configDir: string, bindingId: string): ActiveRuntimeManifest | null {
  if (!SAFE_SEGMENT.test(bindingId)) return null;
  return normalizeRuntimeBinding(readJson<ActiveRuntimeManifest>(
    storageLayout.runtimeDependencyBindingFile(configDir, bindingId),
  ));
}

function writeRuntimeBinding(configDir: string, binding: ActiveRuntimeManifest): void {
  const bindingId = safeSegment(binding.bindingId, 'binding id');
  fs.mkdirSync(storageLayout.runtimeDependencyBindingsDir(configDir), { recursive: true, mode: 0o700 });
  writeJsonAtomic(
    storageLayout.runtimeDependencyBindingFile(configDir, bindingId),
    binding,
  );
}

function runtimeBindings(configDir: string): ActiveRuntimeManifest[] {
  const bindingsDir = storageLayout.runtimeDependencyBindingsDir(configDir);
  if (!fs.existsSync(bindingsDir)) return [];
  const bindings: ActiveRuntimeManifest[] = [];
  for (const entry of fs.readdirSync(bindingsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const bindingId = entry.name.slice(0, -'.json'.length);
    if (!SAFE_SEGMENT.test(bindingId)) continue;
    const binding = readRuntimeBinding(configDir, bindingId);
    if (binding && binding.bindingId === bindingId) bindings.push(binding);
  }
  return bindings;
}

function isMuslRuntime(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.report?.getReport) {
    const report = process.report.getReport() as ProcessReport;
    if (report?.header?.glibcVersionRuntime) return false;
  }
  return true;
}

function runtimePlatformKey(options: RuntimePlatformOptions = {}): string {
  const platform = safeSegment(options.platform || process.platform, 'platform');
  const arch = safeSegment(options.arch || process.arch, 'architecture');
  if (options.platformKey) return safeSegment(options.platformKey, 'platform key');
  const musl = options.musl ?? (platform === process.platform && isMuslRuntime());
  return platform === 'linux' && musl ? `${platform}-${arch}-musl` : `${platform}-${arch}`;
}

function legacyGlibcNeedsStaticAgentBrowser(
  platformKey: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!/^linux-(?:x64|arm64)$/.test(platformKey)) return false;
  if (env.FARMING_NODE_LD && env.FARMING_NODE_LIBRARY_PATH) return true;
  if (process.platform !== 'linux') return false;
  const version = process.report?.getReport
    ? (process.report.getReport() as ProcessReport)?.header?.glibcVersionRuntime
    : '';
  const match = String(version || '').match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  return Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 28);
}

function dependencyPlatformKey(
  id: string,
  platformKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return id === 'agentBrowser' && legacyGlibcNeedsStaticAgentBrowser(platformKey, env)
    ? `${platformKey}-musl`
    : platformKey;
}

function dependencyCacheDir(
  configDir: string,
  id: string,
  version: string,
  platformKey: string,
): string {
  return path.join(
    storageLayout.runtimeDependenciesDir(configDir),
    safeSegment(id, 'id'),
    safeSegment(version, 'version'),
    safeSegment(platformKey, 'platform key'),
  );
}

function fileSha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseIntegrity(integrity: unknown): { algorithm: 'sha256' | 'sha512'; digest: Buffer } {
  const match = String(integrity || '').match(/^(sha256|sha512)-([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Runtime artifact integrity must use sha256 or sha512 SRI');
  return {
    algorithm: match[1] as 'sha256' | 'sha512',
    digest: Buffer.from(match[2], 'base64'),
  };
}

function which(command: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const program = process.platform === 'win32' ? 'where.exe' : 'which';
    const output = execFileSync(program, [command], {
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 64 * 1024,
      env,
    });
    return String(output).split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

function semanticVersion(output: unknown): string {
  return String(output || '').match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] || '';
}

async function verifyExecutable(
  executablePath: string,
  expectedVersion: string,
  options: VerifyExecutableOptions = {},
): Promise<ExecutableVerification> {
  const execute: ExecFileImplementation = options.execFile || execFile;
  const args = options.args || ['--version'];
  const invocation = options.useConfiguredLoader
    ? runtimeExecutableInvocation(
      executablePath,
      args,
      options.env || process.env,
      options.platform || process.platform,
    )
    : { command: executablePath, args };
  return new Promise(resolve => {
    execute(invocation.command, invocation.args, {
      encoding: 'utf8',
      timeout: options.timeoutMs || 5_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: options.env || process.env,
    }, (error: ExecFileException | null, stdout: string, stderr: string) => {
      const output = `${stdout || ''}\n${stderr || ''}`.trim();
      const version = semanticVersion(output);
      resolve({
        valid: !error && version === expectedVersion,
        version,
        output,
        error: error?.message || '',
      });
    });
  });
}

function explicitCandidate(
  dependency: RuntimeDependencyDefinition,
  env: NodeJS.ProcessEnv,
): { path: string; key: string } | null {
  for (const key of dependency.envKeys) {
    const value = String(env[key] || '').trim();
    if (value) return { path: path.resolve(value), key };
  }
  return null;
}

function systemCandidates(
  dependency: RuntimeDependencyDefinition,
  env: NodeJS.ProcessEnv,
): Array<{ path: string; key: string }> {
  const explicit = explicitCandidate(dependency, env);
  if (explicit) return [explicit];
  return dependency.commands
    .map(command => which(command, env))
    .filter(Boolean)
    .map(candidate => ({ path: path.resolve(candidate), key: '' }));
}

function resolutionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (
    !env.FARMING_RUNTIME_MANIFEST_ID
    || env.FARMING_RUNTIME_MANIFEST_ID === MANIFEST.manifestId
  ) {
    return env;
  }
  const resolved = { ...env };
  for (const dependency of DEPENDENCIES) {
    for (const key of dependency.envKeys) delete resolved[key];
  }
  delete resolved.FARMING_RUNTIME_MANIFEST_ID;
  return resolved;
}

function managedRuntimeUsesConfiguredLoader(id: string, platformKey = ''): boolean {
  return id === 'agentBrowser' && !platformKey.endsWith('-musl');
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

function processRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES';
  }
}

async function acquirePrepareLock(
  configDir: string,
  options: LockOptions = {},
): Promise<() => void> {
  const lockDir = storageLayout.runtimeDependenciesLockDir(configDir);
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir, { recursive: false, mode: 0o700 });
      writeJsonAtomic(path.join(lockDir, 'owner.json'), {
        pid: process.pid,
        token: options.token || crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      });
      return () => fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (error: unknown) {
      if (errorCode(error) !== 'EEXIST') {
        if (errorCode(error) === 'ENOENT') {
          fs.mkdirSync(path.dirname(lockDir), { recursive: true });
          continue;
        }
        throw error;
      }
      const owner = readJson<LockOwner>(path.join(lockDir, 'owner.json'));
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
      } catch {
        continue;
      }
      if ((owner && !processRunning(Number(owner.pid))) || (!owner && ageMs >= LOCK_STALE_MS)) {
        const stale = `${lockDir}.stale-${Date.now()}-${crypto.randomUUID()}`;
        try {
          fs.renameSync(lockDir, stale);
          fs.rmSync(stale, { recursive: true, force: true });
          continue;
        } catch {
          // Another starter recovered or replaced the lock first.
        }
      }
      if (Date.now() - startedAt >= (options.lockTimeoutMs || LOCK_TIMEOUT_MS)) {
        throw new Error(
          'Timed out waiting for another Farming startup dependency preparation',
          { cause: error },
        );
      }
      await (options.wait || delay)(options.lockPollMs || LOCK_POLL_MS);
    }
  }
}

function npmArtifactIdentity(artifactUrl: string | URL): {
  packageName: string;
  version: string;
} {
  const artifact = new URL(artifactUrl);
  const segments = artifact.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const separator = segments.indexOf('-');
  if (separator < 1 || separator !== segments.length - 2) {
    throw new Error('Runtime artifact must use a standard npm tarball URL');
  }
  const packageName = segments.slice(0, separator).join('/');
  const packageBase = packageName.split('/').pop();
  const filename = segments[separator + 1];
  const prefix = `${packageBase}-`;
  if (!filename.startsWith(prefix) || !filename.endsWith('.tgz')) {
    throw new Error('Runtime artifact tarball does not match its npm package');
  }
  return {
    packageName,
    version: filename.slice(prefix.length, -'.tgz'.length),
  };
}

function configuredRuntimeNpmMirror(env: NodeJS.ProcessEnv): string {
  if (Object.prototype.hasOwnProperty.call(env, 'FARMING_RUNTIME_NPM_MIRROR')) {
    const configured = String(env.FARMING_RUNTIME_NPM_MIRROR || '').trim();
    if (!configured || /^(0|false|none|off)$/i.test(configured)) return '';
    return configured;
  }
  return String(SOURCE_CONFIG.defaultNpmMirror || '').trim();
}

async function runtimeArtifactDownloadUrls(
  artifact: RuntimeArtifact,
  options: DownloadOptions = {},
): Promise<string[]> {
  const authoritative = new URL(artifact.url);
  if (authoritative.origin !== AUTHORITATIVE_NPM_ORIGIN) {
    throw new Error('Runtime artifact must use the authoritative public npm registry');
  }
  const env = options.env || process.env;
  const configuredMirror = configuredRuntimeNpmMirror(env);
  if (!configuredMirror) return [authoritative.href];
  const mirror = new URL(configuredMirror);
  if (
    mirror.protocol !== 'https:'
    || mirror.username
    || mirror.password
    || mirror.search
    || mirror.hash
    || !['', '/'].includes(mirror.pathname)
  ) {
    throw new Error('FARMING_RUNTIME_NPM_MIRROR must be an HTTPS registry origin');
  }
  if (mirror.origin === authoritative.origin) return [authoritative.href];

  const { packageName, version } = npmArtifactIdentity(authoritative);
  const metadataUrl = new URL(
    `${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
    mirror,
  );
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.mirrorLookupTimeoutMs || MIRROR_LOOKUP_TIMEOUT_MS,
  );
  timeout.unref?.();
  try {
    const request: FetchImplementation = options.fetch || fetch;
    const response = await request(metadataUrl, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return [authoritative.href];
    const metadata = await response.json() as MirrorMetadata;
    const mirroredTarball = metadata.dist?.tarball;
    if (
      metadata.version !== version
      || metadata.dist?.integrity !== artifact.integrity
      || !mirroredTarball
    ) {
      return [authoritative.href];
    }
    const mirrored = new URL(mirroredTarball);
    if (mirrored.protocol !== 'https:' || mirrored.origin !== mirror.origin) {
      return [authoritative.href];
    }
    return [mirrored.href, authoritative.href];
  } catch {
    return [authoritative.href];
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadArtifactFromUrl(
  artifact: RuntimeArtifact,
  url: string,
  destination: string,
  options: DownloadOptions = {},
): Promise<void> {
  const { algorithm, digest } = parseIntegrity(artifact.integrity);
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS,
  );
  timeout.unref?.();
  const hash = crypto.createHash(algorithm);
  let received = 0;
  try {
    const request: FetchImplementation = options.fetch || fetch;
    const response = await request(url, {
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Runtime download failed with HTTP ${response.status}`);
    }
    const expectedSize = Number(artifact.size) || 0;
    const responseSize = Number(response.headers.get('content-length')) || 0;
    const progressTotal = expectedSize || responseSize;
    const limit = expectedSize || MAX_DOWNLOAD_BYTES;
    notifyProgress(options.onDownloadProgress, { receivedBytes: 0, totalBytes: progressTotal, url });
    const meter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        received += chunk.length;
        if (received > limit) {
          callback(new Error(`Runtime download exceeded ${limit} bytes`));
          return;
        }
        hash.update(chunk);
        notifyProgress(options.onDownloadProgress, {
          receivedBytes: received,
          totalBytes: progressTotal,
          url,
        });
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(
        response.body as unknown as import('stream/web').ReadableStream<Uint8Array>,
      ),
      meter,
      fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
    if (expectedSize && received !== expectedSize) {
      throw new Error(`Runtime download size mismatch: expected ${expectedSize}, received ${received}`);
    }
    if (!crypto.timingSafeEqual(hash.digest(), digest)) {
      throw new Error('Runtime artifact failed integrity verification');
    }
  } catch (error: unknown) {
    fs.rmSync(destination, { force: true });
    if (errorName(error) === 'AbortError') {
      throw new Error('Runtime download timed out', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadArtifact(
  artifact: RuntimeArtifact,
  destination: string,
  options: DownloadOptions = {},
): Promise<void> {
  const urls = await runtimeArtifactDownloadUrls(artifact, options);
  for (const [index, url] of urls.entries()) {
    try {
      await downloadArtifactFromUrl(artifact, url, destination, options);
      return;
    } catch (error: unknown) {
      if (index === urls.length - 1) throw error;
      const retry = {
        error: errorMessage(error),
        nextUrl: urls[index + 1],
        url,
      };
      if (options.onDownloadRetry) notifyProgress(options.onDownloadRetry, retry);
      else {
        console.warn(
          `Runtime npm mirror download failed; retrying the authoritative npm registry: ${retry.error}`,
        );
      }
    }
  }
}

async function extractArtifact(
  artifact: RuntimeArtifact,
  archivePath: string,
  stagingDir: string,
): Promise<string> {
  const entry = safeRelative(artifact.entry);
  if (artifact.archive === 'file') {
    const destination = path.join(stagingDir, entry);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(archivePath, destination);
    return destination;
  }
  if (artifact.archive !== 'tgz') throw new Error(`Unsupported runtime archive: ${artifact.archive}`);
  if (artifact.archiveEntry) {
    const archiveEntry = safeRelative(artifact.archiveEntry, 'archive entry');
    const extractionDir = path.join(stagingDir, '.artifact');
    const extractedName = path.posix.basename(archiveEntry);
    fs.mkdirSync(extractionDir, { recursive: true });
    await tar.x({
      cwd: extractionDir,
      file: archivePath,
      gzip: true,
      preserveOwner: false,
      strict: true,
      strip: archiveEntry.split('/').length - 1,
      filter: candidate => candidate === archiveEntry,
    });
    const extractedPath = path.join(extractionDir, extractedName);
    const extractedStat = fs.lstatSync(extractedPath);
    if (!extractedStat.isFile() || extractedStat.isSymbolicLink()) {
      throw new Error('Runtime archive entry must be a regular file');
    }
    const destination = path.join(stagingDir, entry);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(extractedPath, destination);
    fs.rmSync(extractionDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
    return destination;
  }
  const prefix = safeRelative(artifact.archivePrefix, 'archive prefix');
  const prefixWithSlash = `${prefix}/`;
  await tar.x({
    cwd: stagingDir,
    file: archivePath,
    gzip: true,
    preserveOwner: false,
    strict: true,
    strip: prefix.split('/').length,
    filter: archiveEntry => archiveEntry === prefix || archiveEntry.startsWith(prefixWithSlash),
  });
  fs.rmSync(archivePath, { force: true });
  const executablePath = path.resolve(stagingDir, entry);
  if (!executablePath.startsWith(`${path.resolve(stagingDir)}${path.sep}`)) {
    throw new Error('Runtime executable escaped the staging directory');
  }
  const realExecutablePath = fs.realpathSync(executablePath);
  const executableStat = fs.lstatSync(executablePath);
  if (
    !executableStat.isFile()
    || executableStat.isSymbolicLink()
    || !realExecutablePath.startsWith(`${fs.realpathSync(stagingDir)}${path.sep}`)
  ) {
    throw new Error('Runtime executable must be a regular file inside the staging directory');
  }
  return executablePath;
}

function dependencyManifest(
  id: string,
  platformKey: string,
): { dependency: RuntimeDependencyManifestEntry; artifact: RuntimeArtifact } {
  if (MANIFEST.schemaVersion !== 1 || !MANIFEST.manifestId) {
    throw new Error('Runtime dependency manifest is invalid');
  }
  const dependency = MANIFEST.dependencies?.[id];
  const artifact = dependency?.artifacts?.[platformKey];
  if (!dependency || !artifact) {
    throw new Error(`${id} has no runtime artifact for ${platformKey}`);
  }
  parseIntegrity(artifact.integrity);
  safeRelative(artifact.entry);
  if (artifact.archive === 'tgz') {
    if (artifact.archiveEntry) safeRelative(artifact.archiveEntry, 'archive entry');
    else safeRelative(artifact.archivePrefix, 'archive prefix');
  }
  return { dependency, artifact };
}

async function resolveCachedRuntime(
  configDir: string,
  id: string,
  platformKey: string,
  options: Pick<DownloadOptions, 'env'> = {},
): Promise<ResolvedRuntime | null> {
  const { dependency, artifact } = dependencyManifest(id, platformKey);
  const cacheDir = dependencyCacheDir(configDir, id, dependency.version, platformKey);
  const record = readJson<RuntimeCacheRecord>(path.join(cacheDir, 'runtime.json'));
  const executablePath = path.resolve(cacheDir, artifact.entry);
  if (
    !record
    || record.schemaVersion !== 1
    || record.manifestId !== MANIFEST.manifestId
    || record.id !== id
    || record.version !== dependency.version
    || record.platformKey !== platformKey
    || record.integrity !== artifact.integrity
    || record.entry !== artifact.entry
    || !fs.existsSync(executablePath)
    || fileSha256(executablePath) !== record.executableSha256
  ) {
    return null;
  }
  if (dependency.managedProbe !== false) {
    const verification = await verifyExecutable(
      executablePath,
      dependency.reportedVersion || dependency.version,
      {
        args: dependency.probe?.args,
        env: options.env,
        useConfiguredLoader: managedRuntimeUsesConfiguredLoader(id, platformKey),
      },
    );
    if (!verification.valid) return null;
  }
  return {
    id,
    version: dependency.version,
    platformKey,
    source: 'managed',
    executablePath,
  };
}

async function findExactRuntime(
  configDir: string,
  definition: RuntimeDependencyDefinition,
  platformKey: string,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedRuntime | null> {
  const { dependency } = dependencyManifest(definition.id, platformKey);
  const expectedVersion = dependency.reportedVersion || dependency.version;
  const candidates = definition.allowSystem === false ? [] : systemCandidates(definition, env);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) {
      if (candidate.key) {
        throw new Error(`${candidate.key} points to a missing executable: ${candidate.path}`);
      }
      continue;
    }
    const verification = await verifyExecutable(candidate.path, expectedVersion, {
      args: dependency.probe?.args,
      env,
    });
    if (verification.valid) {
      return {
        id: definition.id,
        version: dependency.version,
        reportedVersion: expectedVersion,
        platformKey,
        source: 'system',
        executablePath: candidate.path,
      };
    }
    if (candidate.key) {
      throw new Error(
        `${candidate.key} must provide ${definition.id} ${expectedVersion}; `
        + `found ${verification.version || 'an unverifiable executable'}`,
      );
    }
  }
  const cached = await resolveCachedRuntime(configDir, definition.id, platformKey, { env });
  if (cached) return cached;
  const seedDir = String(env[PREPARED_RUNTIME_SEED_ENV] || '').trim();
  if (!seedDir) return null;
  if (!path.isAbsolute(seedDir)) {
    throw new Error(`${PREPARED_RUNTIME_SEED_ENV} must be an absolute directory.`);
  }
  if (path.resolve(seedDir) === path.resolve(configDir)) return null;
  return resolveCachedRuntime(seedDir, definition.id, platformKey, { env });
}

async function installExactRuntime(
  configDir: string,
  definition: RuntimeDependencyDefinition,
  platformKey: string,
  options: RuntimeManagerOptions = {},
): Promise<ResolvedRuntime> {
  if (String(options.env?.[RUNTIME_DOWNLOAD_POLICY_ENV] || '').trim() === 'forbid') {
    throw new Error(
      `${definition.id} ${MANIFEST.dependencies[definition.id]?.version || ''} was not prepared during npm install; `
      + 'run npm install again before starting Farming Desktop.',
    );
  }
  const { dependency, artifact } = dependencyManifest(definition.id, platformKey);
  const cacheDir = dependencyCacheDir(configDir, definition.id, dependency.version, platformKey);
  const stagingDir = `${cacheDir}.preparing-${process.pid}-${crypto.randomUUID()}`;
  const archivePath = path.join(stagingDir, 'artifact.download');
  const quarantine = `${cacheDir}.invalid-${Date.now()}-${crypto.randomUUID()}`;
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  try {
    notifyProgress(options.onProgress, {
      dependencyId: definition.id,
      phase: 'download',
      receivedBytes: 0,
      totalBytes: Number(artifact.size) || 0,
      version: dependency.version,
    });
    await downloadArtifact(artifact, archivePath, {
      ...options,
      onDownloadProgress: progress => {
        notifyProgress(options.onDownloadProgress, progress);
        notifyProgress(options.onProgress, {
          dependencyId: definition.id,
          phase: 'download',
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
          version: dependency.version,
        });
      },
      onDownloadRetry: retry => {
        notifyProgress(options.onDownloadRetry, retry);
        notifyProgress(options.onProgress, {
          dependencyId: definition.id,
          message: retry.error,
          phase: 'retry',
          version: dependency.version,
        });
      },
    });
    const executablePath = await extractArtifact(artifact, archivePath, stagingDir);
    if (!fs.existsSync(executablePath)) throw new Error(`${definition.id} archive omitted ${artifact.entry}`);
    fs.chmodSync(executablePath, 0o700);
    notifyProgress(options.onProgress, {
      dependencyId: definition.id,
      phase: 'verify',
      version: dependency.version,
    });
    if (dependency.managedProbe !== false) {
      const verification = await verifyExecutable(
        executablePath,
        dependency.reportedVersion || dependency.version,
        {
          args: dependency.probe?.args,
          env: options.env,
          useConfiguredLoader: managedRuntimeUsesConfiguredLoader(definition.id, platformKey),
        },
      );
      if (!verification.valid) {
        throw new Error(
          `${definition.id} runtime reported ${verification.version || 'no version'}; `
          + `expected ${dependency.reportedVersion || dependency.version}`,
        );
      }
    }
    writeJsonAtomic(path.join(stagingDir, 'runtime.json'), {
      schemaVersion: 1,
      manifestId: MANIFEST.manifestId,
      id: definition.id,
      version: dependency.version,
      platformKey,
      integrity: artifact.integrity,
      entry: artifact.entry,
      executableSha256: fileSha256(executablePath),
      installedAt: new Date().toISOString(),
    });
    const hadCache = fs.existsSync(cacheDir);
    if (hadCache) fs.renameSync(cacheDir, quarantine);
    try {
      fs.renameSync(stagingDir, cacheDir);
    } catch (error: unknown) {
      if (hadCache && !fs.existsSync(cacheDir) && fs.existsSync(quarantine)) {
        fs.renameSync(quarantine, cacheDir);
      }
      throw error;
    }
    fs.rmSync(quarantine, { recursive: true, force: true });
  } catch (error: unknown) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
  const resolved = await resolveCachedRuntime(
    configDir,
    definition.id,
    platformKey,
    { env: options.env },
  );
  if (!resolved) throw new Error(`${definition.id} runtime did not pass post-install verification`);
  return resolved;
}

function applyRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
  prepared: ResolvedRuntime[],
): NodeJS.ProcessEnv {
  const byId = new Map(prepared.map(item => [item.id, item]));
  const codex = byId.get('codex')?.executablePath;
  const claude = byId.get('claude')?.executablePath;
  const agentBrowser = byId.get('agentBrowser')?.executablePath;
  if (codex) {
    env.FARMING_CODEX_BIN = codex;
    env.CODEX_PATH = codex;
  }
  if (claude) {
    env.FARMING_CLAUDE_BIN = claude;
    env.CLAUDE_CODE_EXECUTABLE = claude;
  }
  if (agentBrowser) {
    env.FARMING_AGENT_BROWSER_BIN = agentBrowser;
    env.FARMING_AGENT_BROWSER_EXECUTABLE = agentBrowser;
    if (byId.get('agentBrowser')?.platformKey?.endsWith('-musl')) {
      env.FARMING_AGENT_BROWSER_STATIC = '1';
    } else {
      delete env.FARMING_AGENT_BROWSER_STATIC;
    }
  }
  env.FARMING_RUNTIME_MANIFEST_ID = MANIFEST.manifestId;
  return env;
}

async function prepareRuntimeDependencies(options: RuntimeManagerOptions = {}): Promise<{
  binding: ActiveRuntimeManifest;
  manifestId: string;
  platformKey: string;
  dependencies: ResolvedRuntime[];
}> {
  const env = options.env || process.env;
  const candidateEnv = resolutionEnvironment(env);
  const configDir = options.configDir || storageLayout.farmingConfigDir(env);
  const platformKey = runtimePlatformKey(options);
  fs.mkdirSync(storageLayout.runtimeDependenciesDir(configDir), { recursive: true });
  const releaseLock = await acquirePrepareLock(configDir, options);
  const prepared: ResolvedRuntime[] = [];
  try {
    for (const definition of selectedDependencyDefinitions(options.dependencyIds)) {
      const selectedPlatformKey = dependencyPlatformKey(
        definition.id,
        platformKey,
        candidateEnv,
      );
      let runtime = await findExactRuntime(
        configDir,
        definition,
        selectedPlatformKey,
        candidateEnv,
      );
      if (!runtime) {
        const installRuntime = options.installRuntime || installExactRuntime;
        runtime = await installRuntime(configDir, definition, selectedPlatformKey, options);
      }
      runtime.platformKey ||= selectedPlatformKey;
      prepared.push(runtime);
      notifyProgress(options.onProgress, {
        dependencyId: definition.id,
        phase: 'ready',
        source: runtime.source,
        version: runtime.version,
      });
    }
    applyRuntimeEnvironment(env, prepared);
    const bindingId = runtimeBindingId(MANIFEST.manifestId, platformKey);
    const existing = readRuntimeBinding(configDir, bindingId);
    const binding: ActiveRuntimeManifest = {
      schemaVersion: 2,
      bindingId,
      manifestId: MANIFEST.manifestId,
      platformKey,
      dependencies: {
        ...(existing?.platformKey === platformKey ? existing.dependencies : {}),
        ...Object.fromEntries(prepared.map(item => [item.id, {
          version: item.version,
          platformKey: item.platformKey,
          source: item.source,
          executablePath: item.executablePath,
        }])),
      },
      preparedAt: new Date().toISOString(),
    };
    writeRuntimeBinding(configDir, binding);
    if (options.activate !== false) {
      writeJsonAtomic(storageLayout.runtimeDependenciesActiveFile(configDir), binding);
    }
    return { binding, manifestId: MANIFEST.manifestId, platformKey, dependencies: prepared };
  } finally {
    releaseLock();
  }
}

async function pruneRuntimeDependencies(
  options: Omit<RuntimeManagerOptions, 'installRuntime'> = {},
): Promise<{ removed: string[] }> {
  const env = options.env || process.env;
  const configDir = options.configDir || storageLayout.farmingConfigDir(env);
  const releaseLock = await acquirePrepareLock(configDir, options);
  const removed: string[] = [];
  try {
    const active = normalizeRuntimeBinding(readJson<ActiveRuntimeManifest>(
      storageLayout.runtimeDependenciesActiveFile(configDir),
    ));
    const storedBindings = runtimeBindings(configDir).sort((left, right) => (
      (Date.parse(right.preparedAt || '') || 0) - (Date.parse(left.preparedAt || '') || 0)
    ));
    if (!active && storedBindings.length === 0) return { removed };
    const retainedCount = Math.max(
      1,
      Math.min(10, Math.floor(Number(options.retainedBindings) || DEFAULT_RETAINED_BINDINGS)),
    );
    const retainedIds = new Set<string>();
    if (active?.bindingId) retainedIds.add(active.bindingId);
    for (const binding of storedBindings) {
      if (retainedIds.size >= retainedCount) break;
      if (binding.bindingId) retainedIds.add(binding.bindingId);
    }
    const retainedBindings = storedBindings.filter(binding => (
      binding.bindingId && retainedIds.has(binding.bindingId)
    ));
    if (active && !retainedBindings.some(binding => binding.bindingId === active.bindingId)) {
      retainedBindings.push(active);
    }
    for (const binding of storedBindings) {
      if (!binding.bindingId || retainedIds.has(binding.bindingId)) continue;
      const bindingFile = storageLayout.runtimeDependencyBindingFile(configDir, binding.bindingId);
      fs.rmSync(bindingFile, { force: true });
      removed.push(bindingFile);
    }

    const keepDirs = new Map<string, Set<string>>();
    for (const binding of retainedBindings) {
      for (const [id, dependency] of Object.entries(binding.dependencies || {})) {
        if (dependency.source !== 'managed') continue;
        if (!DEPENDENCY_BY_ID.has(id)) continue;
        const selectedPlatform = safeSegment(
          dependency.platformKey || binding.platformKey,
          'platform key',
        );
        const keepDir = dependencyCacheDir(
          configDir,
          id,
          safeSegment(dependency.version, 'version'),
          selectedPlatform,
        );
        const paths = keepDirs.get(id) || new Set<string>();
        paths.add(path.resolve(keepDir));
        keepDirs.set(id, paths);
      }
    }

    for (const definition of DEPENDENCIES) {
      const dependencyRoot = path.join(
        storageLayout.runtimeDependenciesDir(configDir),
        safeSegment(definition.id, 'id'),
      );
      if (!fs.existsSync(dependencyRoot)) continue;
      const dependencyRootStat = fs.lstatSync(dependencyRoot);
      if (!dependencyRootStat.isDirectory() || dependencyRootStat.isSymbolicLink()) {
        fs.rmSync(dependencyRoot, { recursive: true, force: true });
        removed.push(dependencyRoot);
        continue;
      }
      const dependencyKeepDirs = keepDirs.get(definition.id) || new Set<string>();
      for (const versionEntry of fs.readdirSync(dependencyRoot, { withFileTypes: true })) {
        const versionDir = path.join(dependencyRoot, versionEntry.name);
        if (!versionEntry.isDirectory()) {
          fs.rmSync(versionDir, { recursive: true, force: true });
          removed.push(versionDir);
          continue;
        }
        for (const platformEntry of fs.readdirSync(versionDir, { withFileTypes: true })) {
          const platformDir = path.join(versionDir, platformEntry.name);
          if (
            platformEntry.isDirectory()
            && dependencyKeepDirs.has(path.resolve(platformDir))
          ) continue;
          fs.rmSync(platformDir, { recursive: true, force: true });
          removed.push(platformDir);
        }
        if (fs.readdirSync(versionDir).length === 0) {
          fs.rmdirSync(versionDir);
          removed.push(versionDir);
        }
      }
      if (fs.readdirSync(dependencyRoot).length === 0) fs.rmdirSync(dependencyRoot);
    }
    return { removed };
  } finally {
    releaseLock();
  }
}

export {
  DEPENDENCIES,
  MANIFEST,
  SOURCE_CONFIG,
  applyRuntimeEnvironment,
  dependencyCacheDir,
  dependencyPlatformKey,
  downloadArtifact,
  extractArtifact,
  managedRuntimeUsesConfiguredLoader,
  prepareRuntimeDependencies,
  pruneRuntimeDependencies,
  readRuntimeBinding,
  runtimeArtifactDownloadUrls,
  runtimeBindingId,
  runtimeBindings,
  runtimePlatformKey,
  selectedDependencyDefinitions,
  verifyExecutable,
};
