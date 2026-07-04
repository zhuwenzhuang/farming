import { useState, useCallback } from 'react'
import type { Agent } from '@/types/agent'
import { AgentCard } from './AgentCard'

interface SidebarMenuItem {
  key: string
  label: string
  enabled: boolean
  action?: () => void
}

interface SidebarProps {
  mainAgent: Agent | null
  onNewAgent: () => void
  onOpenSession: (agentId: string) => void
}

const MENU_ITEMS: Omit<SidebarMenuItem, 'action'>[] = [
  { key: 'N', label: 'New Agent', enabled: true },
]

export function Sidebar({ mainAgent, onNewAgent, onOpenSession }: SidebarProps) {
  const [expanded, setExpanded] = useState(false)
  const toggleExpand = useCallback(() => setExpanded(v => !v), [])

  function getAction(key: string) {
    if (key === 'N') return onNewAgent
    return undefined
  }

  return (
    <div className={`sidebar${expanded ? ' sidebar-expanded' : ''}`} data-testid="sidebar">
      <button className="sidebar-toggle fx-crt-panel fx-crt-panel-compact" data-testid="sidebar-toggle" onClick={toggleExpand}>
        <span className="key-hint">{expanded ? '[×]' : '[=]'}</span>
      </button>
      <div className="sidebar-menu">
        {MENU_ITEMS.map(item => {
          const action = getAction(item.key)
          return (
            <div
              key={item.key}
              className={`sidebar-item fx-crt-panel fx-crt-panel-compact ${item.enabled ? '' : 'disabled'}`}
              data-testid={`sidebar-item-${item.key.toLowerCase()}`}
              onClick={item.enabled ? action : undefined}
            >
              <span className="key-hint">[{item.key}]</span> <span className="sidebar-item-label">{item.label}</span>
            </div>
          )
        })}
      </div>

      {mainAgent && (
        <div className="main-agent-panel fx-crt-panel" data-testid="main-agent-panel">
          <div className="main-agent-header fx-crt-panel-compact">
            MAIN AGENT <span className="key-badge">[0]</span>
          </div>
          <div className="main-agent-content" data-testid="main-agent-content" onClick={() => onOpenSession(mainAgent.id)}>
            <AgentCard
              agent={mainAgent}
              onClick={() => onOpenSession(mainAgent.id)}
              compact
              hideTitle
            />
          </div>
        </div>
      )}
    </div>
  )
}
