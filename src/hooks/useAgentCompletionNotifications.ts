import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { isPageActive } from '@/hooks/usePageVisibility'
import {
  AGENT_COMPLETION_NOTIFICATION_COORDINATION_MS,
  AGENT_COMPLETION_NOTIFICATION_SETTLE_MS,
  AGENT_COMPLETION_NOTIFICATIONS_EVENT,
  AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY,
  agentCompletionNotificationContent,
  agentCompletionNotificationOwner,
  agentCompletionNotificationStillEligible,
  agentNotificationPermission,
  observeAgentCompletionNotificationEvents,
  readAgentCompletionNotificationsEnabled,
  type AgentCompletionNotificationCandidate,
  type AgentCompletionNotificationEvent,
} from '@/lib/agent-completion-notifications'
import type { Agent } from '@/types/agent'

const COORDINATOR_CHANNEL = 'farming-agent-completion-notifications-v1'
const HANDLED_EVENT_LIMIT = 128

type CoordinatorMessage =
  | {
      type: 'candidate'
      eventKey: string
      candidate: AgentCompletionNotificationCandidate
    }
  | {
      type: 'handled'
      eventKey: string
    }

interface PendingCoordination {
  candidates: Map<string, AgentCompletionNotificationCandidate>
  deliver: (() => void) | null
  decisionTimer: number | null
  cleanupTimer: number
}

class CompletionNotificationCoordinator {
  private readonly tabId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  private readonly channel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(COORDINATOR_CHANNEL)
  private readonly pending = new Map<string, PendingCoordination>()
  private readonly handled = new Set<string>()
  private readonly handledOrder: string[] = []

  constructor() {
    if (this.channel) this.channel.onmessage = event => this.receive(event.data)
  }

  coordinate(eventKey: string, pageActive: boolean, deliver: () => void) {
    if (this.handled.has(eventKey)) return
    const pending = this.pendingFor(eventKey)
    const candidate = { tabId: this.tabId, pageActive }
    pending.candidates.set(this.tabId, candidate)
    pending.deliver = deliver
    this.channel?.postMessage({ type: 'candidate', eventKey, candidate } satisfies CoordinatorMessage)
    if (pending.decisionTimer !== null) window.clearTimeout(pending.decisionTimer)
    pending.decisionTimer = window.setTimeout(() => this.decide(eventKey), AGENT_COMPLETION_NOTIFICATION_COORDINATION_MS)
  }

  dispose() {
    this.channel?.close()
    this.pending.forEach(pending => {
      if (pending.decisionTimer !== null) window.clearTimeout(pending.decisionTimer)
      window.clearTimeout(pending.cleanupTimer)
    })
    this.pending.clear()
  }

  private receive(value: unknown) {
    if (!value || typeof value !== 'object') return
    const message = value as {
      type?: unknown
      eventKey?: unknown
      candidate?: { tabId?: unknown; pageActive?: unknown }
    }
    if (message.type === 'handled' && typeof message.eventKey === 'string') {
      this.markHandled(message.eventKey, false)
      return
    }
    if (
      message.type !== 'candidate'
      || typeof message.eventKey !== 'string'
      || !message.candidate
      || typeof message.candidate.tabId !== 'string'
      || typeof message.candidate.pageActive !== 'boolean'
      || this.handled.has(message.eventKey)
    ) return
    const pending = this.pendingFor(message.eventKey)
    const candidate = {
      tabId: message.candidate.tabId,
      pageActive: message.candidate.pageActive,
    }
    pending.candidates.set(candidate.tabId, candidate)
  }

  private pendingFor(eventKey: string) {
    const existing = this.pending.get(eventKey)
    if (existing) return existing
    const pending: PendingCoordination = {
      candidates: new Map(),
      deliver: null,
      decisionTimer: null,
      cleanupTimer: window.setTimeout(() => this.clearPending(eventKey), 5_000),
    }
    this.pending.set(eventKey, pending)
    return pending
  }

  private decide(eventKey: string) {
    const pending = this.pending.get(eventKey)
    if (!pending || this.handled.has(eventKey)) return
    pending.decisionTimer = null
    const owner = agentCompletionNotificationOwner(Array.from(pending.candidates.values()))
    if (owner === null) {
      this.markHandled(eventKey)
      return
    }
    if (owner !== this.tabId || !pending.deliver) return
    const deliver = pending.deliver
    this.markHandled(eventKey)
    deliver()
  }

