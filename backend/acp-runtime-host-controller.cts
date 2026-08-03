'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;

interface GenerationOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fileSystemError(error: unknown): error is { code?: unknown } {
  return typeof error === 'object' && error !== null;
}

function positiveGeneration(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileSystemError(error) && error.code !== 'ESRCH';
  }
}

async function readOwner(lockDir: string): Promise<{ nonce: string; pid: number } | null> {
  try {
    const value = JSON.parse(await fs.promises.readFile(path.join(lockDir, 'owner.json'), 'utf8'));
    const nonce = String(value.nonce || '');
    const pid = Number(value.pid);
    return nonce && Number.isSafeInteger(pid) ? { nonce, pid } : null;
  } catch (error) {
    if (fileSystemError(error) && error.code === 'ENOENT') return null;
    return null;
  }
}

async function acquireLock(lockDir: string, options: GenerationOptions): Promise<string> {
  const deadline = Date.now() + Number(options.lockTimeoutMs || LOCK_TIMEOUT_MS);
  const staleLockMs = Number(options.staleLockMs ?? STALE_LOCK_MS);
  while (Date.now() < deadline) {
    const nonce = crypto.randomUUID();
    const candidate = `${lockDir}.candidate.${process.pid}.${nonce}`;
    try {
      await fs.promises.mkdir(candidate);
      const ownerHandle = await fs.promises.open(path.join(candidate, 'owner.json'), 'wx', 0o600);
      try {
        await ownerHandle.writeFile(
        JSON.stringify({ nonce, pid: process.pid, createdAt: Date.now() }),
        );
        await ownerHandle.sync();
      } finally {
        await ownerHandle.close();
      }
      const candidateHandle = await fs.promises.open(candidate, 'r');
      try {
        await candidateHandle.sync();
      } finally {
        await candidateHandle.close();
      }
      await fs.promises.rename(candidate, lockDir);
      return nonce;
    } catch (error) {
      await fs.promises.rm(candidate, { recursive: true, force: true }).catch(() => {});
      if (!fileSystemError(error) || !['EEXIST', 'ENOTEMPTY'].includes(String(error.code))) throw error;
      try {
        const stat = await fs.promises.stat(lockDir);
        const owner = await readOwner(lockDir);
        if (Date.now() - stat.mtimeMs > staleLockMs && !owner) {
          const reclaimed = `${lockDir}.reclaimed.ownerless.${crypto.randomUUID()}`;
          await fs.promises.rename(lockDir, reclaimed).catch(renameError => {
            if (!fileSystemError(renameError) || renameError.code !== 'ENOENT') throw renameError;
          });
          try {
            const reclaimedStat = await fs.promises.stat(reclaimed);
            const reclaimedOwner = await readOwner(reclaimed);
            if (reclaimedStat.dev === stat.dev && reclaimedStat.ino === stat.ino && !reclaimedOwner) {
              await fs.promises.rm(reclaimed, { recursive: true, force: true });
            } else if (reclaimedOwner) {
              await fs.promises.rename(reclaimed, lockDir).catch(() => {});
            }
          } catch (reclaimedError) {
            if (!fileSystemError(reclaimedError) || reclaimedError.code !== 'ENOENT') throw reclaimedError;
          }
          continue;
        }
        if (
          Date.now() - stat.mtimeMs > staleLockMs
          && owner
          && !processAlive(owner.pid)
          && (await readOwner(lockDir))?.nonce === owner.nonce
        ) {
          const reclaimed = `${lockDir}.reclaimed.${owner.nonce}.${crypto.randomUUID()}`;
          await fs.promises.rename(lockDir, reclaimed).catch(renameError => {
            if (!fileSystemError(renameError) || renameError.code !== 'ENOENT') throw renameError;
          });
          const reclaimedOwner = await readOwner(reclaimed);
          if (reclaimedOwner?.nonce === owner.nonce) {
            await fs.promises.rm(reclaimed, { recursive: true, force: true });
          } else if (reclaimedOwner) {
            await fs.promises.rename(reclaimed, lockDir).catch(() => {});
          }
          continue;
        }
      } catch (statError) {
        if (!fileSystemError(statError) || statError.code !== 'ENOENT') throw statError;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new Error('Timed out allocating ACP runtime host controller generation');
}

async function allocateAcpRuntimeHostControllerGeneration(
  configDir: string,
  options: GenerationOptions = {},
): Promise<number> {
  const root = path.resolve(configDir);
  const generationFile = path.join(root, 'acp-runtime-host-controller-generation');
  const lockDir = path.join(root, '.acp-runtime-host-controller-generation.lock');
  await fs.promises.mkdir(root, { recursive: true });
  const ownerNonce = await acquireLock(lockDir, options);
  try {
    let current = 0;
    try {
      current = positiveGeneration(await fs.promises.readFile(generationFile, 'utf8'));
    } catch (error) {
      if (!fileSystemError(error) || error.code !== 'ENOENT') throw error;
    }
    const generation = current + 1;
    const temporary = `${generationFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${generation}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, generationFile);
    const directory = await fs.promises.open(root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return generation;
  } finally {
    if ((await readOwner(lockDir))?.nonce === ownerNonce) {
      await fs.promises.rm(lockDir, { recursive: true, force: true });
    }
  }
}

export { allocateAcpRuntimeHostControllerGeneration };
