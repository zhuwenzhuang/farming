const RUNTIME_KINDS = new Set(['terminal', 'acp', 'json', 'app-server']);

function terminalBinding() {
  return { kind: 'terminal' };
}

function acpBinding(source = {}) {
  return {
    kind: 'acp',
    state: source.state || source.acpState || '',
    error: source.error || source.acpError || '',
    stopReason: source.stopReason || source.acpStopReason || '',
    pendingPermission: source.pendingPermission || source.acpPendingPermission || null,
    pendingPermissions: source.pendingPermissions || source.acpPendingPermissions || [],
    pendingElicitation: source.pendingElicitation || source.acpPendingElicitation || null,
    pendingElicitations: source.pendingElicitations || source.acpPendingElicitations || [],
    activeElicitations: source.activeElicitations || source.acpActiveElicitations || [],
    sessionUpdatedAt: source.sessionUpdatedAt || source.acpSessionUpdatedAt || '',
    sessionRevision: Number(source.sessionRevision ?? source.acpSessionRevision) || 0,
  };
}

function jsonBinding(source = {}) {
  return {
    kind: 'json',
    state: source.state || source.jsonCliState || '',
    error: source.error || source.jsonCliError || '',
    transcriptUpdatedAt: source.transcriptUpdatedAt || source.jsonCliTranscriptUpdatedAt || '',
    events: source.events || source.jsonCliEvents || [],
  };
}

function appServerBinding(source = {}) {
  return {
    kind: 'app-server',
    state: source.state || source.codexAppServerState || '',
    endpoint: source.endpoint || source.codexAppServerEndpoint || '',
    threadId: source.threadId || source.codexAppServerThreadId || '',
    turnId: source.turnId || source.codexAppServerTurnId || '',
    error: source.error || source.codexAppServerError || '',
    pendingRequestId: source.pendingRequestId || source.codexAppServerPendingRequestId || '',
    pendingRequestMethod: source.pendingRequestMethod || source.codexAppServerPendingRequestMethod || '',
    pendingRequest: source.pendingRequest || source.codexAppServerPendingRequest || null,
    notice: source.notice || source.codexAppServerNotice || null,
    goal: source.goal || source.codexAppServerGoal || null,
    observerDeferred: source.observerDeferred === true || source.codexCliObserverDeferred === true,
    homePath: source.homePath || source.codexAppServerHomePath || '',
    transcriptUpdatedAt: source.transcriptUpdatedAt || source.codexAppServerTranscriptUpdatedAt || '',
  };
}

function runtimeKind(agent) {
  if (RUNTIME_KINDS.has(agent?.runtimeBinding?.kind)) return agent.runtimeBinding.kind;
  if (agent?.agentRuntimeMode === 'acp') return 'acp';
  if (agent?.agentRuntimeMode === 'json') return 'json';
  return agent?.codexRuntimeMode === 'app-server' ? 'app-server' : 'terminal';
}

function bindingFromLegacy(agent) {
  if (RUNTIME_KINDS.has(agent?.runtimeBinding?.kind)) return agent.runtimeBinding;
  switch (runtimeKind(agent)) {
    case 'acp': return acpBinding(agent);
    case 'json': return jsonBinding(agent);
    case 'app-server': return appServerBinding(agent);
    default: return terminalBinding();
  }
}

function runtimeBindingFor(kind, source = {}) {
  switch (kind) {
    case 'acp': return acpBinding(source);
    case 'json': return jsonBinding(source);
    case 'app-server': return appServerBinding(source);
    default: return terminalBinding();
  }
}

function runtimeBindingOf(agent, expectedKind) {
  const binding = bindingFromLegacy(agent);
  return !expectedKind || binding.kind === expectedKind ? binding : null;
}

function replaceRuntimeBinding(agent, kind, source = {}) {
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

function installRuntimeBinding(agent) {
  if (!agent || typeof agent !== 'object') return agent;
  const jsonResumeEvents = Array.isArray(agent.runtimeBinding?.events)
    ? agent.runtimeBinding.events
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
  set(key, agent) {
    return super.set(key, installRuntimeBinding(agent));
  }
}

function publicRuntimeBinding(agent) {
  const binding = RUNTIME_KINDS.has(agent?.runtimeBinding?.kind)
    ? agent.runtimeBinding
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
  if (binding.kind === 'app-server') {
    return {
      kind: 'app-server',
      state: binding.state,
      endpoint: binding.endpoint,
      threadId: binding.threadId,
      turnId: binding.turnId,
      error: binding.error,
      pendingRequestId: binding.pendingRequestId,
      pendingRequestMethod: binding.pendingRequestMethod,
      pendingRequest: binding.pendingRequest,
      notice: binding.notice,
      goal: binding.goal,
      observerDeferred: binding.observerDeferred,
    };
  }
  return { ...binding };
}

function runtimeState(agent) {
  const binding = RUNTIME_KINDS.has(agent?.runtimeBinding?.kind)
    ? agent.runtimeBinding
    : bindingFromLegacy(agent);
  return binding.kind === 'terminal' ? '' : binding.state || '';
}

function legacyRuntimeMetadata(agent) {
  const binding = bindingFromLegacy(agent);
  const metadata = {
    codexRuntimeMode: binding.kind === 'app-server' ? 'app-server' : 'cli',
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
  if (binding.kind === 'app-server') {
    return {
      ...metadata,
      codexAppServerHomePath: binding.homePath,
      codexAppServerState: binding.state,
      codexAppServerEndpoint: binding.endpoint,
      codexAppServerThreadId: binding.threadId,
      codexAppServerTurnId: binding.turnId,
      codexAppServerError: binding.error,
      codexAppServerPendingRequestId: binding.pendingRequestId,
      codexAppServerPendingRequestMethod: binding.pendingRequestMethod,
      codexAppServerPendingRequest: binding.pendingRequest,
      codexCliObserverDeferred: binding.observerDeferred,
    };
  }
  return metadata;
}

module.exports = {
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
