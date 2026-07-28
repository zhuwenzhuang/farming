import type { AgentTranscriptProcessItem } from './acp-entry-projection'

export type AcpCollaborationAction = 'started' | 'updated' | 'finished' | 'interrupted' | 'failed' | 'recorded'

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
  action: AcpCollaborationAction
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

function stateAction(status: string): AcpCollaborationAction | null {
  if (['completed', 'shutdown'].includes(status)) return 'finished'
  if (['errored', 'notfound'].includes(status)) return 'failed'
  if (status === 'interrupted') return 'interrupted'
  if (['pendinginit', 'running'].includes(status)) return 'updated'
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
      const agentStatus = String(collaboration.agentsStates?.[threadId]?.status || '').toLowerCase()
      const action = tool === 'wait'
        ? stateAction(agentStatus) || (itemStatus === 'failed' ? 'failed' : 'recorded')
        : fallbackToolAction(tool, itemStatus) || 'recorded'
      if (tool !== 'wait' && action !== 'recorded' && activityActions.has(`${threadId}:${action}`)) continue
      append(item, threadId, action, collaboration.agentsStates?.[threadId]?.message)
    }
  }
  return events
}

export function acpCollaborationAgents(items: AgentTranscriptProcessItem[]): AcpCollaborationAgent[] {
  const groups = new Map<string, AcpCollaborationAgent>()
  for (const event of acpCollaborationEvents(items)) {
    const existing = groups.get(event.threadId)
    if (existing) {
      existing.events.push(event)
      if (event.action !== 'recorded') existing.action = event.action
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
      action: event.action,
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
  return [...groups.values()]
}
