import { useEffect } from 'react'
import type { Agent } from '@/types/agent'
import { agentTitle } from '@/lib/format'

interface TaskListDialogProps {
  open: boolean
  agents: Agent[]
  keyMap: Map<string, string>
  onOpenSession: (agentId: string) => void
  onClose: () => void
}

export function TaskListDialog({ open, agents, keyMap, onOpenSession, onClose }: TaskListDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const idToKey = new Map<string, string>()
  keyMap.forEach((agentId, key) => idToKey.set(agentId, key))

  if (!open) return null

  return (
    <div className="dialog-overlay" data-testid="task-list-overlay">
      <div className="history-dialog fx-crt-panel" data-testid="task-list-dialog">
        <div className="dialog-header fx-crt-panel-compact">
          <div className="dialog-header-copy">
            <div className="dialog-header-title">Task List</div>
          </div>
          <button type="button" className="close-btn" onClick={onClose}>Close [Esc]</button>
        </div>

        {agents.length === 0 ? (
          <div className="history-empty">No child agents running.</div>
        ) : (
          <div className="history-list" data-testid="task-list">
            {agents.map(agent => (
              <button
                key={agent.id}
                type="button"
                className="history-item fx-crt-panel fx-crt-panel-compact task-list-row"
                data-testid="task-list-row"
                onClick={() => {
                  onOpenSession(agent.id)
                  onClose()
                }}
              >
                <div className="history-row">
                  <span className="history-command">{agentTitle(agent)}</span>
                  <span className="history-reason">{agent.status}</span>
                  {idToKey.get(agent.id) && (
                    <span className="key-hint-badge">[{idToKey.get(agent.id)}]</span>
                  )}
                </div>
                {agent.task ? (
                  <div className="history-task">task: {agent.task}</div>
                ) : (
                  <div className="history-task muted">task: —</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
