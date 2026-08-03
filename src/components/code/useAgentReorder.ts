import { useState } from 'react'
import type { DragEvent } from 'react'

const DROP_AT_END = '__agent_drop_at_end__'

type AgentDrag = {
  agentId: string
  targetAgentId: string
  position: 'before' | 'after'
}

export function useAgentReorder<T extends { id: string }>(
  agents: ReadonlyArray<T>,
  onReorder: (agentId: string, beforeAgentId: string, afterAgentId: string) => void,
  onBegin: () => void,
  sharesOrder?: (source: T, target: T) => boolean,
) {
  const [agentDrag, setAgentDrag] = useState<AgentDrag | null>(null)
  const finishAgentDrag = () => setAgentDrag(null)
  const beginAgentDrag = (event: DragEvent<HTMLElement>, agentId: string) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', agentId)
    onBegin()
    setAgentDrag({ agentId, targetAgentId: '', position: 'before' })
  }
  const updateAgentDropTarget = (event: DragEvent<HTMLElement>, targetAgentId: string) => {
    if (!agentDrag || agentDrag.agentId === targetAgentId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    if (agentDrag.targetAgentId === targetAgentId && agentDrag.position === position) return
    setAgentDrag(current => current ? { ...current, targetAgentId, position } : null)
  }
  const reorderAgent = (targetAgentId?: string) => {
    if (!agentDrag) return
    const source = agents.find(agent => agent.id === agentDrag.agentId)
    const candidates = agents.filter(agent => (
      agent.id !== agentDrag.agentId
      && (!source || !sharesOrder || sharesOrder(source, agent))
    ))
    const targetIndex = targetAgentId
      ? candidates.findIndex(agent => agent.id === targetAgentId)
      : candidates.length
    if (targetIndex < 0) return
    const insertIndex = targetAgentId && agentDrag.position === 'after'
      ? targetIndex + 1
      : targetIndex
    onReorder(
      agentDrag.agentId,
      insertIndex > 0 ? candidates[insertIndex - 1]?.id ?? '' : '',
      insertIndex < candidates.length ? candidates[insertIndex]?.id ?? '' : '',
    )
  }
  const dropAgent = (event: DragEvent<HTMLElement>, targetAgentId: string) => {
    event.preventDefault()
    if (agentDrag?.agentId !== targetAgentId) reorderAgent(targetAgentId)
    finishAgentDrag()
  }
  const updateAgentEndDropTarget = (event: DragEvent<HTMLElement>) => {
    if (!agentDrag) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (agentDrag.targetAgentId === DROP_AT_END) return
    setAgentDrag(current => current ? { ...current, targetAgentId: DROP_AT_END, position: 'after' } : null)
  }
  const dropAgentAtEnd = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    reorderAgent()
    finishAgentDrag()
  }

  return {
    agentDrag,
    beginAgentDrag,
    dropAgent,
    dropAgentAtEnd,
    droppingAtEnd: agentDrag?.targetAgentId === DROP_AT_END,
    finishAgentDrag,
    updateAgentDropTarget,
    updateAgentEndDropTarget,
  }
}
