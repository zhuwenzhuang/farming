import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Agent } from '@/types/agent'
import {
  composerStateAliasKeysForAgent,
  composerStateKeyForAgent,
  createDefaultAgentComposerState,
  mergeAgentComposerStates,
  type AgentComposerAdmission,
  type AgentComposerState,
} from './composer-state'
import {
  acpComposerStateAliasKeysForAgent,
  acpComposerStateKeyForAgent,
  isAcpComposerStateKey,
} from './acp/acp-composer-state'
import {
  loadAgentComposerCheckpoint,
  nextAgentComposerCheckpointTimestamp,
  saveAgentComposerCheckpoint,
} from './composer-persistence'

type PermissionSwitchReplacement = {
  originalAgentId: string
  replacementAgentId: string
  transitionFromAgentId?: string
} | null

interface UseAgentComposerStateOptions {
  agents: Agent[]
  permissionSwitchingAgentId?: string | null
  permissionSwitchReplacement: PermissionSwitchReplacement
  onDiscardAttachment: (attachment: AgentComposerState['attachments'][number]) => void
}

function sameComposerAdmission(left: AgentComposerAdmission, right: AgentComposerAdmission) {
  return left.id === right.id
    && left.composerKey === right.composerKey
    && left.text === right.text
    && left.createdAt === right.createdAt
    && left.attachments === right.attachments
    && left.editableText === right.editableText
    && left.composerMode === right.composerMode
    && left.status === right.status
    && left.historyRecorded === right.historyRecorded
    && left.delivery === right.delivery
    && left.origin === right.origin
    && left.draftAttachmentIds === right.draftAttachmentIds
}

