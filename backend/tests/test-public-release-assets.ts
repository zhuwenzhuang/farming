const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const VERSION = '9.9.9';
const CANDIDATE_SHA = 'ab'.repeat(20);

interface SyntheticReleaseOptions {
  corruptFile?: string;
  removeFile?: string;
  extraFile?: string;
  dropChecksumEntry?: string;
  manifestGitSha?: string;
  manifestShaTamper?: string;
  largeAsset?: { name: string; totalBytes: number };
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Builds the byte-exact public asset set of one release from the verifier's
 * own platform enumeration: four CLI assets, four app bundles, the
 * authoritative checksum file, and manifest.json. Checksums and manifest
 * digests come from pristine bytes first; corruption, removal, and tampering
 * are applied afterwards, exactly like damage in transit or a manipulated
 * publication.
 */
function buildPublicReleaseAssets(expectedAssets, options: SyntheticReleaseOptions = {}) {
  const assets = new Map();
  for (const asset of expectedAssets) {
    const detail = asset.type === 'cli'
      ? `farming cli ${asset.platform} ${asset.arch}`
      : `farming app bundle ${asset.platform} ${asset.arch} ${asset.compatibilityProfile || 'standard'}`;
    assets.set(asset.file, Buffer.from(`${detail}\n`));
  }
  for (const file of ['LICENSE', 'LICENSE.pi-acp', 'LICENSE.pi-acp-sdk', 'LICENSE.pi-acp-zod', 'THIRD_PARTY_NOTICES.md']) {
    assets.set(file, Buffer.from(`${file} fixture\n`));
  }

  // Content selection happens before checksum/manifest generation; a large
  // asset simulates a production-sized app bundle.
  if (options.largeAsset) {
    assert.ok(assets.has(options.largeAsset.name), `cannot enlarge unknown asset ${options.largeAsset.name}`);
    const big = Buffer.alloc(options.largeAsset.totalBytes);
    for (let index = 0; index < big.length; index += 1) big[index] = (index * 31 + 7) % 251;
    assets.set(options.largeAsset.name, big);
  }

  const checksumName = `farming_${VERSION}_checksums.txt`;
  let checksumLines = expectedAssets.map(({ file }) => `${sha256Hex(assets.get(file))}  ${file}`);
  if (options.dropChecksumEntry) {
    checksumLines = checksumLines.filter(line => !line.endsWith(`  ${options.dropChecksumEntry}`));
  }
  assets.set(checksumName, Buffer.from(`${checksumLines.join('\n')}\n`));

  const manifestAssets = [];
  for (const asset of expectedAssets) {
    const entry: Record<string, unknown> = {
      type: asset.type,
      file: asset.file,
      sha256: sha256Hex(assets.get(asset.file)),
      releaseVersion: VERSION,
      platform: asset.platform,
      arch: asset.arch,
    };
    if (asset.type === 'app-bundle') {
      entry.packageVersion = VERSION;
      entry.gitSha = CANDIDATE_SHA;
      entry.compatibilityProfile = asset.compatibilityProfile;
      entry.bundledNodeModules = true;
      entry.bundledGlibcRuntime = asset.compatibilityProfile === 'linux-x64-legacy-glibc228';
    }
    manifestAssets.push(entry);
  }
  const manifest = {
    name: 'farming',
    releaseVersion: VERSION,
    tag: `v${VERSION}`,
    gitSha: options.manifestGitSha || CANDIDATE_SHA,
    basePath: '/farming',
    sourceIncluded: false,
    builtAt: '2026-08-30T00:00:00.000Z',
    assets: manifestAssets,
  };
  if (options.manifestShaTamper) {
    const entry = manifest.assets.find(asset => asset.file === options.manifestShaTamper);
    entry.sha256 = 'f'.repeat(64);
  }
  assets.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  if (options.corruptFile) {
    const original = assets.get(options.corruptFile);
    assert.ok(original, `cannot corrupt unknown asset ${options.corruptFile}`);
    assets.set(options.corruptFile, Buffer.concat([original, Buffer.from('CORRUPTED-IN-TRANSIT\n')]));
  }
  if (options.removeFile) {
    assert.ok(assets.has(options.removeFile), `cannot remove unknown asset ${options.removeFile}`);
    assets.delete(options.removeFile);
  }
  if (options.extraFile) {
    assets.set(options.extraFile, Buffer.from('unexpected public file\n'));
  }
  return assets;
}

/**
 * Mirrors the publish workflow download stage: every public asset is written
 * into the release directory under its exact public name and nothing else is
 * placed there. The download index lives OUTSIDE the release directory; a
 * control file inside the release directory is a verification failure.
 */
function stageWorkflowRelease(stageRoot, assets) {
  const releaseDir = path.join(stageRoot, 'public-release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const releaseIndex = path.join(stageRoot, 'public-release-index.tsv');
  const indexLines = [];
  for (const [name, buffer] of assets) {
    fs.writeFileSync(path.join(releaseDir, name), buffer);
    indexLines.push(`${name}\thttps://release.example.invalid/assets/${encodeURIComponent(name)}`);
  }
  fs.writeFileSync(releaseIndex, `${indexLines.join('\n')}\n`);
  return { releaseDir, releaseIndex };
}

async function run() {
  const verifier = await import(pathToFileURL(
    path.join(process.cwd(), 'scripts/verify-public-release-assets.mjs'),
  ).href);
  const scriptPath = path.join(process.cwd(), 'scripts/verify-public-release-assets.mjs');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-public-release-assets-'));
  try {
    // The verifier's enumeration is the single source of truth shared with the
    // publish workflow's required-asset list; it must keep covering every
    // supported platform/target path.
    const expectedAssets = verifier.expectedPublicAssets(VERSION);
    const expectedNames = expectedAssets.map(asset => asset.file);
    assert.deepStrictEqual(expectedNames.sort(), [
      `farming-${VERSION}-darwin-arm64.tar.gz`,
      `farming-${VERSION}-darwin-x64.tar.gz`,
      `farming-${VERSION}-linux-x64-legacy-glibc228.tar.gz`,
      `farming-${VERSION}-linux-x64.tar.gz`,
      `farming_${VERSION}_darwin_amd64`,
      `farming_${VERSION}_darwin_arm64`,
      `farming_${VERSION}_linux_amd64`,
      `farming_${VERSION}_linux_arm64`,
    ].sort());
    assert.strictEqual(verifier.checksumFileName(VERSION), `farming_${VERSION}_checksums.txt`);
    assert.deepStrictEqual(verifier.supplementalPublicFiles(), [
      'LICENSE',
      'LICENSE.pi-acp',
      'LICENSE.pi-acp-sdk',
      'LICENSE.pi-acp-zod',
      'THIRD_PARTY_NOTICES.md',
    ]);

    const verify = releaseDir => verifier.verifyPublicReleaseAssets({
      releaseDir,
      candidateSha: CANDIDATE_SHA,
      releaseVersion: VERSION,
    });

    // Complete, untampered publication: every platform asset verifies.
    const pristine = stageWorkflowRelease(
      path.join(temporaryRoot, 'pristine'),
      buildPublicReleaseAssets(expectedAssets),
    );
    const pristineResult = verify(pristine.releaseDir);
    assert.deepStrictEqual(pristineResult.errors, [], `pristine release must verify: ${pristineResult.errors.join('; ')}`);
    assert.deepStrictEqual([...pristineResult.verifiedFiles].sort(), expectedNames.sort());
    const pristineCli = spawnSync(process.execPath, [scriptPath, pristine.releaseDir, CANDIDATE_SHA, VERSION], { encoding: 'utf8' });
    assert.strictEqual(pristineCli.status, 0, pristineCli.stderr);

    // Corrupting ANY single asset — including every non-amd64 platform target —
    // must fail verification and name the corrupt asset. The pre-fix workflow
    // hash-checked only farming_<version>_linux_amd64 and passed all others.
    for (const assetName of expectedNames) {
      const staged = stageWorkflowRelease(
        path.join(temporaryRoot, `corrupt-${assetName.replace(/[^A-Za-z0-9.-]+/g, '-')}`),
        buildPublicReleaseAssets(expectedAssets, { corruptFile: assetName }),
      );
      const result = verify(staged.releaseDir);
      assert.ok(result.errors.length > 0, `corrupt ${assetName} must fail verification`);
      assert.ok(
        result.errors.some(message => message.includes(assetName)),
        `errors must name ${assetName}: ${result.errors.join('; ')}`,
      );
    }
    const corruptCliExit = spawnSync(
      process.execPath,
      [
        scriptPath,
        stageWorkflowRelease(
          path.join(temporaryRoot, 'corrupt-cli-exit'),
          buildPublicReleaseAssets(expectedAssets, { corruptFile: `farming_${VERSION}_darwin_arm64` }),
        ).releaseDir,
        CANDIDATE_SHA,
        VERSION,
      ],
      { encoding: 'utf8' },
    );
    assert.strictEqual(corruptCliExit.status, 1);
    assert.match(corruptCliExit.stderr, new RegExp(`farming_${VERSION}_darwin_arm64`));

    // Removing any asset must fail verification.
    for (const assetName of [`farming_${VERSION}_linux_arm64`, `farming-${VERSION}-darwin-x64.tar.gz`]) {
      const staged = stageWorkflowRelease(
        path.join(temporaryRoot, `missing-${assetName.replace(/[^A-Za-z0-9.-]+/g, '-')}`),
        buildPublicReleaseAssets(expectedAssets, { removeFile: assetName }),
      );
      const result = verify(staged.releaseDir);
      assert.ok(
        result.errors.some(message => message.includes(assetName)),
        `errors must report missing ${assetName}: ${result.errors.join('; ')}`,
      );
    }

    // Manifest identity and per-asset digest mismatches must fail.
    const manifestSha = stageWorkflowRelease(
      path.join(temporaryRoot, 'manifest-gitsha'),
      buildPublicReleaseAssets(expectedAssets, { manifestGitSha: 'cd'.repeat(20) }),
    );
    const manifestShaResult = verify(manifestSha.releaseDir);
    assert.ok(manifestShaResult.errors.some(message => message.includes('gitSha')), manifestShaResult.errors.join('; '));

    const manifestTamper = stageWorkflowRelease(
      path.join(temporaryRoot, 'manifest-sha'),
      buildPublicReleaseAssets(expectedAssets, { manifestShaTamper: `farming_${VERSION}_linux_arm64` }),
    );
    const manifestTamperResult = verify(manifestTamper.releaseDir);
    assert.ok(
      manifestTamperResult.errors.some(message => message.includes(`farming_${VERSION}_linux_arm64`)),
      manifestTamperResult.errors.join('; '),
    );

    // An asset without an authoritative checksum entry cannot verify.
    const unlisted = stageWorkflowRelease(
      path.join(temporaryRoot, 'unlisted'),
      buildPublicReleaseAssets(expectedAssets, { dropChecksumEntry: `farming_${VERSION}_darwin_amd64` }),
    );
    const unlistedResult = verify(unlisted.releaseDir);
    assert.ok(
      unlistedResult.errors.some(message => message.includes(`farming_${VERSION}_darwin_amd64`)),
      `errors must reject the unverified asset: ${unlistedResult.errors.join('; ')}`,
    );

    const missingNotice = stageWorkflowRelease(
      path.join(temporaryRoot, 'missing-notice'),
      buildPublicReleaseAssets(expectedAssets, { removeFile: 'THIRD_PARTY_NOTICES.md' }),
    );
    const missingNoticeResult = verify(missingNotice.releaseDir);
    assert.ok(
      missingNoticeResult.errors.some(message => message.includes('THIRD_PARTY_NOTICES.md')),
      `errors must report the missing public notice: ${missingNoticeResult.errors.join('; ')}`,
    );

    // Regression: the release directory holds public assets only. The workflow
    // keeps its download index outside the release directory; if a control file
    // ever lands inside it, verification must fail instead of passing silently.
    const controlFile = stageWorkflowRelease(
      path.join(temporaryRoot, 'control-file'),
      buildPublicReleaseAssets(expectedAssets),
    );
    fs.writeFileSync(path.join(controlFile.releaseDir, 'public-release-index.tsv'), 'index inside release dir\n');
    const controlFileResult = verify(controlFile.releaseDir);
    assert.ok(
      controlFileResult.errors.some(message => message.includes('public-release-index.tsv')),
      `control files inside the release directory must fail: ${controlFileResult.errors.join('; ')}`,
    );

    // Hashing stays O(1) memory: multi-chunk files hash identically to an
    // independent chunked reference hash, with both the default chunk size and
    // a tiny chunk size that stresses the positional read loop.
    const chunk = verifier.FILE_HASH_CHUNK_SIZE;
    const largePath = path.join(temporaryRoot, 'large-file.bin');
    const largeTotalBytes = chunk * 2 + 123;
    {
      const fd = fs.openSync(largePath, 'w');
      try {
        const piece = Buffer.allocUnsafe(64 * 1024);
        for (let index = 0; index < piece.length; index += 1) piece[index] = (index * 31 + 7) % 251;
        let written = 0;
        while (written < largeTotalBytes) {
          const slice = piece.subarray(0, Math.min(piece.length, largeTotalBytes - written));
          fs.writeSync(fd, slice, 0, slice.length);
          written += slice.length;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    const expectedLargeHash = (() => {
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(largePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        let bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
        while (bytesRead > 0) {
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
          bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
        }
      } finally {
        fs.closeSync(fd);
      }
      return hash.digest('hex');
    })();
    assert.strictEqual(verifier.sha256OfFile(largePath), expectedLargeHash);
    assert.strictEqual(verifier.sha256OfFile(largePath, 3), expectedLargeHash);

    // Implementation proof: release assets are hashed through chunked fd reads
    // and never loaded whole via readFileSync, so runner memory stays bounded
    // for large app bundles.
    const largeAssetName = `farming-${VERSION}-linux-x64.tar.gz`;
    const largeStage = stageWorkflowRelease(
      path.join(temporaryRoot, 'large-release'),
      buildPublicReleaseAssets(expectedAssets, { largeAsset: { name: largeAssetName, totalBytes: largeTotalBytes } }),
    );
    const readFileSyncCalls = [];
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function trackedReadFileSync(filePath, ...rest) {
      readFileSyncCalls.push(String(filePath));
      return originalReadFileSync.call(fs, filePath, ...rest);
    };
    let largeResult;
    try {
      largeResult = verify(largeStage.releaseDir);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    assert.deepStrictEqual(largeResult.errors, [], `large release must verify: ${largeResult.errors.join('; ')}`);
    assert.ok(largeResult.verifiedFiles.includes(largeAssetName));
    const wholeFileAssetReads = readFileSyncCalls.filter(filePath => expectedNames.includes(path.basename(filePath)));
    assert.deepStrictEqual(
      wholeFileAssetReads,
      [],
      'release assets must be hashed via chunked fd reads, not readFileSync whole-file loads',
    );

    console.log('✓ public release assets are hash-verified on every platform and target path');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
