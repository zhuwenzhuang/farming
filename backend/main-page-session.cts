'use strict';

import { isSafeProviderSessionId } from './provider-session-id.cjs';
import { getProviderAdapter } from './provider-adapters.cjs';
import {
  DEFAULT_PROVIDER_HOME_ID,
  canonicalProviderSessionKey,
  decodeProviderSessionKey,
  decodeResumedProviderSessionSource,
  encodeProviderSessionKey,
  encodeResumedProviderSessionSource,
  providerSessionIdentity,
  providerSessionIdentityTupleKey,
  type ProviderSessionIdentity,
} from '../shared/provider-session-identity.js';

interface MainPageAgentSession {
  provider: string;
  providerHomeId: string;
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
  return getProviderAdapter(normalized)?.id || '';
}

function isSafeSessionId(sessionId: unknown): boolean {
  return isSafeProviderSessionId(sessionId);
}

function mainPageAgentSessionKey(
  provider: unknown,
  sessionId: unknown,
  providerHomeId: unknown = '',
): string {
  return encodeProviderSessionKey(
    normalizeMainPageSessionProvider(provider),
    sessionId,
    providerHomeId,
  );
}

function mainPageAgentSessionFromKey(key: unknown): MainPageAgentSession | null {
  const identity = decodeProviderSessionKey(key);
  if (!identity) return null;
  const provider = normalizeMainPageSessionProvider(identity.provider);
  if (!provider || !isSafeSessionId(identity.sessionId)) return null;
  return { provider, providerHomeId: identity.providerHomeId, sessionId: identity.sessionId };
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

    const dedupeKey = providerSessionIdentityTupleKey(session);
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
  return encodeResumedProviderSessionSource(provider, sessionId, providerHomeId);
}

function isActiveAgent(agent: MainPageAgentClaim | null | undefined): boolean {
  return Boolean(agent
    && agent.archived !== true
    && agent.status !== 'dead'
    && agent.status !== 'stopped');
}

function claimedProviderSessionTupleKeys(agent: MainPageAgentClaim): Set<string> {
  const tupleKeys = new Set<string>();
  const add = (identity: ProviderSessionIdentity | null) => {
    if (identity) tupleKeys.add(providerSessionIdentityTupleKey(identity));
  };

  add(decodeProviderSessionKey(agent.providerSessionKey));
  add(providerSessionIdentity(
    agent.providerSessionProvider,
    agent.providerSessionId,
    agent.providerHomeId || DEFAULT_PROVIDER_HOME_ID,
  ));
  const source = decodeResumedProviderSessionSource(agent.source);
  // A forked resume starts a new provider session, so it never claims the origin.
  if (source && !source.forked) add(source);

  return tupleKeys;
}

function findActiveAgentClaimingSession(
  agents: MainPageAgentClaim[] | null | undefined,
  provider: unknown,
  session: ProviderSessionCandidate | null | undefined,
): MainPageAgentClaim | null {
  const normalizedProvider = normalizeMainPageSessionProvider(provider);
  const sessionId = String((session && (session.id || session.sessionId)) || '').trim();
  if (!normalizedProvider || !isSafeSessionId(sessionId) || !Array.isArray(agents)) return null;

  const identity = providerSessionIdentity(
    normalizedProvider,
    sessionId,
    String((session && session.providerHomeId) || DEFAULT_PROVIDER_HOME_ID).trim() || DEFAULT_PROVIDER_HOME_ID,
  );
  if (!identity) return null;
  const tupleKey = providerSessionIdentityTupleKey(identity);

  return agents.find(agent => {
    if (!isActiveAgent(agent)) return false;
    if (agent.providerSessionTemporary === true) return false;
    return claimedProviderSessionTupleKeys(agent).has(tupleKey);
  }) || null;
}

export {
  canonicalProviderSessionKey,
  findActiveAgentClaimingSession,
  mainPageAgentSessionFromKey,
  mainPageAgentSessionKey,
  mainPageAgentSessionsToAutoResume,
  resumedAgentSource,
};
