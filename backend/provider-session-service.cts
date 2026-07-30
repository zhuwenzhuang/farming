import * as fs from 'fs';
import * as path from 'path';
import {
  codexSessionDateKeys,
  listCodexSessionIdentities,
} from './codex-session-history.cjs';

import {
  findAgentSession,
  type AgentSessionHistoryOptions,
} from './agent-session-history.cjs';
import { mainPageAgentSessionKey } from './main-page-session.cjs';
import { isTemporaryProviderSessionId } from './provider-session-id.cjs';

const CODEX_RESOLVE_COOLDOWN_MS = 1000;
const CODEX_MATCH_WINDOW_MS = 30 * 1000;
const CODEX_STARTUP_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 12000];
const TITLE_RESOLVE_COOLDOWN_MS = 30 * 1000;

interface GitWorktree {
  workspace?: string;
}

interface ProviderSessionAgent {
  id: string;
  cwd?: string;
  projectWorkspace?: string;
  gitWorktree?: GitWorktree | null;
  providerHomeId?: string;
  providerHomePath?: string;
  providerSessionId?: string;
  providerSessionKey?: string;
  providerSessionProvider?: string;
  providerSessionResolvedAt?: number | null;
  providerSessionSource?: string;
  providerSessionTemporary?: boolean;
  providerSessionTitle?: string;
  providerSessionWorkspace?: string;
  startedAt?: unknown;
}

interface CodexSessionIdentity {
  id?: string;
  createdAt?: string;
  cwd?: string;
  title?: string;
  workspace?: string;
}

interface ProviderHistorySession {
  title?: unknown;
}

interface CodexSessionIdentityOptions {
  codexHome?: string;
  startedAt: number;
  windowMs: number;
}

interface FindAgentSessionOptions {
  limit: number;
  providerLimit: number;
  providerHomeId: string;
  providerHomes: unknown;
}

export interface SessionUpdatedEvent {
  agentId: string;
  provider: string;
  sessionId: string;
  previousSessionId?: string;
  temporary: false;
  title?: string;
}

export interface ProviderSessionChange {
  kind?: 'known-session' | 'session-updated';
  event?: SessionUpdatedEvent;
  refreshWorkspace?: string;
}

interface ProviderSessionAgentStore<Agent extends ProviderSessionAgent = ProviderSessionAgent> {
  get(agentId: string): Agent | undefined;
  values(): IterableIterator<Agent>;
}

type FindAgentSession = typeof findAgentSession;

type ListCodexSessionIdentities = (
  options: CodexSessionIdentityOptions,
) => PromiseLike<CodexSessionIdentity[]> | CodexSessionIdentity[];

interface ProviderSessionServiceOptions<Agent extends ProviderSessionAgent = ProviderSessionAgent> {
  agents?: ProviderSessionAgentStore<Agent>;
  codexStartupRetryDelaysMs?: readonly number[];
  commit?: (agent: Agent, change: ProviderSessionChange) => void;
  findAgentSession?: FindAgentSession;
  getProviderHomes?: () => AgentSessionHistoryOptions['providerHomes'];
  listCodexSessionIdentities?: ListCodexSessionIdentities;
}

interface ResolutionOptions {
  force?: boolean;
}

interface Resolution {
  lastAttemptAt: number;
  promise: Promise<boolean> | null;
}

interface StartupRetry {
  attempt: number;
  deadlineAt: number;
  timer: NodeJS.Timeout | null;
}

interface ConfirmedSession {
  provider: string;
  sessionId: string;
  source?: string;
  title?: string;
  workspace?: string;
}

function normalizePath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function canonicalPath(value: unknown): string {
  const normalized = normalizePath(value);
  if (!normalized) return '';
  try {
    return normalizePath(fs.realpathSync.native(normalized));
  } catch {
    return normalized;
  }
}

function timestampMs(value: unknown): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

