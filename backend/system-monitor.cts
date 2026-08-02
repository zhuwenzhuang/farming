const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { execFile } = require('child_process');

const DISK_STATS_TTL_MS = 30_000;
const DARWIN_MEMORY_STATS_TTL_MS = 5_000;

type DarwinMemoryProbe = () => Promise<number | null>;

interface SystemMonitorOptions {
  diskStatsTtlMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
  darwinMemoryProbe?: DarwinMemoryProbe;
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
  private readonly platform: NodeJS.Platform;
  private readonly darwinMemoryProbe: DarwinMemoryProbe;
  private diskStatsCache: {
    sampledAt: number;
    value: DiskStats | null;
  };
  private darwinMemoryStatsCache: {
    value: number | null;
    expiresAt: number;
    inFlight: Promise<number | null> | null;
  };

  constructor(options: SystemMonitorOptions = {}) {
    this.diskStatsTtlMs = typeof options.diskStatsTtlMs === 'number'
      && Number.isFinite(options.diskStatsTtlMs)
      ? options.diskStatsTtlMs
      : DISK_STATS_TTL_MS;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.platform = options.platform || process.platform;
    this.darwinMemoryProbe = options.darwinMemoryProbe || (() => this.darwinAvailableMemoryBytes());
    this.diskStatsCache = {
      sampledAt: 0,
      value: null,
    };
    this.darwinMemoryStatsCache = {
      value: null,
      expiresAt: 0,
      inFlight: null,
    };
  }

  async getSystemStats(): Promise<SystemStats> {
    const stats = this.getBasicStats();
    stats.disk = await this.getCachedDiskStats().catch(() => this.diskStatsCache.value || null);
    if (this.platform === 'darwin') {
      const corrected = await this.getCachedDarwinAvailableMemoryBytes();
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

  private getCachedDarwinAvailableMemoryBytes(): Promise<number | null> {
    const now = this.now();
    if (now < this.darwinMemoryStatsCache.expiresAt) {
      return Promise.resolve(this.darwinMemoryStatsCache.value);
    }
    if (this.darwinMemoryStatsCache.inFlight) {
      return this.darwinMemoryStatsCache.inFlight;
    }

    const inFlight = Promise.resolve()
      .then(() => this.darwinMemoryProbe())
      .catch(() => null)
      .then(value => {
        this.darwinMemoryStatsCache.value = value;
        this.darwinMemoryStatsCache.expiresAt = this.now() + DARWIN_MEMORY_STATS_TTL_MS;
        return value;
      })
      .finally(() => {
        if (this.darwinMemoryStatsCache.inFlight === inFlight) {
          this.darwinMemoryStatsCache.inFlight = null;
        }
      });
    this.darwinMemoryStatsCache.inFlight = inFlight;
    return inFlight;
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
  DARWIN_MEMORY_STATS_TTL_MS,
  DISK_STATS_TTL_MS,
  SystemMonitor,
};
