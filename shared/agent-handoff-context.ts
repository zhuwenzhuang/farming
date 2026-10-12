import { decodeProviderSessionKey } from './provider-session-identity.js'

/** Presentation provenance only; it grants no access to the source conversation. */
export interface AgentHandoffContext {
  version: 1
  sourceSessionKey: string
}

export function normalizeAgentHandoffContext(value: unknown): AgentHandoffContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const context = value as Record<string, unknown>
  if (context.version !== 1 || typeof context.sourceSessionKey !== 'string'
    || context.sourceSessionKey.length > 2048 || !decodeProviderSessionKey(context.sourceSessionKey)) return null
  return { version: 1, sourceSessionKey: context.sourceSessionKey }
}
