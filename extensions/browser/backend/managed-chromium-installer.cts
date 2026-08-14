import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { Readable, Transform, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import * as storageLayout from '../../../backend/storage-layout.cjs';
import { extractZipArchive } from '../../../backend/zip-archive.cjs';
import { runtimePlatformKey, verifyExecutable } from '../../../backend/runtime-dependency-manager.cjs';
import { runtimeExecutableInvocation } from '../../../backend/runtime-executable-invocation.cjs';
import { isSameOrDescendantPath } from '../../../backend/path-containment.cjs';
import { AGENT_BROWSER_VERSION } from './agent-browser-runtime.cjs';
import { managedAgentBrowserPath } from './executable-discovery.cjs';

const MANIFEST_FORMAT = 'farming-managed-chromium-v1';
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOCK_TIMEOUT_MS = 16 * 60_000;
const LOCK_STALE_MS = 20 * 60_000;
const LOCK_POLL_MS = 200;
const MAX_INSTALL_OUTPUT_BYTES = 256 * 1024;
const MAX_CHROMIUM_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const SOURCE_PROBE_TIMEOUT_MS = 5_000;
const PINNED_CHROMIUM_VERSION = '151.0.7922.77';
const NPMMIRROR_METADATA_URL =
  'https://registry.npmmirror.com/-/binary/chrome-for-testing/last-known-good-versions.json';
const NPMMIRROR_ARCHIVE_ROOT =
  'https://registry.npmmirror.com/-/binary/chrome-for-testing';
const GOOGLE_METADATA_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

const CHROMIUM_DOWNLOADS = {
  'darwin-arm64': { platformName: 'mac-arm64', sha256: '4b3caaabb967070f1541ff5b0fd2c95b2ba839be33a58842a8a877ec5f3fbd9b' },
  'darwin-x64': { platformName: 'mac-x64', sha256: '0345f09aaa36c85cf716959390f8a7d73b22fe4a26c1e7735dcb5653e474887a' },
  'linux-x64': { platformName: 'linux64', sha256: '60a324a6e1d27b20f2035a2cdaf71641a739fe1f5571f63794773225820bce8a' },
  'win32-x64': { platformName: 'win64', sha256: 'a561db084cf08f3f4d25681ed3e764726b0537082f27063848a01e2e23d612ae' },
} as const;

type BrowserPlatform = NodeJS.Platform;
type InstallSourceKind = 'agent-browser' | 'mirror';

interface ErrorMetadata extends Error {
  cleanupUnproven?: boolean;
  code?: string;
}

interface ManagedChromiumManifest {
  agentBrowserVersion: string;
  browserVersion?: unknown;
  downloadSource?: unknown;
  executableRelativePath: string;
  format: string;
  installedAt?: unknown;
  platformKey: string;
}

interface ValidManagedChromiumManifest extends ManagedChromiumManifest {
  executablePath: string;
}

interface ChromiumInstallSource {
  available?: boolean;
  error?: string;
  id: string;
  index?: number;
  kind: InstallSourceKind;
  label: string;
  latencyMs?: number;
  metadataUrl?: string;
  sha256?: string;
  version?: string;
}

interface ProbedChromiumInstallSource extends ChromiumInstallSource {
  available: boolean;
  error: string;
  index: number;
  latencyMs: number;
  metadataUrl: string;
  version: string;
}

interface FetchJsonOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type FetchJson = (url: string, options?: FetchJsonOptions) => Promise<unknown>;

interface DownloadFileOptions extends FetchJsonOptions {
  allowedHosts?: string[];
}

type DownloadFile = (
  url: string,
  destination: string,
  expectedSha256: string,
  options?: DownloadFileOptions,
) => Promise<void>;

interface InstallCommandOptions {
  env?: NodeJS.ProcessEnv;
  onOutput?: (output: string) => void;
  onSpawn?: (pid: number | undefined) => void;
  platform?: BrowserPlatform;
  timeoutMs?: number;
}

interface InstallCommandResult {
  stderr: string;
  stdout: string;
}

type RunInstallCommand = (
  executablePath: string,
  args: string[],
  options?: InstallCommandOptions,
) => Promise<InstallCommandResult | void>;

interface VerifyBrowserOptions {
  env?: NodeJS.ProcessEnv;
}

type VerifyBrowser = (
  executablePath: string,
  options?: VerifyBrowserOptions,
) => Promise<string>;

interface ExtractArchiveOptions {
  dir: string;
}

type ExtractArchive = (
  archivePath: string,
  options: ExtractArchiveOptions,
) => Promise<void>;

interface MirrorInstallOptions {
  arch: string;
  downloadFile?: DownloadFile;
  extractArchive?: ExtractArchive;
  platform: BrowserPlatform;
}

type InstallFromMirror = (
  source: ChromiumInstallSource,
  destination: string,
  options: MirrorInstallOptions,
) => Promise<{ version?: string } | void>;

interface AgentBrowserVerification {
  valid?: boolean;
}

interface ManagedChromiumStatus {
  agentBrowserVersion: string;
  error: string;
  installedVersion: string;
  state: 'absent' | 'failed' | 'installing' | 'ready';
  updateAvailable: boolean;
}

interface ManagedChromiumBrowserOption {
  kind: 'managed-chromium';
  path: string;
}

interface InstallLock {
  abandon(): void;
  childStarted(pid: number | null | undefined): void;
  release(): void;
}

interface ManagedChromiumInstallerOptions {
  agentBrowserPath?: string | (() => string);
  agentBrowserVersion?: string;
  arch?: string;
  configDir: string;
  downloadFile?: DownloadFile;
  env?: NodeJS.ProcessEnv;
  extractArchive?: ExtractArchive;
  fetchJson?: FetchJson;
  installFromMirror?: InstallFromMirror;
  musl?: boolean;
  platform?: BrowserPlatform;
  platformKey?: string;
  resolveInstallSources?: () => Promise<ChromiumInstallSource[]>;
  runInstallCommand?: RunInstallCommand;
  verifyAgentBrowser?: (executablePath: string) => Promise<AgentBrowserVerification>;
  verifyBrowser?: VerifyBrowser;
  wait?: (ms: number) => Promise<void>;
}

function errorMetadata(error: unknown): ErrorMetadata | null {
  return error && typeof error === 'object' ? error as ErrorMetadata : null;
}

function errorCode(error: unknown): string {
  return errorMetadata(error)?.code || '';
}

function errorMessage(error: unknown): string {
  return errorMetadata(error)?.message || String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(errorCode(error)) || !fs.existsSync(filePath)) throw error;
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporary, filePath);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function processRunning(pid: unknown): boolean {
  const value = Number(pid);
  if (!Number.isSafeInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES';
  }
}

