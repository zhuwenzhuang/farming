const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const tar = require('tar');
const storageLayout = require('./storage-layout');
const { runtimeExecutableInvocation } = require('./runtime-executable-invocation');

const MANIFEST = require('./data/runtime-dependency-manifest.json');
const SOURCE_CONFIG = require('./data/runtime-dependency-sources.json');
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MIRROR_LOOKUP_TIMEOUT_MS = 3_000;
const LOCK_TIMEOUT_MS = 180_000;
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 100;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUTHORITATIVE_NPM_ORIGIN = new URL(SOURCE_CONFIG.authoritativeNpmRegistry).origin;

const DEPENDENCIES = Object.freeze([
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeSegment(value, label) {
  const text = String(value || '').trim();
  if (!SAFE_SEGMENT.test(text) || text === '.' || text === '..') {
    throw new Error(`Invalid runtime dependency ${label}`);
  }
  return text;
}

function safeRelative(value, label = 'entry') {
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

function isMuslRuntime() {
  if (process.platform !== 'linux') return false;
  if (process.report?.getReport) {
    const report = /** @type {any} */ (process.report.getReport());
    if (report?.header?.glibcVersionRuntime) return false;
  }
  return true;
}

function runtimePlatformKey(options = {}) {
  const platform = safeSegment(options.platform || process.platform, 'platform');
  const arch = safeSegment(options.arch || process.arch, 'architecture');
  if (options.platformKey) return safeSegment(options.platformKey, 'platform key');
  const musl = options.musl ?? (platform === process.platform && isMuslRuntime());
  return platform === 'linux' && musl ? `${platform}-${arch}-musl` : `${platform}-${arch}`;
}

function dependencyCacheDir(configDir, id, version, platformKey) {
  return path.join(
    storageLayout.runtimeDependenciesDir(configDir),
    safeSegment(id, 'id'),
    safeSegment(version, 'version'),
    safeSegment(platformKey, 'platform key'),
  );
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseIntegrity(integrity) {
  const match = String(integrity || '').match(/^(sha256|sha512)-([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Runtime artifact integrity must use sha256 or sha512 SRI');
  return { algorithm: match[1], digest: Buffer.from(match[2], 'base64') };
}

function which(command, env = process.env) {
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

function semanticVersion(output) {
  return String(output || '').match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] || '';
}

async function verifyExecutable(executablePath, expectedVersion, options = {}) {
  const exec = options.execFile || execFile;
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
    exec(invocation.command, invocation.args, {
      encoding: 'utf8',
      timeout: options.timeoutMs || 5_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: options.env || process.env,
    }, (error, stdout, stderr) => {
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

function explicitCandidate(dependency, env) {
  for (const key of dependency.envKeys) {
    const value = String(env[key] || '').trim();
    if (value) return { path: path.resolve(value), key };
  }
  return null;
}

function systemCandidates(dependency, env) {
  const explicit = explicitCandidate(dependency, env);
  if (explicit) return [explicit];
  return dependency.commands
    .map(command => which(command, env))
    .filter(Boolean)
    .map(candidate => ({ path: path.resolve(candidate), key: '' }));
}

function resolutionEnvironment(env) {
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

function managedRuntimeUsesConfiguredLoader(id) {
  return id === 'agentBrowser';
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

function processRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM' || error?.code === 'EACCES';
  }
}

async function acquirePrepareLock(configDir, options = {}) {
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
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        if (error?.code === 'ENOENT') {
          fs.mkdirSync(path.dirname(lockDir), { recursive: true });
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

function npmArtifactIdentity(artifactUrl) {
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

function configuredRuntimeNpmMirror(env) {
  if (Object.prototype.hasOwnProperty.call(env, 'FARMING_RUNTIME_NPM_MIRROR')) {
    const configured = String(env.FARMING_RUNTIME_NPM_MIRROR || '').trim();
    if (!configured || /^(0|false|none|off)$/i.test(configured)) return '';
    return configured;
  }
  return String(SOURCE_CONFIG.defaultNpmMirror || '').trim();
}

async function runtimeArtifactDownloadUrls(artifact, options = {}) {
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
    const response = await (options.fetch || fetch)(metadataUrl, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return [authoritative.href];
    const metadata = await response.json();
    if (metadata?.version !== version || metadata?.dist?.integrity !== artifact.integrity) {
      return [authoritative.href];
    }
    const mirrored = new URL(metadata.dist.tarball);
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

async function downloadArtifactFromUrl(artifact, url, destination, options = {}) {
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
    const response = await (options.fetch || fetch)(url, {
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Runtime download failed with HTTP ${response.status}`);
    }
    const expectedSize = Number(artifact.size) || 0;
    const limit = expectedSize || MAX_DOWNLOAD_BYTES;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > limit) {
          callback(new Error(`Runtime download exceeded ${limit} bytes`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
    if (expectedSize && received !== expectedSize) {
      throw new Error(`Runtime download size mismatch: expected ${expectedSize}, received ${received}`);
    }
    if (!crypto.timingSafeEqual(hash.digest(), digest)) {
      throw new Error('Runtime artifact failed integrity verification');
    }
  } catch (error) {
    fs.rmSync(destination, { force: true });
    if (error?.name === 'AbortError') throw new Error('Runtime download timed out', { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadArtifact(artifact, destination, options = {}) {
  const urls = await runtimeArtifactDownloadUrls(artifact, options);
  for (const [index, url] of urls.entries()) {
    try {
      await downloadArtifactFromUrl(artifact, url, destination, options);
      return;
    } catch (error) {
      if (index === urls.length - 1) throw error;
      console.warn(
        `Runtime npm mirror download failed; retrying the authoritative npm registry: ${error.message}`,
      );
    }
  }
}

async function extractArtifact(artifact, archivePath, stagingDir) {
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

function dependencyManifest(id, platformKey) {
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

async function resolveCachedRuntime(configDir, id, platformKey, options = {}) {
  const { dependency, artifact } = dependencyManifest(id, platformKey);
  const cacheDir = dependencyCacheDir(configDir, id, dependency.version, platformKey);
  const record = readJson(path.join(cacheDir, 'runtime.json'));
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
        useConfiguredLoader: managedRuntimeUsesConfiguredLoader(id),
      },
    );
    if (!verification.valid) return null;
  }
  return { id, version: dependency.version, source: 'managed', executablePath };
}

async function findExactRuntime(configDir, definition, platformKey, env) {
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
  return resolveCachedRuntime(configDir, definition.id, platformKey, { env });
}

async function installExactRuntime(configDir, definition, platformKey, options = {}) {
  const { dependency, artifact } = dependencyManifest(definition.id, platformKey);
  const cacheDir = dependencyCacheDir(configDir, definition.id, dependency.version, platformKey);
  const stagingDir = `${cacheDir}.preparing-${process.pid}-${crypto.randomUUID()}`;
  const archivePath = path.join(stagingDir, 'artifact.download');
  const quarantine = `${cacheDir}.invalid-${Date.now()}-${crypto.randomUUID()}`;
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  try {
    await downloadArtifact(artifact, archivePath, options);
    const executablePath = await extractArtifact(artifact, archivePath, stagingDir);
    if (!fs.existsSync(executablePath)) throw new Error(`${definition.id} archive omitted ${artifact.entry}`);
    fs.chmodSync(executablePath, 0o700);
    if (dependency.managedProbe !== false) {
      const verification = await verifyExecutable(
        executablePath,
        dependency.reportedVersion || dependency.version,
        {
          args: dependency.probe?.args,
          env: options.env,
          useConfiguredLoader: managedRuntimeUsesConfiguredLoader(definition.id),
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
    } catch (error) {
      if (hadCache && !fs.existsSync(cacheDir) && fs.existsSync(quarantine)) {
        fs.renameSync(quarantine, cacheDir);
      }
      throw error;
    }
    fs.rmSync(quarantine, { recursive: true, force: true });
  } catch (error) {
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

function applyRuntimeEnvironment(env, prepared) {
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
  }
  env.FARMING_RUNTIME_MANIFEST_ID = MANIFEST.manifestId;
  return env;
}

async function prepareRuntimeDependencies(options = {}) {
  const env = options.env || process.env;
  const candidateEnv = resolutionEnvironment(env);
  const configDir = options.configDir || storageLayout.farmingConfigDir(env);
  const platformKey = runtimePlatformKey(options);
  fs.mkdirSync(storageLayout.runtimeDependenciesDir(configDir), { recursive: true });
  const releaseLock = await acquirePrepareLock(configDir, options);
  const prepared = [];
  try {
    for (const definition of DEPENDENCIES) {
      let runtime = await findExactRuntime(configDir, definition, platformKey, candidateEnv);
      if (!runtime) {
        const installRuntime = options.installRuntime || installExactRuntime;
        runtime = await installRuntime(configDir, definition, platformKey, options);
      }
      prepared.push(runtime);
    }
    applyRuntimeEnvironment(env, prepared);
    writeJsonAtomic(storageLayout.runtimeDependenciesActiveFile(configDir), {
      schemaVersion: 1,
      manifestId: MANIFEST.manifestId,
      platformKey,
      dependencies: Object.fromEntries(prepared.map(item => [item.id, {
        version: item.version,
        source: item.source,
        executablePath: item.executablePath,
      }])),
      preparedAt: new Date().toISOString(),
    });
    return { manifestId: MANIFEST.manifestId, platformKey, dependencies: prepared };
  } finally {
    releaseLock();
  }
}

async function pruneRuntimeDependencies(options = {}) {
  const env = options.env || process.env;
  const configDir = options.configDir || storageLayout.farmingConfigDir(env);
  const active = readJson(storageLayout.runtimeDependenciesActiveFile(configDir));
  if (!active || active.manifestId !== MANIFEST.manifestId) return { removed: [] };
  const platformKey = safeSegment(active.platformKey, 'platform key');
  const releaseLock = await acquirePrepareLock(configDir, options);
  const removed = [];
  try {
    const latest = readJson(storageLayout.runtimeDependenciesActiveFile(configDir));
    if (!latest || latest.manifestId !== MANIFEST.manifestId) return { removed };
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
      const activeDependency = latest.dependencies?.[definition.id];
      const keepDir = activeDependency?.source === 'managed'
        ? dependencyCacheDir(
            configDir,
            definition.id,
            MANIFEST.dependencies[definition.id].version,
            platformKey,
          )
        : '';
      const keepVersionDir = keepDir ? path.dirname(keepDir) : '';
      for (const versionEntry of fs.readdirSync(dependencyRoot, { withFileTypes: true })) {
        const versionDir = path.join(dependencyRoot, versionEntry.name);
        if (
          !versionEntry.isDirectory()
          || !keepDir
          || path.resolve(versionDir) !== path.resolve(keepVersionDir)
        ) {
          fs.rmSync(versionDir, { recursive: true, force: true });
          removed.push(versionDir);
          continue;
        }
        for (const platformEntry of fs.readdirSync(versionDir, { withFileTypes: true })) {
          const platformDir = path.join(versionDir, platformEntry.name);
          if (
            platformEntry.isDirectory()
            && path.resolve(platformDir) === path.resolve(keepDir)
          ) continue;
          fs.rmSync(platformDir, { recursive: true, force: true });
          removed.push(platformDir);
        }
      }
      if (fs.readdirSync(dependencyRoot).length === 0) fs.rmdirSync(dependencyRoot);
    }
    return { removed };
  } finally {
    releaseLock();
  }
}

module.exports = {
  DEPENDENCIES,
  MANIFEST,
  SOURCE_CONFIG,
  applyRuntimeEnvironment,
  dependencyCacheDir,
  downloadArtifact,
  extractArtifact,
  managedRuntimeUsesConfiguredLoader,
  prepareRuntimeDependencies,
  pruneRuntimeDependencies,
  runtimeArtifactDownloadUrls,
  runtimePlatformKey,
  verifyExecutable,
};
