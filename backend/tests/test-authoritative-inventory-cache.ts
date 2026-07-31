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

    console.log('test-authoritative-inventory-cache passed');
  } finally {
    await Promise.allSettled(caches.map(cache => cache.close()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
