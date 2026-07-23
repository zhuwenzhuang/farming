const fs = require('fs');
const path = require('path');
const { findAgentSession } = require('./agent-session-history');
const {
  codexSessionDateKeys,
  listCodexSessionIdentities,
} = require('./codex-session-history');
const { mainPageAgentSessionKey } = require('./main-page-session');
const { isTemporaryProviderSessionId } = require('./provider-session-id');

const CODEX_RESOLVE_COOLDOWN_MS = 1000;
const CODEX_MATCH_WINDOW_MS = 30 * 1000;
const TITLE_RESOLVE_COOLDOWN_MS = 30 * 1000;

function normalizePath(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function canonicalPath(value) {
  const normalized = normalizePath(value);
  if (!normalized) return '';
  try {
    return normalizePath(fs.realpathSync.native(normalized));
  } catch {
    return normalized;
  }
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
    this.listCodexSessionIdentities = options.listCodexSessionIdentities || listCodexSessionIdentities;
    this.findAgentSession = options.findAgentSession || findAgentSession;
    this.resolutions = new Map();
    this.codexIdentityScans = new Map();
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
    this.codexIdentityScans.clear();
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
    const startedAt = Number(agent.startedAt) || 0;
    const codexHome = agent.providerHomePath || '';
    const scanKey = [
      codexHome,
      ...codexSessionDateKeys(startedAt, CODEX_MATCH_WINDOW_MS),
    ].join('\0');
    let scan = this.codexIdentityScans.get(scanKey);
    if (!scan) {
      scan = Promise.resolve(this.listCodexSessionIdentities({
        codexHome: codexHome || undefined,
        startedAt,
        windowMs: CODEX_MATCH_WINDOW_MS,
      })).finally(() => {
        if (this.codexIdentityScans.get(scanKey) === scan) {
          this.codexIdentityScans.delete(scanKey);
        }
      });
      this.codexIdentityScans.set(scanKey, scan);
    }
    const sessions = await scan;
    const workspace = normalizePath(
      agent?.gitWorktree?.workspace || agent?.projectWorkspace || agent?.cwd || ''
    );
    if (!workspace) return null;
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

  confirm(agentId, { provider, sessionId, source, title, workspace }) {
    const current = this.agents.get(agentId);
    const homeId = String(current?.providerHomeId || 'default').trim() || 'default';
    const claimedByAnotherAgent = [...this.agents.values()].some(candidate => (
      candidate?.id !== agentId
      && candidate?.providerSessionProvider === provider
      && candidate?.providerSessionId === sessionId
      && candidate?.providerSessionTemporary !== true
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
      event: { agentId, provider, sessionId, previousSessionId, temporary: false },
      refreshWorkspace: agent.providerSessionWorkspace || '',
    });
    return true;
  }
}

module.exports = { ProviderSessionService };