class ProviderSessionService<Agent extends ProviderSessionAgent = ProviderSessionAgent> {
  agents: ProviderSessionAgentStore<Agent>;
  getProviderHomes: () => AgentSessionHistoryOptions['providerHomes'];
  commit: (agent: Agent, change: ProviderSessionChange) => void;
  listCodexSessionIdentities: ListCodexSessionIdentities;
  findAgentSession: FindAgentSession;
  codexStartupRetryDelaysMs: readonly number[];
  resolutions: Map<string, Resolution>;
  codexIdentityScans: Map<string, Promise<CodexSessionIdentity[]>>;
  codexStartupRetries: Map<string, StartupRetry>;

  constructor(options: ProviderSessionServiceOptions<Agent> = {}) {
    this.agents = options.agents || new Map<string, Agent>();
    this.getProviderHomes = options.getProviderHomes || (() => undefined);
    this.commit = options.commit || (() => {});
    this.listCodexSessionIdentities = options.listCodexSessionIdentities
      || listCodexSessionIdentities;
    this.findAgentSession = options.findAgentSession || findAgentSession;
    this.codexStartupRetryDelaysMs = Array.isArray(options.codexStartupRetryDelaysMs)
      ? options.codexStartupRetryDelaysMs
      : CODEX_STARTUP_RETRY_DELAYS_MS;
    this.resolutions = new Map<string, Resolution>();
    this.codexIdentityScans = new Map<string, Promise<CodexSessionIdentity[]>>();
    this.codexStartupRetries = new Map<string, StartupRetry>();
  }

  activate(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent?.providerSessionProvider || !agent.providerSessionId) return;

    if (agent.providerSessionProvider === 'codex' && agent.providerSessionTemporary === true) {
      this.observe(agentId, { force: true });
      this.scheduleTemporaryCodexStartupRetry(agentId);
      return;
    }

