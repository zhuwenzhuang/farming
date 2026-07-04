import type { SystemStats } from '@/types/agent'
import { formatUptime } from '@/lib/format'

interface TopBarProps {
  activeCount: number
  totalCount: number
  systemStats: SystemStats | null
  uptime: number
  focusedAgentName: string | null
  topAttentionAgent: { name: string; score: number } | null
}

export function TopBar({ activeCount, totalCount, systemStats, uptime, focusedAgentName, topAttentionAgent }: TopBarProps) {
  return (
    <div className="top-bar fx-crt-panel-compact">
      <div className="top-bar-items">
        <span className="top-bar-item">
          Agents: {activeCount}/{totalCount}
        </span>
        <span className="top-bar-item">
          CPU: {systemStats ? `${systemStats.cpu}%` : '--%'}
        </span>
        <span className="top-bar-item">
          MEM: {systemStats ? `${systemStats.memory.percentage}%` : '--%'}
        </span>
        {focusedAgentName && (
          <span className="top-bar-item focus-indicator">
            Focus: {focusedAgentName}
          </span>
        )}
        {topAttentionAgent && !focusedAgentName && (
          <span className={`top-bar-item attention-indicator ${topAttentionAgent.score >= 70 ? 'hot' : ''}`}>
            Attn: {topAttentionAgent.name} [{topAttentionAgent.score}]
          </span>
        )}
        <span className="top-bar-item">
          Uptime: {formatUptime(uptime)}
        </span>
      </div>
    </div>
  )
}
