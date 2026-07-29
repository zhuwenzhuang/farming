const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const extractZip = require('extract-zip');
const { AbortController } = globalThis;
const storageLayout = require('../../../backend/storage-layout.cjs');
const {
  runtimePlatformKey,
  verifyExecutable,
} = require('../../../backend/runtime-dependency-manager.cjs');
const {
  runtimeExecutableInvocation,
} = require('../../../backend/runtime-executable-invocation.cjs');
const {
  AGENT_BROWSER_VERSION,
} = require('./agent-browser-runtime');
const {
  managedAgentBrowserPath,
} = require('./executable-discovery');

const MANIFEST_FORMAT = 'farming-managed-chromium-v1';
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOCK_TIMEOUT_MS = 16 * 60_000;
const LOCK_STALE_MS = 20 * 60_000;
const LOCK_POLL_MS = 200;
const MAX_INSTALL_OUTPUT_BYTES = 256 * 1024;
const MAX_CHROMIUM_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const SOURCE_PROBE_TIMEOUT_MS = 5_000;
const NPMMIRROR_METADATA_URL =
  'https://registry.npmmirror.com/-/binary/chrome-for-testing/last-known-good-versions.json';
const NPMMIRROR_ARCHIVE_ROOT =
  'https://registry.npmmirror.com/-/binary/chrome-for-testing';
