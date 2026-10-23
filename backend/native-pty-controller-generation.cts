'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as storageLayout from './storage-layout.cjs';
import {
  acquireProcessFileLock,
  releaseProcessFileLock,
  recoverPendingLockRelease,
  UPDATE_STATE_LOCK_ERROR_CODE,
  type ProcessFileLockClaim,
} from './process-owned-file-lock.cjs';

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveGeneration(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function fileSystemError(error: unknown): error is { code?: unknown } {
  return typeof error === 'object' && error !== null;
}

async function acquireGenerationLock(claimKey: string, lockDir: string): Promise<ProcessFileLockClaim> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Legacy allocators published empty directories. They have no process proof
    // and cannot safely be overwritten by atomic publication of a new claim.
    try {
      if ((await fs.promises.readdir(lockDir)).length === 0) {
        throw new Error(`Unverifiable legacy native PTY generation lock: ${lockDir}`);
      }
    } catch (error) {
      if (!fileSystemError(error) || error.code !== 'ENOENT') throw error;
    }
    try {
      recoverPendingLockRelease(claimKey, { lockTimeoutMs: 0 });
      return acquireProcessFileLock(claimKey, { lockTimeoutMs: 0 });
    } catch (error) {
      if (!fileSystemError(error) || error.code !== UPDATE_STATE_LOCK_ERROR_CODE) throw error;
    }
    await delay(LOCK_RETRY_MS);
  }
  throw new Error('Timed out allocating native PTY controller generation');
}

async function allocateGeneration(generationFile: string, lockDir: string): Promise<number> {
  const root = path.dirname(generationFile);
  await fs.promises.mkdir(root, { recursive: true });
  // The shared claim primitive appends .lock; retain the established lock path.
  const claimKey = lockDir.slice(0, -'.lock'.length);
  const claim = await acquireGenerationLock(claimKey, lockDir);
  const temporary = `${generationFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let generation = 0;
  const failures: unknown[] = [];
  try {
    let current = 0;
    try {
      current = positiveGeneration(await fs.promises.readFile(generationFile, 'utf8'));
    } catch (error) {
      if (!fileSystemError(error) || error.code !== 'ENOENT') throw error;
    }
    generation = current + 1;
    await fs.promises.writeFile(temporary, `${generation}\n`, { mode: 0o600 });
    await fs.promises.rename(temporary, generationFile);
  } catch (error) {
    failures.push(error);
  }
  try { await fs.promises.rm(temporary, { force: true }); }
  catch (error) { failures.push(error); }
  if (!releaseProcessFileLock(claimKey, claim, { lockTimeoutMs: 0 })) {
    failures.push(new Error('Native PTY generation allocation outcome is uncertain: lock release could not be proven'));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Native PTY generation allocation failed');
  return generation;
}

async function allocateNativePtyControllerGeneration(configDir: string): Promise<number> {
  const root = path.resolve(configDir);
  const generationFile = storageLayout.nativePtyControllerGenerationFile(root);
  const lockDir = storageLayout.nativePtyControllerGenerationLockDir(root);
  return allocateGeneration(generationFile, lockDir);
}

async function allocateNativePtyRuntimeGeneration(configDir: string): Promise<number> {
  const root = path.resolve(configDir);
  return allocateGeneration(
    storageLayout.nativePtyRuntimeGenerationFile(root),
    storageLayout.nativePtyRuntimeGenerationLockDir(root),
  );
}

function formatNativePtyRuntimeEpoch(generation: unknown, id = crypto.randomUUID()): string {
  const normalized = positiveGeneration(generation);
  if (!normalized) throw new Error('Native PTY runtime generation must be positive');
  return `farming-runtime-v1:${String(normalized).padStart(20, '0')}:${id}`;
}

function nativePtyRuntimeEpochGeneration(runtimeEpoch: unknown): number | null {
  const match = /^farming-runtime-v1:(\d{20}):/.exec(String(runtimeEpoch || ''));
  if (!match) return null;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

function compareNativePtyRuntimeEpochs(left: unknown, right: unknown): -1 | 0 | 1 | null {
  if (left === right) return 0;
  const leftGeneration = nativePtyRuntimeEpochGeneration(left);
  const rightGeneration = nativePtyRuntimeEpochGeneration(right);
  if (leftGeneration === null || rightGeneration === null || leftGeneration === rightGeneration) return null;
  return leftGeneration < rightGeneration ? -1 : 1;
}

export {
  allocateNativePtyControllerGeneration,
  allocateNativePtyRuntimeGeneration,
  compareNativePtyRuntimeEpochs,
  formatNativePtyRuntimeEpoch,
  nativePtyRuntimeEpochGeneration,
  positiveGeneration,
};
