const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { readServerProcessIdentity } = require('./server-process-identity');
const storageLayout = require('./storage-layout');

const CACHE_TTL_MS = 5 * 60 * 1000;
const NPM_PACKAGE_NAME = 'farming-code';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeVersion(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withoutPrefix = raw
    .replace(/^refs\/tags\//i, '')
    .replace(/^farming[-_]/i, '')
    .replace(/^v/i, '');
  const match = withoutPrefix.match(/\d+(?:\.\d+)*/);
  return match ? match[0] : withoutPrefix;
}

function versionParts(value) {
  const normalized = normalizeVersion(value);
  if (!normalized) return [];
  return normalized.split('.').map(part => Number(part)).filter(part => Number.isFinite(part));
}

function compareVersions(left, right) {
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

function detectInstallMethod(rootDir, options = {}) {
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

function installMethodBlockedReason(method) {
  if (method === 'source') return 'Source checkouts update through Git, not the in-app updater';
  if (method === 'source-deploy') return 'Source deployments update through their deployment workflow, not the in-app updater';
  if (method === 'app-bundle') return 'App bundles update by reinstalling a release package or switching to npm';
  if (method === 'standalone-cli') return 'Standalone CLI updates must reinstall the matching release asset';
  return `In-app updates require an npm installation; reinstall ${method || 'this installation'} through npm`;
}

function hasComparableVersion(value) {
  return versionParts(value).length > 0;
}

function normalizePlatform(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'darwin' || raw === 'macos' || raw === 'macosx' || raw === 'osx') return 'darwin';
  if (raw === 'linux') return 'linux';
  return raw;
}

function normalizeArch(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'x64' || raw === 'amd64' || raw === 'x86_64') return 'x64';
  if (raw === 'arm64' || raw === 'aarch64') return 'arm64';
  return raw;
}

function requestWithRedirects(url, options = {}, redirectCount = 0, authOrigin = null) {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`too many redirects for ${url}`));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const allowedAuthOrigin = authOrigin === false ? '' : (authOrigin || parsed.origin);
    const sameAuthOrigin = Boolean(allowedAuthOrigin) && parsed.origin === allowedAuthOrigin;
    const client = parsed.protocol === 'http:' ? http : https;
    const headers = {
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

async function requestJson(url, options = {}) {
  const response = await requestWithRedirects(url, options);
  const chunks = [];
  for await (const chunk of response) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function nodeScriptInvocation(nodePath, scriptPath, env = process.env) {
  if (env.FARMING_NODE_LD && env.FARMING_NODE_LIBRARY_PATH) {
    return {
      command: env.FARMING_NODE_LD,
      args: ['--library-path', env.FARMING_NODE_LIBRARY_PATH, nodePath, scriptPath],
    };
  }
  return { command: nodePath, args: [scriptPath] };
}

function npmPackageMetadataUrl(registryUrl, packageName) {
  const registry = String(registryUrl || DEFAULT_NPM_REGISTRY).replace(/\/+$/, '');
  return `${registry}/${encodeURIComponent(packageName).replace(/^%40/, '@')}`;
}

function normalizePathForCompare(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function pathIsInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function npmPackageRoot(npmRoot, packageName) {
  return path.join(npmRoot, ...String(packageName || '').split('/').filter(Boolean));
}

function npmPrefixForPackageRoot(packageRoot, packageName) {
  const segments = String(packageName || '').split('/').filter(Boolean);
  if (!path.isAbsolute(packageRoot) || segments.length === 0) return '';
  let npmRoot = packageRoot;
  for (let index = 0; index < segments.length; index += 1) npmRoot = path.dirname(npmRoot);
  return path.dirname(path.dirname(npmRoot));
}

function readNpmGlobalRoot(npmCommand, npmPrefix, execFile = childProcess.execFile) {
  const args = ['root', '--global'];
  if (npmPrefix) args.push('--prefix', npmPrefix);
  return new Promise((resolve, reject) => {
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

function npmVersionsFromMetadata(metadata, currentVersion) {
  const versions = metadata && metadata.versions && typeof metadata.versions === 'object'
    ? Object.keys(metadata.versions)
    : [];
  return versions
    .filter(version => hasComparableVersion(version) && !version.includes('-'))
    .sort((left, right) => compareVersions(right, left))
    .map(version => ({
      version,
      assetName: version,
      assetSize: Number(metadata.versions[version]?.dist?.unpackedSize || 0),
      blockedReason: '',
      installable: true,
      available: compareVersions(version, currentVersion) > 0,
    }));
}

class FarmingUpdateService {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(__dirname, '..');
    this.installMethod = options.installMethod || detectInstallMethod(this.rootDir, {
      packagedRuntime: options.packagedRuntime === true,
    });
    this.npmPackageName = options.npmPackageName || NPM_PACKAGE_NAME;
    this.npmRegistryUrl = options.npmRegistryUrl || process.env.FARMING_NPM_REGISTRY || DEFAULT_NPM_REGISTRY;
    this.npmPackageRoot = options.npmPackageRoot || process.env.FARMING_MANAGED_PACKAGE_ROOT || '';
    this.npmPrefix = options.npmPrefix || process.env.FARMING_NPM_PREFIX || '';
    this.runtime = options.platform || options.arch
      ? {
        platform: normalizePlatform(options.platform || process.platform),
        arch: normalizeArch(options.arch || process.arch),
      }
      : null;
    this.configDir = options.configDir || path.join(os.homedir(), '.farming');
    this.now = options.now || (() => Date.now());
    this.fetchJson = options.fetchJson || requestJson;
    this.execFile = options.execFile || childProcess.execFile;
    this.getNpmGlobalRoot = options.getNpmGlobalRoot
      || ((npmCommand, npmPrefix) => readNpmGlobalRoot(npmCommand, npmPrefix, this.execFile));
    this.spawn = options.spawn || childProcess.spawn;
    this.npmCache = null;
    this.installState = { phase: 'idle' };
    this.installStartPromise = null;
    this.updateStateFile = options.updateStateFile || storageLayout.updateStateFile(this.configDir);
    this.updateLogFile = options.updateLogFile || storageLayout.updateLogFile(this.configDir);
    this.updateStagingDir = options.updateStagingDir || storageLayout.updateStagingDir(this.configDir);
  }

  currentVersion() {
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

  currentInstallState() {
    const persisted = readJsonFile(this.updateStateFile);
    if (persisted && persisted.method === this.installMethod) return persisted;
    const current = this.currentVersion();
    const currentVersion = normalizeVersion(current.releaseVersion || current.packageVersion);
    if (
      persisted
      && persisted.targetMethod === this.installMethod
      && normalizeVersion(persisted.version) === currentVersion
    ) {
      return persisted;
    }
    return this.installState;
  }

  persistInstallState(state) {
    this.installState = state;
    fs.mkdirSync(this.configDir, { recursive: true });
    const temporaryPath = `${this.updateStateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.updateStateFile);
    return state;
  }

  async npmMetadata(options = {}) {
    const source = npmPackageMetadataUrl(this.npmRegistryUrl, this.npmPackageName);
    if (!options.force && this.npmCache && this.npmCache.source === source && this.now() - this.npmCache.checkedAt < CACHE_TTL_MS) {
      return this.npmCache.metadata;
    }
    const metadata = await this.fetchJson(source, { accept: 'application/json' });
    this.npmCache = { checkedAt: this.now(), source, metadata };
    return metadata;
  }

  async npmStatus(options = {}) {
    const current = this.currentVersion();
    const currentVersion = normalizeVersion(current.releaseVersion || current.packageVersion);
    const metadata = await this.npmMetadata(options);
    const target = await this.npmUpdateTarget();
    const versions = npmVersionsFromMetadata(metadata, currentVersion);
    const latestVersion = normalizeVersion(metadata && metadata['dist-tags'] && metadata['dist-tags'].latest)
      || versions[0]?.version
      || '';
    const requestedVersion = normalizeVersion(options.assetName);
    const selected = versions.find(version => version.version === requestedVersion)
      || versions.find(version => version.version === latestVersion)
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
      },
      versions,
      runtime: this.runtime,
      target,
      available,
      installable: Boolean(selected && target.proven),
      checkedAt: new Date(this.now()).toISOString(),
      state: this.currentInstallState(),
    };
  }

  async npmUpdateTarget() {
    const runningPackageRoot = String(this.npmPackageRoot || '').trim();
    if (!path.isAbsolute(runningPackageRoot)) {
      return {
        proven: false,
        error: 'npm update target could not be proven: the running package has no managed package-root provenance',
      };
    }
    const npmCommand = process.env.FARMING_NPM_COMMAND || 'npm';
    const npmPrefix = this.npmPrefix || npmPrefixForPackageRoot(runningPackageRoot, this.npmPackageName);
    if (!npmPrefix) {
      return {
        proven: false,
        error: 'npm update target could not be proven: the running package has no npm prefix',
      };
    }
    try {
      const root = await this.getNpmGlobalRoot(npmCommand, npmPrefix);
      const targetPackageRoot = npmPackageRoot(root, this.npmPackageName);
      if (normalizePathForCompare(runningPackageRoot) !== normalizePathForCompare(targetPackageRoot)) {
        return {
          proven: false,
          error: `npm update would target a different installation: running ${runningPackageRoot}; npm ${targetPackageRoot}`,
        };
      }
      return {
        proven: true,
        npmPrefix,
        packageRoot: targetPackageRoot,
      };
    } catch (error) {
      return {
        proven: false,
        error: `npm update target could not be inspected: ${error.message || String(error)}`,
      };
    }
  }

  unsupportedStatus() {
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
      state: this.currentInstallState(),
    };
  }

  async check(options = {}) {
    if (this.installMethod === 'npm') return this.npmStatus(options);
    return this.unsupportedStatus();
  }

  async startInstall(options = {}) {
    if (this.installStartPromise) return this.installStartPromise;
    const startPromise = this.startInstallUnreserved(options);
    this.installStartPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.installStartPromise === startPromise) this.installStartPromise = null;
    }
  }

  async startInstallUnreserved(options = {}) {
    const currentState = this.currentInstallState();
    if (['downloading', 'extracting', 'installing', 'restarting', 'rolling-back'].includes(currentState.phase)) {
      return currentState;
    }
    if (currentState.phase === 'ready-to-restart') return currentState;

    if (this.installMethod === 'npm') return this.startNpmInstall(options);
    throw new Error(installMethodBlockedReason(this.installMethod));
  }

  async startNpmInstall(options = {}) {
    const status = await this.npmStatus({ force: true, assetName: options.assetName });
    if (!status.available) {
      return this.persistInstallState({
        method: 'npm',
        phase: status.installable ? 'succeeded' : 'failed',
        version: status.selected.version,
        error: status.installable ? '' : (status.selected.blockedReason || 'No installable npm update is available'),
        completedAt: new Date(this.now()).toISOString(),
      });
    }

    const startedAt = new Date(this.now()).toISOString();
    fs.mkdirSync(this.updateStagingDir, { recursive: true });
    const stagingPrefix = fs.mkdtempSync(path.join(this.updateStagingDir, `npm-${status.selected.version}.`));
    const stagingPackageRoot = npmPackageRoot(
      path.join(stagingPrefix, 'lib', 'node_modules'),
      this.npmPackageName,
    );
    const state = this.persistInstallState({
      method: 'npm',
      phase: 'installing',
      version: status.selected.version,
      previousVersion: status.current.releaseVersion || status.current.packageVersion,
      packageName: this.npmPackageName,
      stagingPrefix,
      stagingPackageRoot,
      startedAt,
      logPath: this.updateLogFile,
    });
    const helperPath = path.join(__dirname, 'npm-update-helper.js');
    const nodePath = process.env.FARMING_NODE_BIN || process.execPath;
    const payload = {
      action: 'prepare',
      packageName: this.npmPackageName,
      targetVersion: status.selected.version,
      previousVersion: status.current.releaseVersion || status.current.packageVersion,
      startedAt,
      stateFile: this.updateStateFile,
      logPath: this.updateLogFile,
      cliPath: path.join(this.rootDir, 'bin', 'farming'),
      packageRoot: status.target.packageRoot,
      nodePath,
      npmCommand: process.env.FARMING_NPM_COMMAND || 'npm',
      npmPrefix: status.target.npmPrefix,
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
    const spawnOptions = {
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
    } catch (error) {
      fs.rmSync(stagingPrefix, { recursive: true, force: true });
      this.persistInstallState({
        ...state,
        phase: 'failed',
        error: error.message || String(error),
        completedAt: new Date(this.now()).toISOString(),
      });
      throw error;
    }
    if (child && typeof child.once === 'function') {
      child.once('error', (error) => {
        fs.rmSync(stagingPrefix, { recursive: true, force: true });
        this.persistInstallState({
          ...state,
          phase: 'failed',
          error: error.message || String(error),
          completedAt: new Date(this.now()).toISOString(),
        });
      });
    }
    if (child && typeof child.unref === 'function') child.unref();
    return state;
  }

  async applyPreparedUpdate() {
    if (this.installStartPromise) return this.installStartPromise;
    const applyPromise = this.applyPreparedUpdateUnreserved();
    this.installStartPromise = applyPromise;
    try {
      return await applyPromise;
    } finally {
      if (this.installStartPromise === applyPromise) this.installStartPromise = null;
    }
  }

  async applyPreparedUpdateUnreserved() {
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
    if (!path.isAbsolute(String(prepared.stagingPrefix || '')) || !path.isAbsolute(String(prepared.stagingPackageRoot || ''))) {
      throw new Error('Prepared npm update is missing its staging identity');
    }
    const stagingPrefix = normalizePathForCompare(prepared.stagingPrefix);
    if (!pathIsInside(normalizePathForCompare(this.updateStagingDir), stagingPrefix)) {
      throw new Error('Prepared npm update is outside the Farming staging directory');
    }
    if (path.resolve(prepared.stagingPackageRoot) !== path.resolve(npmPackageRoot(
      path.join(prepared.stagingPrefix, 'lib', 'node_modules'),
      this.npmPackageName,
    ))) {
      throw new Error('Prepared npm update has an invalid package root');
    }
    const stagingPackageRoot = normalizePathForCompare(prepared.stagingPackageRoot);
    const stagedMetadata = readJsonFile(path.join(stagingPackageRoot, 'package.json')) || {};
    if (normalizeVersion(stagedMetadata.version) !== normalizeVersion(prepared.version)) {
      throw new Error('Prepared npm update is no longer available; prepare it again');
    }
    const helperPath = path.join(__dirname, 'npm-update-helper.js');
    const payload = {
      action: 'apply',
      packageName: this.npmPackageName,
      targetVersion: prepared.version,
      previousVersion: prepared.previousVersion,
      startedAt: prepared.startedAt,
      preparedAt: prepared.preparedAt,
      stateFile: this.updateStateFile,
      logPath: prepared.logPath || this.updateLogFile,
      cliPath: path.join(this.rootDir, 'bin', 'farming'),
      packageRoot: target.packageRoot,
      nodePath,
      npmCommand: process.env.FARMING_NPM_COMMAND || 'npm',
      npmPrefix: target.npmPrefix,
      npmFallbackRegistryUrl: this.npmRegistryUrl,
      stagingPrefix,
      stagingPackageRoot,
      serverPid: process.pid,
      serverProcessIdentity,
      configDir: this.configDir,
      port: process.env.FARMING_PORT || process.env.PORT || '6694',
      basePath: process.env.FARMING_BASE_PATH || '/farming',
      serverHome: process.env.FARMING_SERVER_HOME || '',
      disableAuth: /^(1|true|yes|on)$/i.test(String(process.env.FARMING_DISABLE_AUTH || '')),
    };
    const env = { ...process.env, FARMING_NPM_UPDATE_PAYLOAD: JSON.stringify(payload) };

    const state = this.persistInstallState({ ...prepared, phase: 'restarting', error: '' });
    const helperInvocation = nodeScriptInvocation(nodePath, helperPath);
    const spawnOptions = {
      cwd: this.configDir,
      detached: true,
      stdio: 'ignore',
      env,
    };
    const restorePreparedState = (error) => this.persistInstallState({
      ...prepared,
      phase: 'ready-to-restart',
      error: error.message || String(error),
    });
    let child;
    try {
      child = this.spawn(helperInvocation.command, helperInvocation.args, spawnOptions);
    } catch (error) {
      restorePreparedState(error);
      throw error;
    }
    if (child && typeof child.once === 'function') child.once('error', restorePreparedState);
    if (child && typeof child.unref === 'function') child.unref();
    return state;
  }

}

module.exports = {
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
