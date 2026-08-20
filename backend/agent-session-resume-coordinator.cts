import type { AgentSession } from './agent-session-history.cjs';
import {
  buildAgentSessionResumeCommand,
  isSafeSessionId,
  normalizeProvider,
  providerHistoryAutoResumeErrorIsStale,
  providerHistorySupportsUnarchive,
} from './agent-session-history.cjs';
import {
  findActiveAgentClaimingSession,
  mainPageAgentSessionKey,
  mainPageAgentSessionsToAutoResume,
  resumedAgentSource,
} from './main-page-session.cjs';
import { providerConversationForkCapability, providerSessionResumeOptions } from './provider-adapters.cjs';

interface ResumeOptions {
  acpHistoryMode?: string;
  agentRuntimeMode?: string;
  allowUnarchiveArchived?: boolean;
  asMain?: boolean;
  autoReadInitialAttention?: boolean;
  customTitle?: string;
  fork?: boolean;
  providerHomeId?: string;
  rememberMainPageSession?: boolean;
}

interface ResumeAgentResult {
  agentId?: string;
  archived?: boolean;
  claimed?: boolean;
  error?: string;
  pending?: boolean;
  projectWorkspace?: string;
  reused?: boolean;
  status?: number;
}

interface ResumeHttpBody extends Record<string, unknown> {
  acpHistoryMode?: unknown;
  agentRuntimeMode?: unknown;
  asMain?: unknown;
  customTitle?: unknown;
  fork?: unknown;
  providerHomeId?: unknown;
  unarchiveArchived?: unknown;
}

interface ResumeHttpReply {
  body: Record<string, unknown>;
  status: number;
}

interface ProviderHome {
  id: string;
  path: string;
}

type ProviderHomes = Record<string, ProviderHome[]>;

interface ProviderSessionAvailabilityOptions extends Record<string, unknown> {
  cwd: string;
  providerHomeId: string;
  providerHomePath: string;
  providerHomes: ProviderHomes;
}

type EnsureProviderSessionAvailable = (
  options: ProviderSessionAvailabilityOptions,
) => Promise<{ error?: string } | null | undefined>;

interface ResumeAgentClaim {
  archived?: boolean;
  cwd?: string;
  gitWorktree?: { workspace?: string };
  id?: string;
  projectWorkspace?: string;
  providerHomeId?: string;
  providerSessionId?: string;
  providerSessionKey?: string;
  providerSessionProvider?: string;
  providerSessionTemporary?: boolean;
  source?: string;
  status?: string;
}

interface PersistedSessionRecord extends Record<string, unknown> {
  attentionOutputEpoch?: unknown;
  attentionOutputSeq?: unknown;
  attentionReason?: unknown;
  attentionSeq?: unknown;
  attentionUpdatedAt?: unknown;
  customTitle?: unknown;
  followUp?: unknown;
  id?: unknown;
  pinned?: unknown;
  pinnedOrder?: unknown;
  projectOrder?: unknown;
  projectWorkspace?: unknown;
  providerSessionTitle?: unknown;
  readAttentionAt?: unknown;
  readAttentionSeq?: unknown;
  readOutputEpoch?: unknown;
  readOutputSeq?: unknown;
  task?: unknown;
  workflowTemplate?: unknown;
}

interface ResumeStartOptions extends Record<string, unknown> {
  acpHistoryMode: 'load' | 'resume';
  agentRuntimeMode: 'chat' | 'terminal';
  attentionOutputEpoch?: unknown;
  attentionOutputSeq?: unknown;
  attentionReason?: unknown;
  attentionSeq: number;
  attentionUpdatedAt?: unknown;
  autoReadInitialAttention: boolean;
  customTitle: string;
  customTitleExplicit: boolean;
  followUp: boolean;
  persistentSessionId: string;
  pinned: boolean;
  pinnedOrder?: unknown;
  preserveProviderSessionProfile?: boolean;
  projectOrder?: unknown;
  projectWorkspace: string;
  providerHomeId: string;
  providerHomePath: string;
  providerSessionTitle: string;
  readAttentionAt?: unknown;
  readAttentionSeq: number;
  readOutputEpoch?: unknown;
  readOutputSeq?: unknown;
  requiredCliVersion?: string;
  source: string;
  task: string;
  wantsMain: boolean;
  workflowTemplate: string;
}

