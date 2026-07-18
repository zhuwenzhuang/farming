function runtimeKind(agent) {
  const kind = agent?.runtimeBinding?.kind;
  if (['terminal', 'acp', 'json', 'app-server'].includes(kind)) return kind;
  if (agent?.agentRuntimeMode === 'acp') return 'acp';
  if (agent?.agentRuntimeMode === 'json') return 'json';
  if (agent?.providerSessionProvider === 'codex' && agent?.codexRuntimeMode === 'app-server') {
    return 'app-server';
  }
  return 'terminal';
}

function publicRuntimeBinding(agent) {
  if (agent?.runtimeBinding && runtimeKind(agent) === agent.runtimeBinding.kind) {
    return agent.runtimeBinding.kind === 'terminal'
      ? { kind: 'terminal' }
      : { ...agent.runtimeBinding };
  }
  switch (runtimeKind(agent)) {
    case 'acp':
      return {
        kind: 'acp',
        state: agent.acpState || '',
        error: agent.acpError || '',
        stopReason: agent.acpStopReason || '',
        pendingPermission: agent.acpPendingPermission || null,
        pendingPermissions: Array.isArray(agent.acpPendingPermissions) ? agent.acpPendingPermissions : [],
        pendingElicitation: agent.acpPendingElicitation || null,
        pendingElicitations: Array.isArray(agent.acpPendingElicitations) ? agent.acpPendingElicitations : [],
        activeElicitations: Array.isArray(agent.acpActiveElicitations) ? agent.acpActiveElicitations : [],
        sessionUpdatedAt: agent.acpSessionUpdatedAt || '',
        sessionRevision: Number(agent.acpSessionRevision) || 0,
      };
    case 'json':
      return {
        kind: 'json',
        state: agent.jsonCliState || '',
        error: agent.jsonCliError || '',
        transcriptUpdatedAt: agent.jsonCliTranscriptUpdatedAt || '',
      };
    case 'app-server':
      return {
        kind: 'app-server',
        state: agent.codexAppServerState || '',
        endpoint: agent.codexAppServerEndpoint || '',
        threadId: agent.codexAppServerThreadId || '',
        turnId: agent.codexAppServerTurnId || '',
        error: agent.codexAppServerError || '',
        pendingRequestId: agent.codexAppServerPendingRequestId || '',
        pendingRequestMethod: agent.codexAppServerPendingRequestMethod || '',
        pendingRequest: agent.codexAppServerPendingRequest || null,
        notice: agent.codexAppServerNotice || null,
        goal: agent.codexAppServerGoal || null,
        observerDeferred: agent.codexCliObserverDeferred === true,
      };
    default:
      return { kind: 'terminal' };
  }
}

function runtimeState(agent) {
  if (typeof agent?.runtimeBinding?.state === 'string') return agent.runtimeBinding.state;
  switch (runtimeKind(agent)) {
    case 'acp': return agent?.acpState || '';
    case 'json': return agent?.jsonCliState || '';
    case 'app-server': return agent?.codexAppServerState || '';
    default: return '';
  }
}

module.exports = {
  publicRuntimeBinding,
  runtimeKind,
  runtimeState,
};
