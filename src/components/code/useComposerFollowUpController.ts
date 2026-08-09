import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Agent } from '@/types/agent'
import { isAcpRuntime } from '@/lib/agent-runtime'
import {
  agentWithCurrentLiveState,
  subscribeAgentRuntimeBindingEvents,
} from '@/lib/agent-live-state'
import { isAgentTurnActive, isCodexAgentWorking } from './capabilities'
import { acpComposerStateKeyForAgent } from './acp/acp-composer-state'
import {
  composerStateKeyForAgent,
  removeComposerSubmission,
  removePendingFollowUpMessage,
  restorePendingFollowUpMessageForEdit,
  type AgentComposerPendingFollowUpMessage,
  type AgentComposerState,
} from './composer-state'
import { addComposerHistoryEntry } from './composer-history'
import type { ComposerPromptAttachment } from './composer-message'

export type ComposerMessageSender = (
  agent: Agent,
  message: string,
  attachments?: ComposerPromptAttachment[],
  requestId?: string,
  delivery?: 'prompt' | 'steer',
) => boolean | Promise<boolean>

// Structured transport owns the durable requestId and normally settles at its
// 15s admission deadline. This outer deadline is a liveness backstop: an
// invalid port implementation cannot hold the local exact-mutation fence
// forever. A timeout is treated as not accepted; ACP queues become explicit
// failed UI submissions whose retry reconciles the same requestId. This does
// not claim the backend effect failed, and this owner never blindly replays it.
const COMPOSER_FOLLOW_UP_SETTLE_TIMEOUT_MS = 16_000

type ComposerStateUpdater = (
  composerKey: string,
  updater: (state: AgentComposerState) => AgentComposerState,
) => void

interface UseComposerFollowUpControllerOptions {
  agents: Agent[]
  activeAgent: Agent | null
  activeComposerKey: string
  composerByAgentKey: Record<string, AgentComposerState>
  terminalCanInterrupt: boolean
  sendMessage: ComposerMessageSender
  updateComposerState: ComposerStateUpdater
  updateExistingComposerState: ComposerStateUpdater
  focusComposer: () => void
  interruptAgent: (agentId: string) => void
}

/**
 * Browser-owned admission is deliberately narrow: it prevents concurrent UI
 * effects for one exact queued request. The backend and ACP runtime remain the
 * authoritative owners of delivery admission and Turn state.
 */
export class ComposerFollowUpAdmissions {
  private readonly pendingByComposerKey = new Map<string, string>()
  private readonly mutationByComposerKey = new Map<string, Map<string, 'pending' | 'submission'>>()

  private mutationsFor(composerKey: string) {
    let mutations = this.mutationByComposerKey.get(composerKey)
    if (!mutations) {
      mutations = new Map()
      this.mutationByComposerKey.set(composerKey, mutations)
    }
    return mutations
  }

  private finishMutation(composerKey: string, messageId: string, kind: 'pending' | 'submission') {
    const mutations = this.mutationByComposerKey.get(composerKey)
    if (mutations?.get(messageId) !== kind) return
    mutations.delete(messageId)
    if (mutations.size === 0) this.mutationByComposerKey.delete(composerKey)
  }

  beginPending(composerKey: string, messageId: string) {
    if (this.pendingByComposerKey.has(composerKey) || this.isMutationActive(composerKey, messageId)) return false
    this.pendingByComposerKey.set(composerKey, messageId)
    this.mutationsFor(composerKey).set(messageId, 'pending')
    return true
  }

  finishPending(composerKey: string, messageId: string) {
    if (this.pendingByComposerKey.get(composerKey) === messageId) {
      this.pendingByComposerKey.delete(composerKey)
    }
    this.finishMutation(composerKey, messageId, 'pending')
  }

  pendingMessageId(composerKey: string) {
    return this.pendingByComposerKey.get(composerKey)
  }

  beginSubmission(composerKey: string, messageId: string) {
    if (this.isMutationActive(composerKey, messageId)) return false
    this.mutationsFor(composerKey).set(messageId, 'submission')
    return true
  }

  finishSubmission(composerKey: string, messageId: string) {
    this.finishMutation(composerKey, messageId, 'submission')
  }

  isSubmissionActive(composerKey: string, messageId: string) {
    return this.mutationByComposerKey.get(composerKey)?.get(messageId) === 'submission'
  }

  isMutationActive(composerKey: string, messageId: string) {
    return this.mutationByComposerKey.get(composerKey)?.has(messageId) === true
  }

