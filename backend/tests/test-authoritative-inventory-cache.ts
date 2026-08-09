const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AuthoritativeInventoryCache } = require('../authoritative-inventory-cache.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-authoritative-inventory-'));
  const caches: Array<{ close(): Promise<void> }> = [];
  try {
    const source = path.join(root, 'source.json');
    const snapshot = path.join(root, 'cache', 'inventory.json');
    fs.writeFileSync(source, JSON.stringify({ value: 1 }));

    let loads = 0;
    const cache = new AuthoritativeInventoryCache({ snapshotFile: snapshot, refreshDebounceMs: 5 });
    caches.push(cache);
    const request = () => cache.get('example', {
      watchPaths: [source],
      load: () => {
        loads += 1;
        return JSON.parse(fs.readFileSync(source, 'utf8'));
      },
    });

    assert.deepStrictEqual(await request(), { value: 1 });
    assert.strictEqual(loads, 1);
    assert.deepStrictEqual(await request(), { value: 1 });
    assert.strictEqual(loads, 1, 'an unchanged fingerprint should reuse the authoritative snapshot');

    fs.writeFileSync(source, JSON.stringify({ value: 22 }));
    assert.deepStrictEqual(await request(), { value: 22 });
    assert.strictEqual(loads, 2, 'a changed source fingerprint should reconcile before returning');
    await cache.close();

    let restartedLoads = 0;
    const restarted = new AuthoritativeInventoryCache({ snapshotFile: snapshot, refreshDebounceMs: 5 });
    caches.push(restarted);
    const restartedValue = await restarted.get('example', {
      watchPaths: [source],
      load: () => {
        restartedLoads += 1;
        return JSON.parse(fs.readFileSync(source, 'utf8'));
      },
    });
    assert.deepStrictEqual(restartedValue, { value: 22 });
    assert.strictEqual(restartedLoads, 0, 'a persisted snapshot with a proven fingerprint should survive restart');

    await restarted.close();
    fs.writeFileSync(snapshot, '{broken');
    let malformedLoads = 0;
    const malformed = new AuthoritativeInventoryCache({ snapshotFile: snapshot, refreshDebounceMs: 5 });
    caches.push(malformed);
    const rebuiltValue = await malformed.get('example', {
      watchPaths: [source],
      load: () => {
        malformedLoads += 1;
        return JSON.parse(fs.readFileSync(source, 'utf8'));
      },
    });
    assert.deepStrictEqual(rebuiltValue, { value: 22 });
    assert.strictEqual(malformedLoads, 1, 'a malformed persisted snapshot must rebuild from the authoritative source');

    fs.writeFileSync(source, JSON.stringify({ value: 333 }));
    let unstableLoads = 0;
    malformed.invalidate('example');
    const stableValue = await malformed.get('example', {
      watchPaths: [source],
      load: () => {
        unstableLoads += 1;
        const value = JSON.parse(fs.readFileSync(source, 'utf8'));
        if (unstableLoads === 1) fs.writeFileSync(source, JSON.stringify({ value: 4444 }));
        return value;
      },
    });
    assert.deepStrictEqual(stableValue, { value: 4444 });
    assert.strictEqual(unstableLoads, 2, 'a source change during reconciliation should discard and retry the old result');

    const appendRoot = path.join(root, 'append-only');
    const appendSource = path.join(appendRoot, 'session.jsonl');
    fs.mkdirSync(appendRoot);
    fs.writeFileSync(appendSource, 'first');
    let appendLoads = 0;
    const appendRequest = () => malformed.get('append-only', {
      watchPaths: [appendRoot],
      fingerprintOptions: { appendOnlyRoots: [appendRoot] },
      load: () => {
        appendLoads += 1;
        const value = fs.readFileSync(appendSource, 'utf8');
        if (appendLoads === 1) fs.appendFileSync(appendSource, '-second');
        return value;
      },
    });
    assert.strictEqual(await appendRequest(), 'first');
    assert.strictEqual(await appendRequest(), 'first-second');
    assert.strictEqual(appendLoads, 2, 'an append during load should stay dirty instead of failing or committing a false proof');

    const appendTolerantSource = path.join(root, 'large-history.jsonl');
    const largeHistory = 'x'.repeat(70 * 1024);
    fs.writeFileSync(appendTolerantSource, largeHistory);
    let appendTolerantLoads = 0;
    const appendTolerantRequest = () => malformed.get('append-tolerant', {
      watchPaths: [appendTolerantSource],
      fingerprintOptions: { appendTolerantPaths: [appendTolerantSource] },
      load: () => {
        appendTolerantLoads += 1;
        const value = fs.readFileSync(appendTolerantSource, 'utf8');
        if (appendTolerantLoads === 1) fs.appendFileSync(appendTolerantSource, '-during-load');
        return value;
      },
    });
    assert.strictEqual(await appendTolerantRequest(), largeHistory);
    assert.strictEqual(await appendTolerantRequest(), `${largeHistory}-during-load`);
    assert.strictEqual(await appendTolerantRequest(), `${largeHistory}-during-load`);
    assert.strictEqual(appendTolerantLoads, 2, 'a stable append-tolerant source should reuse its proven value');
    fs.appendFileSync(appendTolerantSource, '-later');
    assert.strictEqual(await appendTolerantRequest(), `${largeHistory}-during-load-later`);
    assert.strictEqual(appendTolerantLoads, 3, 'large append-tolerant files must still invalidate after later appends');

    const prefixRoot = path.join(root, 'prefix-memo');
    const prefixSource = path.join(prefixRoot, 'session.jsonl');
    fs.mkdirSync(prefixRoot);
    fs.writeFileSync(prefixSource, 'a'.repeat(70 * 1024));
    let prefixLoads = 0;
    const prefixCache = new AuthoritativeInventoryCache();
    caches.push(prefixCache);
    const prefixRequest = () => prefixCache.get('prefix-memo', {
      fingerprintPaths: [prefixRoot],
      fingerprintOptions: { appendOnlyRoots: [prefixRoot] },
      watchPaths: [],
      load: () => {
        prefixLoads += 1;
        return fs.readFileSync(prefixSource, 'utf8').slice(0, 16);
      },
    });
    const originalOpen = fs.promises.open;
    let prefixOpens = 0;
    fs.promises.open = async (...args: Parameters<typeof fs.promises.open>) => {
      if (path.resolve(String(args[0])) === prefixSource) prefixOpens += 1;
      return originalOpen(...args);
    };
    try {
      await prefixRequest();
      assert.strictEqual(prefixLoads, 1);
      assert.strictEqual(prefixOpens, 1, 'the first freshness proof should read one bounded transcript prefix');
      await prefixRequest();
      await prefixRequest();
      assert.strictEqual(prefixLoads, 1);
      assert.strictEqual(prefixOpens, 1, 'repeated freshness proofs must not reopen unchanged transcript contents');

      fs.appendFileSync(prefixSource, 'later activity');
      await prefixRequest();
      assert.strictEqual(prefixLoads, 1, 'a long append-only transcript append should preserve the metadata snapshot');
      assert.strictEqual(prefixOpens, 2, 'an append should re-read only the changed transcript prefix');

      const rewritten = `b${fs.readFileSync(prefixSource, 'utf8').slice(1)}`;
      fs.writeFileSync(prefixSource, rewritten);
      const changedAt = new Date(Date.now() + 2_000);
      fs.utimesSync(prefixSource, changedAt, changedAt);
      await prefixRequest();
      assert.strictEqual(prefixLoads, 2, 'a same-size rewrite must invalidate the cached transcript identity');
      assert.strictEqual(prefixOpens, 3, 'a same-size rewrite must re-read the bounded prefix');

      fs.writeFileSync(prefixSource, 'c'.repeat(rewritten.length + 1024));
      const grownAt = new Date(Date.now() + 4_000);
      fs.utimesSync(prefixSource, grownAt, grownAt);
      await prefixRequest();
      assert.strictEqual(prefixLoads, 3, 'an in-place rewrite that also grows must not masquerade as an append');
      assert.strictEqual(prefixOpens, 4, 'a growing rewrite must re-read the bounded prefix');

      const preservedStat = fs.statSync(prefixSource);
      fs.writeFileSync(prefixSource, 'd'.repeat(preservedStat.size));
      fs.utimesSync(prefixSource, preservedStat.atime, preservedStat.mtime);
      if (fs.statSync(prefixSource).ctimeMs === preservedStat.ctimeMs) {
        fs.chmodSync(prefixSource, (preservedStat.mode & 0o777) === 0o600 ? 0o640 : 0o600);
      }
      await prefixRequest();
      assert.strictEqual(prefixLoads, 4, 'ctime must invalidate a same-size rewrite even when mtime is preserved');
      assert.strictEqual(prefixOpens, 5, 'a preserved-mtime rewrite must re-read the bounded prefix');
    } finally {
      fs.promises.open = originalOpen;
    }

    const failureSource = path.join(root, 'failure-source.json');
    fs.writeFileSync(failureSource, JSON.stringify({ value: 7 }));
    const failureCache = new AuthoritativeInventoryCache();
    caches.push(failureCache);
    let failNextLoad = true;
    const failureRequest = () => failureCache.get('failure-recovery', {
      fingerprintPaths: [failureSource],
      watchPaths: [],
      load: () => {
        if (failNextLoad) {
          failNextLoad = false;
          throw new Error('injected inventory failure');
        }
        return JSON.parse(fs.readFileSync(failureSource, 'utf8'));
      },
    });
    await assert.rejects(failureRequest());
    assert.deepStrictEqual(await failureRequest(), { value: 7 }, 'a failed load must release single-flight state for recovery');

    const cancelSource = path.join(root, 'cancel-source.json');
    const cancelSnapshot = path.join(root, 'cancel-cache', 'inventory.json');
    fs.writeFileSync(cancelSource, JSON.stringify({ value: 8 }));
    const cancelCache = new AuthoritativeInventoryCache({ snapshotFile: cancelSnapshot });
    caches.push(cancelCache);
    let releaseLoad: (() => void) | null = null;
    let reportLoadStarted: (() => void) | null = null;
    const loadStarted = new Promise<void>(resolve => { reportLoadStarted = resolve; });
    const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
    const cancelledRequest = cancelCache.get('cancelled', {
      fingerprintPaths: [cancelSource],
      watchPaths: [],
      load: async () => {
        reportLoadStarted?.();
        await loadGate;
        return { value: 8 };
      },
    });
    await loadStarted;
    const closeTask = cancelCache.close();
    releaseLoad?.();
    await assert.rejects(cancelledRequest);
    await closeTask;
    const cancelArtifacts = fs.existsSync(path.dirname(cancelSnapshot))
      ? fs.readdirSync(path.dirname(cancelSnapshot))
      : [];
    assert.deepStrictEqual(cancelArtifacts, [], 'cancellation must not leave a snapshot or temporary file behind');

    const retireSource = path.join(root, 'retire-source.json');
    const retireSnapshot = path.join(root, 'retire-cache', 'inventory.json');
    fs.writeFileSync(retireSource, JSON.stringify({ value: 9 }));
    const retireCache = new AuthoritativeInventoryCache({ snapshotFile: retireSnapshot });
    caches.push(retireCache);
    const originalRename = fs.promises.rename;
    let releaseSnapshotRename: (() => void) | null = null;
    let reportSnapshotRename: (() => void) | null = null;
    let gateFirstSnapshotRename = true;
    const snapshotRenameStarted = new Promise<void>(resolve => { reportSnapshotRename = resolve; });
    const snapshotRenameGate = new Promise<void>(resolve => { releaseSnapshotRename = resolve; });
    fs.promises.rename = async (...args: Parameters<typeof fs.promises.rename>) => {
      if (gateFirstSnapshotRename && path.resolve(String(args[1])) === retireSnapshot) {
        gateFirstSnapshotRename = false;
        reportSnapshotRename?.();
        await snapshotRenameGate;
      }
      return originalRename(...args);
    };
    try {
      const retiringRequest = retireCache.get('retiring', {
        fingerprintPaths: [retireSource],
        watchPaths: [retireSource],
        load: () => ({ value: 9 }),
      });
      await snapshotRenameStarted;
      const retainTask = retireCache.retain(new Set<string>());
      releaseSnapshotRename?.();
      await assert.rejects(retiringRequest);
      await retainTask;
    } finally {
      fs.promises.rename = originalRename;
    }
    const retiredDocument = JSON.parse(fs.readFileSync(retireSnapshot, 'utf8'));
    assert.deepStrictEqual(
      Object.keys(retiredDocument.entries),
      [],
      'retiring a key must fence a pending snapshot commit before deleteExcept completes',
    );
    assert.strictEqual(
      fs.readdirSync(path.dirname(retireSnapshot)).some(name => name.endsWith('.tmp')),
      false,
      'retirement must remove every snapshot temporary file',
    );

    console.log('test-authoritative-inventory-cache passed');
  } finally {
    const closeResults = await Promise.allSettled(caches.map(cache => cache.close()));
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(
      closeResults.every(result => result.status === 'fulfilled'),
      true,
      'every authoritative cache must close successfully',
    );
    assert.strictEqual(fs.existsSync(root), false, 'cache fixtures must remove their exact temporary root');
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
