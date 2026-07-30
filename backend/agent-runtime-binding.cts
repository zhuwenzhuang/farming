type RuntimeKind = 'terminal' | 'acp' | 'json';

interface RuntimeBindingFields {
  state?: string;
  error?: string;
  stopReason?: string;
  supportsSteer?: boolean;
  supportsFork?: boolean;
  pendingPermission?: unknown;
  pendingPermissions?: unknown[];
  pendingElicitation?: unknown;
  pendingElicitations?: unknown[];
  activeElicitations?: unknown[];
  sessionUpdatedAt?: string;
  sessionRevision?: number;
  events?: unknown[];
  transcriptUpdatedAt?: string;
}

interface TerminalRuntimeBinding extends RuntimeBindingFields {
  kind: 'terminal';
}

interface AcpRuntimeBinding extends RuntimeBindingFields {
  kind: 'acp';
  state: string;
  error: string;
  stopReason: string;
  supportsSteer: boolean;
  supportsFork: boolean;
  pendingPermission: unknown;
  pendingPermissions: unknown[];
  pendingElicitation: unknown;
  pendingElicitations: unknown[];
  activeElicitations: unknown[];
  sessionUpdatedAt: string;
  sessionRevision: number;
}

interface JsonRuntimeBinding extends RuntimeBindingFields {
  kind: 'json';
  state: string;
  error: string;
  transcriptUpdatedAt: string;
  events: unknown[];
}

type RuntimeBinding = TerminalRuntimeBinding | AcpRuntimeBinding | JsonRuntimeBinding;

interface RuntimeBindingSource {
  kind?: unknown;
  state?: string;
  error?: string;
  stopReason?: string;
  supportsSteer?: boolean;
  supportsFork?: boolean;
  pendingPermission?: unknown;
  pendingPermissions?: unknown[];
  pendingElicitation?: unknown;
  pendingElicitations?: unknown[];
  activeElicitations?: unknown[];
  sessionUpdatedAt?: string;
  sessionRevision?: unknown;
  events?: unknown[];
  transcriptUpdatedAt?: string;
  acpState?: string;
  acpError?: string;
  acpStopReason?: string;
  acpPendingPermission?: unknown;
  acpPendingPermissions?: unknown[];
  acpPendingElicitation?: unknown;
  acpPendingElicitations?: unknown[];
  acpActiveElicitations?: unknown[];
  acpSessionUpdatedAt?: string;
  acpSessionRevision?: unknown;
  jsonCliState?: string;
  jsonCliError?: string;
  jsonCliEvents?: unknown[];
  jsonCliTranscriptUpdatedAt?: string;
}

interface RuntimeAgentSource extends RuntimeBindingSource {
  [key: string]: unknown;
  agentRuntimeMode?: string;
  codexRuntimeMode?: string;
  runtimeBinding?: RuntimeBinding | { kind?: string; events?: unknown[] };
  runtimeResumeState?: Record<string, unknown>;
  lifecycleJournal?: unknown;
}

const RUNTIME_KINDS = new Set<RuntimeKind>(['terminal', 'acp', 'json']);

function isRuntimeKind(value: unknown): value is RuntimeKind {
  return typeof value === 'string' && RUNTIME_KINDS.has(value as RuntimeKind);
}

function terminalBinding(): TerminalRuntimeBinding {
  return { kind: 'terminal' };
}

function acpBinding(source: RuntimeBindingSource = {}): AcpRuntimeBinding {
  return {
    kind: 'acp',
    state: source.state || source.acpState || '',
    error: source.error || source.acpError || '',
    stopReason: source.stopReason || source.acpStopReason || '',
    supportsSteer: source.supportsSteer === true,
    supportsFork: source.supportsFork === true,
    pendingPermission: source.pendingPermission || source.acpPendingPermission || null,
    pendingPermissions: source.pendingPermissions || source.acpPendingPermissions || [],
    pendingElicitation: source.pendingElicitation || source.acpPendingElicitation || null,
    pendingElicitations: source.pendingElicitations || source.acpPendingElicitations || [],
    activeElicitations: source.activeElicitations || source.acpActiveElicitations || [],
    sessionUpdatedAt: source.sessionUpdatedAt || source.acpSessionUpdatedAt || '',
    sessionRevision: Number(source.sessionRevision ?? source.acpSessionRevision) || 0,
  };
}

