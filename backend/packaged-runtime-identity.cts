import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface PackagedRuntimeIdentity {
  version: string;
  platformKey: string;
  sourceId: string;
  sha256: string;
  farmingSha: string;
}

/** A build-produced digest stays beside the executable, inside the package's trust boundary. */
export function verifyPackagedRuntimeIdentity(
  executable: string,
  expected: Pick<PackagedRuntimeIdentity, 'version' | 'platformKey' | 'sourceId'>,
): PackagedRuntimeIdentity {
  const identityPath = path.join(path.dirname(executable), 'identity.json');
  for (const file of [executable, identityPath]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Patched runtime must be a regular file: ${file}`);
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as PackagedRuntimeIdentity;
  if (identity.version !== expected.version || identity.platformKey !== expected.platformKey
    || identity.sourceId !== expected.sourceId || !/^[a-f0-9]{40}$/.test(identity.farmingSha)
    || !/^[a-f0-9]{64}$/.test(identity.sha256)) {
    throw new Error('Patched runtime identity does not match the reviewed source and platform');
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  if (digest !== identity.sha256) throw new Error('Patched runtime executable digest mismatch');
  return identity;
}