interface ProjectMembership {
  pinnedProjectWorkspaces: string[];
  projectWorkspaces: string[];
}

interface ResumeSettings extends Partial<ProjectMembership> {
  mainPageSessionKeys?: unknown;
}

interface AgentSessionResumeCoordinatorPorts {
  archiveNewAgent(agentId: string): Promise<{ error?: string } | null | undefined>;
  canonicalProjectWorkspace(workspace: string | null): Promise<string>;
  configuredProviderHomes(): ProviderHomes;
  currentAgentSessions(): Promise<AgentSession[]>;
  ensureProviderSessionAvailable(
    provider: string,
    sessionId: string,
    options: ProviderSessionAvailabilityOptions,
  ): Promise<{ error?: string } | null | undefined>;
  findAgentSession(provider: string, sessionId: string, options: {
    limit: number;
    providerHomeId: string;
    providerHomes: ProviderHomes;
    providerLimit: number;
    scanLimit: number;
  }): Promise<AgentSession | null>;
  getActiveAgents(): ResumeAgentClaim[];
  getMainPageSessionKeys(): string[];
  getSavedAgentSession(provider: string, sessionId: string, providerHomeId: string): PersistedSessionRecord | null;
  getSettings(): ResumeSettings;
  mountProjectWorkspace(workspace: string): ProjectMembership;
  publishAgentState(): void;
  rememberMainPageSession(provider: string, sessionId: string, providerHomeId: string): void;
  removeMainPageSession(provider: string, sessionId: string, providerHomeId: string): void;
  runProviderSessionResumeAdmission<Result>(
    provider: string,
    sessionId: string,
    providerHomeId: string,
    operation: (ensureAvailable: EnsureProviderSessionAvailable) => Promise<Result>,
  ): Promise<Result>;
  startAgent(
    command: string,
    workspace: string | null,
    callback: (agentId: string | null, error?: string | null) => void,
    options: ResumeStartOptions,
  ): Promise<string | null>;
  waitForAgentRecovery(): Promise<unknown>;
  warn(...args: unknown[]): void;
}

function caughtMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isMainAgentSessionWorkspace(session: AgentSession | null) {
  const values = [session?.cwd, session?.workspace];
  return values.some(value => {
    const normalized = String(value || '').trim().replace(/[\\/]+$/, '');
    return normalized === '~/.farming' || /(^|[/\\])\.farming$/.test(normalized);
  });
}

const PROVIDER_HOME_ID_RE = /^[A-Za-z0-9._-]+$/;

interface ResumeIdentity {
  provider: string;
  providerHomeId: string;
  sessionId: string;
}

type ResumeIdentityResolution =
  | { failure: ResumeAgentResult; identity?: undefined }
  | { failure?: undefined; identity: ResumeIdentity };

interface ResumeAdmission {
  identity: ResumeIdentity | null;
  joined: boolean;
  result: ResumeAgentResult;
}

interface PendingResumeAdmission<Result> {
  promise: Promise<Result>;
  signature: string;
}

type PendingResumeAdmissions<Result> = Map<
  string,
  Map<string, Map<string, PendingResumeAdmission<Result>>>
>;

type ResumeAdmissionTicket<Result> =
  | { conflict: true; joined?: undefined; promise?: undefined }
  | { conflict?: undefined; joined: boolean; promise: Promise<Result> };

function normalizedResumeOptions(options: ResumeOptions) {
  const shouldFork = options.fork === true;
  const requestedAsMain = options.asMain === true && !shouldFork;
  return {
    acpHistoryMode: options.acpHistoryMode === 'resume' ? 'resume' : 'load',
    agentRuntimeMode: options.agentRuntimeMode === 'chat' || options.agentRuntimeMode === 'acp' ? 'chat' : 'terminal',
    allowUnarchiveArchived: options.allowUnarchiveArchived === true,
    autoReadInitialAttention: options.autoReadInitialAttention === true,
    customTitle: Object.prototype.hasOwnProperty.call(options, 'customTitle')
      ? [true, typeof options.customTitle === 'string' ? options.customTitle : '']
      : [false, ''],
    fork: shouldFork,
    asMain: requestedAsMain,
  };
}

