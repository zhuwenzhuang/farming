'use strict';

const { parseCommand } = require('./cli-agents');
const { getProviderAdapter, providerForProgram } = require('./provider-adapters.cjs');
const { isSafeProviderSessionId } = require('./provider-session-id.cjs');

interface AgentProviderSessionPlan {
  provider: string;
  id: string;
  precreate: boolean;
  temporary: boolean;
  source: string;
  forkedFromProviderSessionId: string;
  providerHomeId?: string;
  identityWorkspace?: string;
  resumeInsertIndex?: number | null;
  error?: string;
  args: string[];
}

interface ExactResumeSession {
  provider: string;
  providerHomeId: string;
  sessionId: string;
}

interface AgentProviderSessionOptions {
  command?: string;
  program?: string;
  args?: string[];
  source?: string;
}

function sessionFromExactResumeSource(source: unknown): ExactResumeSession | null {
  const match = String(source || '').match(/^([a-z0-9_-]+)-history:(?:home:([A-Za-z0-9._-]+):)?([A-Za-z0-9._:-]+)$/);
  if (!match || !getProviderAdapter(match[1]) || !isSafeProviderSessionId(match[3])) return null;
  return {
    provider: match[1],
    providerHomeId: match[2] || 'default',
    sessionId: match[3],
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
  { command, program, args, source }: AgentProviderSessionOptions = {},
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
    id: plan.id,
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
