const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const storageLayout = require('./storage-layout');

const CACHE_TTL_MS = 5 * 60 * 1000;
const UPDATE_SOURCE_UNCONFIGURED_REASON = 'Update source is empty. Save an Update URL in Settings or restore the default source.';
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

function installMethodAllowsBundleUpdate(method) {
  return method === 'app-bundle' || method === 'source-deploy';
}

function installMethodBlockedReason(method) {
  if (method === 'source') return 'Source checkouts update through Git, not the in-app updater';
  if (method === 'standalone-cli') return 'Standalone CLI updates must reinstall the matching release asset';
  return `In-app updates are not supported for ${method || 'this installation'}`;
}

function hasComparableVersion(value) {
  return versionParts(value).length > 0;
}

function releaseVersionFromAsset(asset) {
  return normalizeVersion(asset && (
    asset.releaseVersion ||
    asset.version ||
    asset.file ||
    asset.name ||
    basenameFromUrl(asset.browser_download_url || asset.downloadUrl || asset.url)
  ));
}

function releaseVersionFromRelease(release) {
  const taggedVersion = normalizeVersion(release && (release.tag_name || release.name));
  if (hasComparableVersion(taggedVersion)) return taggedVersion;
  const assetVersion = releaseVersionFromAsset(selectReleaseAsset(release));
  return hasComparableVersion(assetVersion) ? assetVersion : taggedVersion;
}

function releaseVersionFromManifest(manifest) {
  if (!manifest) return '';
  if (manifest.version) return normalizeVersion(manifest.version);
  if (manifest.releaseVersion) return normalizeVersion(manifest.releaseVersion);
  if (manifest.tag) return normalizeVersion(manifest.tag);
  const assets = manifestAssets(manifest);
  const appBundle = assets.find(asset => asset && asset.type === 'app-bundle') || assets[0];
  return releaseVersionFromAsset(appBundle);
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
    releaseVersion: manifest.releaseVersion || manifest.version || '',
  }];
}

function normalizeSha256(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : '';
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

function assetMatchesRuntime(asset, runtime) {
  if (!runtime) return true;
  return normalizePlatform(asset && asset.platform) === runtime.platform
    && normalizeArch(asset && asset.arch) === runtime.arch;
}

function assetCompatibilityPreference(asset, preferredProfile = '') {
  const profile = String(asset && asset.compatibilityProfile || '').trim();
  const preferred = String(preferredProfile || '').trim();
  if (preferred) return profile === preferred ? 0 : 1;
  return profile ? 1 : 0;
}

function runtimeFromBundleName(value) {
  const match = /-(darwin|linux)-(x64|arm64)\.tar\.gz$/i.exec(String(value || ''));
  return match ? { platform: normalizePlatform(match[1]), arch: normalizeArch(match[2]) } : null;
}

function releaseFromAssetListing(release) {
  const rawAssets = Array.isArray(release && release.assets) ? release.assets : [];
  const checksumAsset = rawAssets.find(asset => /(?:checksums?|sha256)\.(?:txt|sha256)$/i.test(String(asset && asset.name || '')));
  return {
    ...release,
    __directAssets: true,
    assets: rawAssets.map(asset => {
      const runtime = runtimeFromBundleName(asset && asset.name);
      const isBundle = /^farming[-_].*\.tar\.gz$/i.test(String(asset && asset.name || ''));
      return {
        ...asset,
        ...(isBundle ? { type: 'app-bundle' } : {}),
        ...(runtime || {}),
        ...(checksumAsset?.browser_download_url ? { checksum_url: checksumAsset.browser_download_url } : {}),
      };
    }),
  };
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
        const file = String(asset && (
          asset.file ||
          asset.name ||
          basenameFromUrl(asset.browser_download_url || asset.downloadUrl || asset.url)
        ) || '');
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
    !/(sha256|checksum|checksums)/i.test(String(asset.name || '')) &&
    asset.browser_download_url
  )) || null;
}