const GOOGLE_METADATA_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
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
      if (!['EEXIST', 'EPERM'].includes(error?.code) || !fs.existsSync(filePath)) throw error;
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporary, filePath);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function processRunning(pid) {
  const value = Number(pid);
  if (!Number.isSafeInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM' || error?.code === 'EACCES';
  }
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function browserExecutableName(platform) {
  if (platform === 'darwin') return 'Google Chrome for Testing';
  if (platform === 'win32') return 'chrome.exe';
  return 'chrome';
}

function findBrowserExecutable(rootDir, options = {}) {
  const platform = options.platform || process.platform;
  const expectedName = browserExecutableName(platform);
  const stack = [{ directory: rootDir, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { directory, depth } = stack.pop();
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

function appendBounded(current, chunk) {
  const next = `${current}${String(chunk || '')}`;
  return next.length > MAX_INSTALL_OUTPUT_BYTES
    ? next.slice(next.length - MAX_INSTALL_OUTPUT_BYTES)
    : next;
}

function stableChromeVersion(payload) {
  const version = String(payload?.channels?.Stable?.version || '').trim();
  return /^\d+\.\d+\.\d+\.\d+$/.test(version) ? version : '';
}

function chromiumArchivePlatform(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux64';
  if (platform === 'win32' && arch === 'x64') return 'win64';
  return '';
}

function chromiumArchiveName(platformName) {
  return `chrome-${platformName}.zip`;
}

async function fetchJson(url, options = {}) {
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

async function probeChromiumInstallSources(options = {}) {
  const fetchJsonImpl = options.fetchJson || fetchJson;
  const candidates = [
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
    },
  ];
  const probed = await Promise.all(candidates.map(async (candidate, index) => {
    const startedAt = Date.now();
    try {
      const metadata = await fetchJsonImpl(candidate.metadataUrl, {
        timeoutMs: options.timeoutMs || SOURCE_PROBE_TIMEOUT_MS,
      });
      const version = stableChromeVersion(metadata);
      if (!version) throw new Error('Stable Chrome version is missing');
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
        error: error?.message || String(error),
      };
    }
  }));
  return probed.sort((left, right) => {
    if (left.available !== right.available) return left.available ? -1 : 1;
    if (left.latencyMs !== right.latencyMs) return left.latencyMs - right.latencyMs;
    return left.index - right.index;
  });
}

async function downloadFile(url, destination, options = {}) {
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
    let received = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_CHROMIUM_ARCHIVE_BYTES) {
          callback(new Error('Chromium archive exceeded the download size limit'));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      limit,
      fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function killInstallProcess(child, platform) {
  if (!child?.pid) return;
  try {
    if (platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') child.kill?.('SIGKILL');
  }
}

function defaultRunInstallCommand(executablePath, args, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const invocation = runtimeExecutableInvocation(executablePath, args, env, platform);
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
    let exitProofTimeout = null;
    let ownershipError = null;
    const timeoutMs = options.timeoutMs || INSTALL_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killInstallProcess(child, platform);
      exitProofTimeout = setTimeout(() => {
        if (settled) return;
        const error = new Error(
          `Chromium installation timed out and process ${child.pid} exit could not be proven`,
        );
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
      clearTimeout(exitProofTimeout);
      reject(ownershipError || error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(exitProofTimeout);
      if (ownershipError) {
        reject(ownershipError);
        return;
      }
      if (timedOut) {
        const error = new Error(`Chromium installation timed out after ${timeoutMs} ms`);
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
      );
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

function defaultVerifyBrowser(executablePath, options = {}) {
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

async function installFromNpmMirror(source, destination, options = {}) {
  const platformName = chromiumArchivePlatform(options.platform, options.arch);
  if (!platformName) {
    throw new Error(
      `Chrome for Testing does not publish a ${options.platform}-${options.arch} archive`,
    );
  }
  let version = String(source.version || '').trim();
  if (!version) {
    const metadata = await (options.fetchJson || fetchJson)(NPMMIRROR_METADATA_URL, {
      timeoutMs: SOURCE_PROBE_TIMEOUT_MS,
    });
    version = stableChromeVersion(metadata);
  }
  if (!version) throw new Error('npmmirror did not report a Stable Chrome version');

  const archiveName = chromiumArchiveName(platformName);
  const archivePath = path.join(destination, archiveName);
  const archiveUrl = `${NPMMIRROR_ARCHIVE_ROOT}/${version}/${platformName}/${archiveName}`;
  await (options.downloadFile || downloadFile)(archiveUrl, archivePath, {
    allowedHosts: ['registry.npmmirror.com', 'cdn.npmmirror.com'],
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  try {
    await (options.extractArchive || extractZip)(archivePath, { dir: destination });
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
  return { version };
}

class ManagedChromiumInstaller {
  constructor(options = {}) {
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
      || (() => probeChromiumInstallSources({ fetchJson: options.fetchJson }));
    this.installFromMirror = options.installFromMirror || installFromNpmMirror;
    this.downloadFile = options.downloadFile || downloadFile;
    this.extractArchive = options.extractArchive || extractZip;
    this.fetchJson = options.fetchJson || fetchJson;
    this.verifyBrowser = options.verifyBrowser || defaultVerifyBrowser;
    this.verifyAgentBrowser = options.verifyAgentBrowser
      || (executablePath => verifyExecutable(executablePath, this.agentBrowserVersion, {
        env: this.env,
        platform: this.platform,
        useConfiguredLoader: true,
      }));
    this.wait = options.wait || delay;
    this.installPromise = null;
    this.lastFailure = '';
  }

  rootDir() {
    return storageLayout.managedChromiumRootDir(this.configDir);
  }

  targetDir() {
    return storageLayout.managedChromiumVersionDir(
      this.configDir,
      this.agentBrowserVersion,
      this.platformKey,
    );
  }

  manifestFile(directory = this.targetDir()) {
    return path.join(directory, 'install.json');
  }

  readValidManifest(directory = this.targetDir()) {
    const manifest = readJson(this.manifestFile(directory));
    if (
      manifest?.format !== MANIFEST_FORMAT
      || manifest.agentBrowserVersion !== this.agentBrowserVersion
      || manifest.platformKey !== this.platformKey
      || typeof manifest.executableRelativePath !== 'string'
    ) return null;
    const executablePath = path.resolve(directory, manifest.executableRelativePath);
    if (!pathInside(directory, executablePath)) return null;
    try {
      fs.accessSync(executablePath, fs.constants.X_OK);
    } catch {
      return null;
    }
    return { ...manifest, executablePath };
  }

  installedOlderVersion() {
    let versions = [];
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
      if (!pathInside(directory, executablePath)) return false;
      try {
        fs.accessSync(executablePath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) || '';
  }

  status() {
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

  browserOption() {
    const manifest = this.readValidManifest();
    return manifest
      ? { kind: 'managed-chromium', path: manifest.executablePath }
      : null;
  }

  async acquireLock() {
    const lockDir = storageLayout.managedChromiumInstallLockDir(this.configDir);
    const startedAt = Date.now();
    const token = crypto.randomUUID();
    let childPid = null;
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
          childStarted(pid) {
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
        if (error?.code !== 'EEXIST') {
          if (error?.code === 'ENOENT') {
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
          const timeout = new Error('Timed out waiting for another Chromium installation');
          timeout.code = 'CHROMIUM_INSTALL_LOCK_TIMEOUT';
          throw timeout;
        }
        await this.wait(LOCK_POLL_MS);
      }
    }
  }

  async install() {
    if (this.readValidManifest()) return this.status();
    if (this.installPromise) return this.installPromise;
    this.lastFailure = '';
    this.installPromise = (async () => {
      try {
        await this.performInstall();
      } catch (error) {
        this.lastFailure = error?.message || String(error);
        throw error;
      } finally {
        this.installPromise = null;
      }
      return this.status();
    })();
    return this.installPromise;
  }

  async performInstall() {
    const agentBrowserPath = String(
      typeof this.agentBrowserPath === 'function'
        ? this.agentBrowserPath()
        : this.agentBrowserPath,
    ).trim();
    if (!agentBrowserPath) {
      const error = new Error(
        `agent-browser ${this.agentBrowserVersion} is not prepared; restart Farming through its launcher`,
      );
      error.code = 'AGENT_BROWSER_NOT_FOUND';
      throw error;
    }
    const agentBrowser = await this.verifyAgentBrowser(agentBrowserPath);
    if (!agentBrowser?.valid) {
      const error = new Error(`Farming requires agent-browser ${this.agentBrowserVersion} to install Chromium`);
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
      let installed = null;
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
              fetchJson: this.fetchJson,
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
            const error = new Error(`${source.label} did not install a usable Chromium executable`);
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
          if (error?.cleanupUnproven === true) throw error;
          lock.childStarted(null);
          failures.push(`${source.label}: ${error?.message || error}`);
          fs.rmSync(attemptDir, { recursive: true, force: true });
        }
      }
      if (!installed) {
        const error = new Error(
          `Chromium installation failed from every available source: ${failures.join('; ')}`,
        );
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
      cleanupSafe = error?.cleanupUnproven !== true;
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

module.exports = {
  GOOGLE_METADATA_URL,
  INSTALL_TIMEOUT_MS,
  MANIFEST_FORMAT,
  NPMMIRROR_ARCHIVE_ROOT,
  NPMMIRROR_METADATA_URL,
  ManagedChromiumInstaller,
  chromiumArchivePlatform,
  downloadFile,
  defaultRunInstallCommand,
  defaultVerifyBrowser,
  findBrowserExecutable,
  installFromNpmMirror,
  probeChromiumInstallSources,
};
