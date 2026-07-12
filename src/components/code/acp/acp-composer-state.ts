import type { Agent } from '@/types/agent'
import { composerStateAliasKeysForAgent, composerStateKeyForAgent } from '../composer-state'

const ACP_COMPOSER_STATE_PREFIX = 'acp:'

export function acpComposerStateKeyForAgent(agent: Agent | null | undefined) {
  const key = composerStateKeyForAgent(agent)
  return key ? `${ACP_COMPOSER_STATE_PREFIX}${key}` : ''
}

export function acpComposerStateAliasKeysForAgent(agent: Agent) {
  return composerStateAliasKeysForAgent(agent).map(key => `${ACP_COMPOSER_STATE_PREFIX}${key}`)
}

export function isAcpComposerStateKey(key: string) {
  return key.startsWith(ACP_COMPOSER_STATE_PREFIX)
}
