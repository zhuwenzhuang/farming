import { useRef, useState } from 'react'
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
  // Native dragover and drop can arrive before React commits a render. The
  // ref owns the input transaction; state only projects it into row feedback.
  const dragRef = useRef<AgentDrag | null>(null)
  const [agentDrag, setDragFeedback] = useState<AgentDrag | null>(null)
  const setAgentDrag = (next: AgentDrag | null) => {
    dragRef.current = next
    setDragFeedback(next)
  }
  const finishAgentDrag = () => setAgentDrag(null)
  const clearAgentDropTarget = () => {
    const current = dragRef.current
    if (current?.targetAgentId) setAgentDrag({ ...current, targetAgentId: '' })
  }
  const leaveAgentDropTarget = (event: DragEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    clearAgentDropTarget()
  }
  const acceptsTarget = (targetAgentId: string) => {
    const agentDrag = dragRef.current
    if (!agentDrag || agentDrag.agentId === targetAgentId) return false
    const source = agents.find(agent => agent.id === agentDrag.agentId)
    const target = agents.find(agent => agent.id === targetAgentId)
    return Boolean(source && target && (!sharesOrder || sharesOrder(source, target)))
  }
  const beginAgentDrag = (event: DragEvent<HTMLElement>, agentId: string) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', agentId)
    onBegin()
    setAgentDrag({ agentId, targetAgentId: '', position: 'before' })
  }
  const updateAgentDropTarget = (
    event: DragEvent<HTMLElement>,
    targetAgentId: string,
    visibleRow: Element = event.currentTarget,
  ) => {
    const agentDrag = dragRef.current
    if (!agentDrag) return
    if (!acceptsTarget(targetAgentId)) {
      event.dataTransfer.dropEffect = 'none'
      clearAgentDropTarget()
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = visibleRow.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    if (agentDrag.targetAgentId === targetAgentId && agentDrag.position === position) return
    setAgentDrag({ ...agentDrag, targetAgentId, position })
  }
  const reorderAgent = (targetAgentId?: string) => {
    const agentDrag = dragRef.current
    if (!agentDrag) return
    const source = agents.find(agent => agent.id === agentDrag.agentId)
    if (!source) return
    const candidates = agents.filter(agent => (
      agent.id !== agentDrag.agentId
      && (!sharesOrder || sharesOrder(source, agent))
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
    return agentDrag.agentId
  }
  const dropAgent = (event: DragEvent<HTMLElement>, targetAgentId: string) => {
    event.preventDefault()
    if (dragRef.current?.targetAgentId === targetAgentId && acceptsTarget(targetAgentId)) reorderAgent(targetAgentId)
    finishAgentDrag()
  }
  const updateAgentEndDropTarget = (event: DragEvent<HTMLElement>) => {
    const agentDrag = dragRef.current
    if (!agentDrag) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (agentDrag.targetAgentId === DROP_AT_END) return
    setAgentDrag({ ...agentDrag, targetAgentId: DROP_AT_END, position: 'after' })
  }
  const dropAgentAtEnd = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    const droppedAgentId = dragRef.current?.targetAgentId === DROP_AT_END ? reorderAgent() : undefined
    finishAgentDrag()
    return droppedAgentId
  }

  return {
    agentDrag,
    beginAgentDrag,
    dropAgent,
    dropAgentAtEnd,
    droppingAtEnd: agentDrag?.targetAgentId === DROP_AT_END,
    finishAgentDrag,
    leaveAgentDropTarget,
    updateAgentDropTarget,
    updateAgentEndDropTarget,
  }
}