function jsonBinding(source: RuntimeBindingSource = {}): JsonRuntimeBinding {
  return {
    kind: 'json',
    state: source.state || source.jsonCliState || '',
    error: source.error || source.jsonCliError || '',
    transcriptUpdatedAt: source.transcriptUpdatedAt || source.jsonCliTranscriptUpdatedAt || '',
    events: source.events || source.jsonCliEvents || [],
  };
}

function runtimeKind(agent: RuntimeAgentSource | null | undefined): RuntimeKind {
  if (isRuntimeKind(agent?.runtimeBinding?.kind)) return agent.runtimeBinding.kind;
  // App Server was an experimental Codex runtime. Persisted records migrate to
  // ACP because codex-acp uses the same Codex thread id as its session id.
  if (agent?.runtimeBinding?.kind === 'app-server' || agent?.codexRuntimeMode === 'app-server') return 'acp';
  if (agent?.agentRuntimeMode === 'acp') return 'acp';
  if (agent?.agentRuntimeMode === 'json') return 'json';
  return 'terminal';
}

function bindingFromLegacy(agent: RuntimeAgentSource | null | undefined): RuntimeBinding {
  if (isRuntimeKind(agent?.runtimeBinding?.kind)) return agent.runtimeBinding as RuntimeBinding;
  if (agent?.runtimeBinding?.kind === 'app-server' || agent?.codexRuntimeMode === 'app-server') {
    return acpBinding({ state: 'connecting' });
  }
  switch (runtimeKind(agent)) {
    case 'acp': return acpBinding(agent || {});
    case 'json': return jsonBinding(agent || {});
    default: return terminalBinding();
  }
}

function runtimeBindingFor(kind: 'acp', source?: RuntimeBindingSource | null): AcpRuntimeBinding;
function runtimeBindingFor(kind: 'json', source?: RuntimeBindingSource | null): JsonRuntimeBinding;
function runtimeBindingFor(kind: 'terminal', source?: RuntimeBindingSource | null): TerminalRuntimeBinding;
function runtimeBindingFor(kind: unknown, source?: RuntimeBindingSource | null): RuntimeBinding;
function runtimeBindingFor(kind: unknown, source: RuntimeBindingSource | null = {}): RuntimeBinding {
  const normalizedSource = source || {};
  switch (kind) {
    case 'acp': return acpBinding(normalizedSource);
    case 'json': return jsonBinding(normalizedSource);
    default: return terminalBinding();
  }
}

function runtimeBindingOf(
  agent: RuntimeAgentSource | null | undefined,
  expectedKind: 'acp',
): AcpRuntimeBinding | null;
function runtimeBindingOf(
  agent: RuntimeAgentSource | null | undefined,
  expectedKind: 'json',
): JsonRuntimeBinding | null;
function runtimeBindingOf(
  agent: RuntimeAgentSource | null | undefined,
  expectedKind: 'terminal',
): TerminalRuntimeBinding | null;
function runtimeBindingOf(
  agent: RuntimeAgentSource | null | undefined,
  expectedKind?: RuntimeKind,
): RuntimeBinding | null;
function runtimeBindingOf(
  agent: RuntimeAgentSource | null | undefined,
  expectedKind: unknown,
): RuntimeBinding | null;
function runtimeBindingOf(
  agent: RuntimeAgentSource | null | undefined,
  expectedKind?: unknown,
): RuntimeBinding | null {
  const binding = bindingFromLegacy(agent);
  return !expectedKind || (isRuntimeKind(expectedKind) && binding.kind === expectedKind)
    ? binding
    : null;
}

function replaceRuntimeBinding(
  agent: RuntimeAgentSource,
  kind: 'acp',
  source?: RuntimeBindingSource | null,
): AcpRuntimeBinding;
function replaceRuntimeBinding(
  agent: RuntimeAgentSource,
  kind: 'json',
  source?: RuntimeBindingSource | null,
): JsonRuntimeBinding;
function replaceRuntimeBinding(
  agent: RuntimeAgentSource,
  kind: 'terminal',
  source?: RuntimeBindingSource | null,
): TerminalRuntimeBinding;
function replaceRuntimeBinding(
  agent: RuntimeAgentSource,
  kind: unknown,
  source?: RuntimeBindingSource | null,
): RuntimeBinding;
function replaceRuntimeBinding(
  agent: RuntimeAgentSource,
  kind: unknown,
  source: RuntimeBindingSource | null = {},
): RuntimeBinding {
  const binding = runtimeBindingFor(kind, source);
  agent.runtimeBinding = binding;
  return binding;
}

