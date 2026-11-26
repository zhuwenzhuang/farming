import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseGlyph } from '@/components/IconGlyphs'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import {
  fetchAgentTurnCheckpointDiff,
  restoreAgentTurnCheckpoint,
  type TurnCheckpointDiffResponse,
  type TurnCheckpointItem,
} from '@/lib/turn-checkpoints'
import type { CodeCopy } from './copy'

interface AgentTurnCheckpointModalProps {
  agentId: string
  checkpoints: readonly TurnCheckpointItem[]
  initialCheckpointId?: string
  agentBusy?: boolean
  copy: CodeCopy
  onClose: () => void
  onRestored: () => void
}

function formatCheckpointTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function diffLineClassName(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
    return 'code-agent-transcript-checkpoint-diff-line meta'
  }
  if (line.startsWith('@@')) return 'code-agent-transcript-checkpoint-diff-line hunk'
  if (line.startsWith('+')) return 'code-agent-transcript-checkpoint-diff-line added'
  if (line.startsWith('-')) return 'code-agent-transcript-checkpoint-diff-line removed'
  return 'code-agent-transcript-checkpoint-diff-line context'
}

export function AgentTurnCheckpointModal({
  agentId,
  checkpoints,
  initialCheckpointId,
  agentBusy = false,
  copy,
  onClose,
  onRestored,
}: AgentTurnCheckpointModalProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [selectedId, setSelectedId] = useState<string>(
    () => initialCheckpointId || checkpoints[0]?.id || '',
  )
  const [selectedFile, setSelectedFile] = useState<string>('')
  const [diff, setDiff] = useState<TurnCheckpointDiffResponse | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<'before' | 'after' | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreFeedback, setRestoreFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)

  const selectedCheckpoint = useMemo(
    () => checkpoints.find(cp => cp.id === selectedId) ?? checkpoints[0] ?? null,
    [checkpoints, selectedId],
  )

  useEffect(() => {
    if (initialCheckpointId && checkpoints.some(cp => cp.id === initialCheckpointId)) {
      setSelectedId(initialCheckpointId)
    }
  }, [checkpoints, initialCheckpointId])

  useInteractionLayer({
    enabled: true,
    elements: () => [surfaceRef.current],
    onDismiss: onClose,
    dismissOnPointerOutside: true,
    dismissOnEscape: true,
  })

  useEffect(() => {
    if (!selectedCheckpoint) {
      setDiff(null)
      return undefined
    }
    const controller = new AbortController()
    setDiffLoading(true)
    setDiffError(null)
    fetchAgentTurnCheckpointDiff(agentId, selectedCheckpoint.id, selectedFile || undefined, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) {
          setDiff(result)
          setDiffLoading(false)
        }
      })
      .catch(caught => {
        if (controller.signal.aborted) return
        setDiff(null)
        setDiffError(caught instanceof Error ? caught.message : String(caught))
        setDiffLoading(false)
      })
    return () => controller.abort()
  }, [agentId, selectedCheckpoint, selectedFile])

  const handleRestore = useCallback(async (target: 'before' | 'after') => {
    if (!selectedCheckpoint || restoring) return
    setRestoring(true)
    setRestoreFeedback(null)
    try {
      const result = await restoreAgentTurnCheckpoint(agentId, selectedCheckpoint.id, target)
      setConfirmTarget(null)
      setRestoreFeedback({
        kind: 'success',
        message: copy.checkpointRestoredSummary(result.restoredCount + result.removedCount, Boolean(result.safetyCheckpoint)),
      })
      onRestored()
    } catch (caught) {
      setRestoreFeedback({
        kind: 'error',
        message: caught instanceof Error ? caught.message : String(caught),
      })
    } finally {
      setRestoring(false)
    }
  }, [agentId, copy, onRestored, restoring, selectedCheckpoint])

  const patchLines = useMemo(
    () => (diff?.patch ? diff.patch.split('\n') : []),
    [diff?.patch],
  )

  const dialog = (
    <div className="code-agent-transcript-checkpoint-backdrop" data-testid="code-turn-checkpoint-backdrop">
      <div
        ref={surfaceRef}
        className="code-menu-surface code-agent-transcript-checkpoint-modal"
        data-testid="code-turn-checkpoint-modal"
        role="dialog"
        aria-modal="true"
        aria-label={copy.checkpointTitle}
      >
        <div className="code-agent-transcript-checkpoint-header">
          <div className="code-agent-transcript-checkpoint-heading">
            <h3>{copy.checkpointTitle}</h3>
            <span>{copy.checkpointCount(checkpoints.length)}</span>
          </div>
          <button
            type="button"
            className="code-agent-transcript-checkpoint-close"
            data-testid="code-turn-checkpoint-close"
            aria-label={copy.close}
            onClick={onClose}
          >
            <CloseGlyph />
          </button>
        </div>

        <div className="code-agent-transcript-checkpoint-body">
          <aside className="code-agent-transcript-checkpoint-list" role="listbox" aria-label={copy.checkpointTitle}>
            {checkpoints.map(cp => {
              const active = cp.id === selectedCheckpoint?.id
              const totalAdd = cp.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
              const totalDel = cp.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
              return (
                <button
                  key={cp.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`code-agent-transcript-checkpoint-item ${active ? 'active' : ''}`}
                  data-testid="code-turn-checkpoint-item"
                  onClick={() => {
                    setSelectedId(cp.id)
                    setSelectedFile('')
                    setConfirmTarget(null)
                    setRestoreFeedback(null)
                  }}
                >
                  <span className="code-agent-transcript-checkpoint-item-top">
                    <strong>{cp.summary || copy.checkpointTurnLabel}</strong>
                    <span className="code-agent-transcript-checkpoint-time">{formatCheckpointTime(cp.createdAt)}</span>
                  </span>
                  <span className="code-agent-transcript-checkpoint-item-meta">
                    {cp.kind === 'pre-restore' ? (
                      <span className="code-agent-transcript-checkpoint-badge">{copy.checkpointSafetyBackup}</span>
                    ) : null}
                    <span>{copy.checkpointFilesChanged(cp.files.length)}</span>
                    {totalAdd > 0 ? <span className="code-agent-transcript-checkpoint-add">+{totalAdd}</span> : null}
                    {totalDel > 0 ? <span className="code-agent-transcript-checkpoint-del">-{totalDel}</span> : null}
                  </span>
                </button>
              )
            })}
          </aside>

          <section className="code-agent-transcript-checkpoint-detail">
            {selectedCheckpoint ? (
              <>
                <div className="code-agent-transcript-checkpoint-detail-bar">
                  <div className="code-agent-transcript-checkpoint-files">
                    <button
                      type="button"
                      className={`code-agent-transcript-checkpoint-file-chip ${selectedFile === '' ? 'active' : ''}`}
                      onClick={() => setSelectedFile('')}
                    >
                      {copy.searchAll} ({selectedCheckpoint.files.length})
                    </button>
                    {selectedCheckpoint.files.map(file => (
                      <button
                        key={file.path}
                        type="button"
                        className={`code-agent-transcript-checkpoint-file-chip ${selectedFile === file.path ? 'active' : ''}`}
                        onClick={() => setSelectedFile(file.path)}
                      >
                        {file.path}
                      </button>
                    ))}
                  </div>
                  <div className="code-agent-transcript-checkpoint-actions">
                    {confirmTarget ? (
                      <div className="code-agent-transcript-checkpoint-confirm" data-testid="code-turn-checkpoint-confirm">
                        <span>
                          {confirmTarget === 'before'
                            ? copy.checkpointConfirmUndo
                            : copy.checkpointConfirmRestoreAfter}
                        </span>
                        <button
                          type="button"
                          className="code-agent-transcript-checkpoint-action danger"
                          data-testid="code-turn-checkpoint-confirm-apply"
                          disabled={restoring || agentBusy}
                          onClick={() => void handleRestore(confirmTarget)}
                        >
                          {restoring ? copy.checkpointRestoring : copy.checkpointConfirmButton}
                        </button>
                        <button
                          type="button"
                          className="code-agent-transcript-checkpoint-action"
                          disabled={restoring}
                          onClick={() => setConfirmTarget(null)}
                        >
                          {copy.cancel}
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="code-agent-transcript-checkpoint-action"
                          data-testid="code-turn-checkpoint-undo"
                          disabled={agentBusy || restoring}
                          title={agentBusy ? copy.checkpointBusyHint : copy.checkpointUndoTurn}
                          onClick={() => setConfirmTarget('before')}
                        >
                          {copy.checkpointUndoTurn}
                        </button>
                        <button
                          type="button"
                          className="code-agent-transcript-checkpoint-action"
                          data-testid="code-turn-checkpoint-restore-after"
                          disabled={agentBusy || restoring}
                          title={agentBusy ? copy.checkpointBusyHint : copy.checkpointRestoreAfter}
                          onClick={() => setConfirmTarget('after')}
                        >
                          {copy.checkpointRestoreAfter}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {restoreFeedback ? (
                  <div
                    className={`code-agent-transcript-checkpoint-status ${restoreFeedback.kind}`}
                    data-testid="code-turn-checkpoint-status"
                    role={restoreFeedback.kind === 'error' ? 'alert' : 'status'}
                  >
                    {restoreFeedback.message}
                  </div>
                ) : null}

                <div className="code-agent-transcript-checkpoint-diff" data-testid="code-turn-checkpoint-diff">
                  {diffLoading ? (
                    <div className="code-agent-transcript-checkpoint-empty">{copy.searching}</div>
                  ) : diffError ? (
                    <div className="code-agent-transcript-checkpoint-status error" role="alert">{diffError}</div>
                  ) : patchLines.length === 0 ? (
                    <div className="code-agent-transcript-checkpoint-empty">{copy.checkpointNoDiff}</div>
                  ) : (
                    <pre className="code-agent-transcript-checkpoint-pre">
                      {patchLines.map((line, index) => (
                        <div key={index} className={diffLineClassName(line)}>
                          {line || ' '}
                        </div>
                      ))}
                    </pre>
                  )}
                </div>
              </>
            ) : (
              <div className="code-agent-transcript-checkpoint-empty">{copy.checkpointNoDiff}</div>
            )}
          </section>
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog
}
