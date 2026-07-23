const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  ccStatisticsRuntimeDir,
  ccStatisticsUsageCacheFile,
} = require('./storage-layout');

const SOURCE_ROOT = path.join(__dirname, 'vendor', 'cc-statistics');
const VENDOR_METADATA = require('./vendor/cc-statistics/VENDOR.json');
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETENTION_DAYS = 52 * 7;
const DEFAULT_RECENT_RAW_MS = 24 * 60 * 60 * 1000;
const RESULT_REUSE_MS = 2_000;

function pythonCandidates() {
  const configured = String(process.env.FARMING_CC_STATISTICS_PYTHON || '').trim();
  return Array.from(new Set([
    configured,
    process.platform === 'win32' ? 'python.exe' : 'python3',
    process.platform === 'win32' ? 'py.exe' : 'python',
  ].filter(Boolean)));
}

async function buffersEqual(leftPath, rightPath) {
  try {
    const [left, right] = await Promise.all([
      fsp.readFile(leftPath),
      fsp.readFile(rightPath),
    ]);
    return left.equals(right);
  } catch {
    return false;
  }
}

async function copyTreeAtomic(sourceDir, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyTreeAtomic(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || await buffersEqual(sourcePath, targetPath)) continue;
    await fsp.copyFile(sourcePath, targetPath);
  }
}

async function upstreamFiles(rootDir, relativeDir = '') {
  const directory = path.join(rootDir, relativeDir);
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    const relativePath = path.posix.join(
      relativeDir.split(path.sep).join('/'),
      entry.name,
    );
    if (entry.isDirectory()) {
      files.push(...await upstreamFiles(rootDir, relativePath));
      continue;
    }
    if (
      entry.isFile()
      && ![
        '.gitignore',
        'VENDOR.json',
        'farming_usage_cli.py',
        'cc_stats/farming_usage.py',
      ].includes(relativePath)
    ) {
      files.push(relativePath);
    }
  }
  return files;
}

async function verifyUpstreamTree(sourceRoot) {
  const digest = crypto.createHash('sha256');
  const files = (await upstreamFiles(sourceRoot)).sort();
  for (const relativePath of files) {
    digest.update(relativePath);
    digest.update('\0');
    digest.update(await fsp.readFile(path.join(sourceRoot, relativePath)));
    digest.update('\0');
  }
  const actual = digest.digest('hex');
  if (actual !== VENDOR_METADATA.upstreamTreeSha256) {
    throw new Error(
      `Vendored cc-statistics integrity mismatch: expected ${VENDOR_METADATA.upstreamTreeSha256}, got ${actual}`,
    );
  }
}

