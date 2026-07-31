import * as os from 'os';
import * as fsp from 'fs/promises';
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

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

interface CodexSessionPresentation {
  pinnedIds: Set<string>;
  projectlessIds: Set<string>;
  unreadIds: Set<string>;
  workspaceHints: Record<string, string>;
}

async function readCodexSessionPresentation(homePath: string): Promise<CodexSessionPresentation | null> {
  let state: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(homePath, '.codex-global-state.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      state = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  const atom = state['electron-persisted-atom-state'];
  const unreadByHost = atom && typeof atom === 'object' && !Array.isArray(atom)
    ? (atom as Record<string, unknown>)['unread-thread-ids-by-host-v1']
    : null;
  const localUnread = unreadByHost && typeof unreadByHost === 'object' && !Array.isArray(unreadByHost)
    ? (unreadByHost as Record<string, unknown>).local
    : null;
  return {
    pinnedIds: stringSet(state['pinned-thread-ids']),
    projectlessIds: stringSet(state['projectless-thread-ids']),
    unreadIds: stringSet(localUnread),
    workspaceHints: stringRecord(state['thread-workspace-root-hints']),
  };
}

function applyCodexSessionPresentation(
  sessions: AgentSession[],
  presentation: CodexSessionPresentation | null,
): AgentSession[] {
  if (!presentation) return sessions;
  return sessions.map(session => {
    const id = String(session.id || '').trim();
    const workspaceHint = String(presentation.workspaceHints[id] || '').trim();
    return {
      ...session,
      pinned: presentation.pinnedIds.has(id),
      projectless: presentation.projectlessIds.has(id),
      unread: presentation.unreadIds.has(id),
      ...(workspaceHint ? { workspace: workspaceHint } : {}),
    };
  });
}

const SESSION_FILE_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

async function appendOnlySessionActivity(
  provider: AgentProvider,
  homePath: string,
): Promise<Map<string, number>> {
  const activity = new Map<string, number>();
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 16 || visited >= 50_000) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (caught) {
      const error = caught as NodeJS.ErrnoException;
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
      throw caught;
    }
    for (const entry of entries) {
      if (visited >= 50_000) return;
      visited += 1;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const id = entry.name.match(SESSION_FILE_ID)?.[1];
      if (!id) continue;
      try {
        const stat = await fsp.stat(candidate);
        activity.set(id, Math.max(activity.get(id) || 0, stat.mtimeMs));
      } catch (caught) {
        const error = caught as NodeJS.ErrnoException;
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw caught;
      }
    }
  };
  await Promise.all(appendOnlyHistoryRoots(provider, homePath).map(root => visit(root, 0)));
  return activity;
}

function applySessionActivity(
  sessions: AgentSession[],
  activity: Map<string, number>,
): AgentSession[] {
  return sessions.map(session => {
    const id = String(session.id || '').trim();
    const mtimeMs = activity.get(id) || 0;
    if (mtimeMs <= Date.parse(String(session.updatedAt || session.createdAt || ''))) return session;
    return { ...session, updatedAt: new Date(mtimeMs).toISOString() };
  }).sort(compareAgentSessions);
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
        const cached = this.cache.get(key, {
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
        if (provider === 'opencode') return cached;
        return Promise.all([
          cached,
          appendOnlySessionActivity(provider, home.path),
          provider === 'codex' ? readCodexSessionPresentation(home.path) : null,
        ]).then(([sessions, activity, presentation]) => applySessionActivity(
          provider === 'codex'
            ? applyCodexSessionPresentation(sessions, presentation)
            : sessions,
          activity,
        ));
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
  applyCodexSessionPresentation,
  applySessionActivity,
  appendOnlySessionActivity,
  historyWatchPaths,
  readCodexSessionPresentation,
};
export type {
  AgentSessionInventoryMetadata,
  AgentSessionInventoryOptions,
};
