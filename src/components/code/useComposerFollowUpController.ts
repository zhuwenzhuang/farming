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
  createPendingFollowUpMessage,
  MAX_COMPOSER_SUBMISSIONS,
  removeComposerSubmission,
  removePendingFollowUpMessage,
  restorePendingFollowUpMessageForEdit,
  type AgentComposerPendingFollowUpMessage,
  type AgentComposerState,
  type ComposerDeliveryOptions,
  type ComposerDeliveryOutcome,
} from './composer-state'
import { addComposerHistoryEntry } from './composer-history'
import type { ComposerContextReference, ComposerPromptAttachment } from './composer-message'

export type ComposerMessageSender = (
  agent: Agent,
  message: string,
  attachments?: ComposerPromptAttachment[],
  requestId?: string,
  delivery?: 'prompt' | 'steer',
  contextReferences?: ComposerContextReference[],
  options?: ComposerDeliveryOptions,
) => boolean | Promise<boolean>

// Transport owns authoritative delivery results. This outer deadline bounds a
// stalled sender without claiming its effect failed. Late definitive outcomes
// still settle the retained exact request; timeout alone never permits replay.
const COMPOSER_FOLLOW_UP_SETTLE_TIMEOUT_MS = 30_000

type ComposerStateUpdater = (
  composerKey: string,
  updater: (state: AgentComposerState) => AgentComposerState,
) => void

export interface ComposerFollowUpOwnership {
  admissions: ComposerFollowUpAdmissions
  promptStartFences: Record<string, number>
}

export function isComposerPromptStartFenceActive(agent: Agent | null | undefined, revisionBeforePrompt: number | undefined) {
  if (!agent || !isAcpRuntime(agent) || revisionBeforePrompt === undefined) return false
  return !agent.archived
    && agent.status !== 'dead'
    && agent.status !== 'stopped'
    && agent.runtimeBinding.state !== 'error'
    && !isAgentTurnActive(agent)
    && (Number(agent.runtimeBinding.sessionRevision) || 0) <= revisionBeforePrompt
}