function releaseAssetVersion(asset, fallbackVersion = '') {
  return normalizeVersion(
    asset && (asset.releaseVersion || asset.version || asset.name || asset.file || asset.browser_download_url) ||
    fallbackVersion
  );
}

function selectableReleaseAssets(release, patternText = '', runtime = null, preferredCompatibilityProfile = '') {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const pattern = patternText ? new RegExp(patternText) : null;
  return assets
    .filter(asset => (
      /^farming[-_].*\.tar\.gz$/i.test(String(asset.name || '')) &&
      !/(sha256|checksum|checksums)/i.test(String(asset.name || '')) &&
      asset.browser_download_url &&
      assetMatchesRuntime(asset, runtime) &&
      (!preferredCompatibilityProfile || String(asset.compatibilityProfile || '').trim() === preferredCompatibilityProfile) &&
      (!pattern || pattern.test(String(asset.name || '')))
    ))
    .sort((left, right) => (
      compareVersions(releaseAssetVersion(right), releaseAssetVersion(left)) ||
      assetCompatibilityPreference(left, preferredCompatibilityProfile) - assetCompatibilityPreference(right, preferredCompatibilityProfile) ||
      String(right.name || '').localeCompare(String(left.name || ''))
    ));
}

function selectReleaseAssetByName(release, assetName, patternText = '', runtime = null, preferredCompatibilityProfile = '') {
  const wanted = String(assetName || '').trim();
  if (!wanted) return selectableReleaseAssets(release, patternText, runtime, preferredCompatibilityProfile)[0] || null;
  return selectableReleaseAssets(release, patternText, runtime, preferredCompatibilityProfile)
    .find(asset => String(asset.name || '') === wanted) || null;
}

function selectManifestAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  return assets.find(asset => (
    String(asset.name || '').toLowerCase() === 'manifest.json' &&
    asset.browser_download_url
  )) || null;
}

