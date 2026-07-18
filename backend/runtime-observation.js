const { runtimeKind, runtimeState } = require('./agent-runtime-binding');
const { deriveTerminalStatus } = require('./terminal-status');

const WORKING_STATES = new Set(['working', 'interrupting']);
const WAITING_STATES = new Set(['waiting-for-input', 'waiting-for-permission']);
const IDLE_STATES = new Set(['idle', 'connected', 'ready']);

function providerObservationKind(agent) {
  const provider = String(agent?.providerSessionProvider || '').toLowerCase();
  if (provider === 'codex' || provider === 'claude') return provider;
  return provider ? 'process' : 'unknown';
}

function structuredPhase(agent) {
  const state = runtimeState(agent);
  if (WORKING_STATES.has(state)) return 'working';
  if (WAITING_STATES.has(state)) return 'waiting';
  if (IDLE_STATES.has(state)) return 'idle';
  if (state === 'starting' || state === 'loading') return 'starting';
  if (state === 'stopped' || state === 'dead' || state === 'exited') return 'exited';
  return 'unknown';
}

function terminalStatusFor(agent) {
  if (agent?.terminalStatus) return agent.terminalStatus;
  return deriveTerminalStatus({
    command: agent?.command,
    cwd: agent?.cwd,
    status: agent?.status === 'running' ? 'running' : agent?.status,
    title: agent?.sessionTitle,
    previewText: agent?.previewText || agent?.output,
    terminalBusy: typeof agent?.terminalBusy === 'boolean' ? agent.terminalBusy : null,
    shellLastEvent: agent?.shellLastEvent,
    shellLastExitCode: agent?.shellLastExitCode,
    shellCommand: agent?.shellCommand,
    shellLastCommand: agent?.shellLastCommand,
    shellCommandStartedAt: agent?.shellCommandStartedAt,
    shellLastCommandStartedAt: agent?.shellLastCommandStartedAt,
    shellLastCommandFinishedAt: agent?.shellLastCommandFinishedAt,
    shellLastCommandDurationMs: agent?.shellLastCommandDurationMs,
  });
}

function terminalPhase(agent, status) {
  if (agent?.status === 'pending') return 'starting';
  if (agent?.status === 'stopped' || agent?.status === 'dead' || status.activity === 'exited') return 'exited';
  if (status.activity === 'busy') return 'working';
  if (status.activity === 'idle') return 'idle';
  return 'unknown';
}

function deriveRuntimeObservation(agent) {
  const observedAt = Number(agent?.lastActivity || agent?.startedAt) || 0;
  if (runtimeKind(agent) !== 'terminal') {
    return {
      kind: providerObservationKind(agent),
      phase: agent?.status === 'pending'
        ? 'starting'
        : (agent?.status === 'stopped' || agent?.status === 'dead' ? 'exited' : structuredPhase(agent)),
      confidence: 'authoritative',
      source: 'structured-runtime',
      observerVersion: 'structured-v1',
      observedAt,
    };
  }

  const status = terminalStatusFor(agent);
  const shellMarker = status.source === 'shell-status-marker';
  return {
    kind: status.kind || 'unknown',
    phase: terminalPhase(agent, status),
    confidence: shellMarker ? 'high' : 'heuristic',
    source: shellMarker ? 'shell-marker' : 'terminal-observer',
    observerVersion: shellMarker ? 'shell-marker-v1' : 'terminal-observer-v1',
    observedAt,
  };
}

module.exports = {
  deriveRuntimeObservation,
};
