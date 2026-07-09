import { useEffect } from 'react'
import type { AgentLaunchPrefill, TaskHistoryEntry } from '@/types/agent'

interface HistoryDialogProps {
  open: boolean
  entries: TaskHistoryEntry[]
  needsMainAgent: boolean
  onClose: () => void
  onRelaunch?: (prefill: AgentLaunchPrefill) => void
}

function formatTime(value: number | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

function reasonLabel(reason: string): string {
  if (reason === 'zombie-cleanup') return 'Zombie Cleanup'
  if (reason === 'manual-kill') return 'Manual Kill'
  if (reason === 'process-exit') return 'Process Exit'
  return reason
}

export function HistoryDialog({ open, entries, needsMainAgent, onClose, onRelaunch }: HistoryDialogProps) {
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

  if (!open) return null

  return (
    <div className="dialog-overlay" data-testid="history-dialog-overlay">
      <div className="history-dialog fx-crt-panel" data-testid="history-dialog">
        <div className="dialog-header fx-crt-panel-compact">
          <div className="dialog-header-copy">
            <div className="dialog-header-title">History Archive</div>
          </div>
          <button className="close-btn" onClick={onClose}>Close [Esc]</button>
        </div>

        {entries.length === 0 ? (
          <div className="history-empty">No archived tasks yet.</div>
        ) : (
          <div className="history-list" data-testid="history-list">
            {entries.map((entry) => (
              <div key={entry.id} className="history-item fx-crt-panel fx-crt-panel-compact">
                <div className="history-row">
                  <span className="history-command">{entry.command || 'unknown'}</span>
                  <span className="history-reason">{reasonLabel(entry.reason)}</span>
                </div>
                {entry.task && <div className="history-task">task: {entry.task}</div>}
                <div className="history-meta">
                  cwd: {entry.cwd || '-'} | archived: {formatTime(entry.archivedAt)} | last activity: {formatTime(entry.lastActivity)}
                </div>
                {onRelaunch && !needsMainAgent && (
                  <button
                    type="button"
                    className="history-relaunch"
                    data-testid="history-relaunch"
                    onClick={() => {
                      onRelaunch({
                        command: entry.command,
                        workspace: entry.cwd,
                        task: entry.task,
                        workflowTemplate: entry.workflowTemplate,
                        customTitle: entry.customTitle,
                      })
                    }}
                  >
                    Relaunch
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
