import type { CSSProperties } from 'react'
import type { Agent } from '@/types/agent'
import { agentPreviewText, agentTitle } from '@/lib/format'
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
  const name = agentTitle(agent)
  const useTerminalPreview = !compact && !hideTitle
  const preview = agentPreviewText(agent)
  const zombieClass = agent.isZombie ? 'zombie' : ''
  const task = typeof agent.task === 'string' ? agent.task.trim() : ''
  const childLabel = agent.parentAgentId ? 'Child' : ''

  return (
    <div
      className={`agent-block ${agent.isMain ? '' : `${agent.activityLevel} ${zombieClass}`} ${agent.status}`}
      data-agent-id={agent.id}
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
            {agent.isZombie && <span className="zombie-badge">ZOMBIE</span>}
            {childLabel && <span className="child-badge">{childLabel}</span>}
            {agent.activityLevel} | score:{agent.attentionScore}
          </span>
          {keyHint && <span className="key-badge">[{keyHint}]</span>}
        </div>
      )}
      <div className="agent-body">
        {!compact && agent.cwd && (
          <div className="agent-cwd">{agent.cwd}</div>
        )}
        {!compact && task && (
          <div className="agent-task" title={task}>{task}</div>
        )}
        {useTerminalPreview ? (
          <div className="agent-output agent-output-terminal">
            <TerminalSnapshotPreview
              text={agent.previewText || agent.output || ''}
              snapshot={agent.previewSnapshot}
              cols={agent.previewCols || 80}
              rows={agent.previewRows || 24}
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