function browserExecutableName(platform: BrowserPlatform): string {
  if (platform === 'darwin') return 'Google Chrome for Testing';
  if (platform === 'win32') return 'chrome.exe';
  return 'chrome';
}

function findBrowserExecutable(
  rootDir: string,
  options: { platform?: BrowserPlatform } = {},
): string {
  const platform = options.platform || process.platform;
  const expectedName = browserExecutableName(platform);
  const stack: Array<{ directory: string; depth: number }> = [{ directory: rootDir, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const { directory, depth } = current;
    if (depth > 8 || visited > 30_000) continue;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['.home', '.xdg'].includes(entry.name)) {
          stack.push({ directory: candidate, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || entry.name !== expectedName) continue;
      if (platform === 'darwin' && !candidate.includes('.app/Contents/MacOS/')) continue;
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep looking for a complete executable.
      }
    }
  }
  return '';
}

function appendBounded(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk || '')}`;
  return next.length > MAX_INSTALL_OUTPUT_BYTES
    ? next.slice(next.length - MAX_INSTALL_OUTPUT_BYTES)
    : next;
}

function stableChromeVersion(payload: unknown): string {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const channels = record.channels && typeof record.channels === 'object'
    ? record.channels as Record<string, unknown>
    : {};
  const stable = channels.Stable && typeof channels.Stable === 'object'
    ? channels.Stable as Record<string, unknown>
    : {};
  const version = String(stable.version || '').trim();
  return /^\d+\.\d+\.\d+\.\d+$/.test(version) ? version : '';
}

function chromiumDownload(platform: BrowserPlatform, arch: string) {
  return CHROMIUM_DOWNLOADS[`${platform}-${arch}` as keyof typeof CHROMIUM_DOWNLOADS];
}

function chromiumArchiveName(platformName: string): string {
  return `chrome-${platformName}.zip`;
}

async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Timed out fetching ${url}`)),
    options.timeoutMs || SOURCE_PROBE_TIMEOUT_MS,
  );
  timeout.unref?.();
  try {
    const response = await (options.fetchImpl || fetch)(url, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function probeChromiumInstallSources(
  options: {
    arch?: string;
    fetchJson?: FetchJson;
    platform?: BrowserPlatform;
    timeoutMs?: number;
  } = {},
): Promise<ProbedChromiumInstallSource[]> {
  const fetchJsonImpl = options.fetchJson || fetchJson;
  const mirrorDownload = chromiumDownload(
    options.platform || process.platform,
    options.arch || process.arch,
  );
  const candidates: Array<ChromiumInstallSource & { metadataUrl: string }> = [
    {
      id: 'google',
      label: 'Google Chrome for Testing',
      kind: 'agent-browser',
      metadataUrl: GOOGLE_METADATA_URL,
    },
    {
      id: 'npmmirror',
      label: 'npmmirror',
      kind: 'mirror',
      metadataUrl: NPMMIRROR_METADATA_URL,
      sha256: mirrorDownload?.sha256 || '',
      version: PINNED_CHROMIUM_VERSION,
    },
  ];
  const probed = await Promise.all(candidates.map(async (candidate, index) => {
    const startedAt = Date.now();
    try {
      const metadata = await fetchJsonImpl(candidate.metadataUrl || '', {
        timeoutMs: options.timeoutMs || SOURCE_PROBE_TIMEOUT_MS,
      });
      const version = candidate.kind === 'mirror'
        ? candidate.version || ''
        : stableChromeVersion(metadata);
      if (!version) throw new Error('Stable Chrome version is missing');
      if (candidate.kind === 'mirror' && !candidate.sha256) {
        throw new Error('No trusted Chromium digest is available for this platform');
      }
      return {
        ...candidate,
        index,
        available: true,
        latencyMs: Math.max(0, Date.now() - startedAt),
        version,
        error: '',
      };
    } catch (error) {
      return {
        ...candidate,
        index,
        available: false,
        latencyMs: Number.POSITIVE_INFINITY,
        version: '',
        error: errorMessage(error),
      };
    }
  }));
  return probed.sort((left, right) => {
    if (left.available !== right.available) return left.available ? -1 : 1;
    if (left.latencyMs !== right.latencyMs) return left.latencyMs - right.latencyMs;
    return left.index - right.index;
  });
}

async function downloadFile(
  url: string,
  destination: string,
  expectedSha256: string,
  options: DownloadFileOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Timed out downloading ${url}`)),
    options.timeoutMs || INSTALL_TIMEOUT_MS,
  );
  timeout.unref?.();
  try {
    const response = await (options.fetchImpl || fetch)(url, {
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} while downloading Chromium`);
    }
    const allowedHosts = new Set(options.allowedHosts || []);
    if (allowedHosts.size && !allowedHosts.has(new URL(response.url).hostname)) {
      throw new Error(`Chromium mirror redirected to unsupported host ${new URL(response.url).hostname}`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_CHROMIUM_ARCHIVE_BYTES) {
      throw new Error(`Chromium archive is unexpectedly large (${contentLength} bytes)`);
    }
    const sha256 = crypto.createHash('sha256');
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        received += chunk.length;
        if (received > MAX_CHROMIUM_ARCHIVE_BYTES) {
          callback(new Error('Chromium archive exceeded the download size limit'));
          return;
        }
        sha256.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as never),
      limit,
      fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
    const actualSha256 = sha256.digest('hex');
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      const error = new Error(
        `Chromium download integrity check failed (expected ${expectedSha256}, received ${actualSha256})`,
      ) as ErrorMetadata;
      error.code = 'CHROMIUM_INTEGRITY_FAILED';
      throw error;
    }
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function killInstallProcess(child: ChildProcess, platform: BrowserPlatform): void {
  if (!child?.pid) return;
  try {
    if (platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') child.kill?.('SIGKILL');
  }
}

function defaultRunInstallCommand(
  executablePath: string,
  args: string[],
  options: InstallCommandOptions = {},
): Promise<InstallCommandResult> {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const invocation = env.FARMING_AGENT_BROWSER_STATIC === '1'
    ? { command: executablePath, args }
    : runtimeExecutableInvocation(executablePath, args, env, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      detached: platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let exitProofTimeout: NodeJS.Timeout | null = null;
    let ownershipError: unknown = null;
    const timeoutMs = options.timeoutMs || INSTALL_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killInstallProcess(child, platform);
      exitProofTimeout = setTimeout(() => {
        if (settled) return;
        const error = new Error(
          `Chromium installation timed out and process ${child.pid} exit could not be proven`,
        ) as ErrorMetadata;
        error.code = 'CHROMIUM_INSTALL_EXIT_UNPROVEN';
        error.cleanupUnproven = true;
        settled = true;
        reject(error);
      }, 30_000);
      exitProofTimeout.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.stdout?.on('data', chunk => {
      stdout = appendBounded(stdout, chunk);
      options.onOutput?.(String(chunk));
    });
    child.stderr?.on('data', chunk => {
      stderr = appendBounded(stderr, chunk);
      options.onOutput?.(String(chunk));
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (exitProofTimeout) clearTimeout(exitProofTimeout);
      reject(ownershipError || error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (exitProofTimeout) clearTimeout(exitProofTimeout);
      if (ownershipError) {
        reject(ownershipError);
        return;
      }
      if (timedOut) {
        const error = new Error(`Chromium installation timed out after ${timeoutMs} ms`) as ErrorMetadata;
        error.code = 'CHROMIUM_INSTALL_TIMEOUT';
        reject(error);
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = String(stderr || stdout || '').trim().slice(-2_000);
      const error = new Error(
        detail || `agent-browser install exited with ${signal || `code ${code}`}`,
      ) as ErrorMetadata;
      error.code = 'CHROMIUM_INSTALL_FAILED';
      reject(error);
    });
    try {
      options.onSpawn?.(child.pid);
    } catch (error) {
      ownershipError = error;
      killInstallProcess(child, platform);
    }
  });
}

function defaultVerifyBrowser(
  executablePath: string,
  options: VerifyBrowserOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executablePath, ['--version'], {
      encoding: 'utf8',
      env: options.env || process.env,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(
          String(stderr || '').trim()
          || error.message
          || 'The installed Chromium executable could not start',
          { cause: error },
        ));
        return;
      }
      const version = String(stdout || stderr || '').trim();
      if (!/Chrom(?:e|ium)/i.test(version)) {
        reject(new Error('The installed Chromium executable did not report a browser version'));
        return;
      }
      resolve(version);
    });
  });
}

