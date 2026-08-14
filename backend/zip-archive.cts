import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

const yauzl = require('yauzl') as {
  openPromise(
    archivePath: string,
    options: {
      autoClose: boolean;
      strictFileNames: boolean;
      validateEntrySizes: boolean;
    },
  ): Promise<ZipArchive>;
};

const ZIP_FILE_TYPE_MASK = 0o170000;
const ZIP_DIRECTORY_TYPE = 0o040000;
const ZIP_REGULAR_FILE_TYPE = 0o100000;
const ZIP_SYMBOLIC_LINK_TYPE = 0o120000;
const MAX_SYMBOLIC_LINK_BYTES = 16 * 1024;

interface ZipEntry {
  externalFileAttributes: number;
  fileName: string;
  uncompressedSize: number;
  versionMadeBy: number;
}

interface ZipArchive {
  eachEntry(): AsyncIterable<ZipEntry>;
  openReadStreamPromise(entry: ZipEntry): Promise<Readable>;
}

interface ExtractZipArchiveOptions {
  dir: string;
}

interface PendingSymbolicLink {
  destination: string;
  entryName: string;
  target: string;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
}

function portableAbsolutePath(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:/.test(value);
}

function normalizedArchivePath(value: string, description: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.includes('\0') || portableAbsolutePath(normalized)) {
    throw new Error(`${description} must be a relative path inside the archive`);
  }
  const relative = path.posix.normalize(normalized).replace(/\/$/, '');
  if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error(`${description} escapes the archive root: ${value}`);
  }
  return relative;
}

function archiveDestination(root: string, entryName: string): string {
  const relative = normalizedArchivePath(entryName, 'ZIP entry');
  const destination = path.resolve(root, ...relative.split('/'));
  const containment = path.relative(root, destination);
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
    throw new Error(`ZIP entry escapes the extraction root: ${entryName}`);
  }
  return destination;
}

function validateZipSymlinkTarget(entryName: string, target: string): void {
  const normalizedTarget = target.replaceAll('\\', '/');
  if (!normalizedTarget || normalizedTarget.includes('\0') || portableAbsolutePath(normalizedTarget)) {
    throw new Error(`ZIP symbolic link target must stay inside the archive: ${entryName}`);
  }
  const entryPath = normalizedArchivePath(entryName, 'ZIP symbolic link');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), normalizedTarget));
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    throw new Error(`ZIP symbolic link target escapes the archive root: ${entryName}`);
  }
}

async function lstatIfPresent(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function ensureSafeDirectory(root: string, directory: string, mode = 0o755): Promise<void> {
  const relative = path.relative(root, directory);
  if (!relative) return;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`ZIP directory escapes the extraction root: ${directory}`);
  }
  let current = root;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const existing = await lstatIfPresent(current);
    if (existing?.isSymbolicLink()) {
      throw new Error(`ZIP extraction refuses to write through a symbolic link: ${current}`);
    }
    if (existing && !existing.isDirectory()) {
      throw new Error(`ZIP extraction expected a directory: ${current}`);
    }
    if (!existing) {
      await fs.promises.mkdir(current, {
        mode: index === segments.length - 1 ? mode : 0o755,
      });
    }
  }
}

async function readSymbolicLinkTarget(archive: ZipArchive, entry: ZipEntry): Promise<string> {
  if (entry.uncompressedSize > MAX_SYMBOLIC_LINK_BYTES) {
    throw new Error(`ZIP symbolic link target is too large: ${entry.fileName}`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await archive.openReadStreamPromise(entry)) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_SYMBOLIC_LINK_BYTES) {
      throw new Error(`ZIP symbolic link target is too large: ${entry.fileName}`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function zipEntryKind(entry: ZipEntry): 'directory' | 'file' | 'symlink' {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & ZIP_FILE_TYPE_MASK;
  const madeBy = entry.versionMadeBy >>> 8;
  if (type === ZIP_SYMBOLIC_LINK_TYPE) return 'symlink';
  if (
    type === ZIP_DIRECTORY_TYPE
    || entry.fileName.endsWith('/')
    || (madeBy === 0 && entry.externalFileAttributes === 16)
  ) return 'directory';
  if (type !== 0 && type !== ZIP_REGULAR_FILE_TYPE) {
    throw new Error(`ZIP entry is not a regular file, directory, or symbolic link: ${entry.fileName}`);
  }
  return 'file';
}

function zipEntryMode(entry: ZipEntry, kind: 'directory' | 'file'): number {
  const archivedMode = ((entry.externalFileAttributes >>> 16) & 0xffff) & 0o777;
  return archivedMode || (kind === 'directory' ? 0o755 : 0o644);
}

async function extractZipEntry(
  archive: ZipArchive,
  root: string,
  entry: ZipEntry,
  symbolicLinks: PendingSymbolicLink[],
): Promise<void> {
  if (entry.fileName.startsWith('__MACOSX/')) return;
  const destination = archiveDestination(root, entry.fileName);
  const kind = zipEntryKind(entry);
  if (kind === 'directory') {
    await ensureSafeDirectory(root, destination, zipEntryMode(entry, kind));
    return;
  }
  await ensureSafeDirectory(root, path.dirname(destination));
  if (kind === 'symlink') {
    const target = await readSymbolicLinkTarget(archive, entry);
    validateZipSymlinkTarget(entry.fileName, target);
    symbolicLinks.push({ destination, entryName: entry.fileName, target });
    return;
  }
  const input = await archive.openReadStreamPromise(entry);
  try {
    await pipeline(input, fs.createWriteStream(destination, {
      flags: 'wx',
      mode: zipEntryMode(entry, kind),
    }));
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createPendingSymbolicLinks(root: string, links: PendingSymbolicLink[]): Promise<void> {
  for (const link of links) {
    validateZipSymlinkTarget(link.entryName, link.target);
    await ensureSafeDirectory(root, path.dirname(link.destination));
    if (await lstatIfPresent(link.destination)) {
      throw new Error(`ZIP symbolic link destination already exists: ${link.entryName}`);
    }
    await fs.promises.symlink(link.target, link.destination);
  }
}

async function extractZipArchive(archivePath: string, options: ExtractZipArchiveOptions): Promise<void> {
  if (!path.isAbsolute(options.dir)) {
    throw new Error('ZIP extraction directory must be absolute');
  }
  await fs.promises.mkdir(options.dir, { recursive: true, mode: 0o755 });
  const root = await fs.promises.realpath(options.dir);
  const archive = await yauzl.openPromise(archivePath, {
    autoClose: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const symbolicLinks: PendingSymbolicLink[] = [];
  for await (const entry of archive.eachEntry()) {
    await extractZipEntry(archive, root, entry, symbolicLinks);
  }
  await createPendingSymbolicLinks(root, symbolicLinks);
}

export {
  extractZipArchive,
  validateZipSymlinkTarget,
};
