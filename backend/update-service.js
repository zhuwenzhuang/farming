const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

const CACHE_TTL_MS = 5 * 60 * 1000;
const UPDATE_SOURCE_UNCONFIGURED_REASON = 'Update source is not configured. Set FARMING_UPDATE_MANIFEST_URL to enable in-app upgrades.';

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

function releaseVersionFromRelease(release) {
  return normalizeVersion(release && (release.tag_name || release.name));
}

function releaseVersionFromManifest(manifest) {
  if (!manifest) return '';
  if (manifest.version) return normalizeVersion(manifest.version);
  if (manifest.releaseVersion) return normalizeVersion(manifest.releaseVersion);
  if (manifest.tag) return normalizeVersion(manifest.tag);
  const assets = manifestAssets(manifest);
  const appBundle = assets.find(asset => asset && asset.type === 'app-bundle') || assets[0];
  return normalizeVersion(appBundle && (appBundle.releaseVersion || appBundle.file || appBundle.name));
}

function releaseTagFromManifest(manifest) {
  const tag = String(manifest && manifest.tag || '').trim();
  if (tag) return tag;
  const version = releaseVersionFromManifest(manifest);
  return version ? `v${version}` : '';
}

function isAbsoluteHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function resolveUpdateUrl(value, baseUrl = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isAbsoluteHttpUrl(raw)) return raw;
  if (!baseUrl) return '';
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return '';
  }
}

function basenameFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = isAbsoluteHttpUrl(raw) ? new URL(raw) : new URL(raw, 'http://farming.local/');
    const pathname = parsed.pathname || '';
    return pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return raw.split('/').filter(Boolean).pop() || '';
  }
}

function manifestAssets(manifest) {
  if (Array.isArray(manifest && manifest.assets)) return manifest.assets;
  const tarUrl = manifest && (manifest.tarUrl || manifest.downloadUrl || manifest.url);
  const file = manifest && (manifest.file || manifest.name || basenameFromUrl(tarUrl));
  if (!tarUrl && !file) return [];
  return [{
    type: 'app-bundle',
    file,
    url: tarUrl,
    size: manifest.size || manifest.bytes || 0,
    sha256: manifest.sha256 || '',
    bundledGlibc: manifest.bundledGlibc,
    releaseVersion: manifest.releaseVersion || manifest.version || '',
  }];
}

function releaseFromManifest(manifest, options = {}) {
  const tag = releaseTagFromManifest(manifest);
  const assetBaseUrl = options.assetBaseUrl || options.manifestUrl || '';
  const assets = manifestAssets(manifest);
  return {
    __manifest: manifest,
    tag_name: tag,
    name: manifest && manifest.name ? String(manifest.name) : tag,
    published_at: manifest && (manifest.publishedAt || manifest.builtAt) ? String(manifest.publishedAt || manifest.builtAt) : '',
    assets: assets
      .map(asset => {
        const file = String(asset && (asset.file || asset.name) || '');
        if (!file) return null;
        return {
          ...asset,
          name: file,
          size: asset.size || asset.bytes || 0,
          browser_download_url: asset.browser_download_url
            || resolveUpdateUrl(asset.downloadUrl || asset.url || file, assetBaseUrl),
        };
      })
      .filter(asset => asset && asset.browser_download_url),
  };
}

function selectReleaseAsset(release, patternText = '') {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  if (patternText) {
    const pattern = new RegExp(patternText);
    const matched = assets.find(asset => pattern.test(String(asset.name || '')) && asset.browser_download_url);
    if (matched) return matched;
  }

  return assets.find(asset => (
    /^farming[-_].*\.tar\.gz$/i.test(String(asset.name || '')) &&
    !/(sha256|checksum|checksums|glibc)/i.test(String(asset.name || '')) &&
    asset.browser_download_url
  )) || null;
}

function selectManifestAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  return assets.find(asset => (
    String(asset.name || '').toLowerCase() === 'manifest.json' &&
    asset.browser_download_url
  )) || null;
}

