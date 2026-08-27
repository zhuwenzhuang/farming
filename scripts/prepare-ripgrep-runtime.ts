#!/usr/bin/env -S npx tsx

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

import {
  MANAGED_RIPGREP_ARTIFACTS,
  MANAGED_RIPGREP_VERSION,
  canonicalManagedRipgrepPlatform,
  currentManagedRipgrepPlatform,
  managedRipgrepFilename,
  managedRipgrepRelativePath,
} from '../backend/ripgrep-runtime.cjs';

const yauzl = require('yauzl') as {
  open(filename: string, options: { lazyEntries: boolean }, callback: (error: Error | null, zipfile?: {
    close(): void;
    openReadStream(entry: { fileName: string }, callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void): void;
    readEntry(): void;
    on(event: 'entry', callback: (entry: { fileName: string }) => void): void;
    on(event: 'end' | 'error', callback: (error?: Error) => void): void;
  }) => void): void;
};

const projectRoot = path.resolve(__dirname, '..');
const configuredCacheRoot = process.env.FARMING_RIPGREP_CACHE;
if (configuredCacheRoot && !path.isAbsolute(configuredCacheRoot)) {
  throw new Error('FARMING_RIPGREP_CACHE must be an absolute path');
}
const cacheRoot = configuredCacheRoot || path.join(projectRoot, 'node_modules', '.cache', 'farming', 'ripgrep');

function requestedPlatforms(argv = process.argv): string[] {
  const index = argv.indexOf('--platform');
  if (index < 0) return [currentManagedRipgrepPlatform()];
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('-')) throw new Error('--platform requires a platform key or all');
  if (value === 'all') return Object.keys(MANAGED_RIPGREP_ARTIFACTS);
  return [canonicalManagedRipgrepPlatform(value)];
}

function sha256(filename: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

async function downloadArchive(platformKey: string): Promise<string> {
  const artifact = MANAGED_RIPGREP_ARTIFACTS[platformKey];
  if (!artifact) throw new Error(`Farming does not provide ripgrep for ${platformKey}`);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const archive = path.join(cacheRoot, artifact.archiveName);
  if (fs.existsSync(archive) && sha256(archive) === artifact.sha256) return archive;
  const staging = `${archive}.tmp-${process.pid}`;
  fs.rmSync(staging, { force: true });
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${MANAGED_RIPGREP_VERSION}/${artifact.archiveName}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error(`Failed to download managed ripgrep: ${response.status} ${url}`);
    await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(staging, { mode: 0o600 }));
    const actualSha256 = sha256(staging);
    if (actualSha256 !== artifact.sha256) {
      throw new Error(`Managed ripgrep checksum mismatch for ${artifact.archiveName}`);
    }
    fs.rmSync(archive, { force: true });
    fs.renameSync(staging, archive);
  } finally {
    fs.rmSync(staging, { force: true });
  }
  return archive;
}

async function extractZipEntry(archive: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) return reject(openError || new Error(`Failed to open ${archive}`));
      let found = false;
      let settled = false;
      const fail = (error?: Error) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(error || new Error(`Managed ripgrep archive has no rg.exe: ${archive}`));
      };
      zipfile.on('error', fail);
      zipfile.on('end', () => {
        if (!found) fail();
      });
      zipfile.on('entry', entry => {
        if (!/(^|\/)rg\.exe$/i.test(entry.fileName)) return zipfile.readEntry();
        found = true;
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError || new Error(`Failed to read ${entry.fileName}`));
          pipeline(stream, fs.createWriteStream(destination, { mode: 0o755 }))
            .then(() => {
              if (settled) return;
              settled = true;
              zipfile.close();
              resolve();
            }, fail);
        });
      });
      zipfile.readEntry();
    });
  });
}

async function extractRipgrep(platformKey: string, archive: string): Promise<void> {
  const destination = path.join(projectRoot, managedRipgrepRelativePath(platformKey));
  const destinationDirectory = path.dirname(destination);
  fs.mkdirSync(destinationDirectory, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(path.join(destinationDirectory, '.rg-stage-'));
  const staging = path.join(stagingDirectory, managedRipgrepFilename(platformKey));
  try {
    if (archive.endsWith('.zip')) {
      await extractZipEntry(archive, staging);
    } else {
      await tar.x({
        file: archive,
        cwd: stagingDirectory,
        filter: entryPath => /(^|\/)rg$/.test(entryPath),
        strip: 1,
      });
      if (!fs.existsSync(staging)) throw new Error(`Managed ripgrep archive has no rg: ${archive}`);
    }
    if (platformKey.startsWith('win32-')) fs.chmodSync(staging, 0o644);
    else fs.chmodSync(staging, 0o755);
    fs.rmSync(destination, { force: true });
    fs.renameSync(staging, destination);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

export async function prepareRipgrepRuntimes(platforms: string[]): Promise<void> {
  for (const requestedPlatform of new Set(platforms.map(canonicalManagedRipgrepPlatform))) {
    if (!MANAGED_RIPGREP_ARTIFACTS[requestedPlatform]) {
      throw new Error(`Farming does not provide ripgrep for ${requestedPlatform}`);
    }
    const archive = await downloadArchive(requestedPlatform);
    await extractRipgrep(requestedPlatform, archive);
    const destination = path.join(projectRoot, managedRipgrepRelativePath(requestedPlatform));
    if (!fs.statSync(destination).isFile()) throw new Error(`Managed ripgrep is missing after extraction: ${destination}`);
  }
}

async function main(): Promise<void> {
  await prepareRipgrepRuntimes(requestedPlatforms());
}

if (require.main === module) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { requestedPlatforms };
