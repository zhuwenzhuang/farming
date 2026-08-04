const os = require('os');
const path = require('path');
import { AsyncCache } from './async-cache.cjs';
import { discoverSlashCommands } from './slash-command-discovery.cjs';

type SlashCommandList = Awaited<ReturnType<typeof discoverSlashCommands>>;

interface SlashCommandDiscoveryRequest {
  provider: string;
  providerHomePath: string;
  workspace?: string;
}

interface SlashCommandDiscoveryCacheOptions {
  discover?: (request: SlashCommandDiscoveryRequest) => Promise<SlashCommandList>;
  maxEntries?: number;
  now?: () => number;
  ttlMs?: number;
}

function normalizeCachePath(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return path.resolve(text.replace(/^~(?=$|[/\\])/, os.homedir()));
}

function slashCommandDiscoveryCacheKey(request: SlashCommandDiscoveryRequest): string {
  return JSON.stringify({
    provider: String(request.provider || '').trim().toLowerCase(),
    providerHomePath: normalizeCachePath(request.providerHomePath),
    workspace: normalizeCachePath(request.workspace),
  });
}

function createSlashCommandDiscoveryCache(options: SlashCommandDiscoveryCacheOptions = {}) {
  const discover = options.discover ?? discoverSlashCommands;
  const requestedTtlMs = Number(options.ttlMs ?? 30_000);
  const ttlMs = Number.isFinite(requestedTtlMs) ? Math.max(0, requestedTtlMs) : 30_000;
  const requestedMaxEntries = Number(options.maxEntries ?? 256);
  const maxEntries = Number.isFinite(requestedMaxEntries) ? Math.max(1, Math.floor(requestedMaxEntries)) : 256;
  const retainedKeys = new Map<string, true>();
  const cache = new AsyncCache<SlashCommandList>(async key => {
    const request = JSON.parse(key) as SlashCommandDiscoveryRequest;
    return discover(request);
  }, {
    ttlMs,
    staleMs: ttlMs,
    now: options.now,
  });

  return {
    async get(request: SlashCommandDiscoveryRequest): Promise<SlashCommandList> {
      const key = slashCommandDiscoveryCacheKey(request);
      retainedKeys.delete(key);
      retainedKeys.set(key, true);
      while (retainedKeys.size > maxEntries) {
        const oldestKey = retainedKeys.keys().next().value;
        if (typeof oldestKey !== 'string') break;
        retainedKeys.delete(oldestKey);
        cache.invalidate(oldestKey);
      }
      return await cache.get(key) ?? [];
    },
    invalidate(request?: SlashCommandDiscoveryRequest): void {
      if (!request) {
        retainedKeys.clear();
        cache.invalidate();
        return;
      }
      const key = slashCommandDiscoveryCacheKey(request);
      retainedKeys.delete(key);
      cache.invalidate(key);
    },
  };
}

export {
  createSlashCommandDiscoveryCache,
  slashCommandDiscoveryCacheKey,
};