function resumeAdmissionSignature(identity: ResumeIdentity, options: ResumeOptions) {
  return JSON.stringify({
    provider: identity.provider,
    providerHomeId: identity.providerHomeId,
    sessionId: identity.sessionId,
    ...normalizedResumeOptions(options),
  });
}

function resolveResumeIdentity(
  provider: unknown,
  rawSessionId: unknown,
  rawProviderHomeId: unknown,
): ResumeIdentityResolution {
  const normalizedProvider = normalizeProvider(provider);
  const sessionId = String(rawSessionId || '').trim();
  if (!normalizedProvider || !isSafeSessionId(sessionId)) {
    return { failure: { error: 'invalid session id', status: 400 } };
  }
  const requestedProviderHomeId = typeof rawProviderHomeId === 'string' ? rawProviderHomeId.trim() : '';
  const providerHomeId = requestedProviderHomeId || 'default';
  if (!PROVIDER_HOME_ID_RE.test(providerHomeId)) {
    return { failure: { error: 'invalid provider home id', status: 400 } };
  }
  return { identity: { provider: normalizedProvider, providerHomeId, sessionId } };
}

function httpResumeOptions(requestBody: ResumeHttpBody): ResumeOptions {
  const shouldFork = requestBody.fork === true;
  const requestedAsMain = requestBody.asMain === true && !shouldFork;
  return {
    acpHistoryMode: requestBody.acpHistoryMode === 'resume' ? 'resume' : 'load',
    agentRuntimeMode: requestBody.agentRuntimeMode === 'chat' || requestBody.agentRuntimeMode === 'acp' ? 'chat' : 'terminal',
    allowUnarchiveArchived: requestBody.unarchiveArchived === true && !shouldFork && !requestedAsMain,
    asMain: requestedAsMain,
    fork: shouldFork,
    providerHomeId: typeof requestBody.providerHomeId === 'string' ? requestBody.providerHomeId : '',
    ...(Object.prototype.hasOwnProperty.call(requestBody, 'customTitle')
      ? { customTitle: requestBody.customTitle as string }
      : {}),
  };
}

function followerResumeHttpReply(reply: ResumeHttpReply): ResumeHttpReply {
  if (reply.status >= 400) return reply;
  return { status: 200, body: { ...reply.body, reused: true, pending: true } };
}

function followerResumeResult(reply: ResumeHttpReply): ResumeAgentResult {
  if (reply.status >= 400) {
    return { error: stringValue(reply.body.error) || 'failed to resume agent session', status: reply.status };
  }
  const agentId = stringValue(reply.body.agentId);
  if (!agentId) return { error: 'Agent session resume returned no Agent identity', status: 500 };
  return {
    agentId,
    projectWorkspace: stringValue(reply.body.projectWorkspace),
    reused: true,
    pending: true,
    ...(reply.body.claimed === true ? { claimed: true } : {}),
  };
}

function projectMembership(settings: ResumeSettings): ProjectMembership {
  return {
    projectWorkspaces: Array.isArray(settings.projectWorkspaces) ? settings.projectWorkspaces : [],
    pinnedProjectWorkspaces: Array.isArray(settings.pinnedProjectWorkspaces) ? settings.pinnedProjectWorkspaces : [],
  };
}

class AgentSessionResumeCoordinator {
  readonly #pendingHttpResumes: PendingResumeAdmissions<ResumeHttpReply> = new Map();
  readonly #pendingStartResumes: PendingResumeAdmissions<ResumeAgentResult> = new Map();
  readonly ports: AgentSessionResumeCoordinatorPorts;

  constructor(ports: AgentSessionResumeCoordinatorPorts) {
    this.ports = ports;
  }

