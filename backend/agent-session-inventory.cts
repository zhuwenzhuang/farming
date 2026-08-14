import * as os from 'os';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  agentSessionHistoryProviders,
  compareAgentSessions,
  isSafePiSessionId,
  listAgentSessions,
  normalizeProvider,
  readPiSessionMetadata,
  resolvePiSessionSource,
} from './agent-session-history.cjs';
import type {
  AgentProvider,
  AgentSession,
  ProviderListOptions,
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

interface AuthoritativeProviderHome {
  homeId: string;
  homePath: string;
  provider: AgentProvider;
}

interface AgentSessionInventorySnapshot {
  authoritativeHomes: AuthoritativeProviderHome[];
  sessions: AgentSession[];
}

interface ResolvedProviderHome {
  id: string;
  path: string;
}

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

interface InventoryProviderPolicy {
  applyActivity?: (
    sessions: AgentSession[],
    activity: Map<string, SessionActivity>,
    previousActivity: Map<string, SessionActivity> | undefined,
    sourceIdentityChanged: () => void,
  ) => Promise<AgentSession[]>;
  activityDirectoryDepth: number;
  appendOnlyRoots: (homePath: string) => string[];
  appendTolerantPaths: (homePath: string) => string[];
  bindingsAffectSource?: boolean;
  enrichWithAppendOnlyActivity?: boolean;
  fingerprintDepth: number;
  resolveSource?: (homePath: string) => Promise<ResolvedInventorySource>;
  loadPresentation?: (
    sessions: AgentSession[],
    homePath: string,
  ) => Promise<AgentSession[]>;
  singleHome?: boolean;
  sourceMayChangeDuringLoad?: boolean;
  watchPaths: (homePath: string) => string[];
}

interface ResolvedInventorySource {
  activityDirectoryDepth: number;
  activityRoots: string[];
  appendOnlyIdentityOnly?: boolean;
  appendOnlyRoots: string[];
  fingerprintDepth: number;
  fingerprintPaths: string[];
  listOptions?: Pick<ProviderListOptions, 'piSessionSource'>;
}

interface SessionActivity {
  filePath: string;
  mtimeMs: number;
  size: number;
}

const INVENTORY_PROVIDER_POLICIES = {
  codex: {
    activityDirectoryDepth: 3,
    appendOnlyRoots: homePath => [
      path.join(homePath, 'sessions'),
      path.join(homePath, 'archived_sessions'),
    ],
    appendTolerantPaths: homePath => [path.join(homePath, 'session_index.jsonl')],
    enrichWithAppendOnlyActivity: true,
    fingerprintDepth: 4,
    loadPresentation: async (sessions, homePath) => applyCodexSessionPresentation(
      sessions,
      await readCodexSessionPresentation(homePath),
    ),
    watchPaths: homePath => [
      path.join(homePath, 'sessions'),
      path.join(homePath, 'archived_sessions'),
      path.join(homePath, 'session_index.jsonl'),
      path.join(homePath, 'automations'),
    ],
  },
  claude: {
    activityDirectoryDepth: 1,
    appendOnlyRoots: homePath => [path.join(homePath, 'projects')],
    appendTolerantPaths: homePath => [path.join(homePath, 'history.jsonl')],
    enrichWithAppendOnlyActivity: true,
    fingerprintDepth: 2,
    watchPaths: homePath => [path.join(homePath, 'projects'), path.join(homePath, 'history.jsonl')],
  },
  opencode: {
    activityDirectoryDepth: 1,
    appendOnlyRoots: () => [],
    appendTolerantPaths: () => [],
    bindingsAffectSource: true,
    fingerprintDepth: 4,
    singleHome: true,
    sourceMayChangeDuringLoad: true,
    watchPaths: () => openCodeDataRoots().flatMap(dataRoot => [
      path.join(dataRoot, 'opencode.db'),
      path.join(dataRoot, 'opencode.db-wal'),
      path.join(dataRoot, 'opencode.db-shm'),
      path.join(dataRoot, 'storage'),
    ]),
  },
  pi: {
    applyActivity: applyPiSessionActivity,
    activityDirectoryDepth: 1,
    appendOnlyRoots: homePath => [path.join(homePath, 'sessions')],
    appendTolerantPaths: () => [],
    enrichWithAppendOnlyActivity: true,
    fingerprintDepth: 2,
    resolveSource: async homePath => {
      const source = await resolvePiSessionSource(homePath);
      const root = source?.root || '';
      const custom = source?.layout === 'custom';
      return {
        activityDirectoryDepth: custom ? 0 : 1,
        activityRoots: root ? [root] : [],
        appendOnlyIdentityOnly: true,
        appendOnlyRoots: root ? [root] : [],
        fingerprintDepth: custom ? 1 : 2,
        fingerprintPaths: [path.join(homePath, 'settings.json'), root].filter(Boolean),
        listOptions: { piSessionSource: source },
      };
    },
    watchPaths: homePath => [path.join(homePath, 'settings.json'), path.join(homePath, 'sessions')],
  },
  qoder: {
    activityDirectoryDepth: 1,
    appendOnlyRoots: homePath => [path.join(homePath, 'projects')],
    appendTolerantPaths: () => [],
    enrichWithAppendOnlyActivity: true,
    fingerprintDepth: 2,
    watchPaths: homePath => [path.join(homePath, 'projects')],
  },
  qwen: {
    activityDirectoryDepth: 2,
    appendOnlyRoots: homePath => [path.join(homePath, 'projects')],
    appendTolerantPaths: () => [],
    enrichWithAppendOnlyActivity: true,
    fingerprintDepth: 3,
    watchPaths: homePath => [path.join(homePath, 'projects')],
  },
} satisfies Record<AgentProvider, InventoryProviderPolicy>;

function inventoryProviderPolicy(provider: AgentProvider): InventoryProviderPolicy {
  return INVENTORY_PROVIDER_POLICIES[provider];
}

function historyWatchPaths(provider: AgentProvider, homePath: string): string[] {
  return inventoryProviderPolicy(provider).watchPaths(homePath);
}

function appendOnlyHistoryRoots(provider: AgentProvider, homePath: string): string[] {
  return inventoryProviderPolicy(provider).appendOnlyRoots(homePath);
}

function appendTolerantHistoryPaths(provider: AgentProvider, homePath: string): string[] {
  return inventoryProviderPolicy(provider).appendTolerantPaths(homePath);
}

function historyFingerprintDepth(provider: AgentProvider): number {
  return inventoryProviderPolicy(provider).fingerprintDepth;
}

function historyActivityDirectoryDepth(provider: AgentProvider): number {
  return inventoryProviderPolicy(provider).activityDirectoryDepth;
}

async function resolveInventorySource(
  provider: AgentProvider,
  homePath: string,
): Promise<ResolvedInventorySource> {
  const policy = inventoryProviderPolicy(provider);
  if (policy.resolveSource) return policy.resolveSource(homePath);
  return {
    activityDirectoryDepth: historyActivityDirectoryDepth(provider),
    activityRoots: appendOnlyHistoryRoots(provider, homePath),
    appendOnlyRoots: appendOnlyHistoryRoots(provider, homePath),
    fingerprintDepth: historyFingerprintDepth(provider),
    fingerprintPaths: historyWatchPaths(provider, homePath),
  };
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

function sessionIdFromHistoryFile(provider: AgentProvider, fileName: string): string {
  if (provider === 'pi') {
    const match = fileName.match(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(.+)\.jsonl$/);
    const id = String(match?.[1] || '').trim();
    return isSafePiSessionId(id) ? id : '';
  }
  return fileName.match(SESSION_FILE_ID)?.[1] || '';
}

async function appendOnlySessionActivity(
  provider: AgentProvider,
  homePath: string,
  options: {
    maxDirectoryDepth?: number;
    roots?: string[];
  } = {},
): Promise<Map<string, SessionActivity>> {
  const activity = new Map<string, SessionActivity>();
  const maxDirectoryDepth = options.maxDirectoryDepth ?? historyActivityDirectoryDepth(provider);
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDirectoryDepth || visited >= 50_000) return;
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
        if (depth < maxDirectoryDepth) await visit(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const id = sessionIdFromHistoryFile(provider, entry.name);
      if (!id) continue;
      try {
        const stat = await fsp.stat(candidate);
        const current = activity.get(id);
        if (!current || stat.mtimeMs >= current.mtimeMs) {
          activity.set(id, { filePath: candidate, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      } catch (caught) {
        const error = caught as NodeJS.ErrnoException;
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw caught;
      }
    }
  };
  await Promise.all((options.roots || appendOnlyHistoryRoots(provider, homePath)).map(root => visit(root, 0)));
  return activity;
}

function applySessionActivity(
  sessions: AgentSession[],
  activity: Map<string, SessionActivity>,
): AgentSession[] {
  return sessions.map(session => {
    const id = String(session.id || '').trim();
    const mtimeMs = activity.get(id)?.mtimeMs || 0;
    if (mtimeMs <= Date.parse(String(session.updatedAt || session.createdAt || ''))) return session;
    return { ...session, updatedAt: new Date(mtimeMs).toISOString() };
  }).sort(compareAgentSessions);
}

function activityChanged(
  current: SessionActivity,
  previous: SessionActivity | undefined,
): boolean {
  return Boolean(previous) && (
    current.filePath !== previous?.filePath
    || current.mtimeMs !== previous.mtimeMs
    || current.size !== previous.size
  );
}

async function applyPiSessionActivity(
  sessions: AgentSession[],
  activity: Map<string, SessionActivity>,
  previousActivity: Map<string, SessionActivity> | undefined,
  sourceIdentityChanged: () => void,
): Promise<AgentSession[]> {
  const updated = await Promise.all(sessions.map(async session => {
    const id = String(session.id || '').trim();
    const current = activity.get(id);
    if (!current) return session;
    const cachedUpdatedAt = Date.parse(String(session.updatedAt || session.createdAt || ''));
    const shouldRefresh = activityChanged(current, previousActivity?.get(id))
      || (!previousActivity && current.mtimeMs > (Number.isFinite(cachedUpdatedAt) ? cachedUpdatedAt : 0));
    if (!shouldRefresh) return session;

    const metadata = await readPiSessionMetadata(current.filePath);
    if (!metadata || metadata.id !== id) {
      sourceIdentityChanged();
      return null;
    }
    const mtimeIso = current.mtimeMs > 0 ? new Date(current.mtimeMs).toISOString() : '';
    const updatedAt = Date.parse(mtimeIso) > Date.parse(metadata.updatedAt)
      ? mtimeIso
      : (metadata.updatedAt || mtimeIso);
    return {
      ...session,
      createdAt: metadata.createdAt,
      cwd: metadata.cwd,
      projectless: !metadata.workspace,
      title: metadata.title,
      updatedAt,
      workspace: metadata.workspace,
    };
  }));
  return updated.filter((session): session is AgentSession => session !== null).sort(compareAgentSessions);
}

function sourceKey(
  provider: AgentProvider,
  home: ResolvedProviderHome,
  bindings: ProviderSessionHomeBinding[],
): string {
  const relevantBindings = inventoryProviderPolicy(provider).bindingsAffectSource === true
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
  if (inventoryProviderPolicy(provider).singleHome !== true) return homes;
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

async function providerHomeAvailable(homePath: string): Promise<boolean> {
  try {
    return (await fsp.stat(homePath)).isDirectory();
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException;
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw caught;
  }
}

class AgentSessionInventory {
  private readonly activitySnapshots = new Map<string, Map<string, SessionActivity>>();
  private readonly cache: AuthoritativeInventoryCache<AgentSession[]>;
  private readonly listSessions: typeof listAgentSessions;
  private pendingSnapshot: Promise<AgentSessionInventorySnapshot> | null = null;
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

  list(
    metadata: () => AgentSessionInventoryMetadata,
  ): Promise<AgentSession[]> {
    return this.snapshot(metadata).then(snapshot => snapshot.sessions);
  }

  snapshot(
    metadata: () => AgentSessionInventoryMetadata,
  ): Promise<AgentSessionInventorySnapshot> {
    if (this.pendingSnapshot) return this.pendingSnapshot;
    const pending = this.load(metadata);
    this.pendingSnapshot = pending;
    const clearPending = () => {
      if (this.pendingSnapshot === pending) this.pendingSnapshot = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  private async load(
    metadata: () => AgentSessionInventoryMetadata,
  ): Promise<AgentSessionInventorySnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = this.revision;
      const current = metadata();
      const bindings = current.providerSessionBindings || [];
      const requests = agentSessionHistoryProviders().flatMap(provider => (
        selectedHomes(provider, current.providerHomes[provider]).map(home => ({ provider, home }))
      ));
      const activeKeys = new Set<string>();
      let sourceIdentityChanged = false;
      const groups = await Promise.all(requests.map(({ provider, home }) => {
        const policy = inventoryProviderPolicy(provider);
        const key = sourceKey(provider, home, bindings);
        activeKeys.add(key);
        return (async () => {
          const [source, homeAvailable] = await Promise.all([
            resolveInventorySource(provider, home.path),
            providerHomeAvailable(home.path),
          ]);
          const cached = this.cache.get(key, {
            backgroundRefresh: false,
            fingerprintPaths: source.fingerprintPaths,
            fingerprintOptions: {
              appendOnlyIdentityOnly: source.appendOnlyIdentityOnly,
              appendOnlyPrefixBytes: 64 * 1024,
              appendOnlyRoots: source.appendOnlyRoots,
              appendTolerantPaths: appendTolerantHistoryPaths(provider, home.path),
              maxDepth: source.fingerprintDepth,
            },
            watchPaths: [],
            sourceMayChangeDuringLoad: policy.sourceMayChangeDuringLoad === true,
            validate: (value: unknown): value is AgentSession[] => Array.isArray(value),
            load: () => this.listSessions({
              providers: [provider],
              providerHomes: { [provider]: [home] },
              providerSessionBindings: bindings,
              limit: INVENTORY_LIMIT,
              providerLimit: INVENTORY_LIMIT,
              scanLimit: INVENTORY_LIMIT,
              ...(source.listOptions || {}),
            }),
          });
          if (policy.enrichWithAppendOnlyActivity !== true) {
            const sessions = await cached;
            const homeStillAvailable = homeAvailable && await providerHomeAvailable(home.path);
            return {
              authoritative: homeStillAvailable && sessions.length < INVENTORY_LIMIT,
              home,
              provider,
              sessions,
            };
          }
          const [sessions, activity] = await Promise.all([
            cached,
            appendOnlySessionActivity(provider, home.path, {
              maxDirectoryDepth: source.activityDirectoryDepth,
              roots: source.activityRoots,
            }),
          ]);
          const presented = policy.loadPresentation
            ? await policy.loadPresentation(sessions, home.path)
            : sessions;
          const result = policy.applyActivity
            ? await policy.applyActivity(
              presented,
              activity,
              this.activitySnapshots.get(key),
              () => {
                sourceIdentityChanged = true;
                this.cache.invalidate(key);
              },
            )
            : applySessionActivity(presented, activity);
          this.activitySnapshots.set(key, activity);
          const homeStillAvailable = homeAvailable && await providerHomeAvailable(home.path);
          return {
            authoritative: homeStillAvailable && result.length < INVENTORY_LIMIT,
            home,
            provider,
            sessions: result,
          };
        })();
      }));
      if (sourceIdentityChanged) continue;
      if (revision !== this.revision) continue;
      await this.cache.retain(activeKeys);
      for (const key of this.activitySnapshots.keys()) {
        if (!activeKeys.has(key)) this.activitySnapshots.delete(key);
      }
      const sessions = mergeSessions(groups.map(group => group.sessions));
      return {
        authoritativeHomes: sessions.length < INVENTORY_LIMIT
          ? groups.flatMap(group => group.authoritative ? [{
              provider: group.provider,
              homeId: group.home.id,
              homePath: group.home.path,
          }] : [])
          : [],
        sessions,
      };
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
  AgentSessionInventorySnapshot,
  AgentSessionInventoryMetadata,
  AgentSessionInventoryOptions,
  AuthoritativeProviderHome,
};