async function resolveRuntimeRoot(configDir) {
  await verifyUpstreamTree(SOURCE_ROOT);
  if (!process.pkg && process.env.FARMING_PACKAGED_RUNTIME !== '1') {
    return SOURCE_ROOT;
  }
  const adapterDigest = crypto.createHash('sha256')
    .update(await fsp.readFile(path.join(SOURCE_ROOT, 'farming_usage_cli.py')))
    .update(await fsp.readFile(path.join(SOURCE_ROOT, 'cc_stats', 'farming_usage.py')))
    .digest('hex')
    .slice(0, 12);
  const revision = `${VENDOR_METADATA.commit.slice(0, 12)}-${adapterDigest}`;
  const runtimeRoot = ccStatisticsRuntimeDir(configDir, revision);
  const markerPath = path.join(runtimeRoot, '.complete');
  try {
    await fsp.access(markerPath);
    return runtimeRoot;
  } catch {
    // Extract the immutable revision below.
  }
  const temporaryRoot = `${runtimeRoot}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
  await copyTreeAtomic(SOURCE_ROOT, temporaryRoot);
  await fsp.writeFile(path.join(temporaryRoot, '.complete'), `${revision}\n`);
  try {
    await fsp.rename(temporaryRoot, runtimeRoot);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
    await fsp.access(markerPath);
  }
  return runtimeRoot;
}

function runPython(python, scriptPath, request, options = {}) {
  return new Promise((resolve, reject) => {
    const args = python.toLowerCase().endsWith('py.exe')
      ? ['-3', scriptPath]
      : [scriptPath];
    const child = spawn(python, args, {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      const error = new Error(`cc-statistics exceeded ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms`);
      error.code = 'ETIMEDOUT';
      finish(error);
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    timeout.unref?.();

    child.once('error', finish);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > (options.maxOutputBytes || 256 * 1024 * 1024)) {
        child.kill();
        const error = new Error('cc-statistics result exceeded the bounded output limit');
        error.code = 'EMSGSIZE';
        finish(error);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        const error = new Error(detail || `cc-statistics exited with code ${code}`);
        error.code = 'ECCSTATISTICS';
        finish(error);
        return;
      }
      try {
        finish(null, JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch (cause) {
        const error = new Error('cc-statistics returned invalid JSON', { cause });
        error.code = 'EBADMSG';
        finish(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function probePython(python, options = {}) {
  return new Promise((resolve, reject) => {
    const check = 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 42)';
    const args = python.toLowerCase().endsWith('py.exe')
      ? ['-3', '-c', check]
      : ['-c', check];
    const child = spawn(python, args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      const error = new Error(`Python version probe exceeded ${options.timeoutMs || 5_000}ms`);
      error.code = 'ETIMEDOUT';
      finish(error);
    }, options.timeoutMs || 5_000);
    timeout.unref?.();
    child.once('error', finish);
    child.once('close', code => {
      if (code === 0) {
        finish();
        return;
      }
      const error = new Error(
        code === 42
          ? `${python} is older than Python 3.10`
          : `${python} failed the Python 3.10 runtime probe`,
      );
      error.code = 'EPYTHONVERSION';
      finish(error);
    });
  });
}

class CCStatisticsClient {
  constructor(options = {}) {
    this.configDir = options.configDir;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.runner = options.runner || runPython;
    this.probe = options.probe || probePython;
    this.python = options.python || '';
    this.pythonVerified = false;
    this.pending = null;
    this.cached = null;
    this.cachedAt = 0;
    this.cacheKey = '';
  }

  async invoke(request) {
    const runtimeRoot = await resolveRuntimeRoot(this.configDir);
    const scriptPath = path.join(runtimeRoot, 'farming_usage_cli.py');
    const candidates = this.python ? [this.python] : pythonCandidates();
    let lastError = null;
    for (const candidate of candidates) {
      const alreadyVerified = this.pythonVerified && candidate === this.python;
      try {
        if (!alreadyVerified) await this.probe(candidate);
      } catch (error) {
        lastError = error;
        continue;
      }
      this.python = candidate;
      this.pythonVerified = true;
      try {
        return await this.runner(candidate, scriptPath, request, {
          timeoutMs: this.timeoutMs,
        });
      } catch (error) {
        if (alreadyVerified && ['ENOENT', 'EACCES'].includes(error?.code)) {
          this.python = '';
          this.pythonVerified = false;
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    const error = new Error(
      'cc-statistics requires Python 3.10 or newer; no usable Python runtime was found.',
      { cause: lastError },
    );
    error.code = 'ENOENT';
    throw error;
  }

  collect(options = {}) {
    const now = options.now ?? Date.now();
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const roots = {
      codex: Array.from(new Set(options.codexRoots || [])).sort(),
      claude: Array.from(new Set(options.claudeRoots || [])).sort(),
    };
    const cacheKey = JSON.stringify({ roots, retentionDays });
    if (
      options.fresh !== true
      && this.cached
      && this.cacheKey === cacheKey
      && now - this.cachedAt <= RESULT_REUSE_MS
    ) {
      return Promise.resolve(this.cached);
    }
    if (this.pending && this.cacheKey === cacheKey) return this.pending;
    this.cacheKey = cacheKey;
    const request = {
      cacheFile: ccStatisticsUsageCacheFile(this.configDir),
      nowMs: now,
      retentionDays,
      recentRawMs: options.recentRawMs ?? DEFAULT_RECENT_RAW_MS,
      roots,
    };
    const pending = this.invoke(request).then(result => {
      this.cached = result;
      this.cachedAt = now;
      return result;
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
}

module.exports = {
  CCStatisticsClient,
  DEFAULT_RECENT_RAW_MS,
  DEFAULT_RETENTION_DAYS,
  resolveRuntimeRoot,
  runPython,
  probePython,
  verifyUpstreamTree,
};
