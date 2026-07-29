#!/bin/sh
':' //; script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; repo_dir="$script_dir"; while [ ! -x "$repo_dir/node_modules/.bin/tsx" ] && [ "$repo_dir" != "/" ]; do repo_dir="$(dirname -- "$repo_dir")"; done; if [ ! -x "$repo_dir/node_modules/.bin/tsx" ]; then echo "Pinned tsx runtime not found above $script_dir" >&2; exit 127; fi; exec "$repo_dir/node_modules/.bin/tsx" "$0" "$@"
import { execFileSync } from 'node:child_process';
import { verifyReleaseBundle } from './verify-release-bundle';

const PROFILE = 'linux-x64-glibc217';
const MAX_GLIBC = [2, 17];
const MAX_GLIBCXX = [3, 4, 19];
const MAX_CXXABI = [1, 3, 7];

function compareVersion(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function newestVersion(nativeModule: string, prefix: string): number[] | undefined {
  const pattern = new RegExp(`${prefix}_(\\d+(?:\\.\\d+)+)`, 'g');
  const versions = [...nativeModule.matchAll(pattern)]
    .map(match => match[1].split('.').map(Number));
  return versions.sort(compareVersion).at(-1);
}

function assertCompatibleVersion(nativeModule: string, prefix: string, maximum: number[]): number[] | undefined {
  const newest = newestVersion(nativeModule, prefix);
  if (newest && compareVersion(newest, maximum) > 0) {
    throw new Error(
      `node-pty requires ${prefix}_${newest.join('.')}; expected ${prefix}_${maximum.join('.')} or older`,
    );
  }
  return newest;
}

function verifyLinuxCompatRelease(archivePath: string) {
  const bundle = verifyReleaseBundle(archivePath);
  const { release, entries } = bundle;
  if (release.platform !== 'linux' || release.arch !== 'x64') {
    throw new Error('compatibility bundle must target linux-x64');
  }
  if (release.compatibilityProfile !== PROFILE) {
    throw new Error(`compatibility bundle must use profile ${PROFILE}`);
  }
  if (release.bundledNodeModules !== true) {
    throw new Error('compatibility bundle must include production dependencies');
  }

  const ptyEntry = entries.find(entry => entry.endsWith('/node_modules/node-pty/build/Release/pty.node'));
  if (!ptyEntry) {
    throw new Error('compatibility bundle is missing the source-built linux-x64 node-pty module');
  }
  const nativeModule = execFileSync('tar', ['-xOf', archivePath, ptyEntry], {
    encoding: 'latin1',
    maxBuffer: 20 * 1024 * 1024,
  });
  const newestGlibc = newestVersion(nativeModule, 'GLIBC');
  if (!newestGlibc) {
    throw new Error('could not determine the node-pty glibc ABI requirement');
  }
  assertCompatibleVersion(nativeModule, 'GLIBC', MAX_GLIBC);
  assertCompatibleVersion(nativeModule, 'GLIBCXX', MAX_GLIBCXX);
  assertCompatibleVersion(nativeModule, 'CXXABI', MAX_CXXABI);
  return bundle;
}

function main(): void {
  const archivePath = process.argv[2];
  if (!archivePath) {
    console.error('Usage: tsx scripts/verify-linux-compat-release.ts <farming-linux-x64-glibc217.tar.gz>');
    process.exit(2);
  }
  const bundle = verifyLinuxCompatRelease(archivePath);
  console.log(`Verified ${PROFILE} bundle ${archivePath}: version ${bundle.release.releaseVersion}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message || String(error));
    process.exit(1);
  }
}

export { verifyLinuxCompatRelease };
