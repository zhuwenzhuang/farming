#!/usr/bin/env node

/**
 * Verifies the complete public asset set of one Farming GitHub Release.
 *
 * Every supported platform/target asset must be present, listed in the
 * authoritative checksum file, hash-verified against that file, and
 * consistent with manifest.json. A release is rejected when any asset is
 * missing, corrupt, unlisted, or mismatched — not only one probe asset.
 *
 * Usage:
 *   node scripts/verify-public-release-assets.mjs <release-dir> <candidate-sha> <release-version>
 *
 * <release-dir> must contain the downloaded public release assets using their
 * exact public names, including `farming_<version>_checksums.txt` and
 * `manifest.json`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_TARGETS = [
  { platform: 'darwin', arch: 'amd64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'linux', arch: 'amd64' },
  { platform: 'linux', arch: 'arm64' },
];

/** Fixed hashing buffer size; app bundles are hashed in chunks, never loaded whole. */
export const FILE_HASH_CHUNK_SIZE = 1024 * 1024;

const APP_BUNDLE_TARGETS = [
  { platform: 'linux', arch: 'x64', compatibilityProfile: '', fileSuffix: '' },
  {
    platform: 'linux',
    arch: 'x64',
    compatibilityProfile: 'linux-x64-legacy-glibc228',
    fileSuffix: '-legacy-glibc228',
  },
  { platform: 'darwin', arch: 'x64', compatibilityProfile: '', fileSuffix: '' },
  { platform: 'darwin', arch: 'arm64', compatibilityProfile: '', fileSuffix: '' },
];

/** Authoritative checksum file name for one release version. */
export function checksumFileName(version) {
  return `farming_${version}_checksums.txt`;
}

/** Enumerates every public platform asset one Farming release must publish. */
export function expectedPublicAssets(version) {
  const assets = CLI_TARGETS.map(({ platform, arch }) => ({
    type: 'cli',
    file: `farming_${version}_${platform}_${arch}`,
    platform,
    arch,
  }));
  for (const { platform, arch, compatibilityProfile, fileSuffix } of APP_BUNDLE_TARGETS) {
    assets.push({
      type: 'app-bundle',
      file: `farming-${version}-${platform}-${arch}${fileSuffix}.tar.gz`,
      platform,
      arch,
      compatibilityProfile,
    });
  }
  return assets;
}

/** Parses a `sha256sum`-style checksum file into an exact name -> sha256 map. */
export function parseChecksumFile(text, sourceName) {
  const checksums = new Map();
  const lines = String(text).split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`${sourceName} contains no checksum entries`);
  }
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?([^*\s].*)$/i);
    if (!match) throw new Error(`Invalid checksum entry in ${sourceName}: ${line}`);
    const name = match[2].trim();
    const sha256 = match[1].toLowerCase();
    if (checksums.has(name)) {
      throw new Error(`Duplicate checksum entry for ${name} in ${sourceName}`);
    }
    checksums.set(name, sha256);
  }
  return checksums;
}

/**
 * Hashes one file with fixed-size synchronous fd reads so verification memory
 * stays O(1) even for multi-gigabyte app bundles.
 */
