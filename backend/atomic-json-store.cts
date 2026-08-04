'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface AtomicJsonFileSystem {
  mkdirSync(directory: string, options: { recursive: true }): unknown;
  openSync(file: string, flags: string, mode?: number | string): number;
  writeFileSync(descriptor: number, data: string, encoding: 'utf8'): void;
  fdatasyncSync(descriptor: number): void;
  closeSync(descriptor: number): void;
  renameSync(source: string, target: string): void;
  unlinkSync(file: string): void;
}

interface AtomicWriteJsonOptions {
  fileSystem?: AtomicJsonFileSystem;
  mode?: number | string;
  trailingNewline?: boolean;
}

interface AtomicWriteJsonAsyncOptions {
  beforeCommit?: () => boolean;
  mode?: number;
  trailingNewline?: boolean;
}

function atomicWriteJson(
  file: string,
  value: unknown,
  options: AtomicWriteJsonOptions = {},
): void {
  const fileSystem = options.fileSystem || fs;
  const temporaryFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const suffix = options.trailingNewline ? '\n' : '';
  let descriptor = null;

  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  try {
    descriptor = fileSystem.openSync(temporaryFile, 'wx', options.mode);
    fileSystem.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}${suffix}`, 'utf8');
    fileSystem.fdatasyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;
    fileSystem.renameSync(temporaryFile, file);
  } finally {
    if (descriptor !== null) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      fileSystem.unlinkSync(temporaryFile);
    } catch {
      // A successful rename already removed the temporary path.
    }
  }
}

async function atomicWriteJsonAsync(
  file: string,
  value: unknown,
  options: AtomicWriteJsonAsyncOptions = {},
): Promise<boolean> {
  const temporaryFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const suffix = options.trailingNewline ? '\n' : '';
  let handle: fs.promises.FileHandle | null = null;
  let published = false;

  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  try {
    handle = await fs.promises.open(temporaryFile, 'wx', options.mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}${suffix}`, 'utf8');
    await handle.datasync();
    await handle.close();
    handle = null;
    if (options.beforeCommit && !options.beforeCommit()) return false;
    // The generation check and atomic publication must be one main-thread turn;
    // otherwise an existing synchronous lifecycle commit can interleave between
    // the check and rename and be overwritten by stale title metadata.
    fs.renameSync(temporaryFile, file);
    published = true;
    return true;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write failure.
      }
    }
    if (!published) {
      try {
        await fs.promises.unlink(temporaryFile);
      } catch {
        // The temporary file may not have been created before the failure.
      }
    }
  }
}

export {
  atomicWriteJson,
  atomicWriteJsonAsync,
};