  private markHandled(eventKey: string, broadcast = true) {
    if (!this.handled.has(eventKey)) {
      this.handled.add(eventKey)
      this.handledOrder.push(eventKey)
      while (this.handledOrder.length > HANDLED_EVENT_LIMIT) {
        const oldest = this.handledOrder.shift()
        if (oldest) this.handled.delete(oldest)
      }
    }
    this.clearPending(eventKey)
    if (broadcast) this.channel?.postMessage({ type: 'handled', eventKey } satisfies CoordinatorMessage)
  }

  private clearPending(eventKey: string) {
    const pending = this.pending.get(eventKey)
    if (!pending) return
    if (pending.decisionTimer !== null) window.clearTimeout(pending.decisionTimer)
    window.clearTimeout(pending.cleanupTimer)
    this.pending.delete(eventKey)
  }
}

export function useAgentCompletionNotifications({
  agents,
  language,
  onOpenAgent,
}: {
  agents: Agent[]
  language: 'en' | 'zh'
  onOpenAgent: (agentId: string) => void
}) {
  const agentsRef = useRef(agents)
  const languageRef = useRef(language)
  const onOpenAgentRef = useRef(onOpenAgent)
  const cursorRef = useRef(new Map<string, number>())
  const initializedRef = useRef(false)
  const pendingTimersRef = useRef(new Map<string, number>())
  const coordinatorRef = useRef<CompletionNotificationCoordinator | null>(null)

  useLayoutEffect(() => {
    agentsRef.current = agents
    languageRef.current = language
    onOpenAgentRef.current = onOpenAgent
  }, [agents, language, onOpenAgent])

  useEffect(() => {
    // `pendingTimersRef.current` is never reassigned after useRef initialization,
    // so the timer map captured here is the same map the cleanup must drain.
    const pendingTimers = pendingTimersRef.current
    coordinatorRef.current = new CompletionNotificationCoordinator()
    return () => {
      coordinatorRef.current?.dispose()
      coordinatorRef.current = null
      pendingTimers.forEach(timer => window.clearTimeout(timer))
      pendingTimers.clear()
    }
  }, [])

  const deliverCompletionNotification = useCallback((
    event: AgentCompletionNotificationEvent,
    eventKey: string,
    pageActiveAtObservation: boolean,
  ) => {
    const agent = agentsRef.current.find(candidate => candidate.id === event.agentId)
    if (!agentCompletionNotificationStillEligible(agent, event)) return
    if (!readAgentCompletionNotificationsEnabled()) return
    if (agentNotificationPermission() !== 'granted') return
    const pageActive = pageActiveAtObservation || isPageActive()
    coordinatorRef.current?.coordinate(eventKey, pageActive, () => {
      const latestAgent = agentsRef.current.find(candidate => candidate.id === event.agentId)
      if (!agentCompletionNotificationStillEligible(latestAgent, event) || !latestAgent) return
      if (!readAgentCompletionNotificationsEnabled()) return
      if (agentNotificationPermission() !== 'granted' || isPageActive()) return
      const content = agentCompletionNotificationContent(
        latestAgent,
        languageRef.current,
        event.kind,
        event.summary,
      )
      try {
        const notification = new Notification(content.title, {
          body: content.body,
          tag: `farming-agent-${latestAgent.id}`,
        })
        notification.onclick = () => {
          window.focus()
          onOpenAgentRef.current(latestAgent.id)
          notification.close()
        }
      } catch {
        // Browser permission and OS notification state may change after the eligibility check.
      }
    })
  }, [])

  useEffect(() => {
    const events = observeAgentCompletionNotificationEvents(cursorRef.current, agents)
    if (!initializedRef.current) {
      initializedRef.current = true
      return
    }

    events.forEach(event => {
      const eventKey = `${event.agentId}:${event.kind}:${event.attentionSeq}`
      const existingTimer = pendingTimersRef.current.get(eventKey)
      if (existingTimer !== undefined) window.clearTimeout(existingTimer)
      const pageActiveAtObservation = isPageActive()
      const timer = window.setTimeout(() => {
        pendingTimersRef.current.delete(eventKey)
        deliverCompletionNotification(event, eventKey, pageActiveAtObservation)
      }, AGENT_COMPLETION_NOTIFICATION_SETTLE_MS)
      pendingTimersRef.current.set(eventKey, timer)
    })
  }, [agents, deliverCompletionNotification])

  useEffect(() => {
    const syncSetting = () => {
      if (!readAgentCompletionNotificationsEnabled()) {
        pendingTimersRef.current.forEach(timer => window.clearTimeout(timer))
        pendingTimersRef.current.clear()
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY) syncSetting()
    }
    window.addEventListener(AGENT_COMPLETION_NOTIFICATIONS_EVENT, syncSetting)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(AGENT_COMPLETION_NOTIFICATIONS_EVENT, syncSetting)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
}
