import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyReleaseBundle } from './verify-release-bundle';

export function stageRemoteDeploymentArtifact(source: string, destination: string, gitSha: string, checksum: string): void {
  assert(path.isAbsolute(source), 'Remote artifact path must be absolute');
  assert.match(gitSha, /^[a-f0-9]{40}$/, 'Remote artifact requires an exact git SHA');
  assert.match(checksum, /^[a-f0-9]{64}$/, 'Remote artifact requires an exact SHA-256');
  const stat = fs.lstatSync(source);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Remote artifact must be a regular file');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let copied = false;
  try {
    const owned = fs.openSync(destination, 'wx', 0o600);
    copied = true;
    fs.closeSync(owned);
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o600);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex'), checksum,
      'Remote deployment artifact checksum mismatch');
    const { release } = verifyReleaseBundle(destination);
    assert.equal(release.gitSha, gitSha, 'Remote deployment artifact git SHA mismatch');
    assert.equal(release.platform, 'linux');
    assert.equal(release.arch, 'x64');
    assert.equal(release.updateMethod, 'app-bundle');
    assert.equal(release.bundledNodeModules, true);
    assert.equal(release.bundledGlibcRuntime, true, 'Remote artifact must carry its Linux compatibility runtime');
    assert.equal(release.compatibilityProfile, 'linux-x64-legacy-glibc228');
  } catch (error) {
    if (copied) fs.rmSync(destination);
    throw error;
  }
}

if (require.main === module) {
  try {
    const [source, destination, gitSha, checksum] = process.argv.slice(2);
    stageRemoteDeploymentArtifact(source, destination, gitSha, checksum);
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
