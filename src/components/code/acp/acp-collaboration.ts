import type {
  AgentTranscriptProcessItem,
  AgentTranscriptSubagentState,
} from './acp-entry-projection'

export type AcpCollaborationAction = 'started' | 'updated' | 'finished' | 'interrupted' | 'failed' | 'recorded'
export type AcpCollaborationStatus = 'pending' | 'running' | 'completed' | 'paused' | 'failed' | 'closed' | 'unknown'

export interface AcpCollaborationEvent {
  id: string
  processItemId: string
  threadId: string
  name: string
  action: AcpCollaborationAction
  tone: number
  title: string
  message: string
}

export interface AcpCollaborationAgent {
  id: string
  threadId: string
  name: string
  status: AcpCollaborationStatus
  parentThreadId?: string
  tone: number
  icon: number
  events: AcpCollaborationEvent[]
  activities: AcpCollaborationActivity[]
}

export interface AcpCollaborationActivity {
  id: string
  processItemId: string
  processItemIds: string[]
  action: AcpCollaborationAction
  title: string
  message: string
  count: number
}

function displayAgentName(path: string, threadId: string) {
  const segments = path.split('/').filter(Boolean)
  const lastSegment = segments[segments.length - 1] || ''
  const normalized = lastSegment.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (normalized) return normalized.charAt(0).toUpperCase() + normalized.slice(1)
  const suffix = threadId.replace(/[^a-z0-9]/gi, '').slice(0, 6)
  return suffix ? `Agent ${suffix}` : 'Subagent'
}

function activityAction(activity: string): AcpCollaborationAction | null {
  if (activity === 'started') return 'started'
  if (activity === 'interacted') return 'updated'
  if (activity === 'interrupted') return 'interrupted'
  return null
}

function fallbackToolAction(tool: string, status: string): AcpCollaborationAction | null {
  if (status === 'failed') return 'failed'
  if (tool === 'spawnagent') return 'started'
  if (['sendinput', 'resumeagent'].includes(tool)) return 'updated'
  if (tool === 'closeagent') return 'finished'
  return null
}

function threadVisualHash(threadId: string) {
  let hash = 0
  for (const character of threadId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return hash
}

function eventTone(threadId: string) {
  return threadVisualHash(threadId) % 4
}

function agentIcon(threadId: string) {
  return Math.floor(threadVisualHash(threadId) / 4) % 6
}

export function acpCollaborationEvents(items: AgentTranscriptProcessItem[]): AcpCollaborationEvent[] {
  const nameByThread = new Map<string, string>()
  const activityActions = new Set<string>()
  for (const item of items) {
    const collaboration = item.collaboration
    if (collaboration?.kind !== 'activity' || !collaboration.threadId) continue
    nameByThread.set(collaboration.threadId, displayAgentName(collaboration.agentPath || '', collaboration.threadId))
    const action = activityAction(String(collaboration.activity || '').toLowerCase())
    if (action) activityActions.add(`${collaboration.threadId}:${action}`)
  }

  const events: AcpCollaborationEvent[] = []
  const seen = new Set<string>()
  const append = (
    item: AgentTranscriptProcessItem,
    threadId: string,
    action: AcpCollaborationAction,
    message = '',
  ) => {
    const key = `${item.id}:${threadId}:${action}`
    if (!threadId || seen.has(key)) return
    seen.add(key)
    events.push({
      id: key,
      processItemId: item.id,
      threadId,
      name: nameByThread.get(threadId) || displayAgentName('', threadId),
      action,
      tone: eventTone(threadId),
      title: String(item.title || '').trim(),
      message: String(message || '').trim(),
    })
  }

  for (const item of items) {
    const collaboration = item.collaboration
    if (!collaboration) continue
    if (collaboration.kind === 'activity') {
      const action = activityAction(String(collaboration.activity || '').toLowerCase()) || 'recorded'
      append(item, collaboration.threadId || '', action)
      continue
    }
    const tool = String(collaboration.tool || '').toLowerCase()
    const itemStatus = String(item.status || '').toLowerCase()
    const threadIds = [...new Set([
      ...(collaboration.receiverThreadIds || []),
      ...Object.keys(collaboration.agentsStates || {}),
    ].filter(Boolean))]
    for (const threadId of threadIds) {
      const action = tool === 'wait'
        ? (itemStatus === 'failed' ? 'failed' : 'recorded')
        : fallbackToolAction(tool, itemStatus) || 'recorded'
      if (tool !== 'wait' && action !== 'recorded' && activityActions.has(`${threadId}:${action}`)) continue
      append(item, threadId, action, collaboration.agentsStates?.[threadId]?.message)
    }
  }
  return events
}

function collaborationStatus(status: string): AcpCollaborationStatus {
  if (status === 'pendingInit') return 'pending'
  if (status === 'running') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'interrupted') return 'paused'
  if (['errored', 'notFound'].includes(status)) return 'failed'
  if (status === 'shutdown') return 'closed'
  return 'unknown'
}

export function acpCollaborationAgents(
  items: AgentTranscriptProcessItem[],
  states: AgentTranscriptSubagentState[] = [],
): AcpCollaborationAgent[] {
  const stateByThreadId = new Map(states.map(state => [state.threadId, state]))
  const groups = new Map<string, AcpCollaborationAgent>()
  for (const event of acpCollaborationEvents(items)) {
    const existing = groups.get(event.threadId)
    if (existing) {
      existing.events.push(event)
      existing.name = event.name
      const previousActivity = existing.activities[existing.activities.length - 1]
      if (
        event.action === 'updated'
        && previousActivity?.action === event.action
        && previousActivity.title === event.title
        && previousActivity.message === event.message
      ) {
        previousActivity.processItemId = event.processItemId
        previousActivity.processItemIds.push(event.processItemId)
        previousActivity.count += 1
      } else {
        existing.activities.push({
          id: event.id,
          processItemId: event.processItemId,
          processItemIds: [event.processItemId],
          action: event.action,
          title: event.title,
          message: event.message,
          count: 1,
        })
      }
      continue
    }
    groups.set(event.threadId, {
      id: event.threadId,
      threadId: event.threadId,
      name: event.name,
      status: collaborationStatus(stateByThreadId.get(event.threadId)?.status || ''),
      parentThreadId: stateByThreadId.get(event.threadId)?.parentThreadId,
      tone: event.tone,
      icon: agentIcon(event.threadId),
      events: [event],
      activities: [{
        id: event.id,
        processItemId: event.processItemId,
        processItemIds: [event.processItemId],
        action: event.action,
        title: event.title,
        message: event.message,
        count: 1,
      }],
    })
  }
  for (const agent of groups.values()) {
    const state = stateByThreadId.get(agent.threadId)
    if (state?.name?.trim()) agent.name = state.name.trim()
    agent.status = collaborationStatus(state?.status || '')
    agent.parentThreadId = state?.parentThreadId
  }
  for (const state of states) {
    if (groups.has(state.threadId)) continue
    groups.set(state.threadId, {
      id: state.threadId,
      threadId: state.threadId,
      name: state.name?.trim() || displayAgentName('', state.threadId),
      status: collaborationStatus(state.status),
      parentThreadId: state.parentThreadId,
      tone: eventTone(state.threadId),
      icon: agentIcon(state.threadId),
      events: [],
      activities: [],
    })
  }
  return [...groups.values()]
}