const LEGACY_RUNTIME_FIELDS = [
  'acpState', 'acpError', 'acpStopReason', 'acpPendingPermission', 'acpPendingPermissions',
  'acpPendingElicitation', 'acpPendingElicitations', 'acpActiveElicitations',
  'acpSessionUpdatedAt', 'acpSessionRevision', 'jsonCliState', 'jsonCliError',
  'jsonCliTranscriptUpdatedAt', 'codexAppServerState', 'codexAppServerEndpoint',
  'codexAppServerThreadId', 'codexAppServerTurnId', 'codexAppServerError',
  'codexAppServerPendingRequestId', 'codexAppServerPendingRequestMethod',
  'codexAppServerPendingRequest', 'codexAppServerNotice', 'codexAppServerGoal',
  'codexCliObserverDeferred', 'codexAppServerHomePath', 'codexAppServerTranscriptUpdatedAt',
];

function installRuntimeBinding<T extends RuntimeAgentSource | null | undefined>(agent: T): T {
  if (!agent || typeof agent !== 'object') return agent;
  const runtimeEvents = agent.runtimeBinding && 'events' in agent.runtimeBinding
    ? agent.runtimeBinding.events
    : undefined;
  const jsonResumeEvents = Array.isArray(runtimeEvents)
    ? runtimeEvents
    : (Array.isArray(agent.jsonCliEvents) ? agent.jsonCliEvents : []);
  const binding = bindingFromLegacy(agent);
  agent.runtimeBinding = binding;
  agent.runtimeResumeState = {
    ...(agent.runtimeResumeState || {}),
    jsonEvents: jsonResumeEvents,
  };
  for (const name of ['agentRuntimeMode', 'codexRuntimeMode', 'jsonCliEvents', ...LEGACY_RUNTIME_FIELDS]) {
    delete agent[name];
  }
  return agent;
}

class RuntimeAgentMap extends Map {
  set(key: string, agent: RuntimeAgentSource): this {
    return super.set(key, installRuntimeBinding(agent));
  }
}

function publicRuntimeBinding(
  agent: RuntimeAgentSource | null | undefined,
): RuntimeBinding | Omit<JsonRuntimeBinding, 'events'> {
  const binding = isRuntimeKind(agent?.runtimeBinding?.kind)
    ? agent.runtimeBinding as RuntimeBinding
    : bindingFromLegacy(agent);
  if (binding.kind === 'terminal') return terminalBinding();
  if (binding.kind === 'json') {
    return {
      kind: 'json',
      state: binding.state,
      error: binding.error,
      transcriptUpdatedAt: binding.transcriptUpdatedAt,
    };
  }
  return { ...binding };
}

function runtimeState(agent: RuntimeAgentSource | null | undefined): string {
  const binding = isRuntimeKind(agent?.runtimeBinding?.kind)
    ? agent.runtimeBinding as RuntimeBinding
    : bindingFromLegacy(agent);
  return binding.kind === 'terminal' ? '' : binding.state || '';
}

function legacyRuntimeMetadata(agent: RuntimeAgentSource | null | undefined): Record<string, unknown> {
  const binding = bindingFromLegacy(agent);
  const metadata = {
    agentRuntimeMode: ['acp', 'json'].includes(binding.kind) ? binding.kind : 'terminal',
  };
  if (binding.kind === 'acp') {
    return {
      ...metadata,
      acpState: binding.state,
      acpError: binding.error,
      acpStopReason: binding.stopReason,
      acpPendingPermission: binding.pendingPermission,
      acpPendingPermissions: binding.pendingPermissions,
      acpPendingElicitation: binding.pendingElicitation,
      acpPendingElicitations: binding.pendingElicitations,
      acpActiveElicitations: binding.activeElicitations,
      acpSessionUpdatedAt: binding.sessionUpdatedAt,
      acpSessionRevision: binding.sessionRevision,
    };
  }
  if (binding.kind === 'json') {
    return {
      ...metadata,
      jsonCliState: binding.state,
      jsonCliError: binding.error,
      jsonCliTranscriptUpdatedAt: binding.transcriptUpdatedAt,
    };
  }
  return metadata;
}

export {
  RuntimeAgentMap,
  installRuntimeBinding,
  legacyRuntimeMetadata,
  publicRuntimeBinding,
  replaceRuntimeBinding,
  runtimeBindingFor,
  runtimeBindingOf,
  runtimeKind,
  runtimeState,
};