  #findClaimingAgent(provider: string, sessionId: string, providerHomeId: string, session?: AgentSession | null) {
    return findActiveAgentClaimingSession(this.ports.getActiveAgents(), provider, {
      id: sessionId,
      providerHomeId,
      ...(session || {}),
    });
  }

  async #lookupSession(provider: string, sessionId: string, providerHomeId: string, providerHomes: ProviderHomes) {
    return this.ports.findAgentSession(provider, sessionId, {
      limit: 1000,
      providerLimit: 1000,
      scanLimit: 5000,
      providerHomeId,
      providerHomes,
    });
  }

  #pendingAdmission<Result>(
    admissions: PendingResumeAdmissions<Result>,
    provider: string,
    providerHomeId: string,
    sessionId: string,
  ) {
    return admissions.get(provider)?.get(providerHomeId)?.get(sessionId);
  }

  #setPendingAdmission<Result>(
    admissions: PendingResumeAdmissions<Result>,
    provider: string,
    providerHomeId: string,
    sessionId: string,
    admission: PendingResumeAdmission<Result>,
  ) {
    const byHome = admissions.get(provider) || new Map<string, Map<string, PendingResumeAdmission<Result>>>();
    const bySession = byHome.get(providerHomeId) || new Map<string, PendingResumeAdmission<Result>>();
    bySession.set(sessionId, admission);
    byHome.set(providerHomeId, bySession);
    admissions.set(provider, byHome);
  }

  #clearPendingAdmission<Result>(
    admissions: PendingResumeAdmissions<Result>,
    provider: string,
    providerHomeId: string,
    sessionId: string,
    admission: PendingResumeAdmission<Result>,
  ) {
    const byHome = admissions.get(provider);
    const bySession = byHome?.get(providerHomeId);
    if (!bySession || bySession.get(sessionId) !== admission) return;
    bySession.delete(sessionId);
    if (bySession.size === 0) byHome?.delete(providerHomeId);
    if (byHome?.size === 0) admissions.delete(provider);
  }

  #admit<Result>(
    admissions: PendingResumeAdmissions<Result>,
    provider: string,
    providerHomeId: string,
    sessionId: string,
    signature: string,
    operation: () => Promise<Result>,
  ): ResumeAdmissionTicket<Result> {
    const existing = this.#pendingAdmission(admissions, provider, providerHomeId, sessionId);
    if (existing) {
      if (existing.signature !== signature) return { conflict: true };
      return { joined: true, promise: existing.promise };
    }
    const admission: PendingResumeAdmission<Result> = {
      signature,
      promise: Promise.resolve().then(operation),
    };
    this.#setPendingAdmission(admissions, provider, providerHomeId, sessionId, admission);
    void admission.promise.finally(() => {
      this.#clearPendingAdmission(admissions, provider, providerHomeId, sessionId, admission);
    }).catch(() => {});
    return { joined: false, promise: admission.promise };
  }

  async #startNewAgent(
    identity: ResumeIdentity,
    options: ResumeOptions,
    ensureAvailable?: EnsureProviderSessionAvailable,
  ): Promise<ResumeAgentResult> {
    const { provider, providerHomeId, sessionId } = identity;
    const shouldFork = options.fork === true;
    const requestedAsMain = options.asMain === true && !shouldFork;
    const providerHomes = this.ports.configuredProviderHomes();
    let session = await this.#lookupSession(provider, sessionId, providerHomeId, providerHomes);
    if (options.allowUnarchiveArchived === true && providerHistorySupportsUnarchive(provider) && !requestedAsMain) {
      const configuredHomePath = (providerHomes[provider] || [])
        .find(home => home.id === providerHomeId)?.path || '';
      const availabilityOptions = {
        providerHomeId,
        providerHomePath: session?.providerHomePath || configuredHomePath,
        providerHomes,
        cwd: session?.cwd || session?.workspace || '',
      };
      const unarchiveResult = ensureAvailable
        ? await ensureAvailable(availabilityOptions)
        : await this.ports.ensureProviderSessionAvailable(provider, sessionId, availabilityOptions);
      if (unarchiveResult?.error) return { error: unarchiveResult.error };
      session = await this.#lookupSession(provider, sessionId, providerHomeId, providerHomes)
        || (session ? { ...session, archived: false } : session);
    }
    if (session?.archived && !shouldFork) {
      this.ports.removeMainPageSession(provider, sessionId, providerHomeId);
      return {
        error: `${session.providerName || provider} session is archived. Unarchive it before resuming.`,
        status: 409,
        archived: true,
      };
    }
    if (!shouldFork && !requestedAsMain) {
      const claimingAgent = this.#findClaimingAgent(provider, sessionId, providerHomeId, session);
      if (claimingAgent) {
        const projectWorkspace = await this.ports.canonicalProjectWorkspace(
          claimingAgent.gitWorktree?.workspace || claimingAgent.projectWorkspace || claimingAgent.cwd || null,
        );
        return { agentId: claimingAgent.id, projectWorkspace, reused: true, claimed: true };
      }
    }

    const resumeAsMain = requestedAsMain && isMainAgentSessionWorkspace(session);
    if (requestedAsMain && !resumeAsMain) {
      return { error: 'session is not a Main Agent session', status: 400 };
    }

    const savedSession = shouldFork
      ? null
      : this.ports.getSavedAgentSession(provider, sessionId, session?.providerHomeId || providerHomeId);
    const hasRequestedCustomTitle = Object.prototype.hasOwnProperty.call(options, 'customTitle');
    const savedAttentionSeq = Number(savedSession?.attentionSeq) || 0;
    const savedReadAttentionSeq = Number(savedSession?.readAttentionSeq) || 0;
    const workingDirectory = session?.cwd || session?.workspace || null;
    const projectWorkspace = resumeAsMain
      ? ''
      : await this.ports.canonicalProjectWorkspace(
        String(savedSession?.projectWorkspace || session?.workspace || session?.cwd || workingDirectory || ''),
      );
    const command = buildAgentSessionResumeCommand(provider, sessionId, {
      fork: shouldFork,
      cwd: workingDirectory,
      providerHomePath: session?.providerHomePath || '',
    });
    if (!command) return { error: 'invalid session id', status: 400 };

    const resolvedProviderHomeId = session?.providerHomeId || providerHomeId;
    const resumeSource = resumedAgentSource(provider, sessionId, resolvedProviderHomeId);
    const startOptions: ResumeStartOptions = {
      wantsMain: resumeAsMain,
      task: stringValue(savedSession?.task) || session?.title || '',
      workflowTemplate: stringValue(savedSession?.workflowTemplate),
      customTitle: hasRequestedCustomTitle
        ? (typeof options.customTitle === 'string' ? options.customTitle : '')
        : stringValue(savedSession?.customTitle),
      customTitleExplicit: hasRequestedCustomTitle,
      projectWorkspace,
      source: shouldFork ? resumeSource.replace('-history:', '-history-fork:') : resumeSource,
      agentRuntimeMode: options.agentRuntimeMode === 'chat' || options.agentRuntimeMode === 'acp' ? 'chat' : 'terminal',
      acpHistoryMode: options.acpHistoryMode === 'resume' ? 'resume' : 'load',
      providerHomeId: resolvedProviderHomeId,
      providerHomePath: session?.providerHomePath || '',
      providerSessionTitle: session?.title || stringValue(savedSession?.providerSessionTitle),
      persistentSessionId: stringValue(savedSession?.id),
      followUp: shouldFork ? false : savedSession?.followUp === true,
      pinned: savedSession?.pinned === true,
      projectOrder: savedSession?.projectOrder,
      pinnedOrder: savedSession?.pinnedOrder,
      attentionSeq: savedAttentionSeq,
      readAttentionSeq: savedReadAttentionSeq,
      attentionUpdatedAt: savedSession?.attentionUpdatedAt,
      readAttentionAt: savedSession?.readAttentionAt,
      attentionReason: savedSession?.attentionReason,
      attentionOutputEpoch: savedSession?.attentionOutputEpoch,
      attentionOutputSeq: savedSession?.attentionOutputSeq,
      readOutputEpoch: savedSession?.readOutputEpoch,
      readOutputSeq: savedSession?.readOutputSeq,
      autoReadInitialAttention: options.autoReadInitialAttention === true && savedAttentionSeq <= savedReadAttentionSeq,
      ...providerSessionResumeOptions(provider, {
        preserveProfile: true,
        requiredCliVersion: session?.cliVersion || '',
      }),
    };

    return new Promise<ResumeAgentResult>((resolve) => {
      let settled = false;
      const settle = (result: ResumeAgentResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let started: Promise<string | null>;
      try {
        started = this.ports.startAgent(command, workingDirectory, (agentId, error) => {
          if (error) {
            settle({ error, status: 400 });
            return;
          }
          if (!agentId) {
            settle({ error: 'failed to resume agent session', status: 500 });
            return;
          }
          settle({ agentId, projectWorkspace });
        }, startOptions);
      } catch (error) {
        settle({ error: caughtMessage(error) || 'failed to resume agent session', status: 500 });
        return;
      }
      void started.then(agentId => {
        if (agentId) {
          settle({ agentId, projectWorkspace });
          return;
        }
        settle({ error: 'failed to resume agent session', status: 500 });
      }, error => {
        settle({ error: caughtMessage(error) || 'failed to resume agent session', status: 500 });
      });
    });
  }

  #followPendingHttpResume(
    identity: ResumeIdentity,
    options: ResumeOptions,
  ): Promise<ResumeAgentResult> | null {
    const owner = this.#pendingAdmission(
      this.#pendingHttpResumes,
      identity.provider,
      identity.providerHomeId,
      identity.sessionId,
    );
    if (!owner) return null;
    if (owner.signature !== resumeAdmissionSignature(identity, options)) {
      return Promise.resolve({
        error: 'A different resume request is already in progress for this Agent session',
        status: 409,
      });
    }
    return owner.promise.then(followerResumeResult, error => ({
      error: caughtMessage(error) || 'failed to resume agent session',
      status: 500,
    }));
  }

  async #resumeCore(provider: string, rawSessionId: string, options: ResumeOptions = {}): Promise<ResumeAdmission> {
    const resolved = resolveResumeIdentity(provider, rawSessionId, options.providerHomeId);
    if (resolved.failure) return { identity: null, joined: false, result: resolved.failure };
    const identity = resolved.identity;

    const shouldFork = options.fork === true;
    if (shouldFork && providerConversationForkCapability(identity.provider, 'terminal').supported !== true) {
      return {
        identity,
        joined: false,
        result: { error: `${identity.provider} does not support session Fork`, status: 400 },
      };
    }
    const requestedAsMain = options.asMain === true && !shouldFork;
    if (!shouldFork) {
      const existingAgent = this.#findClaimingAgent(identity.provider, identity.sessionId, identity.providerHomeId);
      if (existingAgent) {
        try {
          const projectWorkspace = requestedAsMain
            ? ''
            : await this.ports.canonicalProjectWorkspace(
              existingAgent.gitWorktree?.workspace || existingAgent.projectWorkspace || existingAgent.cwd || null,
            );
          return { identity, joined: false, result: { agentId: existingAgent.id, projectWorkspace, reused: true } };
        } catch (error) {
          return { identity, joined: false, result: { error: caughtMessage(error), status: 500 } };
        }
      }
    }
    const startOptions: ResumeOptions = {
      ...options,
      fork: shouldFork,
      asMain: requestedAsMain,
      providerHomeId: identity.providerHomeId,
    };
    const start = shouldFork
      ? () => this.#startNewAgent(identity, startOptions)
      : () => this.ports.runProviderSessionResumeAdmission(
          identity.provider,
          identity.sessionId,
          identity.providerHomeId,
          ensureAvailable => this.#startNewAgent(identity, startOptions, ensureAvailable),
        );
    const pending = this.#admit(
      this.#pendingStartResumes,
      identity.provider,
      identity.providerHomeId,
      identity.sessionId,
      resumeAdmissionSignature(identity, startOptions),
      start,
    );
    if (pending.conflict) {
      return {
        identity,
        joined: false,
        result: { error: 'A different resume request is already in progress for this Agent session', status: 409 },
      };
    }
    const result = await pending.promise.catch(error => ({
      error: caughtMessage(error) || 'failed to resume agent session',
      status: 500,
    }));
    return { identity, joined: pending.joined, result };
  }

  async resume(provider: string, rawSessionId: string, options: ResumeOptions = {}): Promise<ResumeAgentResult> {
    const resolved = resolveResumeIdentity(provider, rawSessionId, options.providerHomeId);
    if (resolved.failure) return resolved.failure;
    const followed = this.#followPendingHttpResume(resolved.identity, options);
    if (followed) return followed;
    const admission = await this.#resumeCore(provider, rawSessionId, options);
    const result = admission.result;
    const identity = admission.identity;
    if (result.error || !identity) return result;
    const shouldFork = options.fork === true;
    const requestedAsMain = options.asMain === true && !shouldFork;
    const shouldRememberMainPageSession = options.rememberMainPageSession !== false && !shouldFork && !requestedAsMain;
    try {
      if (shouldRememberMainPageSession) {
        this.ports.rememberMainPageSession(identity.provider, identity.sessionId, identity.providerHomeId);
      }
    } catch (error) {
      return { error: caughtMessage(error), status: 500 };
    }
    const projectWorkspace = result.projectWorkspace || '';
    if (admission.joined) {
      return {
        agentId: result.agentId,
        projectWorkspace,
        reused: true,
        pending: true,
        ...(result.claimed ? { claimed: true } : {}),
      };
    }
    if (result.reused) {
      return {
        agentId: result.agentId,
        projectWorkspace,
        reused: true,
        ...(result.claimed ? { claimed: true } : {}),
      };
    }
    return { agentId: result.agentId, projectWorkspace };
  }

  async #resumeHttpOperation(
    identity: ResumeIdentity,
    options: ResumeOptions,
  ): Promise<ResumeHttpReply> {
    const shouldFork = options.fork === true;
    const requestedAsMain = options.asMain === true && !shouldFork;
    const shouldRememberMainPageSession = !shouldFork && !requestedAsMain;
    const sessionKey = mainPageAgentSessionKey(identity.provider, identity.sessionId, identity.providerHomeId);
    const mainPageSessionWasRemembered = shouldRememberMainPageSession
      && this.ports.getMainPageSessionKeys().includes(sessionKey);
    const admission = await this.#resumeCore(identity.provider, identity.sessionId, options);
    const result = admission.result;
    if (result.error) return { status: result.status || 400, body: { error: result.error } };
    if (!result.agentId) return { status: 500, body: { error: 'Agent session resume returned no Agent identity' } };
    const reused = result.reused === true || admission.joined;

    if (shouldRememberMainPageSession) {
      this.ports.rememberMainPageSession(identity.provider, identity.sessionId, identity.providerHomeId);
    }

    let membership = projectMembership(this.ports.getSettings());
    try {
      if (!requestedAsMain && result.projectWorkspace) {
        membership = this.ports.mountProjectWorkspace(result.projectWorkspace);
      }
    } catch (error) {
      let rollbackError = '';
      if (!reused) {
        try {
          const rollback = await this.ports.archiveNewAgent(result.agentId);
          if (rollback?.error) rollbackError = rollback.error;
        } catch (cleanupError) {
          rollbackError = caughtMessage(cleanupError);
        }
      }
      if (!reused && !rollbackError && !mainPageSessionWasRemembered) {
        this.ports.removeMainPageSession(identity.provider, identity.sessionId, identity.providerHomeId);
      }
      this.ports.publishAgentState();
      const mountError = caughtMessage(error) || 'Failed to create Project';
      return {
        status: 500,
        body: {
          error: rollbackError ? `${mountError}. Rollback failed: ${rollbackError}` : mountError,
          ...(rollbackError ? { rollbackError } : {}),
        },
      };
    }
    this.ports.publishAgentState();
    if (reused) {
      return {
        status: 200,
        body: {
          agentId: result.agentId,
          ...(result.projectWorkspace ? { projectWorkspace: result.projectWorkspace } : {}),
          projectWorkspaces: membership.projectWorkspaces,
          pinnedProjectWorkspaces: membership.pinnedProjectWorkspaces,
          reused: true,
          ...(result.claimed ? { claimed: true } : {}),
          ...(admission.joined ? { pending: true } : {}),
        },
      };
    }
    return {
      status: 201,
      body: {
        agentId: result.agentId,
        ...(result.projectWorkspace ? { projectWorkspace: result.projectWorkspace } : {}),
        projectWorkspaces: membership.projectWorkspaces,
        pinnedProjectWorkspaces: membership.pinnedProjectWorkspaces,
      },
    };
  }

  async resumeHttp(provider: string, rawSessionId: string, body: ResumeHttpBody | undefined): Promise<ResumeHttpReply> {
    const requestBody = body || {};
    if (Object.prototype.hasOwnProperty.call(requestBody, 'customTitle') && typeof requestBody.customTitle !== 'string') {
      return { status: 400, body: { error: 'customTitle must be a string' } };
    }
    const options = httpResumeOptions(requestBody);
    const resolved = resolveResumeIdentity(provider, rawSessionId, options.providerHomeId);
    if (resolved.failure) {
      return { status: resolved.failure.status || 400, body: { error: resolved.failure.error || 'invalid session id' } };
    }
    const identity = resolved.identity;
    const pending = this.#admit(
      this.#pendingHttpResumes,
      identity.provider,
      identity.providerHomeId,
      identity.sessionId,
      resumeAdmissionSignature(identity, options),
      () => this.#resumeHttpOperation(identity, options),
    );
    if (pending.conflict) {
      return { status: 409, body: { error: 'A different resume request is already in progress for this Agent session' } };
    }
    const reply = await pending.promise.catch(error => ({
      status: 500,
      body: { error: caughtMessage(error) },
    }));
    return pending.joined ? followerResumeHttpReply(reply) : reply;
  }

  async autoResumeMainPageAgentSessions() {
    try {
      await this.ports.waitForAgentRecovery();
    } catch (error) {
      this.ports.warn('Skipping main-page Agent session auto-resume after failed lifecycle recovery:', caughtMessage(error));
      return;
    }
    const sessions = mainPageAgentSessionsToAutoResume(this.ports.getSettings());
    if (sessions.length === 0) return;

    let knownSessions: AgentSession[];
    try {
      knownSessions = await this.ports.currentAgentSessions();
    } catch (error) {
      this.ports.warn('Failed to load Agent session catalog for auto-resume:', caughtMessage(error));
      return;
    }
    const knownByKey = new Map(knownSessions.map(session => [
      mainPageAgentSessionKey(session.provider, session.id, session.providerHomeId || 'default'),
      session,
    ]));
    let resumedCount = 0;
    for (const session of sessions) {
      try {
        const providerHomeId = session.providerHomeId || 'default';
        const sessionDetails = knownByKey.get(mainPageAgentSessionKey(session.provider, session.sessionId, providerHomeId));
        if (!sessionDetails) {
          this.ports.warn('Dropping stale main-page session from auto-resume:', session.provider, session.sessionId);
          this.ports.removeMainPageSession(session.provider, session.sessionId, providerHomeId);
          continue;
        }
        if (this.#findClaimingAgent(session.provider, session.sessionId, providerHomeId, sessionDetails)) continue;
        const result = await this.resume(session.provider, session.sessionId, {
          rememberMainPageSession: false,
          providerHomeId,
          autoReadInitialAttention: true,
        });
        if (result.error) {
          if (providerHistoryAutoResumeErrorIsStale(session.provider, result.error)) {
            this.ports.warn(`Dropping stale ${session.provider} session from auto-resume:`, session.provider, session.sessionId, result.error);
            this.ports.removeMainPageSession(session.provider, session.sessionId, providerHomeId);
            continue;
          }
          this.ports.warn('Failed to auto-resume main page agent session:', session.provider, session.sessionId, result.error);
        } else {
          resumedCount += 1;
        }
      } catch (error) {
        this.ports.warn('Failed to auto-resume main page agent session:', session.provider, session.sessionId, caughtMessage(error));
      }
    }
    if (resumedCount > 0) this.ports.publishAgentState();
  }
}

export {
  AgentSessionResumeCoordinator,
  type AgentSessionResumeCoordinatorPorts,
  type ResumeAgentResult,
  type ResumeHttpBody,
};