export function useAgentComposerState({
  agents,
  permissionSwitchingAgentId,
  permissionSwitchReplacement,
  onDiscardAttachment,
}: UseAgentComposerStateOptions) {
  const initialCheckpointRef = useRef<ReturnType<typeof loadAgentComposerCheckpoint> | null>(null)
  if (initialCheckpointRef.current === null) {
    initialCheckpointRef.current = loadAgentComposerCheckpoint()
  }
  const [composerByAgentKey, setComposerByAgentKey] = useState<Record<string, AgentComposerState>>(
    initialCheckpointRef.current.states,
  )
  const composerStateUpdatedAtRef = useRef(initialCheckpointRef.current.updatedAtByKey)
  const composerStateDeletedAtRef = useRef(new Map<string, number>())
  const composerAdmissionsRef = useRef(initialCheckpointRef.current.admissions)
  const composerAdmissionUpdatedAtRef = useRef(initialCheckpointRef.current.admissionUpdatedAtById)
  const composerAdmissionDeletedAtRef = useRef(initialCheckpointRef.current.admissionDeletedAtById)
  const composerByAgentKeyRef = useRef(composerByAgentKey)
  composerByAgentKeyRef.current = composerByAgentKey

  const nextCheckpointTimestamp = useCallback((composerKey: string) => (
    nextAgentComposerCheckpointTimestamp(
      composerKey,
      composerStateUpdatedAtRef.current,
      composerStateDeletedAtRef.current,
    )
  ), [])

  const nextAdmissionTimestamp = useCallback((requestId: string, now = Date.now()) => (
    nextAgentComposerCheckpointTimestamp(
      requestId,
      composerAdmissionUpdatedAtRef.current,
      composerAdmissionDeletedAtRef.current,
      now,
    )
  ), [])

  const synchronizeComposerAdmissions = useCallback((states: Record<string, AgentComposerState>) => {
    const projected = new Map<string, AgentComposerAdmission>()
    Object.entries(states).forEach(([composerKey, state]) => {
      for (const submission of state.submissions || []) {
        projected.set(submission.id, { ...submission, composerKey })
      }
    })
    for (const requestId of composerAdmissionsRef.current.keys()) {
      if (projected.has(requestId)) continue
      const deletedAt = nextAdmissionTimestamp(requestId)
      composerAdmissionsRef.current.delete(requestId)
      composerAdmissionUpdatedAtRef.current.delete(requestId)
      composerAdmissionDeletedAtRef.current.set(requestId, deletedAt)
    }
    for (const [requestId, admission] of projected) {
      const current = composerAdmissionsRef.current.get(requestId)
      if (current && sameComposerAdmission(current, admission)) continue
      composerAdmissionsRef.current.set(requestId, admission)
      composerAdmissionUpdatedAtRef.current.set(
        requestId,
        nextAdmissionTimestamp(requestId),
      )
      composerAdmissionDeletedAtRef.current.delete(requestId)
    }
  }, [nextAdmissionTimestamp])

  const persistComposerCheckpoint = useCallback(() => {
    saveAgentComposerCheckpoint(
      composerByAgentKeyRef.current,
      composerStateUpdatedAtRef.current,
      composerStateDeletedAtRef.current,
      undefined,
      undefined,
      {
        admissions: composerAdmissionsRef.current,
        updatedAtById: composerAdmissionUpdatedAtRef.current,
        deletedAtById: composerAdmissionDeletedAtRef.current,
      },
    )
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(persistComposerCheckpoint, 250)
    return () => window.clearTimeout(timeout)
  }, [composerByAgentKey, persistComposerCheckpoint])

  useEffect(() => {
    window.addEventListener('pagehide', persistComposerCheckpoint)
    return () => window.removeEventListener('pagehide', persistComposerCheckpoint)
  }, [persistComposerCheckpoint])

  useLayoutEffect(() => {
    const retainedComposerKeys = new Set(
      agents
        .filter(agent => !agent.archived && agent.status !== 'dead' && agent.status !== 'stopped')
        .flatMap(agent => [composerStateKeyForAgent(agent), acpComposerStateKeyForAgent(agent)])
        .filter(Boolean)
    )
    if (permissionSwitchingAgentId) {
      retainedComposerKeys.add(permissionSwitchingAgentId)
      retainedComposerKeys.add(`acp:${permissionSwitchingAgentId}`)
    }
    setComposerByAgentKey(current => {
      let next = current
      let changed = false
      const mutable = () => {
        if (next === current) next = { ...current }
        changed = true
        return next
      }

      if (permissionSwitchReplacement) {
        const replacementAgent = agents.find(agent => (
          agent.id === permissionSwitchReplacement.replacementAgentId
        ))
        const sourceAgentIds = Array.from(new Set([
          permissionSwitchReplacement.originalAgentId,
          permissionSwitchReplacement.transitionFromAgentId,
          ...(replacementAgent?.restartedFromAgentIds ?? []),
          replacementAgent?.restartedFromAgentId,
        ].filter((agentId): agentId is string => (
          Boolean(agentId)
          && agentId !== permissionSwitchReplacement.replacementAgentId
        ))))
        const moveReplacementState = (sourceKey: string, replacementKey: string) => {
          if (sourceKey === replacementKey) return
          const sourceState = next[sourceKey]
          if (!sourceState) return
          const nextStateByKey = mutable()
          const replacementState = nextStateByKey[replacementKey]
          nextStateByKey[replacementKey] = replacementState
            ? mergeAgentComposerStates(replacementState, sourceState)
            : sourceState
          composerStateUpdatedAtRef.current.set(replacementKey, Math.max(
            nextCheckpointTimestamp(replacementKey),
            (composerStateUpdatedAtRef.current.get(sourceKey) || 0) + 1,
          ))
          composerStateDeletedAtRef.current.delete(replacementKey)
          composerStateDeletedAtRef.current.set(sourceKey, nextCheckpointTimestamp(sourceKey))
          composerStateUpdatedAtRef.current.delete(sourceKey)
          delete nextStateByKey[sourceKey]
        }
        const replacementTerminalKey = replacementAgent
          ? composerStateKeyForAgent(replacementAgent)
          : permissionSwitchReplacement.replacementAgentId
        const replacementAcpKey = replacementAgent
          ? acpComposerStateKeyForAgent(replacementAgent)
          : `acp:${permissionSwitchReplacement.replacementAgentId}`
        sourceAgentIds.forEach(sourceAgentId => {
          moveReplacementState(sourceAgentId, replacementTerminalKey)
          moveReplacementState(`acp:${sourceAgentId}`, replacementAcpKey)
        })
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
          composerStateUpdatedAtRef.current.set(canonicalKey, Math.max(
            nextCheckpointTimestamp(canonicalKey),
            (composerStateUpdatedAtRef.current.get(aliasKey) || 0) + 1,
          ))
          composerStateDeletedAtRef.current.delete(canonicalKey)
          composerStateDeletedAtRef.current.set(aliasKey, nextCheckpointTimestamp(aliasKey))
          composerStateUpdatedAtRef.current.delete(aliasKey)
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
          composerStateUpdatedAtRef.current.set(acpCanonicalKey, Math.max(
            nextCheckpointTimestamp(acpCanonicalKey),
            (composerStateUpdatedAtRef.current.get(aliasKey) || 0) + 1,
          ))
          composerStateDeletedAtRef.current.delete(acpCanonicalKey)
          composerStateDeletedAtRef.current.set(aliasKey, nextCheckpointTimestamp(aliasKey))
          composerStateUpdatedAtRef.current.delete(aliasKey)
          delete nextStateByKey[aliasKey]
        })
      })

      Object.entries(next).forEach(([composerKey, state]) => {
        if (retainedComposerKeys.has(composerKey)) return
        // Agent replacement is delivered as several authoritative updates. A
        // chained restart can therefore make every member of the lineage
        // briefly absent from `agents`. User-owned Composer state must survive
        // that transport gap; a later lineage-bearing Agent will canonicalize
        // the preserved key. Empty UI-only state is still safe to discard.
        if (
          state.draft
          || state.attachments.length > 0
          || state.mode !== 'default'
          || state.history.entries.length > 0
          || (state.pendingFollowUp?.messages.length ?? 0) > 0
          || (state.submissions?.length ?? 0) > 0
        ) {
          return
        }
        const nextStateByKey = mutable()
        state.attachments.forEach(onDiscardAttachment)
        composerStateDeletedAtRef.current.set(composerKey, nextCheckpointTimestamp(composerKey))
        composerStateUpdatedAtRef.current.delete(composerKey)
        delete nextStateByKey[composerKey]
      })
      if (changed) {
        synchronizeComposerAdmissions(next)
        composerByAgentKeyRef.current = next
      }
      return changed ? next : current
    })
  }, [agents, nextCheckpointTimestamp, onDiscardAttachment, permissionSwitchingAgentId, permissionSwitchReplacement, synchronizeComposerAdmissions])

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
      composerStateUpdatedAtRef.current.set(canonicalKey, nextCheckpointTimestamp(canonicalKey))
      composerStateDeletedAtRef.current.delete(canonicalKey)
      const next = { ...current, [canonicalKey]: nextState }
      synchronizeComposerAdmissions(next)
      composerByAgentKeyRef.current = next
      return next
    })
  }, [nextCheckpointTimestamp, resolveComposerStateKey, synchronizeComposerAdmissions])

  const updateExistingComposerStateForKey = useCallback((composerKey: string, updater: (state: AgentComposerState) => AgentComposerState) => {
    setComposerByAgentKey(current => {
      const canonicalKey = resolveComposerStateKey(composerKey)
      if (!canonicalKey) return current
      const previous = current[canonicalKey]
      if (!previous) return current
      const nextState = updater(previous)
      if (nextState === previous) return current
      composerStateUpdatedAtRef.current.set(canonicalKey, nextCheckpointTimestamp(canonicalKey))
      composerStateDeletedAtRef.current.delete(canonicalKey)
      const next = { ...current, [canonicalKey]: nextState }
      synchronizeComposerAdmissions(next)
      composerByAgentKeyRef.current = next
      return next
    })
  }, [nextCheckpointTimestamp, resolveComposerStateKey, synchronizeComposerAdmissions])

  const prepareComposerStateForTransport = useCallback((
    composerKey: string,
    updater: (state: AgentComposerState) => AgentComposerState,
  ) => {
    const canonicalKey = resolveComposerStateKey(composerKey)
    if (!canonicalKey) return false
    const current = composerByAgentKeyRef.current
    const previous = current[canonicalKey] ?? createDefaultAgentComposerState()
    const nextState = updater(previous)
    if (nextState === previous) return false

    const previousUpdatedAt = new Map(composerStateUpdatedAtRef.current)
    const previousDeletedAt = new Map(composerStateDeletedAtRef.current)
    const previousAdmissions = new Map(composerAdmissionsRef.current)
    const previousAdmissionUpdatedAt = new Map(composerAdmissionUpdatedAtRef.current)
    const previousAdmissionDeletedAt = new Map(composerAdmissionDeletedAtRef.current)
    const next = { ...current, [canonicalKey]: nextState }
    composerStateUpdatedAtRef.current.set(canonicalKey, nextCheckpointTimestamp(canonicalKey))
    composerStateDeletedAtRef.current.delete(canonicalKey)
    synchronizeComposerAdmissions(next)

    const persisted = saveAgentComposerCheckpoint(
      next,
      composerStateUpdatedAtRef.current,
      composerStateDeletedAtRef.current,
      undefined,
      undefined,
      {
        admissions: composerAdmissionsRef.current,
        updatedAtById: composerAdmissionUpdatedAtRef.current,
        deletedAtById: composerAdmissionDeletedAtRef.current,
      },
    )
    if (!persisted) {
      composerStateUpdatedAtRef.current = previousUpdatedAt
      composerStateDeletedAtRef.current = previousDeletedAt
      composerAdmissionsRef.current = previousAdmissions
      composerAdmissionUpdatedAtRef.current = previousAdmissionUpdatedAt
      composerAdmissionDeletedAtRef.current = previousAdmissionDeletedAt
      return false
    }
    composerByAgentKeyRef.current = next
    setComposerByAgentKey(next)
    return true
  }, [nextCheckpointTimestamp, resolveComposerStateKey, synchronizeComposerAdmissions])

  return {
    composerByAgentKey,
    updateComposerStateForKey,
    updateExistingComposerStateForKey,
    prepareComposerStateForTransport,
  }
}
