const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const storageLayout = require('./storage-layout');

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveGeneration(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function acquireGenerationLock(lockDir) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fs.promises.mkdir(lockDir);
      return;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.promises.stat(lockDir);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.promises.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (!statError || statError.code !== 'ENOENT') throw statError;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new Error('Timed out allocating native PTY controller generation');
}

async function allocateGeneration(generationFile, lockDir) {
  const root = path.dirname(generationFile);
  await fs.promises.mkdir(root, { recursive: true });
  await acquireGenerationLock(lockDir);
  try {
    let current = 0;
    try {
      current = positiveGeneration(await fs.promises.readFile(generationFile, 'utf8'));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    const generation = current + 1;
    const temporary = `${generationFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, `${generation}\n`, { mode: 0o600 });
    await fs.promises.rename(temporary, generationFile);
    return generation;
  } finally {
    await fs.promises.rm(lockDir, { recursive: true, force: true });
  }
}

async function allocateNativePtyControllerGeneration(configDir) {
  const root = path.resolve(configDir);
  const generationFile = storageLayout.nativePtyControllerGenerationFile(root);
  const lockDir = storageLayout.nativePtyControllerGenerationLockDir(root);
  return allocateGeneration(generationFile, lockDir);
}

async function allocateNativePtyRuntimeGeneration(configDir) {
  const root = path.resolve(configDir);
  return allocateGeneration(
    storageLayout.nativePtyRuntimeGenerationFile(root),
    storageLayout.nativePtyRuntimeGenerationLockDir(root),
  );
}

function formatNativePtyRuntimeEpoch(generation, id = crypto.randomUUID()) {
  const normalized = positiveGeneration(generation);
  if (!normalized) throw new Error('Native PTY runtime generation must be positive');
  return `farming-runtime-v1:${String(normalized).padStart(20, '0')}:${id}`;
}

module.exports = {
  allocateNativePtyControllerGeneration,
  allocateNativePtyRuntimeGeneration,
  formatNativePtyRuntimeEpoch,
  positiveGeneration,
};
