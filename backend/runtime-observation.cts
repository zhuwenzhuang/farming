import { deriveTerminalStatus } from './terminal-status.cjs';

import { runtimeKind, runtimeState } from './agent-runtime-binding.cjs';
import { providerRuntimeObservationKind } from './provider-adapters.cjs';
import type { RuntimeObservationWire } from '../shared/agent-state-wire.js';

const WORKING_STATES = new Set(['working', 'interrupting']);
const WAITING_STATES = new Set(['waiting-for-input', 'waiting-for-permission']);
const IDLE_STATES = new Set(['idle', 'connected', 'ready']);

type RuntimeObservationPhase = 'working' | 'waiting' | 'idle' | 'starting' | 'exited' | 'unknown';

export interface TerminalObservationStatus {
  activity: string;
  kind?: RuntimeObservationWire['kind'];
  source?: string;
}

interface RuntimeObservationAgent {
  [key: string]: unknown;
  command?: string;
  cwd?: string;
  lastActivity?: number;
  output?: string;
  previewText?: string;
  providerSessionProvider?: string;
  sessionTitle?: string;
  startedAt?: number | null;
  status?: string;
  terminalBusy?: boolean | null;
  terminalStatus?: TerminalObservationStatus;
}

function providerObservationKind(agent: RuntimeObservationAgent): RuntimeObservationWire['kind'] {
  const provider = String(agent?.providerSessionProvider || '').toLowerCase();
  return providerRuntimeObservationKind(provider);
}

function structuredPhase(agent: RuntimeObservationAgent): RuntimeObservationPhase {
  const state = runtimeState(agent);
  if (WORKING_STATES.has(state)) return 'working';
  if (WAITING_STATES.has(state)) return 'waiting';
  if (IDLE_STATES.has(state)) return 'idle';
  if (state === 'starting' || state === 'loading') return 'starting';
  if (state === 'stopped' || state === 'dead' || state === 'exited') return 'exited';
  return 'unknown';
}

function terminalStatusFor(agent: RuntimeObservationAgent): TerminalObservationStatus {
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

function terminalPhase(
  agent: RuntimeObservationAgent,
  status: TerminalObservationStatus,
): RuntimeObservationPhase {
  if (agent?.status === 'pending') return 'starting';
  if (agent?.status === 'stopped' || agent?.status === 'dead' || status.activity === 'exited') return 'exited';
  if (status.activity === 'busy') return 'working';
  if (status.activity === 'idle') return 'idle';
  return 'unknown';
}

function deriveRuntimeObservation(agent: RuntimeObservationAgent): RuntimeObservationWire {
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

export {
  deriveRuntimeObservation,
};
