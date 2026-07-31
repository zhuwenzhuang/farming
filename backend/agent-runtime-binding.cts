type RuntimeKind = 'terminal' | 'acp';
type AgentRuntimeModeRequest = 'terminal' | 'acp' | 'chat';

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

type RuntimeBinding = TerminalRuntimeBinding | AcpRuntimeBinding;

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

const RUNTIME_KINDS = new Set<RuntimeKind>(['terminal', 'acp']);
const AGENT_RUNTIME_MODE_REQUESTS = new Set<AgentRuntimeModeRequest>(['terminal', 'acp', 'chat']);

function isRuntimeKind(value: unknown): value is RuntimeKind {
  return typeof value === 'string' && RUNTIME_KINDS.has(value as RuntimeKind);
}

function isAgentRuntimeModeRequest(value: unknown): value is AgentRuntimeModeRequest {
  return typeof value === 'string'
    && AGENT_RUNTIME_MODE_REQUESTS.has(value as AgentRuntimeModeRequest);
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

function runtimeKind(agent: RuntimeAgentSource | null | undefined): RuntimeKind {
  if (isRuntimeKind(agent?.runtimeBinding?.kind)) return agent.runtimeBinding.kind;
  if (agent?.agentRuntimeMode === 'acp') return 'acp';
  return 'terminal';
}

function bindingFromLegacy(agent: RuntimeAgentSource | null | undefined): RuntimeBinding {
  if (isRuntimeKind(agent?.runtimeBinding?.kind)) return agent.runtimeBinding as RuntimeBinding;
  switch (runtimeKind(agent)) {
    case 'acp': return acpBinding(agent || {});
    default: return terminalBinding();
  }
}

function runtimeBindingFor(kind: 'acp', source?: RuntimeBindingSource | null): AcpRuntimeBinding;
function runtimeBindingFor(kind: 'terminal', source?: RuntimeBindingSource | null): TerminalRuntimeBinding;
function runtimeBindingFor(kind: unknown, source?: RuntimeBindingSource | null): RuntimeBinding;
function runtimeBindingFor(kind: unknown, source: RuntimeBindingSource | null = {}): RuntimeBinding {
  const normalizedSource = source || {};
  switch (kind) {
    case 'acp': return acpBinding(normalizedSource);
    default: return terminalBinding();
  }
}

function runtimeBindingOf(
  agent: RuntimeAgentSource | null | undefined,
  expectedKind: 'acp',
): AcpRuntimeBinding | null;
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
  const binding = bindingFromLegacy(agent);
  agent.runtimeBinding = binding;
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
): RuntimeBinding {
  const binding = isRuntimeKind(agent?.runtimeBinding?.kind)
    ? agent.runtimeBinding as RuntimeBinding
    : bindingFromLegacy(agent);
  if (binding.kind === 'terminal') return terminalBinding();
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
    agentRuntimeMode: binding.kind === 'acp' ? 'acp' : 'terminal',
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
  return metadata;
}

export {
  type AgentRuntimeModeRequest,
  RuntimeAgentMap,
  isAgentRuntimeModeRequest,
  installRuntimeBinding,
  legacyRuntimeMetadata,
  publicRuntimeBinding,
  replaceRuntimeBinding,
  runtimeBindingFor,
  runtimeBindingOf,
  runtimeKind,
  runtimeState,
};
