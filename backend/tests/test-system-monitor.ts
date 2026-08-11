const assert = require('assert');
const packageJson = require('../../package.json');
const {
  DARWIN_MEMORY_STATS_TTL_MS,
  SystemMonitor,
} = require('../system-monitor.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function run() {
  const monitor = new SystemMonitor();
  const stats = await monitor.getSystemStats();

  assert(Number.isFinite(stats.cpu), 'cpu should be a finite number');
  assert(stats.cpu >= 0 && stats.cpu <= 100, 'cpu should be normalized to 0-100');
  assert(stats.memory && Number.isFinite(stats.memory.used), 'memory used should be present');
  assert(stats.memory.total >= stats.memory.used, 'memory total should be >= used');
  assert(stats.memory.percentage >= 0 && stats.memory.percentage <= 100, 'memory percentage should be normalized');
  assert.strictEqual(stats.network, null, 'network stats should degrade to null without external probes');
  assert(Number.isFinite(stats.timestamp), 'timestamp should be present');

  assert.strictEqual(
    packageJson.dependencies.systeminformation,
    undefined,
    'system monitoring should remain on bounded built-in probes instead of the systeminformation dependency',
  );

  let now = 1_000;
  let diskCalls = 0;
  const cachedMonitor = new SystemMonitor({
    diskStatsTtlMs: 10_000,
    now: () => now,
  });
  cachedMonitor.getDiskStats = async () => {
    diskCalls += 1;
    return { used: diskCalls, total: 10, percentage: 10 };
  };

  const firstStats = await cachedMonitor.getSystemStats();
  const secondStats = await cachedMonitor.getSystemStats();
  assert.strictEqual(diskCalls, 1, 'disk stats should be cached within the TTL');
  assert.deepStrictEqual(secondStats.disk, firstStats.disk, 'cached disk stats should be reused');

  now += 10_001;
  const refreshedStats = await cachedMonitor.getSystemStats();
  assert.strictEqual(diskCalls, 2, 'disk stats should refresh after the TTL expires');
  assert.strictEqual(refreshedStats.disk.used, 2, 'refreshed disk stats should replace the cached value');

  let memoryCalls = 0;
  const memoryMonitor = new SystemMonitor({
    now: () => now,
    platform: 'darwin',
    darwinMemoryProbe: async () => {
      memoryCalls += 1;
      return 1024;
    },
  });
  memoryMonitor.getDiskStats = async () => null;
  await memoryMonitor.getSystemStats();
  await memoryMonitor.getSystemStats();
  assert.strictEqual(memoryCalls, 1, 'macOS memory stats should be cached within the TTL');

  now += DARWIN_MEMORY_STATS_TTL_MS;
  await memoryMonitor.getSystemStats();
  assert.strictEqual(memoryCalls, 2, 'macOS memory stats should refresh when the TTL expires');

  const slowProbe = deferred();
  const probeStarted = deferred();
  let concurrentCalls = 0;
  let activeCalls = 0;
  let maxActiveCalls = 0;
  const concurrentMonitor = new SystemMonitor({
    platform: 'darwin',
    darwinMemoryProbe: async () => {
      concurrentCalls += 1;
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      probeStarted.resolve();
      const value = await slowProbe.promise;
      activeCalls -= 1;
      return value;
    },
  });
  concurrentMonitor.getDiskStats = async () => null;
  const concurrentReads = [
    concurrentMonitor.getSystemStats(),
    concurrentMonitor.getSystemStats(),
    concurrentMonitor.getSystemStats(),
  ];
  await probeStarted.promise;
  assert.strictEqual(concurrentCalls, 1, 'concurrent reads should share one macOS memory probe');
  assert.strictEqual(maxActiveCalls, 1, 'at most one macOS memory probe should be active');
  slowProbe.resolve(1024);
  await Promise.all(concurrentReads);

  let fallbackCalls = 0;
  let fallbackNow = 10_000;
  const fallbackMonitor = new SystemMonitor({
    now: () => fallbackNow,
    platform: 'darwin',
    darwinMemoryProbe: async () => {
      fallbackCalls += 1;
      if (fallbackCalls === 1) throw new Error('vm_stat failed');
      if (fallbackCalls === 2) return null;
      return 1024;
    },
  });
  fallbackMonitor.getDiskStats = async () => null;
  await fallbackMonitor.getSystemStats();
  await fallbackMonitor.getSystemStats();
  assert.strictEqual(fallbackCalls, 1, 'failed macOS memory probes should be cached within the TTL');

  fallbackNow += DARWIN_MEMORY_STATS_TTL_MS;
  await fallbackMonitor.getSystemStats();
  await fallbackMonitor.getSystemStats();
  assert.strictEqual(fallbackCalls, 2, 'null macOS memory probes should be cached within the TTL');

  fallbackNow += DARWIN_MEMORY_STATS_TTL_MS;
  await fallbackMonitor.getSystemStats();
  assert.strictEqual(fallbackCalls, 3, 'macOS memory probes should recover after a cached failure expires');

  console.log('✓ SystemMonitor caches bounded macOS memory probes and stable built-in stats');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
