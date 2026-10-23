import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  allocateNativePtyControllerGeneration,
  allocateNativePtyRuntimeGeneration,
} from '../native-pty-controller-generation.cjs';
import * as storage from '../storage-layout.cjs';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function verify(kind: 'controller' | 'runtime') {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'farming-generation-lock-'));
  const allocate = kind === 'controller' ? allocateNativePtyControllerGeneration : allocateNativePtyRuntimeGeneration;
  const file = kind === 'controller' ? storage.nativePtyControllerGenerationFile(root) : storage.nativePtyRuntimeGenerationFile(root);
  const lock = kind === 'controller' ? storage.nativePtyControllerGenerationLockDir(root) : storage.nativePtyRuntimeGenerationLockDir(root);
  const rename = fs.promises.rename;
  const renameSync = fs.renameSync;
  const entered = deferred();
  const resume = deferred();
  const contender = deferred();
  const pending: Promise<number>[] = [];
  let firstWrite = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    fs.promises.rename = async (source, target) => {
      if (target === file && firstWrite) {
        firstWrite = false;
        entered.resolve();
        await resume.promise;
      }
      return rename(source, target);
    };
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('generation lock test did not reach contention')), 3000);
    });
    const first = allocate(root);
    pending.push(first);
    await Promise.race([entered.promise, deadline]);
    const holder = await fs.promises.readFile(path.join(lock, 'owner.json'), 'utf8');
    const old = new Date(Date.now() - 31_000);
    await fs.promises.utimes(lock, old, old);
    fs.renameSync = (source, target) => {
      try { return renameSync(source, target); }
      finally { if (target === lock) contender.resolve(); }
    };
    let secondSettled = false;
    const second = allocate(root).then(value => { secondSettled = true; return value; });
    pending.push(second);
    await Promise.race([contender.promise, deadline]);
    assert.equal(secondSettled, false, 'age cannot evict a paused live owner');
    assert.equal(await fs.promises.readFile(path.join(lock, 'owner.json'), 'utf8'), holder);
    resume.resolve();
    assert.deepEqual(await Promise.all(pending), [1, 2]);
    assert.equal(Number(await fs.promises.readFile(file, 'utf8')), 2);
    assert.equal(fs.existsSync(lock), false);
    clearTimeout(timer);
    fs.promises.rename = rename;
    fs.renameSync = renameSync;

    // A killed owner is recovered from its exact recorded identity, not age.
    const modulePath = path.resolve(__dirname, '..', 'process-owned-file-lock.cjs');
    const child = spawn(process.execPath, ['-e', `
      require(process.argv[1]).acquireProcessFileLock(process.argv[2]);
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `, modulePath, lock.slice(0, -'.lock'.length)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        once(child.stdout!, 'data'),
        exited.then(() => { throw new Error('claim owner exited before readiness'); }),
        new Promise<never>((_, reject) => { readyTimer = setTimeout(() => reject(new Error('claim owner readiness timeout')), 3000); }),
      ]);
      child.kill('SIGKILL');
      await exited;
      assert.equal(await allocate(root), 3);
    } finally {
      clearTimeout(readyTimer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }

    await fs.promises.mkdir(lock);
    await fs.promises.utimes(lock, old, old);
    await assert.rejects(allocate(root), /Unverifiable legacy/);
    assert.equal(fs.existsSync(lock), true, 'legacy unknown owner is not deleted');
    assert.equal(Number(await fs.promises.readFile(file, 'utf8')), 3);
  } finally {
    clearTimeout(timer);
    resume.resolve();
    await Promise.allSettled(pending);
    fs.promises.rename = rename;
    fs.renameSync = renameSync;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

(async () => {
  await verify('controller');
  await verify('runtime');
  console.log('Native PTY generation exact-owner lock tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