    this.resolutions.delete(`codex:${agentId}`);
    this.commit(agent, { kind: 'known-session' });
    void this.resolveTitle(agentId, { force: true });
  }

  observe(agentId: string, options: ResolutionOptions = {}): void {
    void this.resolveTemporaryCodex(agentId, options);
    void this.resolveTitle(agentId, options);
  }

  stop(agentId: string): void {
    this.resolutions.delete(`codex:${agentId}`);
    this.resolutions.delete(`title:${agentId}`);
    const startupRetry = this.codexStartupRetries.get(agentId);
    if (startupRetry?.timer) clearTimeout(startupRetry.timer);
    this.codexStartupRetries.delete(agentId);
  }

  dispose(): void {
    for (const startupRetry of this.codexStartupRetries.values()) {
      if (startupRetry?.timer) clearTimeout(startupRetry.timer);
    }
    this.resolutions.clear();
    this.codexIdentityScans.clear();
    this.codexStartupRetries.clear();
  }

  scheduleTemporaryCodexStartupRetry(agentId: string): void {
    if (this.codexStartupRetries.has(agentId)) return;
    const agent = this.agents.get(agentId);
    const retry: StartupRetry = {
      attempt: 0,
      timer: null,
      deadlineAt: (Number(agent?.startedAt) || Date.now()) + CODEX_MATCH_WINDOW_MS,
    };
    this.codexStartupRetries.set(agentId, retry);

    const scheduleNext = (): void => {
      if (this.codexStartupRetries.get(agentId) !== retry) return;
      const currentAgent = this.agents.get(agentId);
      if (
        !currentAgent
        || currentAgent.providerSessionProvider !== 'codex'
        || currentAgent.providerSessionTemporary !== true
      ) {
        this.stop(agentId);
        return;
      }
      const delayMs = Number(this.codexStartupRetryDelaysMs[retry.attempt]);
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        this.codexStartupRetries.delete(agentId);
        return;
      }
      if (Date.now() + delayMs > retry.deadlineAt) {
        this.codexStartupRetries.delete(agentId);
        return;
      }
      retry.attempt += 1;
      retry.timer = setTimeout(async () => {
        retry.timer = null;
        if (
          this.codexStartupRetries.get(agentId) !== retry
          || Date.now() > retry.deadlineAt
        ) {
          if (this.codexStartupRetries.get(agentId) === retry) {
            this.codexStartupRetries.delete(agentId);
          }
          return;
        }
        const resolved = await this.resolveTemporaryCodex(agentId, { force: true });
        if (this.codexStartupRetries.get(agentId) !== retry) return;
        if (resolved) return;
        scheduleNext();
      }, delayMs);
      retry.timer.unref?.();
    };

    scheduleNext();
  }

  bindConfirmed(
    agentId: string,
    provider: string,
    sessionId: string,
  ): Agent | null {
    const agent = this.agents.get(agentId);
    if (!agent || !provider || !sessionId || isTemporaryProviderSessionId(sessionId)) return null;
    agent.providerSessionProvider = provider;
    agent.providerSessionId = sessionId;
    agent.providerSessionKey = mainPageAgentSessionKey(
      provider,
      sessionId,
      agent.providerHomeId || '',
    );
    agent.providerSessionTemporary = false;
    return agent;
  }

  runResolution(
    kind: string,
    agentId: string,
    cooldownMs: number,
    force: boolean,
    task: () => boolean | PromiseLike<boolean>,
  ): Promise<boolean> {
    const key = `${kind}:${agentId}`;
    const current = this.resolutions.get(key);
    if (current?.promise) return current.promise;
    const now = Date.now();
    if (!force && current && now - current.lastAttemptAt < cooldownMs) {
      return Promise.resolve(false);
    }

    const resolution: Resolution = { lastAttemptAt: now, promise: null };
    const attempt = Promise.resolve()
      .then(task)
      .catch(() => false)
      .finally(() => {
        if (this.resolutions.get(key) === resolution) resolution.promise = null;
      });
    resolution.promise = attempt;
    this.resolutions.set(key, resolution);
    return attempt;
  }

  resolveTemporaryCodex(
    agentId: string,
    options: ResolutionOptions = {},
  ): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (
      !agent
      || agent.providerSessionProvider !== 'codex'
      || agent.providerSessionTemporary !== true
    ) {
      this.resolutions.delete(`codex:${agentId}`);
      return Promise.resolve(false);
    }
    const startedAt = Number(agent.startedAt) || 0;
    if (
      options.force !== true
      && startedAt
      && Date.now() > startedAt + CODEX_MATCH_WINDOW_MS
    ) {
      return Promise.resolve(false);
    }

    return this.runResolution(
      'codex',
      agentId,
      CODEX_RESOLVE_COOLDOWN_MS,
      options.force === true,
      () => this.findTemporaryCodexSession(agent).then((session) => {
        if (!session?.id) return false;
        return this.confirm(agentId, {
          provider: 'codex',
          sessionId: session.id,
          source: 'codex-rollout',
          title: session.title || '',
          workspace: session.workspace || session.cwd || '',
        });
      }),
    );
  }

  resolveTitle(
    agentId: string,
    options: ResolutionOptions = {},
  ): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (
      !agent?.providerSessionProvider
      || !agent.providerSessionId
      || agent.providerSessionTemporary === true
      || isTemporaryProviderSessionId(agent.providerSessionId)
      || String(agent.providerSessionTitle || '').trim()
    ) {
      this.resolutions.delete(`title:${agentId}`);
      return Promise.resolve(false);
    }

    const inFlight = this.resolutions.get(`title:${agentId}`);
    if (options.force === true && inFlight?.promise) {
      return inFlight.promise.then(resolved => (
        resolved ? true : this.resolveTitle(agentId, { force: true })
      ));
    }

    const provider = agent.providerSessionProvider;
    const sessionId = agent.providerSessionId;
    return this.runResolution(
      'title',
      agentId,
      TITLE_RESOLVE_COOLDOWN_MS,
      options.force === true,
      () => this.findAgentSession(provider, sessionId, {
        limit: 200,
        providerLimit: 200,
        providerHomeId: agent.providerHomeId || 'default',
        providerHomes: this.getProviderHomes(),
      }).then((session) => {
        const title = String(session?.title || '').trim().slice(0, 160);
        if (!title) return false;

        const current = this.agents.get(agentId);
        if (
          !current
          || current.providerSessionProvider !== provider
          || current.providerSessionId !== sessionId
          || current.providerSessionTemporary === true
          || String(current.providerSessionTitle || '').trim()
        ) {
          return false;
        }

        current.providerSessionTitle = title;
        this.commit(current, {
          kind: 'session-updated',
          event: { agentId, provider, sessionId, title, temporary: false },
        });
        return true;
      }),
    );
  }

  async findTemporaryCodexSession(
    agent: ProviderSessionAgent,
  ): Promise<CodexSessionIdentity | null> {
    const startedAt = Number(agent.startedAt) || 0;
    const codexHome = agent.providerHomePath || '';
    const scanKey = [
      codexHome,
      ...codexSessionDateKeys(startedAt, CODEX_MATCH_WINDOW_MS),
    ].join('\0');
    let scan = this.codexIdentityScans.get(scanKey);
    if (!scan) {
      const newScan = Promise.resolve(this.listCodexSessionIdentities({
        codexHome: codexHome || undefined,
        startedAt,
        windowMs: CODEX_MATCH_WINDOW_MS,
      })).finally(() => {
        if (this.codexIdentityScans.get(scanKey) === newScan) {
          this.codexIdentityScans.delete(scanKey);
        }
      });
      scan = newScan;
      this.codexIdentityScans.set(scanKey, scan);
    }
    const sessions = await scan;
    const workspace = normalizePath(
      agent.projectWorkspace || agent.cwd || agent.gitWorktree?.workspace || '',
    );
    if (!workspace) return null;
    const homeId = String(agent.providerHomeId || 'default').trim() || 'default';
    const claimedSessionIds = new Set(
      [...this.agents.values()]
        .filter(candidate => (
          candidate.id !== agent.id
          && candidate.providerSessionProvider === 'codex'
          && (String(candidate.providerHomeId || 'default').trim() || 'default') === homeId
          && candidate.providerSessionId
          && candidate.providerSessionTemporary !== true
        ))
        .map(candidate => candidate.providerSessionId as string),
    );
    const candidates = sessions.filter(session => {
      if (!session.id || claimedSessionIds.has(session.id)) return false;
      const sessionWorkspace = normalizePath(session.workspace || session.cwd);
      if (workspace && !sessionWorkspace) return false;
      const sessionTime = timestampMs(session.createdAt);
      if (!sessionTime || !startedAt) return false;
      return Math.abs(sessionTime - startedAt) <= CODEX_MATCH_WINDOW_MS;
    });

    const exact = candidates.filter(session => (
      workspace === normalizePath(session.workspace || session.cwd)
    ));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const canonicalWorkspace = canonicalPath(workspace);
    const canonical = candidates.filter(session => (
      canonicalWorkspace === canonicalPath(session.workspace || session.cwd)
    ));
    if (canonical.length === 1) return canonical[0];
    return null;
  }

  confirm(
    agentId: string,
    { provider, sessionId, source, title, workspace }: ConfirmedSession,
  ): boolean {
    const current = this.agents.get(agentId);
    const homeId = String(current?.providerHomeId || 'default').trim() || 'default';
    const claimedByAnotherAgent = [...this.agents.values()].some(candidate => (
      candidate.id !== agentId
      && candidate.providerSessionProvider === provider
      && candidate.providerSessionId === sessionId
      && candidate.providerSessionTemporary !== true
      && (String(candidate.providerHomeId || 'default').trim() || 'default') === homeId
    ));
    if (claimedByAnotherAgent) return false;
    const previousSessionId = current?.providerSessionId || '';
    const agent = this.bindConfirmed(agentId, provider, sessionId);
    if (!agent) return false;
    const providerSessionTitle = String(title || '').trim().slice(0, 160);
    agent.providerSessionSource = source || agent.providerSessionSource || '';
    agent.providerSessionResolvedAt = Date.now();
    if (typeof workspace === 'string' && workspace.trim()) {
      agent.providerSessionWorkspace = normalizePath(workspace);
    }
    if (providerSessionTitle) agent.providerSessionTitle = providerSessionTitle;

    this.stop(agentId);
    this.commit(agent, {
      kind: 'session-updated',
      event: {
        agentId,
        provider,
        sessionId,
        previousSessionId,
        temporary: false,
      },
      refreshWorkspace: agent.providerSessionWorkspace || '',
    });
    return true;
  }
}

export { ProviderSessionService };
