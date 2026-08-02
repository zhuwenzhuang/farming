const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { execFile } = require('child_process');

const DISK_STATS_TTL_MS = 30_000;

interface SystemMonitorOptions {
  diskStatsTtlMs?: number;
  now?: () => number;
}

interface DiskStats {
  percentage: number;
  total: number;
  used: number;
}

interface SystemStats {
  cpu: number;
  disk: DiskStats | null;
  memory: {
    percentage: number;
    total: number;
    used: number;
  };
  network: null;
  timestamp: number;
}

class SystemMonitor {
  private readonly diskStatsTtlMs: number;
  private readonly now: () => number;
  private diskStatsCache: {
    sampledAt: number;
    value: DiskStats | null;
  };

  constructor(options: SystemMonitorOptions = {}) {
    this.diskStatsTtlMs = typeof options.diskStatsTtlMs === 'number'
      && Number.isFinite(options.diskStatsTtlMs)
      ? options.diskStatsTtlMs
      : DISK_STATS_TTL_MS;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.diskStatsCache = {
      sampledAt: 0,
      value: null,
    };
  }

  async getSystemStats(): Promise<SystemStats> {
    const stats = this.getBasicStats();
    stats.disk = await this.getCachedDiskStats().catch(() => this.diskStatsCache.value || null);
    if (process.platform === 'darwin') {
      const corrected = await this.darwinAvailableMemoryBytes();
      if (corrected !== null) {
        const totalMem = os.totalmem();
        const usedMem = Math.max(0, totalMem - corrected);
        stats.memory = {
          used: Math.round(usedMem / 1024 / 1024),
          total: Math.round(totalMem / 1024 / 1024),
          percentage: Math.round((usedMem / totalMem) * 100),
        };
      }
    }
    return stats;
  }

  getBasicStats(): SystemStats {
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

  /**
   * macOS `os.freemem()` reports only truly free pages, excluding the
   * inactive, speculative, and purgeable pages the kernel can reclaim.
   * On a typical Mac this makes the sidebar show "MEM 100%" while the
   * system still has gigabytes of reclaimable memory. Parse `vm_stat`
   * to include those reclaimable pages in the available total.
   */
  private darwinAvailableMemoryBytes(): Promise<number | null> {
    return new Promise(resolve => {
      execFile('vm_stat', [], { timeout: 3000, encoding: 'utf8' }, (error: unknown, stdout: string) => {
        if (error || typeof stdout !== 'string') { resolve(null); return; }
        let pageSize = 16384;
        const pages: Record<string, number> = {};
        for (const line of stdout.split('\n')) {
          const sizeMatch = line.match(/page size of (\d+) bytes/);
          if (sizeMatch) { pageSize = Number(sizeMatch[1]); continue; }
          const pageMatch = line.match(/^Pages (free|inactive|speculative|purgeable):\s+(\d+)/);
          if (pageMatch) pages[pageMatch[1]] = Number(pageMatch[2]);
        }
        const reclaimable = (pages.free || 0) + (pages.inactive || 0)
          + (pages.speculative || 0) + (pages.purgeable || 0);
        resolve(reclaimable > 0 ? reclaimable * pageSize : null);
      });
    });
  }

  async getCachedDiskStats(): Promise<DiskStats | null> {
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

  async getDiskStats(): Promise<DiskStats | null> {
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

export {
  DISK_STATS_TTL_MS,
  SystemMonitor,
};