  canDiscardOrEdit(composerKey: string, messageId: string) {
    return !this.isMutationActive(composerKey, messageId)
  }
}

export function settleComposerDelivery(
  delivered: boolean | Promise<boolean>,
  settle: (accepted: boolean) => void,
  deadlineMs = COMPOSER_FOLLOW_UP_SETTLE_TIMEOUT_MS,
) {
  if (typeof delivered === 'boolean') {
    settle(delivered)
    return
  }
  let finished = false
  const finish = (accepted: boolean) => {
    if (finished) return
    finished = true
    globalThis.clearTimeout(timeout)
    settle(accepted)
  }
  const timeout = globalThis.setTimeout(() => finish(false), deadlineMs)
  void delivered.then(finish, () => finish(false))
}

export function stageComposerFollowUpForSteer(
  state: AgentComposerState,
  messageId: string,
) {
  const message = state.pendingFollowUp?.messages.find(candidate => candidate.id === messageId)
  if (!message) return state
  return {
    ...state,
    pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, messageId),
    submissions: [
      ...(state.submissions || []),
      {
        ...message,
        status: 'submitting' as const,
        historyRecorded: true,
        delivery: 'steer' as const,
      },
    ],
  }
}

export function settleComposerSubmissionState(
  state: AgentComposerState,
  messageId: string,
  accepted: boolean,
  historyText?: string,
) {
  return {
    ...state,
    ...(accepted && historyText
      ? { history: addComposerHistoryEntry(state.history, historyText) }
      : {}),
    submissions: accepted
      ? removeComposerSubmission(state.submissions, messageId)
      : state.submissions?.map(candidate => (
        candidate.id === messageId ? { ...candidate, status: 'failed' as const } : candidate
      )),
  }
}

export function failQueuedAcpFollowUp(
  state: AgentComposerState,
  message: AgentComposerPendingFollowUpMessage,
) {
  if (!state.pendingFollowUp?.messages.some(candidate => candidate.id === message.id)) return state
  return {
    ...state,
    pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, message.id),
    submissions: [
      ...(state.submissions || []),
      {
        ...message,
        status: 'failed' as const,
        historyRecorded: true,
        delivery: 'prompt' as const,
      },
    ],
  }
}