async function installFromNpmMirror(
  _source: ChromiumInstallSource,
  destination: string,
  options: MirrorInstallOptions,
): Promise<{ version: string }> {
  const artifact = chromiumDownload(options.platform, options.arch);
  if (!artifact) {
    throw new Error(
      `Chrome for Testing does not publish a trusted ${options.platform}-${options.arch} archive`,
    );
  }
  const archiveName = chromiumArchiveName(artifact.platformName);
  const archivePath = path.join(destination, archiveName);
  const archiveUrl = `${NPMMIRROR_ARCHIVE_ROOT}/${PINNED_CHROMIUM_VERSION}/${artifact.platformName}/${archiveName}`;
  await (options.downloadFile || downloadFile)(archiveUrl, archivePath, artifact.sha256, {
    allowedHosts: ['registry.npmmirror.com', 'cdn.npmmirror.com'],
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  try {
    await (options.extractArchive || extractZipArchive)(archivePath, { dir: destination });
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
  return { version: PINNED_CHROMIUM_VERSION };
}

class ManagedChromiumInstaller {
  readonly agentBrowserPath: string | (() => string);
  readonly agentBrowserVersion: string;
  readonly arch: string;
  readonly configDir: string;
  readonly downloadFile: DownloadFile;
  readonly env: NodeJS.ProcessEnv;
  readonly extractArchive: ExtractArchive;
  readonly installFromMirror: InstallFromMirror;
  readonly platform: BrowserPlatform;
  readonly platformKey: string;
  readonly resolveInstallSources: () => Promise<ChromiumInstallSource[]>;
  readonly runInstallCommand: RunInstallCommand;
  readonly verifyAgentBrowser: (executablePath: string) => Promise<AgentBrowserVerification>;
  readonly verifyBrowser: VerifyBrowser;
  readonly wait: (ms: number) => Promise<void>;
  installPromise: Promise<ManagedChromiumStatus> | null;
  lastFailure: string;

  constructor(options: ManagedChromiumInstallerOptions) {
    this.configDir = options.configDir;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.platformKey = options.platformKey || runtimePlatformKey({
      platform: this.platform,
      arch: this.arch,
      musl: options.musl,
    });
    this.agentBrowserVersion = options.agentBrowserVersion || AGENT_BROWSER_VERSION;
    this.env = options.env || process.env;
    this.agentBrowserPath = options.agentBrowserPath
      || (() => managedAgentBrowserPath({ env: this.env }));
    this.runInstallCommand = options.runInstallCommand || defaultRunInstallCommand;
    this.resolveInstallSources = options.resolveInstallSources
      || (() => probeChromiumInstallSources({
        arch: this.arch,
        fetchJson: options.fetchJson,
        platform: this.platform,
      }));
    this.installFromMirror = options.installFromMirror || installFromNpmMirror;
    this.downloadFile = options.downloadFile || downloadFile;
    this.extractArchive = options.extractArchive || extractZipArchive;
    this.verifyBrowser = options.verifyBrowser || defaultVerifyBrowser;
    this.verifyAgentBrowser = options.verifyAgentBrowser
      || (executablePath => verifyExecutable(executablePath, this.agentBrowserVersion, {
        env: this.env,
        platform: this.platform,
        useConfiguredLoader: this.env.FARMING_AGENT_BROWSER_STATIC !== '1',
      }));
    this.wait = options.wait || delay;
    this.installPromise = null;
    this.lastFailure = '';
  }

  rootDir(): string {
    return storageLayout.managedChromiumRootDir(this.configDir);
  }

  targetDir(): string {
    return storageLayout.managedChromiumVersionDir(
      this.configDir,
      this.agentBrowserVersion,
      this.platformKey,
    );
  }

  manifestFile(directory = this.targetDir()): string {
    return path.join(directory, 'install.json');
  }

  readValidManifest(directory = this.targetDir()): ValidManagedChromiumManifest | null {
    const manifest = readJson(this.manifestFile(directory));
    if (
      manifest?.format !== MANIFEST_FORMAT
      || manifest.agentBrowserVersion !== this.agentBrowserVersion
      || manifest.platformKey !== this.platformKey
      || typeof manifest.executableRelativePath !== 'string'
    ) return null;
    const executablePath = path.resolve(directory, manifest.executableRelativePath);
    if (!isSameOrDescendantPath(directory, executablePath)) return null;
    try {
      fs.accessSync(executablePath, fs.constants.X_OK);
    } catch {
      return null;
    }
    return { ...manifest, executablePath } as unknown as ValidManagedChromiumManifest;
  }

  installedOlderVersion(): string {
    let versions: string[] = [];
    try {
      versions = fs.readdirSync(this.rootDir(), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .filter(version => version !== this.agentBrowserVersion);
    } catch {
      return '';
    }
    return versions.find(version => {
      const directory = storageLayout.managedChromiumVersionDir(
        this.configDir,
        version,
        this.platformKey,
      );
      const manifest = readJson(path.join(directory, 'install.json'));
      if (
        manifest?.format !== MANIFEST_FORMAT
        || manifest.agentBrowserVersion !== version
        || manifest.platformKey !== this.platformKey
        || typeof manifest.executableRelativePath !== 'string'
      ) return false;
      const executablePath = path.resolve(directory, manifest.executableRelativePath);
      if (!isSameOrDescendantPath(directory, executablePath)) return false;
      try {
        fs.accessSync(executablePath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) || '';
  }

  status(): ManagedChromiumStatus {
    const current = this.readValidManifest();
    const installedVersion = current?.agentBrowserVersion || this.installedOlderVersion();
    const updateAvailable = Boolean(installedVersion && !current);
    if (this.installPromise) {
      return {
        state: 'installing',
        agentBrowserVersion: this.agentBrowserVersion,
        installedVersion: installedVersion || '',
        updateAvailable,
        error: '',
      };
    }
    if (current) {
      return {
        state: 'ready',
        agentBrowserVersion: this.agentBrowserVersion,
        installedVersion: current.agentBrowserVersion,
        updateAvailable: false,
        error: '',
      };
    }
    return {
      state: this.lastFailure ? 'failed' : 'absent',
      agentBrowserVersion: this.agentBrowserVersion,
      installedVersion: installedVersion || '',
      updateAvailable,
      error: this.lastFailure,
    };
  }

  browserOption(): ManagedChromiumBrowserOption | null {
    const manifest = this.readValidManifest();
    return manifest
      ? { kind: 'managed-chromium', path: manifest.executablePath }
      : null;
  }

  async acquireLock(): Promise<InstallLock> {
    const lockDir = storageLayout.managedChromiumInstallLockDir(this.configDir);
    const startedAt = Date.now();
    const token = crypto.randomUUID();
    let childPid: number | null = null;
    const writeOwner = () => writeJsonAtomic(path.join(lockDir, 'owner.json'), {
      pid: process.pid,
      childPid,
      token,
      createdAt: new Date().toISOString(),
    });
    while (true) {
      try {
        fs.mkdirSync(lockDir, { recursive: false, mode: 0o700 });
        try {
          writeOwner();
        } catch (error) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          throw error;
        }
        return {
          childStarted(pid: number | null | undefined) {
            childPid = Number(pid) || null;
            writeOwner();
          },
          abandon() {
            const owner = readJson(path.join(lockDir, 'owner.json'));
            if (owner?.token !== token) return;
            writeJsonAtomic(path.join(lockDir, 'owner.json'), {
              pid: null,
              childPid,
              token,
              createdAt: owner.createdAt,
            });
          },
          release() {
            const owner = readJson(path.join(lockDir, 'owner.json'));
            if (owner?.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
          },
        };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          if (errorCode(error) === 'ENOENT') {
            fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
            continue;
          }
          throw error;
        }
        const owner = readJson(path.join(lockDir, 'owner.json'));
        let ageMs = 0;
        try {
          ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
        } catch {
          continue;
        }
        const ownerAlive = processRunning(owner?.pid);
        const childAlive = processRunning(owner?.childPid);
        if ((!ownerAlive && !childAlive) || (!owner && ageMs >= LOCK_STALE_MS)) {
          const stale = `${lockDir}.stale-${Date.now()}-${crypto.randomUUID()}`;
          try {
            fs.renameSync(lockDir, stale);
            fs.rmSync(stale, { recursive: true, force: true });
            continue;
          } catch {
            // Another installer recovered the abandoned lock.
          }
        }
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          const timeout = new Error('Timed out waiting for another Chromium installation') as ErrorMetadata;
          timeout.code = 'CHROMIUM_INSTALL_LOCK_TIMEOUT';
          throw timeout;
        }
        await this.wait(LOCK_POLL_MS);
      }
    }
  }

  async install(): Promise<ManagedChromiumStatus> {
    if (this.readValidManifest()) return this.status();
    if (this.installPromise) return this.installPromise;
    this.lastFailure = '';
    this.installPromise = (async () => {
      try {
        await this.performInstall();
      } catch (error) {
        this.lastFailure = errorMessage(error);
        throw error;
      } finally {
        this.installPromise = null;
      }
      return this.status();
    })();
    return this.installPromise;
  }

  async performInstall(): Promise<ManagedChromiumStatus> {
    const agentBrowserPath = String(
      typeof this.agentBrowserPath === 'function'
        ? this.agentBrowserPath()
        : this.agentBrowserPath,
    ).trim();
    if (!agentBrowserPath) {
      const error = new Error(
        `agent-browser ${this.agentBrowserVersion} is not prepared; restart Farming through its launcher`,
      ) as ErrorMetadata;
      error.code = 'AGENT_BROWSER_NOT_FOUND';
      throw error;
    }
    const agentBrowser = await this.verifyAgentBrowser(agentBrowserPath);
    if (!agentBrowser?.valid) {
      const error = new Error(
        `Farming requires agent-browser ${this.agentBrowserVersion} to install Chromium`,
      ) as ErrorMetadata;
      error.code = 'AGENT_BROWSER_VERSION_MISMATCH';
      throw error;
    }

    const lock = await this.acquireLock();
    let stagingDir = '';
    let cleanupSafe = true;
    try {
      if (this.readValidManifest()) return this.status();
      const targetDir = this.targetDir();
      const parentDir = path.dirname(targetDir);
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
      for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith(`.staging-${this.platformKey}-`)) {
          fs.rmSync(path.join(parentDir, entry.name), { recursive: true, force: true });
        }
      }
      stagingDir = path.join(
        parentDir,
        `.staging-${this.platformKey}-${process.pid}-${crypto.randomUUID()}`,
      );
      fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
      const sources = await this.resolveInstallSources();
      const failures = [];
      let installed: {
        browserVersion: string;
        executablePath: string;
        source: string;
      } | null = null;
      for (const source of sources) {
        const attemptDir = path.join(stagingDir, `source-${source.id}`);
        const installHome = path.join(attemptDir, '.home');
        const xdgRoot = path.join(attemptDir, '.xdg');
        fs.mkdirSync(installHome, { recursive: true, mode: 0o700 });
        fs.mkdirSync(xdgRoot, { recursive: true, mode: 0o700 });
        const installEnv = {
          ...this.env,
          HOME: installHome,
          USERPROFILE: installHome,
          LOCALAPPDATA: path.join(installHome, 'AppData', 'Local'),
          XDG_CACHE_HOME: path.join(xdgRoot, 'cache'),
          XDG_CONFIG_HOME: path.join(xdgRoot, 'config'),
          XDG_STATE_HOME: path.join(xdgRoot, 'state'),
          PLAYWRIGHT_BROWSERS_PATH: attemptDir,
        };
        try {
          if (source.kind === 'mirror') {
            await this.installFromMirror(source, attemptDir, {
              platform: this.platform,
              arch: this.arch,
              downloadFile: this.downloadFile,
              extractArchive: this.extractArchive,
            });
          } else {
            await this.runInstallCommand(agentBrowserPath, ['install'], {
              env: installEnv,
              platform: this.platform,
              timeoutMs: INSTALL_TIMEOUT_MS,
              onSpawn: pid => lock.childStarted(pid),
            });
            lock.childStarted(null);
          }
          const executablePath = findBrowserExecutable(attemptDir, { platform: this.platform });
          if (!executablePath) {
            const error = new Error(
              `${source.label} did not install a usable Chromium executable`,
            ) as ErrorMetadata;
            error.code = 'CHROMIUM_EXECUTABLE_NOT_FOUND';
            throw error;
          }
          const browserVersion = await this.verifyBrowser(executablePath, { env: installEnv });
          fs.rmSync(installHome, { recursive: true, force: true });
          fs.rmSync(xdgRoot, { recursive: true, force: true });
          installed = {
            browserVersion,
            executablePath,
            source: source.id,
          };
          break;
        } catch (error) {
          if (errorMetadata(error)?.cleanupUnproven === true) throw error;
          lock.childStarted(null);
          failures.push(`${source.label}: ${errorMessage(error)}`);
          fs.rmSync(attemptDir, { recursive: true, force: true });
        }
      }
      if (!installed) {
        const error = new Error(
          `Chromium installation failed from every available source: ${failures.join('; ')}`,
        ) as ErrorMetadata;
        error.code = 'CHROMIUM_INSTALL_SOURCES_FAILED';
        throw error;
      }
      writeJsonAtomic(this.manifestFile(stagingDir), {
        format: MANIFEST_FORMAT,
        agentBrowserVersion: this.agentBrowserVersion,
        platformKey: this.platformKey,
        browserVersion: installed.browserVersion,
        downloadSource: installed.source,
        executableRelativePath: path.relative(stagingDir, installed.executablePath),
        installedAt: new Date().toISOString(),
      });

      let displacedDir = '';
      if (fs.existsSync(targetDir)) {
        displacedDir = `${targetDir}.invalid-${crypto.randomUUID()}`;
        fs.renameSync(targetDir, displacedDir);
      }
      try {
        fs.renameSync(stagingDir, targetDir);
        stagingDir = '';
      } catch (error) {
        if (displacedDir && !fs.existsSync(targetDir)) fs.renameSync(displacedDir, targetDir);
        throw error;
      }
      if (displacedDir) {
        try {
          fs.rmSync(displacedDir, { recursive: true, force: true });
        } catch (error) {
          console.warn('Managed Chromium installed, but the invalid previous cache could not be removed:', error);
        }
      }
      this.lastFailure = '';
      return this.status();
    } catch (error) {
      cleanupSafe = errorMetadata(error)?.cleanupUnproven !== true;
      throw error;
    } finally {
      if (cleanupSafe) {
        if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
        lock.release();
      } else {
        lock.abandon();
      }
    }
  }
}

export {
  CHROMIUM_DOWNLOADS,
  GOOGLE_METADATA_URL,
  INSTALL_TIMEOUT_MS,
  MANIFEST_FORMAT,
  NPMMIRROR_ARCHIVE_ROOT,
  NPMMIRROR_METADATA_URL,
  PINNED_CHROMIUM_VERSION,
  ManagedChromiumInstaller,
  downloadFile,
  defaultRunInstallCommand,
  defaultVerifyBrowser,
  findBrowserExecutable,
  installFromNpmMirror,
  probeChromiumInstallSources,
};
