import { useMemo } from 'react'
import type { Agent } from '@/types/agent'
import type { MapLayoutMode } from '@/lib/map-layout-mode'
import { AgentCard } from './AgentCard'

interface MapViewProps {
  agents: Agent[]
  layoutMode: MapLayoutMode
  keyMap: Map<string, string>
  onOpenSession: (agentId: string) => void
  onNewAgent: () => void
}

export function MapView({ agents, layoutMode, keyMap, onOpenSession, onNewAgent }: MapViewProps) {
  const sortedAgents = useMemo(() => {
    const copy = [...agents]
    if (layoutMode === 'task') {
      copy.sort((a, b) => {
        const aw = a.task?.trim() ? 1 : 0
        const bw = b.task?.trim() ? 1 : 0
        if (bw !== aw) return bw - aw
        return b.attentionScore - a.attentionScore
      })
    } else {
      copy.sort((a, b) => b.attentionScore - a.attentionScore)
    }
    return copy
  }, [agents, layoutMode])

  // Build reverse map: agentId -> key digit
  const idToKey = new Map<string, string>()
  keyMap.forEach((agentId, key) => idToKey.set(agentId, key))

  if (agents.length === 0) {
    return (
      <div className="map-area empty" data-testid="map-area">
        <div className="empty-state" data-testid="empty-state">
          <div className="empty-title">No Agents Running</div>
          <div className="empty-hint">
            Press <strong>N</strong> to start a new agent
          </div>
          <button className="start-button" data-testid="empty-start-agent" onClick={onNewAgent}>
            [N] New Agent
          </button>
        </div>
      </div>
    )
  }

  // Choose layout class based on agent count (capped at 5 for predefined layouts)
  const layoutCount = Math.min(sortedAgents.length, 5)
  const layoutClass = `layout-${layoutCount}`

  // For 5+ agents, only the first 5 get named grid areas; extras go to overflow
  const visibleAgents = sortedAgents.slice(0, 5)
  const overflowAgents = sortedAgents.slice(5)

  return (
    <div className={`map-area ${layoutClass}`} data-testid="map-area">
      {visibleAgents.map((agent, index) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          keyHint={idToKey.get(agent.id)}
          onClick={() => onOpenSession(agent.id)}
          style={{ gridArea: `a${index}` }}
        />
      ))}
      {overflowAgents.map(agent => (
        <AgentCard
          key={agent.id}
          agent={agent}
          keyHint={idToKey.get(agent.id)}
          onClick={() => onOpenSession(agent.id)}
          compact
        />
      ))}
    </div>
  )
}
