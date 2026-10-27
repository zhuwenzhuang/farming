import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MANIFEST, prepareRuntimeDependencies, dependencyCacheDir, runtimePlatformKey } from '../runtime-dependency-manager.cjs';
const storageLayout = require('../storage-layout.cjs');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('parallel runtime test timed out')), 5000);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-parallel-runtime-'));
  const ids = ['codex', 'claude'];
  const originals = ids.map(id => MANIFEST.dependencies[id]);
  const platformKey = runtimePlatformKey();
  const body = Buffer.from('verified fixture executable');
  for (const id of ids) {
    MANIFEST.dependencies[id] = {
      version: '1.0.0', managedProbe: false,
      artifacts: { [platformKey]: {
        url: `https://registry.npmjs.org/${id}/-/${id}-1.0.0.tgz`,
        integrity: `sha512-${crypto.createHash('sha512').update(body).digest('base64')}`,
        size: body.length, archive: 'file', entry: id,
      } },
    };
  }
  try {
    for (const scenario of ['success', 'integrity', 'timeout']) {
      const configDir = path.join(root, scenario);
      const env = { FARMING_RUNTIME_NPM_MIRROR: 'off' };
      const oldEnv = { ...env };
      fs.mkdirSync(storageLayout.runtimeDependenciesDir(configDir), { recursive: true });
      const activeFile = storageLayout.runtimeDependenciesActiveFile(configDir);
      const previous = JSON.stringify({ manifestId: 'previous-binding', dependencies: {} });
      fs.writeFileSync(activeFile, previous);
      const started = deferred();
      const releasePeer = deferred();
      const failed = deferred();
      const peerReady = deferred();
      const requests: string[] = [];
      const events: Array<[string, string]> = [];
      let settled = false;
      let cancelledBody = false;
      const preparation = prepareRuntimeDependencies({
        configDir, env, dependencyIds: ids,
        downloadTimeoutMs: scenario === 'timeout' ? 100 : 5000,
        fetch: async url => {
          const id = new URL(url).pathname.split('/')[1];
          requests.push(id);
          if (requests.length === ids.length) started.resolve();
          await started.promise;
          if (id === (scenario === 'success' ? 'codex' : 'claude')) await releasePeer.promise;
          if (id === 'codex' && scenario === 'timeout') {
            return new Response(new ReadableStream({
              start(controller) { controller.enqueue(body.subarray(0, 3)); },
              cancel() { cancelledBody = true; },
            }));
          }
          return new Response(id === 'codex' && scenario === 'integrity'
            ? Buffer.alloc(body.length) : body);
        },
        onProgress: event => {
          events.push([event.dependencyId, event.phase]);
          if (event.phase === 'failed') failed.resolve();
          if (event.dependencyId === 'claude' && event.phase === 'ready') peerReady.resolve();
        },
      });
      const outcome = preparation.then(
        result => { settled = true; return { result, error: undefined }; },
        (error: Error) => { settled = true; return { result: undefined, error }; },
      );
      try {
        await bounded(started.promise);
        assert.deepEqual(requests.sort(), ids.slice().sort(), 'both downloads must start before either can finish');
        if (scenario === 'success') {
          await bounded(peerReady.promise);
          assert.equal(settled, false);
          assert.equal(fs.readFileSync(activeFile, 'utf8'), previous, 'one ready dependency must not activate a partial binding');
        }
        if (scenario === 'integrity') {
          await bounded(failed.promise);
          assert.equal(settled, false, 'failure must wait for the unfinished peer');
          assert(fs.existsSync(storageLayout.runtimeDependenciesLockDir(configDir)));
          assert.equal(fs.readFileSync(activeFile, 'utf8'), previous);
          assert.deepEqual(env, oldEnv);
          assert(!fs.readdirSync(storageLayout.runtimeDependenciesDir(configDir), { recursive: true })
            .some(entry => String(entry).includes('codex') && String(entry).includes('.preparing-')),
          'failed dependency must remove its own staging before reporting failure');
          await assert.rejects(prepareRuntimeDependencies({
            configDir, env: { ...env }, dependencyIds: ids, lockTimeoutMs: 20, lockPollMs: 5,
          }), /Timed out waiting/);
        }
        releasePeer.resolve();
        const { result, error } = await bounded(outcome);
        assert(!fs.existsSync(storageLayout.runtimeDependenciesLockDir(configDir)));
        const remaining = fs.readdirSync(storageLayout.runtimeDependenciesDir(configDir), { recursive: true });
        assert(!remaining.some(entry => /\.(preparing|invalid)-/.test(String(entry))), 'no staging or quarantine leaks');
        if (scenario === 'success') {
          assert.ifError(error);
          assert.deepEqual(result!.dependencies.map(runtime => runtime.id), ids);
          assert.equal(result!.binding.manifestId, MANIFEST.manifestId);
          assert.deepEqual(events.filter(([, phase]) => phase === 'ready').map(([id]) => id), ['claude', 'codex']);
        } else {
          assert.match(error!.message, scenario === 'timeout' ? /timed out/ : /integrity verification/);
          if (scenario === 'timeout') assert(cancelledBody, 'timeout must cancel and close the partial body');
          assert.equal(fs.readFileSync(activeFile, 'utf8'), previous);
          assert.deepEqual(env, oldEnv);
          assert(!fs.existsSync(storageLayout.runtimeDependencyBindingsDir(configDir)));
          assert(fs.existsSync(dependencyCacheDir(configDir, 'claude', '1.0.0', platformKey)), 'retain verified peer cache');
          const retryRequests: string[] = [];
          await prepareRuntimeDependencies({
            configDir, env, dependencyIds: ids,
            fetch: async url => { retryRequests.push(String(url)); return new Response(body); },
          });
          assert.equal(retryRequests.length, 1, 'retry downloads only the failed dependency');
          assert.match(retryRequests[0], /codex/);
        }
      } finally {
        started.resolve();
        releasePeer.resolve();
        await outcome;
      }
    }
    console.log('✓ runtime downloads overlap, retain the lock through failure cleanup, and reuse verified peers on retry');
  } finally {
    ids.forEach((id, index) => { MANIFEST.dependencies[id] = originals[index]; });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