function manifestAssetSafety(asset, manifest, allowUnbundledGlibc = false) {
  if (!asset) {
    return {
      safe: false,
      bundledGlibc: false,
      reason: 'Update manifest has no app bundle asset',
    };
  }
  if (allowUnbundledGlibc) {
    return { safe: true, bundledGlibc: null, reason: '' };
  }
  const assets = manifestAssets(manifest);
  if (assets.length === 0) {
    return {
      safe: false,
      bundledGlibc: false,
      reason: 'Update manifest is missing bundled glibc metadata',
    };
  }

  const assetName = String(asset.name || '');
  const entry = assets.find(item => String(item.file || item.name || basenameFromUrl(item.url || item.tarUrl || item.downloadUrl) || '') === assetName);
  if (!entry) {
    return {
      safe: false,
      bundledGlibc: false,
      reason: 'Update manifest does not describe the app bundle',
    };
  }
  if (entry.type && entry.type !== 'app-bundle') {
    return {
      safe: false,
      bundledGlibc: false,
      reason: 'Update manifest does not mark the app bundle correctly',
    };
  }
  if (entry.bundledGlibc === false) {
    return {
      safe: false,
      bundledGlibc: false,
      reason: 'Update manifest app bundle does not declare bundled glibc',
    };
  }
  return { safe: true, bundledGlibc: entry.bundledGlibc === true ? true : null, reason: '' };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function requestWithRedirects(url, options = {}, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`too many redirects for ${url}`));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const headers = {
      'User-Agent': 'Farming-Update-Check',
      Accept: options.accept || 'application/json',
      ...(options.headers || {}),
    };
    if (options.authToken) {
      headers.Authorization = `Bearer ${options.authToken}`;
    }

    const request = client.get(parsed, { headers }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const nextUrl = new URL(location, parsed).toString();
        requestWithRedirects(nextUrl, options, redirectCount + 1).then(resolve, reject);
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

async function downloadFile(url, outputPath, options = {}) {
  const response = await requestWithRedirects(url, {
    ...options,
    accept: 'application/octet-stream',
  });
  await pipeline(response, fs.createWriteStream(outputPath));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function findReleaseDirectory(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const directory = entries.find(entry => entry.isDirectory());
  if (!directory) {
    throw new Error('downloaded release archive did not contain a directory');
  }
  return path.join(rootDir, directory.name);
}

function releaseInstallDir(rootDir, env = process.env) {
  if (env.FARMING_INSTALL_DIR) return env.FARMING_INSTALL_DIR;
  if (fs.existsSync(path.join(rootDir, '.farming.pid')) || fs.existsSync(path.join(rootDir, 'RELEASE.json'))) {
    return rootDir;
  }
  return path.join(os.homedir(), 'farming');
}

function releaseHasBundledGlibc(releaseDir) {
  const release = readJsonFile(path.join(releaseDir, 'RELEASE.json')) || {};
  return release.bundledGlibc === true &&
    fs.existsSync(path.join(releaseDir, 'vendor', 'glibc228-lib.tar.gz'));
}

class FarmingUpdateService {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(__dirname, '..');
    this.manifestUrl = options.manifestUrl || process.env.FARMING_UPDATE_MANIFEST_URL || '';
    this.assetBaseUrl = options.assetBaseUrl || process.env.FARMING_UPDATE_ASSET_BASE_URL || '';
    this.assetPattern = options.assetPattern || process.env.FARMING_UPDATE_ASSET_PATTERN || '';
    this.authToken = options.authToken || process.env.FARMING_UPDATE_AUTH_TOKEN || '';
    this.allowUnbundledGlibc = options.allowUnbundledGlibc === true ||
      /^(1|true|TRUE|yes|YES|on|ON)$/.test(process.env.FARMING_UPDATE_ALLOW_UNBUNDLED_GLIBC || '');
    this.configDir = options.configDir || path.join(os.homedir(), '.farming');
    this.now = options.now || (() => Date.now());
    this.fetchJson = options.fetchJson || requestJson;
    this.downloadFile = options.downloadFile || downloadFile;
    this.execFile = options.execFile || childProcess.execFile;
    this.spawn = options.spawn || childProcess.spawn;
    this.latestCache = null;
    this.installState = { phase: 'idle' };
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
      type: release.type || (fs.existsSync(path.join(this.rootDir, 'RELEASE.json')) ? 'app-bundle' : 'source'),
      installDir: releaseInstallDir(this.rootDir),
    };
  }

  async latestRelease(options = {}) {
    if (!this.manifestUrl) return null;
    if (!options.force && this.latestCache && this.now() - this.latestCache.checkedAt < CACHE_TTL_MS) {
      return this.latestCache.release;
    }
    const manifest = await this.fetchJson(this.manifestUrl, {
      accept: 'application/json',
      authToken: this.authToken,
    });
    const release = releaseFromManifest(manifest, {
      manifestUrl: this.manifestUrl,
      assetBaseUrl: this.assetBaseUrl,
    });
    this.latestCache = {
      checkedAt: this.now(),
      release,
    };
    return release;
  }

  async latestManifest(release) {
    if (release && release.__manifest) return release.__manifest;
    const asset = selectManifestAsset(release);
    if (!asset) return null;
    try {
      return await this.fetchJson(asset.browser_download_url, {
        authToken: this.authToken,
      });
    } catch {
      return null;
    }
  }

  statusFromRelease(release, manifest = null) {
    const current = this.currentVersion();
    const latestVersion = releaseVersionFromRelease(release);
    const comparableCurrentVersion = normalizeVersion(current.releaseVersion || current.packageVersion);
    const asset = selectReleaseAsset(release, this.assetPattern);
    const configured = Boolean(this.manifestUrl);
    const safety = configured
      ? manifestAssetSafety(asset, manifest, this.allowUnbundledGlibc)
      : { safe: false, bundledGlibc: false, reason: UPDATE_SOURCE_UNCONFIGURED_REASON };
    const newer = Boolean(asset && latestVersion && compareVersions(latestVersion, comparableCurrentVersion) > 0);
    const available = Boolean(newer && safety.safe);

    return {
      current,
      latest: {
        version: latestVersion,
        tag: release && release.tag_name ? release.tag_name : '',
        name: release && release.name ? release.name : '',
        publishedAt: release && release.published_at ? release.published_at : '',
        assetName: asset ? asset.name : '',
        assetSize: asset ? asset.size || 0 : 0,
        assetBundledGlibc: safety.bundledGlibc,
        blockedReason: safety.reason,
        source: this.manifestUrl || '',
      },
      available,
      installable: Boolean(asset && safety.safe),
      checkedAt: new Date(this.now()).toISOString(),
      state: this.installState,
    };
  }

  async check(options = {}) {
    if (!this.manifestUrl) return this.statusFromRelease(null, null);
    const release = await this.latestRelease(options);
    const manifest = await this.latestManifest(release);
    return this.statusFromRelease(release, manifest);
  }

  installEnvironment() {
    const current = this.currentVersion();
    return {
      ...process.env,
      FARMING_INSTALL_DIR: current.installDir,
      FARMING_PORT: process.env.FARMING_PORT || process.env.PORT || '6694',
      FARMING_BASE_PATH: process.env.FARMING_BASE_PATH || '/farming',
      ...(process.env.FARMING_CONFIG_DIR ? { FARMING_CONFIG_DIR: process.env.FARMING_CONFIG_DIR } : {}),
      ...(process.env.FARMING_SERVER_HOME ? { FARMING_SERVER_HOME: process.env.FARMING_SERVER_HOME } : {}),
      ...(process.env.FARMING_DISABLE_AUTH ? { FARMING_DISABLE_AUTH: process.env.FARMING_DISABLE_AUTH } : {}),
    };
  }

  async startInstall() {
    if (['downloading', 'extracting', 'installing'].includes(this.installState.phase)) {
      return this.installState;
    }

    const release = await this.latestRelease({ force: true });
    const manifest = await this.latestManifest(release);
    const status = this.statusFromRelease(release, manifest);
    if (!status.available) {
      const error = status.installable
        ? 'Farming is already up to date'
        : (status.latest.blockedReason || 'Update source has no app bundle asset');
      this.installState = {
        phase: 'failed',
        error,
        checkedAt: status.checkedAt,
      };
      return this.installState;
    }

    const asset = selectReleaseAsset(release, this.assetPattern);
    this.installState = {
      phase: 'downloading',
      version: status.latest.version,
      assetName: status.latest.assetName,
      startedAt: new Date(this.now()).toISOString(),
      logPath: path.join(this.configDir, 'farming-update.log'),
    };
    void this.runInstall(asset).catch(error => {
      this.installState = {
        ...this.installState,
        phase: 'failed',
        error: error.message || String(error),
      };
    });
    return this.installState;
  }

  async runInstall(asset) {
    if (!asset || !asset.browser_download_url) {
      throw new Error('release asset is missing a download URL');
    }

    fs.mkdirSync(this.configDir, { recursive: true });
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'farming-update.'));
    const archivePath = path.join(tempRoot, asset.name || 'farming-update.tar.gz');
    await this.downloadFile(asset.browser_download_url, archivePath, {
      authToken: this.authToken,
    });
    if (asset.sha256) {
      const actualSha256 = sha256File(archivePath);
      if (actualSha256 !== String(asset.sha256).toLowerCase()) {
        throw new Error(`downloaded release checksum mismatch for ${asset.name || 'asset'}`);
      }
    }

    this.installState = { ...this.installState, phase: 'extracting' };
    await new Promise((resolve, reject) => {
      this.execFile('tar', ['-xzf', archivePath, '-C', tempRoot], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const releaseDir = findReleaseDirectory(tempRoot);
    const installer = path.join(releaseDir, 'scripts', 'install-release.sh');
    if (!fs.existsSync(installer)) {
      throw new Error('downloaded release is missing scripts/install-release.sh');
    }
    if (!this.allowUnbundledGlibc && !releaseHasBundledGlibc(releaseDir)) {
      throw new Error('downloaded release does not bundle glibc; refusing in-app upgrade');
    }

    const logPath = this.installState.logPath || path.join(this.configDir, 'farming-update.log');
    const installCommand = [
      'sleep 1',
      `cd ${shellQuote(releaseDir)}`,
      `exec bash scripts/install-release.sh install >> ${shellQuote(logPath)} 2>&1`,
    ].join('; ');
    const child = this.spawn('bash', ['-lc', installCommand], {
      detached: true,
      stdio: 'ignore',
      env: this.installEnvironment(),
    });
    if (child && typeof child.unref === 'function') child.unref();
    this.installState = {
      ...this.installState,
      phase: 'installing',
      releaseDir,
      logPath,
    };
  }
}

module.exports = {
  FarmingUpdateService,
  compareVersions,
  normalizeVersion,
  releaseInstallDir,
  releaseHasBundledGlibc,
  manifestAssetSafety,
  releaseFromManifest,
  releaseVersionFromManifest,
  selectManifestAsset,
  selectReleaseAsset,
};
