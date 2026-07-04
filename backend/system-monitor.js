const os = require('os');
const path = require('path');
const fsp = require('fs/promises');

const DISK_STATS_TTL_MS = 30_000;

class SystemMonitor {
  constructor(options = {}) {
    this.diskStatsTtlMs = Number.isFinite(options.diskStatsTtlMs) ? options.diskStatsTtlMs : DISK_STATS_TTL_MS;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.diskStatsCache = {
      sampledAt: 0,
      value: null,
    };
  }

  async getSystemStats() {
    const stats = this.getBasicStats();
    stats.disk = await this.getCachedDiskStats().catch(() => this.diskStatsCache.value || null);
    return stats;
  }

  getBasicStats() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpuCount = Math.max(1, os.cpus().length);
    const oneMinuteLoad = os.loadavg()[0] || 0;

    return {
      cpu: Math.max(0, Math.min(100, Math.round((oneMinuteLoad / cpuCount) * 100))),
      memory: {
        used: Math.round(usedMem / 1024 / 1024),
        total: Math.round(totalMem / 1024 / 1024),
        percentage: Math.round((usedMem / totalMem) * 100)
      },
      disk: null,
      network: null,
      timestamp: Date.now()
    };
  }

  async getCachedDiskStats() {
    const now = this.now();
    if (this.diskStatsCache.value && now - this.diskStatsCache.sampledAt < this.diskStatsTtlMs) {
      return this.diskStatsCache.value;
    }

    const value = await this.getDiskStats();
    this.diskStatsCache = {
      sampledAt: now,
      value,
    };
    return value;
  }

  async getDiskStats() {
    if (typeof fsp.statfs !== 'function') return null;

    const root = path.parse(process.cwd()).root || '/';
    const stat = await fsp.statfs(root);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bfree) * Number(stat.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;

    return {
      used: Math.round(usedBytes / 1024 / 1024 / 1024),
      total: Math.round(totalBytes / 1024 / 1024 / 1024),
      percentage: Math.round((usedBytes / totalBytes) * 100)
    };
  }
}

module.exports = SystemMonitor;
module.exports.DISK_STATS_TTL_MS = DISK_STATS_TTL_MS;