export function useComposerFollowUpController({
  agents,
  activeAgent,
  activeComposerKey,
  composerByAgentKey,
  terminalCanInterrupt,
  sendMessage,
  updateComposerState,
  updateExistingComposerState,
  focusComposer,
  interruptAgent,
}: UseComposerFollowUpControllerOptions) {
  const composerByAgentKeyRef = useRef(composerByAgentKey)
  composerByAgentKeyRef.current = composerByAgentKey
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const admissionsRef = useRef(new ComposerFollowUpAdmissions())
  const promptStartFencesRef = useRef<Record<string, number>>({})

  const isPromptStartFenced = useCallback((agent: Agent | null | undefined) => Boolean(
    agent
    && isAcpRuntime(agent)
    && promptStartFencesRef.current[agent.id] !== undefined
  ), [])
  const activePromptStartFenced = isPromptStartFenced(activeAgent)
  const activeAgentTurnActive = activePromptStartFenced || isAgentTurnActive(activeAgent)
  const activeAgentCanInterrupt = activeAgentTurnActive || terminalCanInterrupt

  const markPromptStart = useCallback((agent: Agent) => {
    if (!isAcpRuntime(agent)) return
    promptStartFencesRef.current[agent.id] = Number(agent.runtimeBinding.sessionRevision) || 0
  }, [])

  const retryAcpSubmission = useCallback((messageId: string) => {
    if (!activeAgent || !activeComposerKey) return
    const submission = composerByAgentKey[activeComposerKey]?.submissions?.find(candidate => (
      candidate.id === messageId && candidate.status === 'failed'
    ))
    if (!submission || !admissionsRef.current.beginSubmission(activeComposerKey, messageId)) return
    updateComposerState(activeComposerKey, state => ({
      ...state,
      submissions: state.submissions?.map(candidate => (
        candidate.id === messageId ? { ...candidate, status: 'submitting' as const } : candidate
      )),
    }))
    const settle = (accepted: boolean) => {
      updateComposerState(activeComposerKey, state => settleComposerSubmissionState(
        state,
        messageId,
        accepted,
        submission.historyRecorded === true ? undefined : submission.text,
      ))
      admissionsRef.current.finishSubmission(activeComposerKey, messageId)
    }
    try {
      settleComposerDelivery(sendMessage(
        activeAgent,
        submission.text,
        submission.attachments,
        submission.id,
        submission.delivery || 'prompt',
      ), settle)
    } catch {
      settle(false)
    }
  }, [activeAgent, activeComposerKey, composerByAgentKey, sendMessage, updateComposerState])

  const steerPendingFollowUp = useCallback((messageId: string) => {
    if (
      !activeAgent
      || !activeComposerKey
      || !activeAgentTurnActive
      || !isAcpRuntime(activeAgent)
      || activeAgent.runtimeBinding.supportsSteer !== true
    ) return
    const message = composerByAgentKey[activeComposerKey]?.pendingFollowUp?.messages.find(candidate => (
      candidate.id === messageId
    ))
    if (!message || !admissionsRef.current.beginSubmission(activeComposerKey, messageId)) return
    updateComposerState(activeComposerKey, state => stageComposerFollowUpForSteer(state, messageId))
    const settle = (accepted: boolean) => {
      updateComposerState(activeComposerKey, state => settleComposerSubmissionState(
        state,
        messageId,
        accepted,
      ))
      admissionsRef.current.finishSubmission(activeComposerKey, messageId)
    }
    try {
      settleComposerDelivery(sendMessage(activeAgent, message.text, message.attachments, message.id, 'steer'), settle)
    } catch {
      settle(false)
    }
  }, [activeAgent, activeAgentTurnActive, activeComposerKey, composerByAgentKey, sendMessage, updateComposerState])

  const discardAcpSubmission = useCallback((messageId: string) => {
    if (!activeComposerKey || !admissionsRef.current.canDiscardOrEdit(activeComposerKey, messageId)) return
    updateComposerState(activeComposerKey, state => ({
      ...state,
      submissions: removeComposerSubmission(state.submissions, messageId),
    }))
    focusComposer()
  }, [activeComposerKey, focusComposer, updateComposerState])

  const interruptActiveAgent = useCallback(() => {
    if (!activeAgent || !activeAgentCanInterrupt) return
    interruptAgent(activeAgent.id)
    focusComposer()
  }, [activeAgent, activeAgentCanInterrupt, focusComposer, interruptAgent])

  const sendPendingFollowUp = useCallback((messageId: string) => {
    if (!activeAgent || !activeComposerKey) return
    const message = composerByAgentKey[activeComposerKey]?.pendingFollowUp?.messages.find(item => item.id === messageId)
    if (!message || !admissionsRef.current.beginPending(activeComposerKey, message.id)) return
    const settle = (accepted: boolean) => {
      admissionsRef.current.finishPending(activeComposerKey, message.id)
      if (!accepted) return
      updateComposerState(activeComposerKey, state => ({
        ...state,
        pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, messageId),
      }))
      focusComposer()
    }
    try {
      settleComposerDelivery(sendMessage(activeAgent, message.text, message.attachments, message.id, 'prompt'), settle)
    } catch {
      settle(false)
    }
  }, [activeAgent, activeComposerKey, composerByAgentKey, focusComposer, sendMessage, updateComposerState])

  const discardPendingFollowUp = useCallback((messageId: string) => {
    if (!activeAgent || !activeComposerKey || !admissionsRef.current.canDiscardOrEdit(activeComposerKey, messageId)) return
    updateComposerState(activeComposerKey, state => ({
      ...state,
      pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, messageId),
    }))
    focusComposer()
  }, [activeAgent, activeComposerKey, focusComposer, updateComposerState])

  const editPendingFollowUp = useCallback((messageId: string) => {
    if (!activeAgent || !activeComposerKey) return false
    const message = composerByAgentKey[activeComposerKey]?.pendingFollowUp?.messages.find(candidate => (
      candidate.id === messageId
    ))
    if (
      !message
      || !admissionsRef.current.canDiscardOrEdit(activeComposerKey, messageId)
    ) return false
    updateComposerState(activeComposerKey, state => restorePendingFollowUpMessageForEdit(state, messageId))
    focusComposer()
    return true
  }, [activeAgent, activeComposerKey, composerByAgentKey, focusComposer, updateComposerState])

  const reconcilePromptStartFence = useCallback((structuralAgent: Agent) => {
    const agent = agentWithCurrentLiveState(structuralAgent)
    const revisionBeforePrompt = promptStartFencesRef.current[agent.id]
    if (revisionBeforePrompt === undefined) return
    const runtime = isAcpRuntime(agent) ? agent.runtimeBinding : null
    const promptStateConfirmed = isAgentTurnActive(agent)
      || (Number(runtime?.sessionRevision) || 0) > revisionBeforePrompt
    if (
      !runtime
      || promptStateConfirmed
      || runtime.state === 'error'
      || agent.archived
      || agent.status === 'dead'
      || agent.status === 'stopped'
    ) delete promptStartFencesRef.current[agent.id]
  }, [])

  useEffect(() => {
    const activeAgentIds = new Set(agents.map(agent => agent.id))
    Object.keys(promptStartFencesRef.current).forEach(agentId => {
      if (!activeAgentIds.has(agentId)) delete promptStartFencesRef.current[agentId]
    })
    agents.forEach(reconcilePromptStartFence)
  }, [agents, reconcilePromptStartFence])

  const flushPendingFollowUps = useCallback((candidateAgents: Agent[]) => {
    const pendingFlushes: Array<{
      agent: Agent
      composerKey: string
      message: AgentComposerPendingFollowUpMessage
    }> = []

    candidateAgents.forEach(structuralAgent => {
      const agent = agentWithCurrentLiveState(structuralAgent)
      const runtime = isAcpRuntime(agent) ? agent.runtimeBinding : null
      const composerKey = runtime
        ? acpComposerStateKeyForAgent(agent)
        : composerStateKeyForAgent(agent)
      if (!composerKey) return
      const pending = composerByAgentKeyRef.current[composerKey]?.pendingFollowUp
      if (!pending || pending.messages.length === 0) return
      if (agent.archived || agent.status === 'dead' || agent.status === 'stopped') return
      if (runtime) {
        const revisionBeforePrompt = promptStartFencesRef.current[agent.id]
        const currentSessionRevision = Number(runtime.sessionRevision) || 0
        if (revisionBeforePrompt !== undefined && currentSessionRevision <= revisionBeforePrompt) return
      }
      if (runtime ? isAgentTurnActive(agent) : isCodexAgentWorking(agent)) return
      const message = pending.messages[0]
      if (!message || !admissionsRef.current.beginPending(composerKey, message.id)) return
      pendingFlushes.push({ agent, composerKey, message })
    })

    pendingFlushes.forEach(({ agent, composerKey, message }) => {
      const settle = (accepted: boolean) => {
        admissionsRef.current.finishPending(composerKey, message.id)
        if (accepted) {
          updateExistingComposerState(composerKey, state => ({
            ...state,
            pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, message.id),
          }))
          return
        }
        // Terminal input has no admission ACK. Preserve it for an idle retry.
        // ACP non-acceptance (including an uncertain transport timeout) becomes
        // an explicit row; Retry uses the same id so the backend can reconcile
        // rather than replaying an unknown provider effect.
        if (!isAcpRuntime(agent)) return
        updateExistingComposerState(composerKey, state => failQueuedAcpFollowUp(state, message))
      }
      try {
        settleComposerDelivery(sendMessage(agent, message.text, message.attachments, message.id, 'prompt'), settle)
      } catch {
        settle(false)
      }
    })
  }, [sendMessage, updateExistingComposerState])

  useEffect(() => {
    flushPendingFollowUps(agents)
  }, [agents, composerByAgentKey, flushPendingFollowUps])

  useEffect(() => subscribeAgentRuntimeBindingEvents(agentId => {
    const structuralAgent = agentsRef.current.find(agent => agent.id === agentId)
    if (!structuralAgent) return
    reconcilePromptStartFence(structuralAgent)
    flushPendingFollowUps([structuralAgent])
  }), [flushPendingFollowUps, reconcilePromptStartFence])

  return useMemo(() => ({
    activeAgentCanInterrupt,
    activeAgentTurnActive,
    activePromptStartFenced,
    markPromptStart,
    retryAcpSubmission,
    steerPendingFollowUp,
    discardAcpSubmission,
    interruptActiveAgent,
    sendPendingFollowUp,
    discardPendingFollowUp,
    editPendingFollowUp,
  }), [
    activeAgentCanInterrupt,
    activeAgentTurnActive,
    activePromptStartFenced,
    discardAcpSubmission,
    discardPendingFollowUp,
    editPendingFollowUp,
    interruptActiveAgent,
    markPromptStart,
    retryAcpSubmission,
    sendPendingFollowUp,
    steerPendingFollowUp,
  ])
}
