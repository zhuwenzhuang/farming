const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SystemMonitor = require('../system-monitor');

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

  const source = fs.readFileSync(path.join(__dirname, '..', 'system-monitor.js'), 'utf8');
  assert(!source.includes("require('systeminformation')"), 'system monitor should not depend on systeminformation spawn probes');

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

  console.log('✓ SystemMonitor returns stable built-in stats without external probes');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
