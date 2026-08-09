'use strict';

import { parseCommand } from './cli-agents.cjs';

import { getProviderAdapter, providerForProgram } from './provider-adapters.cjs';
import { isSafeProviderSessionId } from './provider-session-id.cjs';
import { decodeResumedProviderSessionSource } from '../shared/provider-session-identity.js';
import type {
  AgentProviderSessionPlan,
  AgentProviderSessionPlanOptions,
  ExactResumeSession,
} from './agent-manager-provider-types.js';

function sessionFromExactResumeSource(source: unknown): ExactResumeSession | null {
  const decoded = decodeResumedProviderSessionSource(source);
  if (!decoded || decoded.forked) return null;
  if (!getProviderAdapter(decoded.provider) || !isSafeProviderSessionId(decoded.sessionId)) return null;
  return {
    provider: decoded.provider,
    providerHomeId: decoded.providerHomeId,
    sessionId: decoded.sessionId,
  };
}

function emptyPlan(args: string[]): AgentProviderSessionPlan {
  return {
    provider: '',
    id: '',
    precreate: false,
    temporary: false,
    source: '',
    forkedFromProviderSessionId: '',
    identityWorkspace: '',
    resumeInsertIndex: null,
    error: '',
    args,
  };
}

function buildAgentProviderSessionPlan(
  { command, program, args, source }: AgentProviderSessionPlanOptions = {},
): AgentProviderSessionPlan {
  const sourceSession = sessionFromExactResumeSource(source);
  const rawParts = parseCommand(command) as string[];
  const provider = sourceSession?.provider || providerForProgram(rawParts[0] || program);
  const launchArgs = Array.isArray(args) ? args : [];
  const adapter = getProviderAdapter(provider);
  if (!adapter) return emptyPlan(launchArgs);

  if (sourceSession) {
    return {
      provider,
      id: sourceSession.sessionId,
      providerHomeId: sourceSession.providerHomeId,
      precreate: false,
      temporary: false,
      source: 'resume-source',
      forkedFromProviderSessionId: '',
      args: launchArgs,
    };
  }

  const plan = adapter.planSession(rawParts.slice(1), launchArgs);
  if (plan?.error) {
    return {
      ...emptyPlan(launchArgs),
      provider,
      error: String(plan.error),
    };
  }
  if (!plan || (!plan.id && plan.precreate !== true)) return emptyPlan(launchArgs);
  return {
    provider,
    id: plan.id || '',
    precreate: plan.precreate === true,
    temporary: plan.temporary === true,
    source: plan.source || '',
    forkedFromProviderSessionId: plan.forkedFromProviderSessionId || '',
    identityWorkspace: plan.identityWorkspace || '',
    resumeInsertIndex: Number.isInteger(plan.resumeInsertIndex) ? plan.resumeInsertIndex : null,
    args: Array.isArray(plan.args) ? plan.args : launchArgs,
  };
}

export {
  buildAgentProviderSessionPlan,
  providerForProgram,
  sessionFromExactResumeSource,
};
