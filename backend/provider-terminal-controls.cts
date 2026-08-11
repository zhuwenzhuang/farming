import {
  activeCodexTerminalProfile,
  applyCodexTerminalProfile,
  codexTerminalProfileEqual,
  codexTerminalSessionIdFromStatus,
  isCodexTerminalComposerPreview,
  resolveCodexTerminalSessionId,
} from './codex-terminal-profile.cjs';
import type { AgentRecord as TypedAgentRecord } from './agent-manager-record-types.js';
import { providerForProgram } from './provider-adapters.cjs';

type ProviderTerminalControlInput = string | readonly unknown[];

interface ResolveProviderTerminalIdentityOptions {
  readPreview: () => unknown | PromiseLike<unknown>;
  sendInput: (input: ProviderTerminalControlInput) => unknown | PromiseLike<unknown>;
  timeoutMs?: number;
}

interface ProviderTerminalIdentityControl {
  canResolveFromPreview(previewText: unknown): boolean;
  displayName: string;
  provider: string;
  resolve(options: ResolveProviderTerminalIdentityOptions): Promise<string>;
  sessionIdFromPreview(previewText: unknown): string;
  source: string;
  timeoutMs: number;
}

interface ApplyProviderTerminalProfileOptions {
  onInputSafe?: () => void;
  profile: Record<string, unknown>;
  readOutput: () => unknown | PromiseLike<unknown>;
  readPreview: () => unknown | PromiseLike<unknown>;
  sendInput: (input: ProviderTerminalControlInput) => unknown | PromiseLike<unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface AppliedProviderTerminalProfile {
  effort: string;
  model: string;
  serviceTier: string;
}

interface ProviderTerminalProfileControl {
  active(agent: TypedAgentRecord, previewText: string): Record<string, unknown> | null;
  apply(options: ApplyProviderTerminalProfileOptions): Promise<AppliedProviderTerminalProfile>;
  displayName: string;
  equal(left: unknown, right: unknown): boolean;
  provider: string;
}

const PROVIDER_TERMINAL_IDENTITY_CONTROLS: readonly ProviderTerminalIdentityControl[] = [
  {
    canResolveFromPreview: isCodexTerminalComposerPreview,
    displayName: 'Codex',
    provider: 'codex',
    resolve: options => resolveCodexTerminalSessionId({
      ...options,
      sendInput: input => options.sendInput(input),
    }),
    sessionIdFromPreview: codexTerminalSessionIdFromStatus,
    source: 'codex-terminal-status',
    timeoutMs: 5_000,
  },
];

const IDENTITY_CONTROL_BY_PROVIDER = new Map(
  PROVIDER_TERMINAL_IDENTITY_CONTROLS.map(control => [control.provider, control] as const),
);

const PROVIDER_TERMINAL_PROFILE_CONTROLS: readonly ProviderTerminalProfileControl[] = [
  {
    active: activeCodexTerminalProfile,
    apply: options => applyCodexTerminalProfile({
      ...options,
      sendInput: input => options.sendInput(input),
    }),
    displayName: 'Codex Terminal',
    equal: codexTerminalProfileEqual,
    provider: 'codex',
  },
];

const PROFILE_CONTROL_BY_PROVIDER = new Map(
  PROVIDER_TERMINAL_PROFILE_CONTROLS.map(control => [control.provider, control] as const),
);

function providerTerminalIdentityControl(
  provider: unknown,
): Readonly<ProviderTerminalIdentityControl> | null {
  return IDENTITY_CONTROL_BY_PROVIDER.get(String(provider || '').trim().toLowerCase()) || null;
}

function providerTerminalProfileControl(
  provider: unknown,
): Readonly<ProviderTerminalProfileControl> | null {
  return PROFILE_CONTROL_BY_PROVIDER.get(String(provider || '').trim().toLowerCase()) || null;
}

function providerTerminalProfileControlForAgent(
  agent: Pick<TypedAgentRecord, 'command' | 'providerSessionProvider'>,
): Readonly<ProviderTerminalProfileControl> | null {
  const program = String(agent.command || '')
    .trim()
    .split(/\s+/)
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) || '';
  return providerTerminalProfileControl(
    agent.providerSessionProvider || providerForProgram(program),
  );
}

function activeProviderTerminalProfile(
  provider: unknown,
  agent: TypedAgentRecord,
  previewText: string,
): Record<string, unknown> | null {
  return (providerTerminalProfileControl(provider) || providerTerminalProfileControlForAgent(agent))
    ?.active(agent, previewText) || null;
}

function providerTerminalProfilesEqual(
  provider: unknown,
  left: unknown,
  right: unknown,
): boolean {
  const control = providerTerminalProfileControl(provider);
  return control ? control.equal(left, right) : left == null && right == null;
}

export {
  activeProviderTerminalProfile,
  providerTerminalIdentityControl,
  providerTerminalProfileControl,
  providerTerminalProfileControlForAgent,
  providerTerminalProfilesEqual,
};
export type {
  AppliedProviderTerminalProfile,
  ApplyProviderTerminalProfileOptions,
  ProviderTerminalControlInput,
  ProviderTerminalIdentityControl,
  ProviderTerminalProfileControl,
  ResolveProviderTerminalIdentityOptions,
};
