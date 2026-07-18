import type { CSSProperties } from 'react'
import type { Agent } from '@/types/agent'
import { agentPreviewText, agentTitle } from '@/lib/format'
import { useAgentWithLiveActivity } from '@/lib/agent-live-activity'
import { TerminalSnapshotPreview } from './TerminalSnapshotPreview'

interface AgentCardProps {
  agent: Agent
  keyHint?: string
  onClick: () => void
  compact?: boolean
  hideTitle?: boolean
  style?: CSSProperties
}

export function AgentCard({ agent, keyHint, onClick, compact, hideTitle, style }: AgentCardProps) {
  const liveAgent = useAgentWithLiveActivity(agent)
  const name = agentTitle(liveAgent)
  const useTerminalPreview = !compact && !hideTitle
  const preview = agentPreviewText(liveAgent)
  const zombieClass = liveAgent.isZombie ? 'zombie' : ''
  const task = typeof liveAgent.task === 'string' ? liveAgent.task.trim() : ''
  const childLabel = liveAgent.parentAgentId ? 'Child' : ''

  return (
    <div
      className={`agent-block ${liveAgent.isMain ? '' : `${liveAgent.activityLevel} ${zombieClass}`} ${liveAgent.status}`}
      data-agent-id={liveAgent.id}
      data-testid="agent-card"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onClick() }}
      style={style}
    >
      {!hideTitle && (
        <div className="agent-title-bar">
          <span className="agent-title-name">{name}</span>
          <span className="agent-title-meta">
            {liveAgent.isZombie && <span className="zombie-badge">ZOMBIE</span>}
            {childLabel && <span className="child-badge">{childLabel}</span>}
            {liveAgent.activityLevel} | score:{liveAgent.attentionScore}
          </span>
          {keyHint && <span className="key-badge">[{keyHint}]</span>}
        </div>
      )}
      <div className="agent-body">
        {!compact && liveAgent.cwd && (
          <div className="agent-cwd">{liveAgent.cwd}</div>
        )}
        {!compact && task && (
          <div className="agent-task" title={task}>{task}</div>
        )}
        {useTerminalPreview ? (
          <div className="agent-output agent-output-terminal">
            <TerminalSnapshotPreview
              text={liveAgent.previewText || liveAgent.output || ''}
              snapshot={liveAgent.previewSnapshot}
              cols={liveAgent.previewCols || 80}
              rows={liveAgent.previewRows || 24}
            />
          </div>
        ) : (
          <div className="agent-output">
            {preview ? preview : 'No output yet...'}
          </div>
        )}
      </div>
    </div>
  )
}
