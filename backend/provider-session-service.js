const path = require('path');
const { findAgentSession } = require('./agent-session-history');
const { listCodexSessions } = require('./codex-session-history');
const { isLinkedWorktreeOf } = require('./git-worktree-info');
const { mainPageAgentSessionKey } = require('./main-page-session');
const { isTemporaryProviderSessionId } = require('./provider-session-id');

const CODEX_RESOLVE_COOLDOWN_MS = 1000;
const CODEX_MATCH_GRACE_MS = 30 * 1000;
const TITLE_RESOLVE_COOLDOWN_MS = 30 * 1000;

function normalizePath(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

class ProviderSessionService {
  constructor(options = {}) {
    this.agents = options.agents || new Map();
    this.getProviderHomes = options.getProviderHomes || (() => undefined);
    this.commit = options.commit || (() => {});
    this.listCodexSessions = options.listCodexSessions || listCodexSessions;
    this.findAgentSession = options.findAgentSession || findAgentSession;
    this.isLinkedWorktreeOf = options.isLinkedWorktreeOf || isLinkedWorktreeOf;
    this.resolutions = new Map();
  }

  activate(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent?.providerSessionProvider || !agent.providerSessionId) return;

    if (agent.providerSessionProvider === 'codex' && agent.providerSessionTemporary === true) {
      this.observe(agentId, { force: true });
      return;
    }

    this.resolutions.delete(`codex:${agentId}`);
    this.commit(agent, { kind: 'known-session' });
    void this.resolveTitle(agentId, { force: true });
  }

  observe(agentId, options = {}) {
    void this.resolveTemporaryCodex(agentId, options);
    void this.resolveTitle(agentId, options);
  }

  stop(agentId) {
    this.resolutions.delete(`codex:${agentId}`);
    this.resolutions.delete(`title:${agentId}`);
  }

  dispose() {
    this.resolutions.clear();
  }

  bindConfirmed(agentId, provider, sessionId) {
    const agent = this.agents.get(agentId);
    if (!agent || !provider || !sessionId || isTemporaryProviderSessionId(sessionId)) return null;
    agent.providerSessionProvider = provider;
    agent.providerSessionId = sessionId;
    agent.providerSessionKey = mainPageAgentSessionKey(provider, sessionId, agent.providerHomeId || '');
    agent.providerSessionTemporary = false;
    return agent;
  }

  runResolution(kind, agentId, cooldownMs, force, task) {
    const key = `${kind}:${agentId}`;
    const current = this.resolutions.get(key);
    if (current?.promise) return current.promise;
    const now = Date.now();
    if (!force && current && now - current.lastAttemptAt < cooldownMs) {
      return Promise.resolve(false);
    }

    const resolution = { lastAttemptAt: now, promise: null };
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

  resolveTemporaryCodex(agentId, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.providerSessionProvider !== 'codex' || agent.providerSessionTemporary !== true) {
      this.resolutions.delete(`codex:${agentId}`);
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

  resolveTitle(agentId, options = {}) {
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

  async findTemporaryCodexSession(agent) {
    const sessions = await this.listCodexSessions({
      codexHome: agent.providerHomePath || undefined,
      limit: 100,
      scanLimit: 1000,
    });
    const workspace = normalizePath(
      agent?.gitWorktree?.workspace || agent?.projectWorkspace || agent?.cwd || ''
    );
    const startedAt = Number(agent.startedAt) || 0;
    const homeId = String(agent.providerHomeId || 'default').trim() || 'default';
    const claimedSessionIds = new Set([...this.agents.values()]
      .filter(candidate => candidate?.id !== agent.id
        && candidate?.providerSessionProvider === 'codex'
        && (String(candidate.providerHomeId || 'default').trim() || 'default') === homeId
        && candidate.providerSessionId
        && candidate.providerSessionTemporary !== true)
      .map(candidate => candidate.providerSessionId));
    const candidates = sessions
      .filter(session => {
        if (!session?.id || claimedSessionIds.has(session.id)) return false;
        const sessionWorkspace = normalizePath(session.workspace || session.cwd);
        if (workspace && !sessionWorkspace) return false;
        const sessionTime = timestampMs(session.createdAt || session.updatedAt);
        if (!sessionTime || !startedAt) return true;
        return sessionTime >= startedAt - CODEX_MATCH_GRACE_MS;
      })
      .sort((a, b) => {
        const aTime = timestampMs(a.createdAt || a.updatedAt);
        const bTime = timestampMs(b.createdAt || b.updatedAt);
        const aDistance = startedAt && aTime ? Math.abs(aTime - startedAt) : Number.MAX_SAFE_INTEGER;
        const bDistance = startedAt && bTime ? Math.abs(bTime - startedAt) : Number.MAX_SAFE_INTEGER;
        if (aDistance !== bDistance) return aDistance - bDistance;
        return bTime - aTime;
      });

    const exact = candidates.find(session => (
      !workspace || workspace === normalizePath(session.workspace || session.cwd)
    ));
    if (exact) return exact;
    if (!workspace) return candidates[0] || null;

    for (const session of candidates.slice(0, 12)) {
      const sessionWorkspace = normalizePath(session.workspace || session.cwd);
      if (!sessionWorkspace) continue;
      if (await this.isLinkedWorktreeOf(workspace, sessionWorkspace)) return session;
    }
    return null;
  }

  confirm(agentId, { provider, sessionId, source, title, workspace }) {
    const previousSessionId = this.agents.get(agentId)?.providerSessionId || '';
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
      event: { agentId, provider, sessionId, previousSessionId, temporary: false },
      refreshWorkspace: agent.providerSessionWorkspace || '',
    });
    return true;
  }
}

module.exports = { ProviderSessionService };
