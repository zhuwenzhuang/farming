const path = require('path');
const { parseCommand } = require('./cli-agents');
const { isSafeProviderSessionId } = require('./provider-session-id');

const AUTO_RESUME_AGENT_SESSION_PROVIDERS = new Set(['codex', 'claude']);

function normalizeMainPageSessionProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return AUTO_RESUME_AGENT_SESSION_PROVIDERS.has(normalized) ? normalized : '';
}

function isSafeSessionId(sessionId) {
  return isSafeProviderSessionId(sessionId);
}

function mainPageAgentSessionKey(provider, sessionId) {
  return `agent-session:${provider}:${sessionId}`;
}

function mainPageAgentSessionFromKey(key) {
  const match = String(key || '').match(/^agent-session:([^:]+):(.+)$/);
  if (!match) return null;

  const provider = normalizeMainPageSessionProvider(match[1]);
  const sessionId = String(match[2] || '').trim();
  if (!provider || !isSafeSessionId(sessionId)) {
    return null;
  }

  return { provider, sessionId };
}

function mainPageAgentSessionsToAutoResume(settings) {
  const keys = Array.isArray(settings && settings.mainPageSessionKeys)
    ? settings.mainPageSessionKeys
    : [];
  const seen = new Set();
  const sessions = [];

  keys.forEach((key) => {
    const session = mainPageAgentSessionFromKey(key);
    if (!session) return;

    const dedupeKey = `${session.provider}:${session.sessionId}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    sessions.push(session);
  });

  return sessions;
}

function resumedAgentSource(provider, sessionId) {
  return `${provider}-history:${sessionId}`;
}

function mainPageSessionProviderForCommand(command) {
  const executable = parseCommand(command)
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  const basename = path.basename(executable || '');
  return normalizeMainPageSessionProvider(basename);
}

function isActiveAgent(agent) {
  return agent
    && agent.archived !== true
    && agent.status !== 'dead'
    && agent.status !== 'stopped';
}

function findActiveAgentClaimingSession(agents, provider, session) {
  const normalizedProvider = normalizeMainPageSessionProvider(provider);
  const sessionId = String((session && (session.id || session.sessionId)) || '').trim();
  if (!normalizedProvider || !isSafeSessionId(sessionId) || !Array.isArray(agents)) return null;

  const sessionKey = mainPageAgentSessionKey(normalizedProvider, sessionId);
  const exactSource = resumedAgentSource(normalizedProvider, sessionId);
  return agents.find(agent => {
    if (!isActiveAgent(agent)) return false;
    if (agent.providerSessionTemporary === true) return false;
    if (agent.providerSessionKey === sessionKey) return true;
    if (
      agent.providerSessionProvider === normalizedProvider
      && agent.providerSessionId === sessionId
    ) {
      return true;
    }
    return agent.source === exactSource;
  }) || null;
}

module.exports = {
  AUTO_RESUME_AGENT_SESSION_PROVIDERS,
  findActiveAgentClaimingSession,
  mainPageAgentSessionFromKey,
  mainPageAgentSessionKey,
  mainPageAgentSessionsToAutoResume,
  mainPageSessionProviderForCommand,
  resumedAgentSource,
};
