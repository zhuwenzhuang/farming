#!/bin/sh
':' //; script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; repo_dir="$script_dir"; while [ ! -x "$repo_dir/node_modules/.bin/tsx" ] && [ "$repo_dir" != "/" ]; do repo_dir="$(dirname -- "$repo_dir")"; done; if [ ! -x "$repo_dir/node_modules/.bin/tsx" ]; then echo "Pinned tsx runtime not found above $script_dir" >&2; exit 127; fi; exec "$repo_dir/node_modules/.bin/tsx" "$0" "$@"
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

interface TarOutputOptions {
  encoding?: BufferEncoding;
}

interface ReleaseManifest {
  type?: string;
  dirty?: boolean;
  releaseVersion?: string;
  packageVersion?: string;
  platform?: string;
  arch?: string;
  compatibilityProfile?: string;
  bundledNodeModules?: boolean;
  bundledGlibcRuntime?: boolean;
  updateMethod?: string;
}

interface BundleInfo {
  entries: string[];
  releaseEntry: string;
  installerEntry: string;
  browserProtocolEntry: string;
  browserExtensionEntry: string;
  computerExtensionEntry: string;
  computerSchemaEntry: string;
  release: ReleaseManifest;
}

function tarOutput(args: string[], options: TarOutputOptions = {}): string {
  try {
    return execFileSync('tar', args, {
      encoding: options.encoding || 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const err = error as { stderr?: string | Buffer; message?: string };
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    const wrapped = new Error(stderr || err.message || `tar failed: ${args.join(' ')}`);
    (wrapped as { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

function archiveEntries(archivePath: string): string[] {
  return tarOutput(['-tzf', archivePath])
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function readArchiveJson(archivePath: string, entry: string): ReleaseManifest {
  return JSON.parse(tarOutput(['-xOf', archivePath, entry]));
}

function findBundleEntry(entries: string[], suffix: string): string {
  return entries.find(entry => entry.endsWith(suffix) && entry.split('/').length >= 2) || '';
}

function relativeBundleEntry(entry: string): string {
  const normalized = String(entry || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error(`release archive contains an unsafe path: ${entry}`);
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some(part => part === '..')) {
    throw new Error(`release archive contains path traversal: ${entry}`);
  }
  return parts.slice(1).join('/');
}

function verifyArchiveEntries(entries: string[]): void {
  const roots = new Set<string>();
  const forbidden = /^(?:\.git|\.gc|\.beads|\.codex|\.claude|\.farming|\.tmp|tests|backend\/tests|docs\/internal)(?:\/|$)|^fa-[^/]*(?:\/|$)/;
  entries.forEach(entry => {
    const parts = String(entry || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts[0]) roots.add(parts[0]);
    const relative = relativeBundleEntry(entry);
    if (forbidden.test(relative)) {
      throw new Error(`release archive contains forbidden private or test content: ${entry}`);
    }
  });
  if (roots.size !== 1) {
    throw new Error(`release archive must contain exactly one top-level directory, found ${roots.size}`);
  }
}

function readBundleRelease(archivePath: string): BundleInfo {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`release archive not found: ${archivePath || '(missing)'}`);
  }

  const entries = archiveEntries(archivePath);
  const releaseEntry = findBundleEntry(entries, '/RELEASE.json');
  if (!releaseEntry) {
    throw new Error(`release archive is missing RELEASE.json: ${archivePath}`);
  }

  const installerEntry = findBundleEntry(entries, '/scripts/install-release.sh');
  const browserProtocolEntry = findBundleEntry(entries, '/shared/browser-protocol.js');
  const browserExtensionEntry = findBundleEntry(entries, '/extensions/browser/backend/index.cjs');
  const computerExtensionEntry = findBundleEntry(entries, '/extensions/computer/backend/index.cjs');
  const computerSchemaEntry = findBundleEntry(entries, '/extensions/computer/backend/cua-tools.json');
  return {
    entries,
    releaseEntry,
    installerEntry,
    browserProtocolEntry,
    browserExtensionEntry,
    computerExtensionEntry,
    computerSchemaEntry,
    release: readArchiveJson(archivePath, releaseEntry),
  };
}

function verifyReleaseBundle(archivePath: string): BundleInfo {
  const bundle = readBundleRelease(archivePath);
  verifyArchiveEntries(bundle.entries);
  if (bundle.release.type !== 'app-bundle') {
    throw new Error(`release archive is not an app bundle: ${archivePath}`);
  }
  if (bundle.release.dirty !== false) {
    throw new Error(`release archive must be built from a clean working tree: ${archivePath}`);
  }
  if (!bundle.release.releaseVersion || bundle.release.releaseVersion !== bundle.release.packageVersion) {
    throw new Error(`release and package versions do not match: ${archivePath}`);
  }
  if (!bundle.installerEntry) {
    throw new Error(`release archive is missing scripts/install-release.sh: ${archivePath}`);
  }
  if (!bundle.browserProtocolEntry) {
    throw new Error(`release archive is missing shared/browser-protocol.js: ${archivePath}`);
  }
  if (!bundle.browserExtensionEntry) {
    throw new Error(`release archive is missing extensions/browser/backend/index.cjs: ${archivePath}`);
  }
  if (!bundle.computerExtensionEntry) {
    throw new Error(`release archive is missing extensions/computer/backend/index.cjs: ${archivePath}`);
  }
  if (!bundle.computerSchemaEntry) {
    throw new Error(`release archive is missing extensions/computer/backend/cua-tools.json: ${archivePath}`);
  }
  return bundle;
}

function main(): void {
  const archivePath = process.argv[2];
  if (!archivePath) {
    console.error('Usage: tsx scripts/verify-release-bundle.ts <farming-release.tar.gz>');
    process.exit(2);
  }
  const bundle = verifyReleaseBundle(archivePath);
  console.log(`Verified app bundle ${archivePath}: version ${bundle.release.releaseVersion || 'unknown'}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message || String(error));
    process.exit(1);
  }
}

export {
  archiveEntries,
  readBundleRelease,
  verifyArchiveEntries,
  verifyReleaseBundle,
};
