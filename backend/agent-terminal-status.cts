'use strict';

import type { AgentRecord as TypedAgentRecord } from './agent-manager-record-types.js';
import { deriveTerminalStatus } from './terminal-status.cjs';

interface AgentTerminalStatusOverrides extends Record<string, unknown> {
  cwd?: string;
  previewText?: string;
  shellCommand?: string;
  shellCommandStartedAt?: number | null;
  shellLastCommand?: string;
  shellLastCommandDurationMs?: number | null;
  shellLastCommandFinishedAt?: number | null;
  shellLastCommandStartedAt?: number | null;
  status?: string;
  terminalBusy?: boolean | null;
  title?: string;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function agentTerminalRuntimeStatus(agentStatus: unknown): unknown {
  return agentStatus === 'stopped' || agentStatus === 'dead' ? 'exited' : agentStatus;
}

function deriveAgentTerminalStatus(
  agent: TypedAgentRecord,
  overrides: AgentTerminalStatusOverrides = {},
) {
  const terminalBusy = Object.prototype.hasOwnProperty.call(overrides, 'terminalBusy')
    ? overrides.terminalBusy
    : agent.terminalBusy;
  return deriveTerminalStatus({
    command: agent.forkCommand || agent.command,
    cwd: overrides.cwd || agent.shellCwd || agent.cwd,
    status: overrides.status || agentTerminalRuntimeStatus(agent.status),
    title: Object.prototype.hasOwnProperty.call(overrides, 'title')
      ? overrides.title
      : (agent.sessionTitle || ''),
    previewText: Object.prototype.hasOwnProperty.call(overrides, 'previewText')
      ? overrides.previewText
      : (agent.previewText || agent.output || ''),
    terminalBusy: typeof terminalBusy === 'boolean' ? terminalBusy : null,
    shellLastExitCode: typeof agent.shellLastExitCode === 'number' ? agent.shellLastExitCode : null,
    shellLastEvent: agent.shellLastEvent || '',
    shellCommand: Object.prototype.hasOwnProperty.call(overrides, 'shellCommand')
      ? overrides.shellCommand
      : (agent.shellCommand || ''),
    shellLastCommand: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommand')
      ? overrides.shellLastCommand
      : (agent.shellLastCommand || ''),
    shellCommandStartedAt: Object.prototype.hasOwnProperty.call(overrides, 'shellCommandStartedAt')
      ? overrides.shellCommandStartedAt
      : finiteNumberOrNull(agent.shellCommandStartedAt),
    shellLastCommandStartedAt: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommandStartedAt')
      ? overrides.shellLastCommandStartedAt
      : finiteNumberOrNull(agent.shellLastCommandStartedAt),
    shellLastCommandFinishedAt: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommandFinishedAt')
      ? overrides.shellLastCommandFinishedAt
      : finiteNumberOrNull(agent.shellLastCommandFinishedAt),
    shellLastCommandDurationMs: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommandDurationMs')
      ? overrides.shellLastCommandDurationMs
      : finiteNumberOrNull(agent.shellLastCommandDurationMs),
  });
}

function agentTerminalStatusEqual(
  left: ReturnType<typeof deriveAgentTerminalStatus>,
  right: ReturnType<typeof deriveAgentTerminalStatus>,
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left) as Array<keyof typeof left>;
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(key => (
    Object.prototype.hasOwnProperty.call(right, key)
    && Object.is(left[key], right[key])
  ));
}

export {
  agentTerminalRuntimeStatus,
  agentTerminalStatusEqual,
  deriveAgentTerminalStatus,
  type AgentTerminalStatusOverrides,
};