interface UseComposerFollowUpControllerOptions {
  ownership?: ComposerFollowUpOwnership
  flushQueues?: boolean
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

export function stageComposerFollowUp(
  state: AgentComposerState,
  messageId: string,
  delivery: 'prompt' | 'steer' = 'steer',
) {
  const message = state.pendingFollowUp?.messages.find(candidate => candidate.id === messageId)
  if (!message || (state.submissions?.length || 0) >= MAX_COMPOSER_SUBMISSIONS) return state
  return {
    ...state,
    pendingFollowUp: removePendingFollowUpMessage(state.pendingFollowUp, messageId),
    submissions: [
      ...(state.submissions || []),
      {
        ...message,
        status: 'queued' as const,
        historyRecorded: true,
        delivery,
      },
    ],
  }
}

export function settleComposerSubmissionState(
  state: AgentComposerState,
  messageId: string,
  accepted: boolean,
  historyText?: string,
  outcome: ComposerDeliveryOutcome = accepted ? 'accepted' : 'unknown',
) {
  const submitted = state.submissions?.find(item => item.id === messageId)
  if (!submitted) return state
  // Only a definite zero-effect failure may return to the editor. Never replace
  // text, media, references or a mode the user has started composing meanwhile.
  if (outcome === 'rejected' && state.submissions?.length === 1 && !state.pendingFollowUp?.messages.length && !state.draft && !state.attachments.length
    && !state.contextReferences?.length && state.mode === 'default') {
    return {
      ...state,
      draft: submitted.editableText ?? submitted.text,
      attachments: (submitted.attachments || []).map((item, index) => ({ ...item, id: `restored-${messageId}-${index}`, status: 'ready' as const })),
      contextReferences: submitted.contextReferences || [],
      mode: submitted.composerMode || 'default',
      submissions: removeComposerSubmission(state.submissions, messageId),
    }
  }
  return {
    ...state,
    ...(accepted && historyText !== undefined
      ? { history: addComposerHistoryEntry(state.history, historyText, undefined, { attachments: (submitted?.attachments || []).map((item, index) => ({ ...item, id: `history-${messageId}-${index}`, status: 'ready' as const })), contextReferences: submitted?.contextReferences || [] }) }
      : {}),
    submissions: accepted
      ? removeComposerSubmission(state.submissions, messageId)
      : state.submissions?.map(candidate => (
        candidate.id === messageId ? { ...candidate, status: outcome === 'rejected' ? 'failed' as const : 'unknown' as const } : candidate
      )),
  }
}

export function useComposerFollowUpController({
  ownership,
  flushQueues = true,
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
  const admissionsRef = useRef(ownership?.admissions ?? new ComposerFollowUpAdmissions())
  const promptStartFencesRef = useRef<Record<string, number>>(ownership?.promptStartFences ?? {})

  // Acceptance can arrive after the corresponding Turn has already completed.
  // Ref cleanup is bookkeeping; rendering must honor current runtime truth now.
  const isPromptStartFenced = useCallback((agent: Agent | null | undefined) => isComposerPromptStartFenceActive(
    agent ? agentWithCurrentLiveState(agent) : agent,
    agent ? promptStartFencesRef.current[agent.id] : undefined,
  ), [])
  const activePromptStartFenced = isPromptStartFenced(activeAgent)
  const activeAgentTurnActive = activePromptStartFenced || isAgentTurnActive(activeAgent)
  const activeAgentCanInterrupt = activeAgentTurnActive || terminalCanInterrupt

  const deliverSubmission = useCallback((agent: Agent, composerKey: string, submission: NonNullable<AgentComposerState['submissions']>[number], reconcile = false) => {
    if (!admissionsRef.current.beginPending(composerKey, submission.id)) return
    updateComposerState(composerKey, state => ({
      ...state,
      submissions: state.submissions?.map(candidate => candidate.id === submission.id ? { ...candidate, status: 'submitting' as const } : candidate),
    }))
    const revisionBeforePrompt = Number(agent.runtimeBinding.kind === 'acp' ? agent.runtimeBinding.sessionRevision : 0) || 0
    let outcome: ComposerDeliveryOutcome = 'unknown'
    const settle = (accepted: boolean) => {
      if (accepted && !reconcile && submission.delivery === 'prompt') promptStartFencesRef.current[agent.id] = revisionBeforePrompt
      updateExistingComposerState(composerKey, state => settleComposerSubmissionState(
        state, submission.id, accepted,
        submission.historyRecorded ? undefined : (submission.editableText ?? submission.text),
        accepted ? 'accepted' : outcome,
      ))
      admissionsRef.current.finishPending(composerKey, submission.id)
    }
    try {
      settleComposerDelivery(sendMessage(agent, submission.text, submission.attachments, submission.id,
        submission.delivery || 'prompt', submission.contextReferences, {
          reconcile,
          onOutcome: value => {
            outcome = value
            // Also reconcile a late definitive result after the outer deadline.
            settle(value === 'accepted')
          },
        }), settle)
    } catch {
      settle(false)
    }
  }, [sendMessage, updateComposerState, updateExistingComposerState])

  const retryAcpSubmission = useCallback((messageId: string) => {
    if (!activeAgent || !activeComposerKey) return
    const submission = composerByAgentKey[activeComposerKey]?.submissions?.[0]
    if (!submission || submission.id !== messageId || !['failed', 'unknown'].includes(submission.status)) return
    if (submission.status === 'failed') {
      // A definite zero-effect failure permits a fresh attempt. Give it a fresh
      // identity so delayed frames from the failed attempt cannot settle it.
      const id = createPendingFollowUpMessage(submission.text).id
      updateComposerState(activeComposerKey, state => ({ ...state,
        submissions: state.submissions?.map(item => item.id === messageId && item.status === 'failed'
          ? { ...item, id, status: 'queued' as const } : item),
      }))
      return
    }
    deliverSubmission(activeAgent, activeComposerKey, submission, true)
  }, [activeAgent, activeComposerKey, composerByAgentKey, deliverSubmission, updateComposerState])

  const steerPendingFollowUp = useCallback((messageId: string) => {
    if (!activeAgent || !activeComposerKey || !activeAgentTurnActive || !isAcpRuntime(activeAgent)
      || activeAgent.runtimeBinding.canSteer !== true
      || !admissionsRef.current.canDiscardOrEdit(activeComposerKey, messageId)) return
    updateComposerState(activeComposerKey, state => stageComposerFollowUp(state, messageId))
  }, [activeAgent, activeComposerKey, activeAgentTurnActive, updateComposerState])

  // One in-flight request per composer, shared by main and side panes. Unknown
  // and failed heads stop this FIFO; neither reconnect nor a newer send skips it.
  const flushSubmissions = useCallback((candidateAgents: Agent[]) => {
    candidateAgents.forEach(structuralAgent => {
      const agent = agentWithCurrentLiveState(structuralAgent)
      if (!isAcpRuntime(agent) || agent.archived || agent.status !== 'running') return
      const key = acpComposerStateKeyForAgent(agent)
      const message = composerByAgentKeyRef.current[key]?.submissions?.[0]
      if (!message || message.status !== 'queued') return
      if (message.delivery !== 'steer' && (isAgentTurnActive(agent) || isPromptStartFenced(agent))) return
      deliverSubmission(agent, key, message)
    })
  }, [deliverSubmission, isPromptStartFenced])
  useEffect(() => { if (flushQueues) flushSubmissions(agents) }, [agents, composerByAgentKey, flushQueues, flushSubmissions])

  const discardAcpSubmission = useCallback((messageId: string) => {
    if (!activeComposerKey || !admissionsRef.current.canDiscardOrEdit(activeComposerKey, messageId)
      || composerByAgentKey[activeComposerKey]?.submissions?.find(message => message.id === messageId)?.status !== 'failed') return
    updateComposerState(activeComposerKey, state => ({
      ...state,
      submissions: removeComposerSubmission(state.submissions, messageId),
    }))
    focusComposer()
  }, [activeComposerKey, composerByAgentKey, focusComposer, updateComposerState])

  const interruptActiveAgent = useCallback(() => {
    if (!activeAgent || !activeAgentCanInterrupt) return
    interruptAgent(activeAgent.id)
    focusComposer()
  }, [activeAgent, activeAgentCanInterrupt, focusComposer, interruptAgent])

  const sendPendingFollowUp = useCallback((messageId: string) => {
    if (!activeAgent || !activeComposerKey || composerByAgentKey[activeComposerKey]?.submissions?.length) return
    const message = composerByAgentKey[activeComposerKey]?.pendingFollowUp?.messages.find(item => item.id === messageId)
    if (!message) return
    if (isAcpRuntime(activeAgent)) {
      updateComposerState(activeComposerKey, state => stageComposerFollowUp(state, message.id, 'prompt'))
      return
    }
    if (!admissionsRef.current.beginPending(activeComposerKey, message.id)) return
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
      settleComposerDelivery(sendMessage(activeAgent, message.text, message.attachments, message.id, 'prompt', message.contextReferences), settle)
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
    if (!isComposerPromptStartFenceActive(agent, revisionBeforePrompt)) delete promptStartFencesRef.current[agent.id]
  }, [])

  useEffect(() => {
    const activeAgentIds = new Set(agents.map(agent => agent.id))
    Object.keys(promptStartFencesRef.current).forEach(agentId => {
      if (flushQueues && !activeAgentIds.has(agentId)) delete promptStartFencesRef.current[agentId]
    })
    agents.forEach(reconcilePromptStartFence)
  }, [agents, flushQueues, reconcilePromptStartFence])

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
      if (composerByAgentKeyRef.current[composerKey]?.submissions?.length) return
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
      if (!message) return
      if (runtime) {
        // All Chat deliveries share the outbox's outcome/recovery state machine.
        updateExistingComposerState(composerKey, state => stageComposerFollowUp(state, message.id, 'prompt'))
        return
      }
      if (!admissionsRef.current.beginPending(composerKey, message.id)) return
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
      }
      try {
        settleComposerDelivery(sendMessage(agent, message.text, message.attachments, message.id, 'prompt', message.contextReferences), settle)
      } catch {
        settle(false)
      }
    })
  }, [sendMessage, updateExistingComposerState])

  useEffect(() => {
    if (flushQueues) flushPendingFollowUps(agents)
  }, [agents, composerByAgentKey, flushPendingFollowUps, flushQueues])

  useEffect(() => subscribeAgentRuntimeBindingEvents(agentId => {
    const structuralAgent = agentsRef.current.find(agent => agent.id === agentId)
    if (!structuralAgent) return
    reconcilePromptStartFence(structuralAgent)
    if (flushQueues) { flushSubmissions([structuralAgent]); flushPendingFollowUps([structuralAgent]) }
  }), [flushPendingFollowUps, flushSubmissions, flushQueues, reconcilePromptStartFence])

  return useMemo(() => ({
    activeAgentCanInterrupt,
    activeAgentTurnActive,
    activePromptStartFenced,
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
    retryAcpSubmission,
    sendPendingFollowUp,
    steerPendingFollowUp,
  ])
}
