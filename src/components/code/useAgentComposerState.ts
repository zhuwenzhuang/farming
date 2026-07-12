import { useCallback, useLayoutEffect, useState } from 'react'
import type { Agent } from '@/types/agent'
import {
  composerStateAliasKeysForAgent,
  composerStateKeyForAgent,
  createDefaultAgentComposerState,
  mergeAgentComposerStates,
  type AgentComposerState,
} from './composer-state'
import {
  acpComposerStateAliasKeysForAgent,
  acpComposerStateKeyForAgent,
  isAcpComposerStateKey,
} from './acp/acp-composer-state'

type PermissionSwitchReplacement = {
  originalAgentId: string
  replacementAgentId: string
} | null

interface UseAgentComposerStateOptions {
  agents: Agent[]
  permissionSwitchReplacement: PermissionSwitchReplacement
  onDiscardAttachment: (attachment: AgentComposerState['attachments'][number]) => void
}

export function useAgentComposerState({
  agents,
  permissionSwitchReplacement,
  onDiscardAttachment,
}: UseAgentComposerStateOptions) {
  const [composerByAgentKey, setComposerByAgentKey] = useState<Record<string, AgentComposerState>>({})

  useLayoutEffect(() => {
    const retainedComposerKeys = new Set(
      agents
        .filter(agent => !agent.archived && agent.status !== 'dead' && agent.status !== 'stopped')
        .flatMap(agent => [composerStateKeyForAgent(agent), acpComposerStateKeyForAgent(agent)])
        .filter(Boolean)
    )
    setComposerByAgentKey(current => {
      let next = current
      let changed = false
      const mutable = () => {
        if (next === current) next = { ...current }
        changed = true
        return next
      }

      if (permissionSwitchReplacement) {
        const moveReplacementState = (sourceKey: string, replacementKey: string) => {
          const sourceState = next[sourceKey]
          if (!sourceState) return
          const nextStateByKey = mutable()
          const replacementState = nextStateByKey[replacementKey]
          nextStateByKey[replacementKey] = replacementState
            ? mergeAgentComposerStates(replacementState, sourceState)
            : sourceState
          delete nextStateByKey[sourceKey]
        }
        moveReplacementState(
          permissionSwitchReplacement.originalAgentId,
          permissionSwitchReplacement.replacementAgentId,
        )
        moveReplacementState(
          `acp:${permissionSwitchReplacement.originalAgentId}`,
          `acp:${permissionSwitchReplacement.replacementAgentId}`,
        )
      }

      agents.forEach(agent => {
        const canonicalKey = composerStateKeyForAgent(agent)
        if (!canonicalKey) return
        composerStateAliasKeysForAgent(agent).forEach(aliasKey => {
          if (aliasKey === canonicalKey) return
          const aliasState = next[aliasKey]
          if (!aliasState) return
          const nextStateByKey = mutable()
          nextStateByKey[canonicalKey] = nextStateByKey[canonicalKey]
            ? mergeAgentComposerStates(nextStateByKey[canonicalKey], aliasState)
            : aliasState
          delete nextStateByKey[aliasKey]
        })
        const acpCanonicalKey = acpComposerStateKeyForAgent(agent)
        acpComposerStateAliasKeysForAgent(agent).forEach(aliasKey => {
          if (aliasKey === acpCanonicalKey) return
          const aliasState = next[aliasKey]
          if (!aliasState) return
          const nextStateByKey = mutable()
          nextStateByKey[acpCanonicalKey] = nextStateByKey[acpCanonicalKey]
            ? mergeAgentComposerStates(nextStateByKey[acpCanonicalKey], aliasState)
            : aliasState
          delete nextStateByKey[aliasKey]
        })
      })

      Object.entries(next).forEach(([composerKey, state]) => {
        if (retainedComposerKeys.has(composerKey)) return
        const nextStateByKey = mutable()
        state.attachments.forEach(onDiscardAttachment)
        delete nextStateByKey[composerKey]
      })
      return changed ? next : current
    })
  }, [agents, onDiscardAttachment, permissionSwitchReplacement])

  const resolveComposerStateKey = useCallback((composerKey: string) => {
    if (!composerKey) return ''
    for (const agent of agents) {
      const acpState = isAcpComposerStateKey(composerKey)
      const canonicalKey = acpState
        ? acpComposerStateKeyForAgent(agent)
        : composerStateKeyForAgent(agent)
      if (!canonicalKey) continue
      const aliasKeys = acpState
        ? acpComposerStateAliasKeysForAgent(agent)
        : composerStateAliasKeysForAgent(agent)
      if (composerKey === canonicalKey || aliasKeys.includes(composerKey)) {
        return canonicalKey
      }
    }
    return composerKey
  }, [agents])

  const updateComposerStateForKey = useCallback((composerKey: string, updater: (state: AgentComposerState) => AgentComposerState) => {
    setComposerByAgentKey(current => {
      const canonicalKey = resolveComposerStateKey(composerKey)
      if (!canonicalKey) return current
      const previous = current[canonicalKey] ?? createDefaultAgentComposerState()
      const nextState = updater(previous)
      if (nextState === previous) return current
      return { ...current, [canonicalKey]: nextState }
    })
  }, [resolveComposerStateKey])

  const updateExistingComposerStateForKey = useCallback((composerKey: string, updater: (state: AgentComposerState) => AgentComposerState) => {
    setComposerByAgentKey(current => {
      const canonicalKey = resolveComposerStateKey(composerKey)
      if (!canonicalKey) return current
      const previous = current[canonicalKey]
      if (!previous) return current
      const nextState = updater(previous)
      if (nextState === previous) return current
      return { ...current, [canonicalKey]: nextState }
    })
  }, [resolveComposerStateKey])

  return {
    composerByAgentKey,
    updateComposerStateForKey,
    updateExistingComposerStateForKey,
  }
}
