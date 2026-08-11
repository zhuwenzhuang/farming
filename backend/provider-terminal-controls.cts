import {
  codexTerminalSessionIdFromStatus,
  isCodexTerminalComposerPreview,
  resolveCodexTerminalSessionId,
} from './codex-terminal-profile.cjs';

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

function providerTerminalIdentityControl(
  provider: unknown,
): Readonly<ProviderTerminalIdentityControl> | null {
  return IDENTITY_CONTROL_BY_PROVIDER.get(String(provider || '').trim().toLowerCase()) || null;
}

export { providerTerminalIdentityControl };
export type {
  ProviderTerminalControlInput,
  ProviderTerminalIdentityControl,
  ResolveProviderTerminalIdentityOptions,
};
