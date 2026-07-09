import { useCallback, useLayoutEffect, useState } from 'react'
import type { Agent } from '@/types/agent'
import {
  composerStateAliasKeysForAgent,
  composerStateKeyForAgent,
  createDefaultAgentComposerState,
  mergeAgentComposerStates,
  type AgentComposerState,
} from './composer-state'

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
        .map(composerStateKeyForAgent)
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
        const sourceState = next[permissionSwitchReplacement.originalAgentId]
        if (sourceState) {
          const nextStateByKey = mutable()
          const replacementState = nextStateByKey[permissionSwitchReplacement.replacementAgentId]
          nextStateByKey[permissionSwitchReplacement.replacementAgentId] = replacementState
            ? mergeAgentComposerStates(replacementState, sourceState)
            : sourceState
          delete nextStateByKey[permissionSwitchReplacement.originalAgentId]
        }
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
      const canonicalKey = composerStateKeyForAgent(agent)
      if (!canonicalKey) continue
      if (composerKey === canonicalKey || composerStateAliasKeysForAgent(agent).includes(composerKey)) {
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
