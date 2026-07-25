import type { AgentTranscriptProcessItem } from './acp-entry-projection'

export type AcpCollaborationAction = 'started' | 'updated' | 'finished' | 'interrupted' | 'failed'

export interface AcpCollaborationEvent {
  id: string
  processItemId: string
  threadId: string
  name: string
  action: AcpCollaborationAction
  tone: number
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

function eventTone(threadId: string) {
  let hash = 0
  for (const character of threadId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return hash % 4
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
  const append = (item: AgentTranscriptProcessItem, threadId: string, action: AcpCollaborationAction) => {
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
    })
  }

  for (const item of items) {
    const collaboration = item.collaboration
    if (!collaboration) continue
    if (collaboration.kind === 'activity') {
      const action = activityAction(String(collaboration.activity || '').toLowerCase())
      if (action) append(item, collaboration.threadId || '', action)
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
        ? stateAction(agentStatus) || (itemStatus === 'failed' ? 'failed' : null)
        : fallbackToolAction(tool, itemStatus)
      if (!action || (tool !== 'wait' && activityActions.has(`${threadId}:${action}`))) continue
      append(item, threadId, action)
    }
  }
  return events
}
