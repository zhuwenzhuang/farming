'use strict';

import * as path from 'path';

const { parseCommand } = require('./cli-agents');
const { isSafeProviderSessionId } = require('./provider-session-id.cjs');

const AUTO_RESUME_AGENT_SESSION_PROVIDERS = new Set(['codex', 'claude', 'opencode', 'qoder', 'qwen']);

interface MainPageAgentSession {
  provider: string;
  providerHomeId?: string;
  sessionId: string;
}

interface MainPageSettings {
  mainPageSessionKeys?: unknown;
}

interface MainPageAgentClaim {
  id?: string;
  archived?: boolean;
  status?: string;
  cwd?: string;
  projectWorkspace?: string;
  gitWorktree?: { workspace?: string };
  providerSessionTemporary?: boolean;
  providerSessionKey?: string;
  providerSessionProvider?: string;
  providerSessionId?: string;
  providerHomeId?: string;
  source?: string;
}

interface ProviderSessionCandidate {
  id?: unknown;
  sessionId?: unknown;
  providerHomeId?: unknown;
}

function normalizeMainPageSessionProvider(provider: unknown): string {
  const normalized = String(provider || '').trim().toLowerCase();
  return AUTO_RESUME_AGENT_SESSION_PROVIDERS.has(normalized) ? normalized : '';
}

function isSafeSessionId(sessionId: unknown): boolean {
  return isSafeProviderSessionId(sessionId);
}

function mainPageAgentSessionKey(
  provider: unknown,
  sessionId: unknown,
  providerHomeId: unknown = '',
): string {
  const normalizedProvider = normalizeMainPageSessionProvider(provider);
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedProvider || !normalizedSessionId) return '';
  const homeId = String(providerHomeId || '').trim();
  if (homeId && homeId !== 'default') return `agent-session:${normalizedProvider}:home:${homeId}:${normalizedSessionId}`;
  return `agent-session:${normalizedProvider}:${normalizedSessionId}`;
}

function mainPageAgentSessionFromKey(key: unknown): MainPageAgentSession | null {
  const match = String(key || '').match(/^agent-session:([^:]+):(.+)$/);
  if (!match) return null;

  const provider = normalizeMainPageSessionProvider(match[1]);
  let providerHomeId = 'default';
  let sessionId = String(match[2] || '').trim();
  const homeMatch = sessionId.match(/^home:([A-Za-z0-9._-]+):(.+)$/);
  if (homeMatch) {
    providerHomeId = homeMatch[1];
    sessionId = String(homeMatch[2] || '').trim();
  }
  if (!provider || !isSafeSessionId(sessionId)) {
    return null;
  }

  return providerHomeId && providerHomeId !== 'default'
    ? { provider, providerHomeId, sessionId }
    : { provider, sessionId };
}

function mainPageAgentSessionsToAutoResume(
  settings: MainPageSettings | null | undefined,
): MainPageAgentSession[] {
  const keys = Array.isArray(settings?.mainPageSessionKeys)
    ? settings.mainPageSessionKeys
    : [];
  const seen = new Set<string>();
  const sessions: MainPageAgentSession[] = [];

  keys.forEach((key) => {
    const session = mainPageAgentSessionFromKey(key);
    if (!session) return;

    const dedupeKey = `${session.provider}:${session.providerHomeId || 'default'}:${session.sessionId}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    sessions.push(session);
  });

  return sessions;
}

function resumedAgentSource(
  provider: unknown,
  sessionId: unknown,
  providerHomeId: unknown = '',
): string {
  const homeId = String(providerHomeId || '').trim();
  return homeId && homeId !== 'default'
    ? `${provider}-history:home:${homeId}:${sessionId}`
    : `${provider}-history:${sessionId}`;
}

function mainPageSessionProviderForCommand(command: unknown): string {
  const executable = (parseCommand(command) as string[])
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  const basename = path.basename(executable || '');
  if (basename === 'qodercli') return 'qoder';
  if (basename === 'qwen') return 'qwen';
  return normalizeMainPageSessionProvider(basename);
}

function isActiveAgent(agent: MainPageAgentClaim | null | undefined): boolean {
  return Boolean(agent
    && agent.archived !== true
    && agent.status !== 'dead'
    && agent.status !== 'stopped');
}

function findActiveAgentClaimingSession(
  agents: MainPageAgentClaim[] | null | undefined,
  provider: unknown,
  session: ProviderSessionCandidate | null | undefined,
): MainPageAgentClaim | null {
  const normalizedProvider = normalizeMainPageSessionProvider(provider);
  const sessionId = String((session && (session.id || session.sessionId)) || '').trim();
  if (!normalizedProvider || !isSafeSessionId(sessionId) || !Array.isArray(agents)) return null;

  const providerHomeId = String((session && session.providerHomeId) || 'default').trim() || 'default';
  const sessionKey = mainPageAgentSessionKey(normalizedProvider, sessionId, providerHomeId);
  const legacySessionKey = mainPageAgentSessionKey(normalizedProvider, sessionId);
  const exactSource = resumedAgentSource(normalizedProvider, sessionId, providerHomeId);
  const legacySource = resumedAgentSource(normalizedProvider, sessionId);

  return agents.find(agent => {
    if (!isActiveAgent(agent)) return false;
    if (agent.providerSessionTemporary === true) return false;
    if (agent.providerSessionKey === sessionKey || (providerHomeId === 'default' && agent.providerSessionKey === legacySessionKey)) return true;
    if (
      agent.providerSessionProvider === normalizedProvider
      && agent.providerSessionId === sessionId
      && (String(agent.providerHomeId || 'default').trim() || 'default') === providerHomeId
    ) {
      return true;
    }
    return agent.source === exactSource || (providerHomeId === 'default' && agent.source === legacySource);
  }) || null;
}

export {
  AUTO_RESUME_AGENT_SESSION_PROVIDERS,
  findActiveAgentClaimingSession,
  mainPageAgentSessionFromKey,
  mainPageAgentSessionKey,
  mainPageAgentSessionsToAutoResume,
  mainPageSessionProviderForCommand,
  resumedAgentSource,
};
