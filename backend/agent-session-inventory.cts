import * as os from 'os';
import * as path from 'path';
import {
  compareAgentSessions,
  listAgentSessions,
  normalizeProvider,
} from './agent-session-history.cjs';
import type {
  AgentProvider,
  AgentSession,
  ProviderHome,
  ProviderSessionHomeBinding,
} from './agent-session-history.cjs';
import { AuthoritativeInventoryCache } from './authoritative-inventory-cache.cjs';

interface AgentSessionInventoryMetadata {
  providerHomes: Partial<Record<AgentProvider, ProviderHome[]>>;
  providerSessionBindings?: ProviderSessionHomeBinding[];
}

interface AgentSessionInventoryOptions {
  cacheFile: string;
  listSessions?: typeof listAgentSessions;
}

interface ResolvedProviderHome {
  id: string;
  path: string;
}

const PROVIDERS: AgentProvider[] = ['codex', 'claude', 'qoder', 'qwen', 'opencode'];
const INVENTORY_LIMIT = 5000;

function openCodeDataRoots(): string[] {
  return [...new Set([
    String(process.env.XDG_DATA_HOME || '').trim()
      ? path.join(String(process.env.XDG_DATA_HOME).trim(), 'opencode')
      : '',
    String(process.env.LOCALAPPDATA || '').trim()
      ? path.join(String(process.env.LOCALAPPDATA).trim(), 'opencode')
      : '',
    String(process.env.APPDATA || '').trim()
      ? path.join(String(process.env.APPDATA).trim(), 'opencode')
      : '',
    path.join(os.homedir(), '.local', 'share', 'opencode'),
    path.join(os.homedir(), 'Library', 'Application Support', 'opencode'),
  ].filter(Boolean))];
}

function historyWatchPaths(provider: AgentProvider, homePath: string): string[] {
  if (provider === 'codex') {
    return [
      path.join(homePath, 'sessions'),
      path.join(homePath, 'archived_sessions'),
      path.join(homePath, 'session_index.jsonl'),
      path.join(homePath, '.codex-global-state.json'),
      path.join(homePath, 'automations'),
    ];
  }
  if (provider === 'claude') {
    return [path.join(homePath, 'projects'), path.join(homePath, 'history.jsonl')];
  }
  if (provider === 'qoder' || provider === 'qwen') {
    return [path.join(homePath, 'projects')];
  }
  return openCodeDataRoots().flatMap(dataRoot => [
    path.join(dataRoot, 'opencode.db'),
    path.join(dataRoot, 'opencode.db-wal'),
    path.join(dataRoot, 'opencode.db-shm'),
    path.join(dataRoot, 'storage'),
  ]);
}

function appendOnlyHistoryRoots(provider: AgentProvider, homePath: string): string[] {
  if (provider === 'codex') {
    return [path.join(homePath, 'sessions'), path.join(homePath, 'archived_sessions')];
  }
  if (provider === 'claude' || provider === 'qoder' || provider === 'qwen') {
    return [path.join(homePath, 'projects')];
  }
  return [];
}

function sourceKey(
  provider: AgentProvider,
  home: ResolvedProviderHome,
  bindings: ProviderSessionHomeBinding[],
): string {
  const relevantBindings = provider === 'opencode'
    ? bindings
      .filter(binding => normalizeProvider(binding.provider) === provider)
      .map(binding => ({
        homeId: binding.providerHomeId,
        homePath: binding.providerHomePath,
        sessionId: binding.providerSessionId,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : [];
  return JSON.stringify({
    version: 1,
    provider,
    homeId: home.id,
    homePath: path.resolve(home.path),
    bindings: relevantBindings,
  });
}

function selectedHomes(
  provider: AgentProvider,
  configured: ProviderHome[] | undefined,
): ResolvedProviderHome[] {
  const homes = Array.isArray(configured)
    ? configured.flatMap(home => {
      const id = String(home?.id || '').trim();
      const homePath = String(home?.path || '').trim();
      return id && homePath ? [{ id, path: homePath }] : [];
    })
    : [];
  if (provider !== 'opencode') return homes;
  const selected = homes.find(home => home.id === 'default') || homes[0];
  return selected ? [selected] : [];
}

function mergeSessions(groups: AgentSession[][]): AgentSession[] {
  const sessions = new Map<string, AgentSession>();
  for (const group of groups) {
    for (const session of group) {
      const provider = normalizeProvider(session.provider);
      const id = String(session.id || '').trim();
      if (!provider || !id) continue;
      const homeId = String(session.providerHomeId || 'default').trim() || 'default';
      sessions.set(`${provider}\0${homeId}\0${id}`, session);
    }
  }
  return [...sessions.values()].sort(compareAgentSessions).slice(0, INVENTORY_LIMIT);
}

class AgentSessionInventory {
  private readonly cache: AuthoritativeInventoryCache<AgentSession[]>;
  private readonly listSessions: typeof listAgentSessions;
  private revision = 0;

  constructor(options: AgentSessionInventoryOptions) {
    this.listSessions = options.listSessions || listAgentSessions;
    this.cache = new AuthoritativeInventoryCache<AgentSession[]>({
      fingerprintOptions: { maxDepth: 16, maxEntries: 50_000 },
      refreshDebounceMs: 200,
      snapshotFile: options.cacheFile,
    });
  }

  invalidate(): void {
    this.revision += 1;
    this.cache.invalidate();
  }

  close(): Promise<void> {
    return this.cache.close();
  }

  async list(
    metadata: () => AgentSessionInventoryMetadata,
  ): Promise<AgentSession[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = this.revision;
      const current = metadata();
      const bindings = current.providerSessionBindings || [];
      const requests = PROVIDERS.flatMap(provider => (
        selectedHomes(provider, current.providerHomes[provider]).map(home => ({ provider, home }))
      ));
      const activeKeys = new Set<string>();
      const groups = await Promise.all(requests.map(({ provider, home }) => {
        const key = sourceKey(provider, home, bindings);
        activeKeys.add(key);
        const fingerprintPaths = historyWatchPaths(provider, home.path);
        return this.cache.get(key, {
          backgroundRefresh: false,
          fingerprintPaths,
          fingerprintOptions: {
            appendOnlyPrefixBytes: 64 * 1024,
            appendOnlyRoots: appendOnlyHistoryRoots(provider, home.path),
          },
          watchPaths: provider === 'opencode' ? [] : fingerprintPaths,
          sourceMayChangeDuringLoad: provider === 'opencode',
          validate: (value: unknown): value is AgentSession[] => Array.isArray(value),
          load: () => this.listSessions({
            providers: [provider],
            providerHomes: { [provider]: [home] },
            providerSessionBindings: bindings,
            limit: INVENTORY_LIMIT,
            providerLimit: INVENTORY_LIMIT,
            scanLimit: INVENTORY_LIMIT,
          }),
        });
      }));
      if (revision !== this.revision) continue;
      await this.cache.retain(activeKeys);
      return mergeSessions(groups);
    }
    throw new Error('Agent session inventory changed repeatedly while loading');
  }
}

export {
  AgentSessionInventory,
  historyWatchPaths,
};
export type {
  AgentSessionInventoryMetadata,
  AgentSessionInventoryOptions,
};