export function sha256OfFile(filePath, chunkSize = FILE_HASH_CHUNK_SIZE) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(chunkSize);
    let position = 0;
    let bytesRead = fs.readSync(fd, buffer, 0, chunkSize, position);
    while (bytesRead > 0) {
      hash.update(bytesRead === chunkSize ? buffer : buffer.subarray(0, bytesRead));
      position += bytesRead;
      bytesRead = fs.readSync(fd, buffer, 0, chunkSize, position);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Verifies one downloaded public release directory.
 * Returns { errors, verifiedFiles }; an empty error list means the complete
 * public asset set is authentic.
 */
export function verifyPublicReleaseAssets({ releaseDir, candidateSha, releaseVersion }) {
  const errors = [];
  const verifiedFiles = [];
  if (!/^[0-9a-f]{40}$/.test(String(candidateSha || ''))) {
    return { errors: [`Candidate SHA is not an exact 40-character commit: ${candidateSha || 'missing'}`], verifiedFiles };
  }
  const version = String(releaseVersion || '').trim();
  if (!version) {
    return { errors: ['Release version is missing'], verifiedFiles };
  }

  const checksumsPath = path.join(releaseDir, checksumFileName(version));
  let checksums = new Map();
  if (!fs.existsSync(checksumsPath)) {
    errors.push(`Authoritative checksum file is missing: ${checksumFileName(version)}`);
  } else {
    try {
      checksums = parseChecksumFile(fs.readFileSync(checksumsPath, 'utf8'), checksumFileName(version));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const manifestPath = path.join(releaseDir, 'manifest.json');
  let manifest = null;
  if (!fs.existsSync(manifestPath)) {
    errors.push('Public manifest.json is missing');
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      errors.push(`Public manifest.json is unreadable: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (manifest) {
    if (manifest.name !== 'farming') errors.push(`Public manifest name must be "farming", found ${JSON.stringify(manifest.name)}`);
    if (manifest.releaseVersion !== version) {
      errors.push(`Public manifest releaseVersion mismatch: manifest=${manifest.releaseVersion}, release=${version}`);
    }
    if (manifest.tag !== `v${version}`) errors.push(`Public manifest tag mismatch: manifest=${manifest.tag}, expected v${version}`);
    if (manifest.gitSha !== candidateSha) {
      errors.push(`Public manifest gitSha mismatch: manifest=${manifest.gitSha}, candidate=${candidateSha}`);
    }
    if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
      errors.push('Public manifest lists no assets');
    }
  }

  const manifestAssets = new Map(
    (manifest && Array.isArray(manifest.assets) ? manifest.assets : [])
      .filter(asset => asset && typeof asset.file === 'string')
      .map(asset => [asset.file, asset]),
  );

  const hashFile = (name) => {
    const filePath = path.join(releaseDir, name);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      errors.push(`Public release asset is missing: ${name}`);
      return;
    }
    const expected = checksums.get(name);
    if (!expected) {
      errors.push(`Public release asset has no checksum entry: ${name}`);
      return;
    }
    let actual;
    try {
      actual = sha256OfFile(filePath);
    } catch (error) {
      errors.push(`Public release asset ${name} could not be hashed: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (actual !== expected) {
      errors.push(`Public release asset checksum mismatch for ${name}: expected ${expected}, actual ${actual}`);
      return;
    }
    verifiedFiles.push(name);
  };

  for (const expected of expectedPublicAssets(version)) {
    hashFile(expected.file);
    const manifestAsset = manifestAssets.get(expected.file);
    if (!manifestAsset) {
      if (manifest) errors.push(`Public manifest is missing asset entry ${expected.file}`);
      continue;
    }
    if (manifestAsset.type !== expected.type) {
      errors.push(`Public manifest asset ${expected.file} has type ${JSON.stringify(manifestAsset.type)}, expected ${expected.type}`);
    }
    if (manifestAsset.sha256 !== checksums.get(expected.file)) {
      errors.push(`Public manifest sha256 for ${expected.file} does not match the checksum file`);
    }
    if (manifestAsset.platform !== expected.platform || manifestAsset.arch !== expected.arch) {
      errors.push(
        `Public manifest asset ${expected.file} targets ${manifestAsset.platform}/${manifestAsset.arch}, `
        + `expected ${expected.platform}/${expected.arch}`,
      );
    }
    if (expected.type === 'app-bundle'
      && String(manifestAsset.compatibilityProfile || '') !== expected.compatibilityProfile) {
      errors.push(
        `Public manifest asset ${expected.file} compatibilityProfile is `
        + `${JSON.stringify(manifestAsset.compatibilityProfile || '')}, `
        + `expected ${JSON.stringify(expected.compatibilityProfile)}`,
      );
    }
    if (expected.type === 'app-bundle' && manifestAsset.gitSha
      && manifestAsset.gitSha !== candidateSha) {
      errors.push(`Public manifest app bundle ${expected.file} gitSha mismatch: ${manifestAsset.gitSha}`);
    }
    manifestAssets.delete(expected.file);
  }

  for (const [file] of manifestAssets) {
    errors.push(`Public manifest lists an unexpected asset: ${file}`);
  }

  for (const name of checksums.keys()) {
    if (!expectedPublicAssets(version).some(asset => asset.file === name)) {
      errors.push(`Checksum file lists an unexpected asset: ${name}`);
    }
  }

  const knownNames = new Set(expectedPublicAssets(version).map(asset => asset.file));
  knownNames.add(checksumFileName(version));
  knownNames.add('manifest.json');
  let entries = [];
  try {
    entries = fs.readdirSync(releaseDir);
  } catch (error) {
    errors.push(`Release directory is unreadable: ${error instanceof Error ? error.message : error}`);
  }
  for (const entry of entries) {
    if (knownNames.has(entry)) continue;
    errors.push(`Unexpected file in public release directory: ${entry}`);
  }

  return { errors, verifiedFiles };
}

function main() {
  const [releaseDir, candidateSha, releaseVersion] = process.argv.slice(2);
  if (!releaseDir || !candidateSha || !releaseVersion) {
    console.error('Usage: node scripts/verify-public-release-assets.mjs <release-dir> <candidate-sha> <release-version>');
    process.exit(2);
  }
  const { errors, verifiedFiles } = verifyPublicReleaseAssets({ releaseDir, candidateSha, releaseVersion });
  if (errors.length > 0) {
    for (const message of errors) console.error(message);
    console.error(`Public release verification failed with ${errors.length} error(s).`);
    process.exit(1);
  }
  console.log(
    `Verified ${verifiedFiles.length} public release assets for v${releaseVersion} (${candidateSha}) `
    + 'against the authoritative checksum file and manifest.',
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