function manifestAssetSafety(asset, manifest, options = {}) {
  const runtime = options.runtime || null;
  if (!asset) {
    return {
      safe: false,
      reason: 'Update manifest has no app bundle asset',
    };
  }
  const assets = manifestAssets(manifest);
  if (assets.length === 0 && !asset.checksum_url && !asset.checksumUrl && !asset.sha256) {
    return {
      safe: false,
      reason: 'Update manifest is missing a SHA-256 checksum',
    };
  }

  const assetName = String(asset.name || '');
  const entry = assets.find(item => String(item.file || item.name || basenameFromUrl(item.url || item.tarUrl || item.downloadUrl) || '') === assetName) || (assets.length === 0 ? asset : null);
  if (!entry) {
    return {
      safe: false,
      reason: 'Update manifest does not describe the app bundle',
    };
  }
  if (entry.type && entry.type !== 'app-bundle') {
    return {
      safe: false,
      reason: 'Update manifest does not mark the app bundle correctly',
    };
  }
  if (!assetMatchesRuntime(entry, runtime)) {
    return {
      safe: false,
      reason: `Update app bundle is not compatible with ${runtime.platform}-${runtime.arch}`,
    };
  }
  const checksumUrl = entry.checksum_url || entry.checksumUrl || asset.checksum_url || asset.checksumUrl || '';
  if (!normalizeSha256(entry.sha256 || asset.sha256) && !checksumUrl) {
    return {
      safe: false,
      reason: 'Update manifest app bundle is missing a SHA-256 checksum',
    };
  }
  return { safe: true, reason: '' };
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

async function requestText(url, options = {}) {
  const response = await requestWithRedirects(url, options);
  const chunks = [];
  for await (const chunk of response) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function isDirectoryUpdateSource(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    return new URL(raw).pathname.endsWith('/');
  } catch {
    return raw.endsWith('/');
  }
}

function isGitHubReleasePage(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'github.com' && /\/releases\/(?:latest|tag\/[^/]+)\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function githubReleaseTagFromPage(body) {
  for (const match of String(body || '').matchAll(/\/releases\/tag\/([^"'/?#<]+)/gi)) {
    const tag = decodeHtmlAttribute(match[1]);
    if (/^v\d/.test(tag)) return tag;
  }
  return '';
}

function githubExpandedAssetsUrl(pageUrl, tag) {
  try {
    const url = new URL(pageUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !tag) return '';
    return `${url.origin}/${parts[0]}/${parts[1]}/releases/expanded_assets/${encodeURIComponent(tag)}`;
  } catch {
    return '';
  }
}

function releaseFromGitHubReleasePage(body, options = {}) {
  const pageUrl = options.pageUrl || '';
  const entries = [];
  for (const match of String(body || '').matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = decodeHtmlAttribute(match[1] || match[2] || match[3]).trim();
    if (value) entries.push(value);
  }
  const checksumUrl = entries
    .map(entry => ({ entry, file: basenameFromUrl(entry) }))
    .find(({ file }) => /(?:checksums?|sha256)\.(?:txt|sha256)$/i.test(file))?.entry || '';
  const assets = entries
    .map(entry => {
      const file = basenameFromUrl(entry);
      const runtime = runtimeFromBundleName(file);
      if (!runtime || !/^farming[-_].*\.tar\.gz$/i.test(file)) return null;
      const browser_download_url = resolveUpdateUrl(entry, pageUrl);
      if (!browser_download_url) return null;
      return {
        type: 'app-bundle',
        name: file,
        file,
        releaseVersion: normalizeVersion(file),
        browser_download_url,
        checksum_url: resolveUpdateUrl(checksumUrl, pageUrl),
        ...runtime,
      };
    })
    .filter(Boolean);
  const latestVersion = assets[0]?.releaseVersion || '';
  return {
    __directAssets: true,
    tag_name: latestVersion ? `v${latestVersion}` : '',
    name: latestVersion ? `v${latestVersion}` : '',
    published_at: '',
    assets,
  };
}

function releaseFromDirectoryListing(body, options = {}) {
  const directoryUrl = options.directoryUrl || '';
  const assetBaseUrl = options.assetBaseUrl || directoryUrl;
  const entries = [];
  const seen = new Set();
  const addCandidate = (value) => {
    const raw = decodeHtmlAttribute(value).trim();
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    entries.push(raw);
  };

  for (const match of String(body || '').matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    addCandidate(match[1] || match[2] || match[3]);
  }
  for (const match of String(body || '').matchAll(/\bfarming[-_][^\s"'<>]+?\.tar\.gz(?![\w.])/gi)) {
    addCandidate(match[0]);
  }

  const checksumUrls = new Map();
  entries.forEach(entry => {
    const file = basenameFromUrl(entry);
    const match = /^(farming[-_].*\.tar\.gz)\.sha256$/i.exec(file);
    if (!match) return;
    const url = resolveUpdateUrl(entry, assetBaseUrl) || resolveUpdateUrl(file, assetBaseUrl);
    if (url) checksumUrls.set(match[1], url);
  });

  const assets = entries
    .map(entry => {
      const file = basenameFromUrl(entry);
      if (!/^farming[-_].*\.tar\.gz$/i.test(file)) return null;
      if (/(sha256|checksum|checksums)/i.test(file)) return null;
      const url = resolveUpdateUrl(entry, assetBaseUrl) || resolveUpdateUrl(file, assetBaseUrl);
      if (!url) return null;
      return {
        type: 'app-bundle',
        file,
        name: file,
        releaseVersion: normalizeVersion(file),
        browser_download_url: url,
        checksum_url: checksumUrls.get(file) || '',
        size: 0,
      };
    })
    .filter(Boolean)
    .sort((left, right) => (
      compareVersions(right.releaseVersion, left.releaseVersion) ||
      String(right.name).localeCompare(String(left.name))
    ));
  const latestVersion = assets[0] ? assets[0].releaseVersion : '';
  return {
    __manifest: {
      releaseVersion: latestVersion,
      assets: assets.map(asset => ({
        type: asset.type,
        file: asset.file,
        url: asset.browser_download_url,
        checksum_url: asset.checksum_url,
        releaseVersion: asset.releaseVersion,
      })),
    },
    tag_name: latestVersion ? `v${latestVersion}` : '',
    name: latestVersion ? `v${latestVersion}` : '',
    published_at: '',
    assets,
  };
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

function sha256FromChecksumText(text, assetName) {
  const escapedName = String(assetName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*([a-f0-9]{64})\\s+(?:\\*?${escapedName})\\s*$`, 'im').exec(String(text || ''));
  return normalizeSha256(match && match[1]);
}

function validateArchiveEntries(entries) {
  const roots = new Set();
  for (const rawEntry of Array.isArray(entries) ? entries : []) {
    const entry = String(rawEntry || '').replace(/\\/g, '/');
    if (!entry || entry.startsWith('/') || entry.includes('\0')) {
      throw new Error(`downloaded release contains an unsafe archive path: ${rawEntry}`);
    }
    const parts = entry.split('/').filter(Boolean);
    if (parts.some(part => part === '..')) {
      throw new Error(`downloaded release contains path traversal: ${rawEntry}`);
    }
    if (parts[0]) roots.add(parts[0]);
  }
  if (roots.size !== 1) {
    throw new Error(`downloaded release must contain exactly one top-level directory, found ${roots.size}`);
  }
}

function listTarArchiveEntries(archivePath) {
  return new Promise((resolve, reject) => {
    childProcess.execFile('tar', ['-tzf', archivePath], { maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`failed to inspect downloaded release archive: ${error.message || error}`));
        return;
      }
      resolve(String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    });
  });
}

function validateExtractedSymlinks(releaseDir) {
  const releaseRoot = path.resolve(releaseDir);
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(entryPath);
        const resolvedTarget = path.resolve(path.dirname(entryPath), target);
        if (path.isAbsolute(target) || (resolvedTarget !== releaseRoot && !resolvedTarget.startsWith(`${releaseRoot}${path.sep}`))) {
          throw new Error(`downloaded release contains a symlink outside the bundle: ${entryPath}`);
        }
        continue;
      }
      if (entry.isDirectory()) visit(entryPath);
    }
  };
  visit(releaseRoot);
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
    this.getUpdateUrl = typeof options.getUpdateUrl === 'function' ? options.getUpdateUrl : null;
    this.manifestUrl = options.updateUrl || options.manifestUrl || '';
    this.assetBaseUrl = options.assetBaseUrl || '';
    this.assetPattern = options.assetPattern || '';
    this.authToken = options.authToken || '';
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
    this.fetchText = options.fetchText || requestText;
    this.downloadFile = options.downloadFile || downloadFile;
    this.listArchiveEntries = options.listArchiveEntries || listTarArchiveEntries;
    this.execFile = options.execFile || childProcess.execFile;
    this.getNpmGlobalRoot = options.getNpmGlobalRoot
      || ((npmCommand, npmPrefix) => readNpmGlobalRoot(npmCommand, npmPrefix, this.execFile));
    this.spawn = options.spawn || childProcess.spawn;
    this.latestCache = null;
    this.npmCache = null;
    this.installState = { phase: 'idle' };
    this.updateStateFile = options.updateStateFile || storageLayout.updateStateFile(this.configDir);
    this.updateLogFile = options.updateLogFile || storageLayout.updateLogFile(this.configDir);
  }

  updateUrl() {
    const configured = this.getUpdateUrl ? this.getUpdateUrl() : this.manifestUrl;
    return String(configured || '').trim();
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
      installDir: this.installMethod === 'npm' ? this.rootDir : releaseInstallDir(this.rootDir),
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

  async latestRelease(options = {}) {
    const updateUrl = this.updateUrl();
    if (!updateUrl) return null;
    if (!options.force && this.latestCache && this.latestCache.source === updateUrl && this.now() - this.latestCache.checkedAt < CACHE_TTL_MS) {
      return this.latestCache.release;
    }
    let release;
    if (isGitHubReleasePage(updateUrl)) {
      const pageBody = await this.fetchText(updateUrl, {
        accept: 'text/html,application/xhtml+xml',
        authToken: this.authToken,
      });
      const tag = githubReleaseTagFromPage(pageBody);
      const expandedAssetsUrl = githubExpandedAssetsUrl(updateUrl, tag);
      if (!expandedAssetsUrl) throw new Error('GitHub Release page did not expose a release tag');
      release = releaseFromGitHubReleasePage(await this.fetchText(expandedAssetsUrl, {
        accept: 'text/html,application/xhtml+xml',
        authToken: this.authToken,
      }), { pageUrl: expandedAssetsUrl });
    } else if (isDirectoryUpdateSource(updateUrl)) {
      release = releaseFromDirectoryListing(await this.fetchText(updateUrl, {
        accept: 'text/html, text/plain',
        authToken: this.authToken,
      }), {
        directoryUrl: updateUrl,
        assetBaseUrl: this.assetBaseUrl,
      });
    } else {
      const payload = await this.fetchJson(updateUrl, {
        accept: 'application/json',
        authToken: this.authToken,
      });
      release = Array.isArray(payload && payload.assets) && payload.assets.some(asset => asset && asset.browser_download_url)
        ? releaseFromAssetListing(payload)
        : releaseFromManifest(payload, {
          manifestUrl: updateUrl,
          assetBaseUrl: this.assetBaseUrl,
        });
    }
    this.latestCache = {
      checkedAt: this.now(),
      source: updateUrl,
      release,
    };
    return release;
  }

  async latestManifest(release) {
    if (release && release.__directAssets) return null;
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

  versionOptionsFromRelease(release, manifest = null) {
    const current = this.currentVersion();
    const updateUrl = this.updateUrl();
    const comparableCurrentVersion = normalizeVersion(current.releaseVersion || current.packageVersion);
    const latestVersion = releaseVersionFromRelease(release);
    const configured = Boolean(updateUrl);
    return selectableReleaseAssets(release, this.assetPattern, this.runtime, current.compatibilityProfile).map(asset => {
      const version = releaseAssetVersion(asset, latestVersion);
      const safety = configured
        ? manifestAssetSafety(asset, manifest, { runtime: this.runtime })
        : { safe: false, reason: UPDATE_SOURCE_UNCONFIGURED_REASON };
      const newer = Boolean(version && compareVersions(version, comparableCurrentVersion) > 0);
      return {
        version,
        assetName: asset.name || '',
        assetSize: asset.size || 0,
        blockedReason: safety.reason,
        installable: Boolean(safety.safe),
        available: Boolean(newer && safety.safe),
      };
    });
  }

  statusFromRelease(release, manifest = null, options = {}) {
    const current = this.currentVersion();
    const updateUrl = this.updateUrl();
    const latestVersion = releaseVersionFromRelease(release);
    const comparableCurrentVersion = normalizeVersion(current.releaseVersion || current.packageVersion);
    const latestAsset = selectableReleaseAssets(release, this.assetPattern, this.runtime, current.compatibilityProfile)[0] || null;
    const asset = selectReleaseAssetByName(release, options.assetName, this.assetPattern, this.runtime, current.compatibilityProfile);
    const configured = Boolean(updateUrl);
    const safety = configured
      ? manifestAssetSafety(asset, manifest, { runtime: this.runtime })
      : { safe: false, reason: UPDATE_SOURCE_UNCONFIGURED_REASON };
    const selectedVersion = releaseAssetVersion(asset, latestVersion);
    const newer = Boolean(asset && selectedVersion && compareVersions(selectedVersion, comparableCurrentVersion) > 0);
    const available = Boolean(newer && safety.safe);
    const versions = this.versionOptionsFromRelease(release, manifest);
    const noCompatibleBundleReason = this.runtime
      ? `Update source has no compatible app bundle for ${this.runtime.platform}-${this.runtime.arch}`
      : 'Update source has no app bundle asset';

    return {
      method: this.installMethod,
      current,
      latest: {
        version: latestVersion,
        tag: release && release.tag_name ? release.tag_name : '',
        name: release && release.name ? release.name : '',
        publishedAt: release && release.published_at ? release.published_at : '',
        assetName: latestAsset ? latestAsset.name : '',
        assetSize: latestAsset ? latestAsset.size || 0 : 0,
        blockedReason: versions[0] ? versions[0].blockedReason : (this.runtime ? noCompatibleBundleReason : (safety.reason || noCompatibleBundleReason)),
        source: updateUrl || '',
      },
      selected: {
        version: selectedVersion,
        assetName: asset ? asset.name : '',
        assetSize: asset ? asset.size || 0 : 0,
        blockedReason: safety.reason,
      },
      versions,
      runtime: this.runtime,
      available,
      installable: Boolean(asset && safety.safe),
      checkedAt: new Date(this.now()).toISOString(),
      state: this.currentInstallState(),
    };
  }

  async check(options = {}) {
    if (this.installMethod === 'npm') return this.npmStatus(options);
    if (!installMethodAllowsBundleUpdate(this.installMethod)) return this.unsupportedStatus();
    if (!this.updateUrl()) return this.statusFromRelease(null, null, options);
    const release = await this.latestRelease(options);
    const manifest = await this.latestManifest(release);
    return this.statusFromRelease(release, manifest, options);
  }

  installEnvironment() {
    const current = this.currentVersion();
    return {
      ...process.env,
      FARMING_INSTALL_DIR: current.installDir,
      FARMING_PORT: process.env.FARMING_PORT || process.env.PORT || '6694',
      FARMING_BASE_PATH: process.env.FARMING_BASE_PATH || '/farming',
      FARMING_CONFIG_DIR: process.env.FARMING_CONFIG_DIR || this.configDir,
      ...(process.env.FARMING_SERVER_HOME ? { FARMING_SERVER_HOME: process.env.FARMING_SERVER_HOME } : {}),
      ...(process.env.FARMING_DISABLE_AUTH ? { FARMING_DISABLE_AUTH: process.env.FARMING_DISABLE_AUTH } : {}),
    };
  }

  async startInstall(options = {}) {
    const currentState = this.currentInstallState();
    if (['downloading', 'extracting', 'installing', 'restarting', 'rolling-back'].includes(currentState.phase)) {
      return currentState;
    }

    if (this.installMethod === 'npm') return this.startNpmInstall(options);
    if (!installMethodAllowsBundleUpdate(this.installMethod)) {
      throw new Error(installMethodBlockedReason(this.installMethod));
    }

    const release = await this.latestRelease({ force: true });
    const manifest = await this.latestManifest(release);
    const status = this.statusFromRelease(release, manifest, options);
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

    const asset = selectReleaseAssetByName(
      release,
      options.assetName,
      this.assetPattern,
      this.runtime,
      this.currentVersion().compatibilityProfile,
    );
    this.persistInstallState({
      phase: 'downloading',
      method: this.installMethod,
      version: status.selected.version,
      previousVersion: status.current.releaseVersion || status.current.packageVersion,
      assetName: status.selected.assetName,
      startedAt: new Date(this.now()).toISOString(),
      logPath: path.join(this.configDir, 'farming-update.log'),
    });
    void this.runInstall(asset).catch(error => {
      this.persistInstallState({
        ...this.installState,
        phase: 'failed',
        error: error.message || String(error),
        completedAt: new Date(this.now()).toISOString(),
      });
    });
    return this.installState;
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
    const state = this.persistInstallState({
      method: 'npm',
      phase: 'installing',
      version: status.selected.version,
      previousVersion: status.current.releaseVersion || status.current.packageVersion,
      packageName: this.npmPackageName,
      startedAt,
      logPath: this.updateLogFile,
    });
    const helperPath = path.join(__dirname, 'npm-update-helper.js');
    const nodePath = process.env.FARMING_NODE_BIN || process.execPath;
    const payload = {
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
      npmFallbackRegistryUrl: this.npmRegistryUrl,
      serverPid: process.pid,
      configDir: this.configDir,
      port: process.env.FARMING_PORT || process.env.PORT || '6694',
      basePath: process.env.FARMING_BASE_PATH || '/farming',
      serverHome: process.env.FARMING_SERVER_HOME || '',
      disableAuth: /^(1|true|yes|on)$/i.test(String(process.env.FARMING_DISABLE_AUTH || '')),
    };
    const helperInvocation = nodeScriptInvocation(nodePath, helperPath);
    const child = this.spawn(helperInvocation.command, helperInvocation.args, {
      cwd: this.configDir,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        FARMING_NPM_UPDATE_PAYLOAD: JSON.stringify(payload),
      },
    });
    if (child && typeof child.unref === 'function') child.unref();
    return state;
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
    let expectedSha256 = normalizeSha256(asset.sha256);
    const checksumUrl = asset.checksum_url || asset.checksumUrl || '';
    if (!expectedSha256 && checksumUrl) {
      const checksumText = await this.fetchText(checksumUrl, {
        accept: 'text/plain',
        authToken: this.authToken,
      });
      expectedSha256 = sha256FromChecksumText(checksumText, asset.name);
    }
    if (!expectedSha256) {
      throw new Error(`release asset is missing a valid SHA-256 checksum: ${asset.name || 'asset'}`);
    }
    const actualSha256 = sha256File(archivePath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`downloaded release checksum mismatch for ${asset.name || 'asset'}`);
    }

    validateArchiveEntries(await this.listArchiveEntries(archivePath));

    this.persistInstallState({ ...this.installState, phase: 'extracting' });
    await new Promise((resolve, reject) => {
      this.execFile('tar', ['-xzf', archivePath, '-C', tempRoot], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const releaseDir = findReleaseDirectory(tempRoot);
    validateExtractedSymlinks(releaseDir);
    const releaseMetadata = readJsonFile(path.join(releaseDir, 'RELEASE.json')) || {};
    if (!assetMatchesRuntime(releaseMetadata, this.runtime)) {
      throw new Error(`downloaded release is not compatible with ${this.runtime.platform}-${this.runtime.arch}`);
    }
    const installer = path.join(releaseDir, 'scripts', 'install-release.sh');
    if (!fs.existsSync(installer)) {
      throw new Error('downloaded release is missing scripts/install-release.sh');
    }
    const logPath = this.installState.logPath || path.join(this.configDir, 'farming-update.log');
    const targetMethod = String(releaseMetadata.updateMethod || releaseMetadata.type || this.installMethod);
    const helperPath = path.join(__dirname, 'bundle-update-helper.js');
    const nodePath = process.env.FARMING_NODE_BIN || process.execPath;
    const helperInvocation = nodeScriptInvocation(nodePath, helperPath);
    const payload = {
      method: this.installMethod,
      targetMethod,
      version: this.installState.version,
      previousVersion: this.installState.previousVersion,
      startedAt: this.installState.startedAt,
      stateFile: this.updateStateFile,
      logPath,
      releaseDir,
      installer,
    };
    this.persistInstallState({
      ...this.installState,
      phase: 'installing',
      targetMethod,
      releaseDir,
      logPath,
    });
    const child = this.spawn(helperInvocation.command, helperInvocation.args, {
      cwd: this.configDir,
      detached: true,
      stdio: 'ignore',
      env: {
        ...this.installEnvironment(),
        FARMING_BUNDLE_UPDATE_PAYLOAD: JSON.stringify(payload),
      },
    });
    if (child && typeof child.unref === 'function') child.unref();
  }
}

module.exports = {
  FarmingUpdateService,
  compareVersions,
  detectInstallMethod,
  installMethodAllowsBundleUpdate,
  normalizeVersion,
  npmPackageMetadataUrl,
  npmPrefixForPackageRoot,
  npmPackageRoot,
  npmVersionsFromMetadata,
  readNpmGlobalRoot,
  releaseInstallDir,
  manifestAssetSafety,
  normalizeSha256,
  validateArchiveEntries,
  releaseFromManifest,
  releaseFromDirectoryListing,
  releaseFromGitHubReleasePage,
  releaseVersionFromManifest,
  selectManifestAsset,
  selectReleaseAsset,
};
