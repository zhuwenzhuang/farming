type ProviderSessionHistoryMutationAction = 'archive' | 'unarchive';

interface ProviderSessionHistoryMutationSession {
  cliVersion?: string;
  cwd?: string;
  providerHomePath?: string;
  workspace?: string;
}

interface ProviderSessionHistoryMutationResult extends Record<string, unknown> {
  error?: string;
}

type ProviderSessionHistoryMutationHandler = (
  sessionId: string,
  session: ProviderSessionHistoryMutationSession,
) => Promise<ProviderSessionHistoryMutationResult | null | undefined>;

interface ProviderSessionHistoryMutationHandlers {
  archiveCodexSession?: ProviderSessionHistoryMutationHandler;
  unarchiveCodexSession?: ProviderSessionHistoryMutationHandler;
}

interface ProviderSessionHistoryMutationDefinition {
  actions: Partial<Record<ProviderSessionHistoryMutationAction, keyof ProviderSessionHistoryMutationHandlers>>;
  provider: string;
}

const PROVIDER_SESSION_HISTORY_MUTATIONS: readonly ProviderSessionHistoryMutationDefinition[] = [
  {
    actions: {
      archive: 'archiveCodexSession',
      unarchive: 'unarchiveCodexSession',
    },
    provider: 'codex',
  },
];

const HISTORY_MUTATION_BY_PROVIDER = new Map(
  PROVIDER_SESSION_HISTORY_MUTATIONS.map(definition => [definition.provider, definition] as const),
);

function providerSessionHistoryMutationSupported(
  provider: unknown,
  action: ProviderSessionHistoryMutationAction,
): boolean {
  const definition = HISTORY_MUTATION_BY_PROVIDER.get(String(provider || '').trim().toLowerCase());
  return Boolean(definition?.actions[action]);
}

async function runProviderSessionHistoryMutation(
  provider: unknown,
  action: ProviderSessionHistoryMutationAction,
  sessionId: string,
  session: ProviderSessionHistoryMutationSession,
  handlers: ProviderSessionHistoryMutationHandlers,
): Promise<ProviderSessionHistoryMutationResult | null> {
  const definition = HISTORY_MUTATION_BY_PROVIDER.get(String(provider || '').trim().toLowerCase());
  const handlerKey = definition?.actions[action];
  const handler = handlerKey ? handlers[handlerKey] : null;
  if (!handler) return null;
  return await handler(sessionId, session) || null;
}

export {
  providerSessionHistoryMutationSupported,
  runProviderSessionHistoryMutation,
};
export type {
  ProviderSessionHistoryMutationAction,
  ProviderSessionHistoryMutationHandlers,
  ProviderSessionHistoryMutationResult,
  ProviderSessionHistoryMutationSession,
};
