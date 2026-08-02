import * as path from 'path';

import {
  findAgentSession,
  type AgentSessionHistoryOptions,
} from './agent-session-history.cjs';
import { mainPageAgentSessionKey } from './main-page-session.cjs';
import { isTemporaryProviderSessionId } from './provider-session-id.cjs';

const TITLE_RESOLVE_COOLDOWN_MS = 30 * 1000;

interface ProviderSessionAgent {
  id: string;
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
}

interface ProviderHistorySession {
  title?: unknown;
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

interface ProviderSessionServiceOptions<Agent extends ProviderSessionAgent = ProviderSessionAgent> {
  agents?: ProviderSessionAgentStore<Agent>;
  commit?: (agent: Agent, change: ProviderSessionChange) => void;
  findAgentSession?: FindAgentSession;
  getProviderHomes?: () => AgentSessionHistoryOptions['providerHomes'];
}

interface ResolutionOptions {
  force?: boolean;
}

interface Resolution {
  lastAttemptAt: number;
  promise: Promise<boolean> | null;
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

class ProviderSessionService<Agent extends ProviderSessionAgent = ProviderSessionAgent> {
  agents: ProviderSessionAgentStore<Agent>;
  getProviderHomes: () => AgentSessionHistoryOptions['providerHomes'];
  commit: (agent: Agent, change: ProviderSessionChange) => void;
  findAgentSession: FindAgentSession;
  resolutions: Map<string, Resolution>;

  constructor(options: ProviderSessionServiceOptions<Agent> = {}) {
    this.agents = options.agents || new Map<string, Agent>();
    this.getProviderHomes = options.getProviderHomes || (() => undefined);
    this.commit = options.commit || (() => {});
    this.findAgentSession = options.findAgentSession || findAgentSession;
    this.resolutions = new Map<string, Resolution>();
  }

  activate(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent?.providerSessionProvider || !agent.providerSessionId) return;

    if (agent.providerSessionProvider === 'codex' && agent.providerSessionTemporary === true) {
      return;
    }

    this.resolutions.delete(`codex:${agentId}`);
    this.commit(agent, { kind: 'known-session' });
    void this.resolveTitle(agentId, { force: true });
  }

  observe(agentId: string, options: ResolutionOptions = {}): void {
    void this.resolveTitle(agentId, options);
  }

  stop(agentId: string): void {
    this.resolutions.delete(`title:${agentId}`);
  }

  dispose(): void {
    this.resolutions.clear();
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
        ) {
          return false;
        }

        // A provider may expose the first user message before it has persisted
        // the generated thread title. Keep the lookup refreshable so the later
        // authoritative title can replace that fallback.
        if (String(current.providerSessionTitle || '').trim() === title) return true;
        current.providerSessionTitle = title;
        this.commit(current, {
          kind: 'session-updated',
          event: { agentId, provider, sessionId, title, temporary: false },
        });
        return true;
      }),
    );
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
