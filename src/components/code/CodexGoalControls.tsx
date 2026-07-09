import { useCallback, useEffect, useRef, useState } from 'react'
import type { Agent, CodexAppServerGoal, CodexGoalStatus } from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { CheckGlyph, CloseGlyph } from '../IconGlyphs'
import type { CodeCopy } from './copy'

function canManageCodexGoal(agent: Agent | null | undefined) {
  return Boolean(agent)
    && agent?.providerSessionProvider === 'codex'
    && agent?.codexRuntimeMode === 'app-server'
    && Boolean(agent?.codexAppServerThreadId || agent?.providerSessionId)
}

function goalStatusForToggle(goal: CodexAppServerGoal | null): CodexGoalStatus {
  return goal?.status === 'active' ? 'paused' : 'active'
}

async function readGoalResponse(response: Response) {
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `${response.status}`)
  return payload
}

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11.6 1.65a1.55 1.55 0 0 1 2.19 2.19l-8.4 8.4-3.14.64.64-3.14 8.71-8.09Zm-.7 2.11-7.08 7.08-.22 1.08 1.08-.22 7.08-7.08-.86-.86Zm1.56-1.4-.86.86.86.86.62-.62a.55.55 0 0 0-.78-.78l-.84.84Z" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 3.4c0-.67.73-1.08 1.3-.72l6.1 3.78a.85.85 0 0 1 0 1.44l-6.1 3.78a.85.85 0 0 1-1.3-.72V3.4Z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.25 3.25c0-.41.34-.75.75-.75h1c.41 0 .75.34.75.75v9.5c0 .41-.34.75-.75.75H5a.75.75 0 0 1-.75-.75v-9.5Zm5 0c0-.41.34-.75.75-.75h1c.41 0 .75.34.75.75v9.5c0 .41-.34.75-.75.75h-1a.75.75 0 0 1-.75-.75v-9.5Z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.25 2h3.5l.5 1H13v1H3V3h2.75l.5-1ZM4.2 5h7.6l-.48 8.1A1 1 0 0 1 10.32 14H5.68a1 1 0 0 1-1-.9L4.2 5Zm2.05 1 .35 7h.95L7.2 6h-.95Zm2.2 0v7h.95V6h-.95Z" />
    </svg>
  )
}

interface CodexGoalControlsProps {
  agent: Agent | null
  active: boolean
  copy: CodeCopy
}

export function CodexGoalControls({ agent, active, copy }: CodexGoalControlsProps) {
  const manageable = canManageCodexGoal(agent)
  const agentId = agent?.id || ''
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [goal, setGoal] = useState<CodexAppServerGoal | null>(agent?.codexAppServerGoal || null)
  const [objective, setObjective] = useState(goal?.objective || '')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setGoal(agent?.codexAppServerGoal || null)
  }, [agent?.codexAppServerGoal])

  useEffect(() => {
    setEditing(false)
    setError('')
  }, [agentId])

  useEffect(() => {
    if (editing) return
    setObjective(goal?.objective || '')
  }, [editing, goal])

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus({ preventScroll: true })
  }, [editing])

  useEffect(() => {
    if (!active || !manageable || !agentId) return undefined
    const controller = new AbortController()
    fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/codex-goal`), {
      signal: controller.signal,
    })
      .then(readGoalResponse)
      .then(payload => {
        setGoal(payload.goal || null)
        setError('')
      })
      .catch(reason => {
        if (reason?.name === 'AbortError') return
        setError(reason?.message || copy.codexTranscriptUnavailable)
      })
    return () => controller.abort()
  }, [active, agentId, manageable, copy.codexTranscriptUnavailable])

  const updateGoal = useCallback((patch: { objective?: string; status?: CodexGoalStatus }) => {
    if (!manageable || !agentId || saving) return
    setSaving(true)
    setError('')
    fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/codex-goal`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then(readGoalResponse)
      .then(payload => {
        setGoal(payload.goal || null)
        setEditing(false)
        setError('')
      })
      .catch(reason => {
        setError(reason?.message || copy.codexTranscriptUnavailable)
      })
      .finally(() => setSaving(false))
  }, [agentId, copy.codexTranscriptUnavailable, manageable, saving])

  const saveGoal = useCallback(() => {
    const nextObjective = objective.trim()
    if (!nextObjective) {
      setError(copy.codexGoalObjective)
      return
    }
    updateGoal({
      objective: nextObjective,
      status: goal?.status || 'active',
    })
  }, [copy.codexGoalObjective, goal?.status, objective, updateGoal])

  const toggleGoal = useCallback(() => {
    if (!goal) {
      setEditing(true)
      return
    }
    updateGoal({ status: goalStatusForToggle(goal) })
  }, [goal, updateGoal])

  const clearGoal = useCallback(() => {
    if (!manageable || !agentId || saving || !goal) return
    setSaving(true)
    setError('')
    fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/codex-goal`), {
      method: 'DELETE',
    })
      .then(readGoalResponse)
      .then(() => {
        setGoal(null)
        setObjective('')
        setEditing(false)
        setError('')
      })
      .catch(reason => {
        setError(reason?.message || copy.codexTranscriptUnavailable)
      })
      .finally(() => setSaving(false))
  }, [agentId, copy.codexTranscriptUnavailable, goal, manageable, saving])

  if (!agent || agent.providerSessionProvider !== 'codex') return null
  if (!goal && !editing) return null

  const running = goal?.status === 'active'
  const disabled = !manageable || saving

  return (
    <section className="code-codex-goal-bar" data-testid="code-codex-goal-bar">
      <textarea
        ref={inputRef}
        className="code-codex-goal-input"
        data-testid="code-codex-goal-input"
        rows={1}
        value={objective}
        placeholder={copy.codexGoalEmpty}
        readOnly={!editing}
        disabled={!manageable || saving}
        aria-label={copy.codexGoalObjective}
        onChange={event => setObjective(event.target.value)}
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') saveGoal()
          if (event.key === 'Escape') {
            setObjective(goal?.objective || '')
            setEditing(false)
            setError('')
          }
        }}
      />
      <div className="code-codex-goal-icon-actions">
        <button
          type="button"
          className="code-codex-goal-icon-button"
          data-testid="code-codex-goal-edit"
          disabled={disabled}
          title={editing ? copy.codexGoalSave : copy.codexGoalEdit}
          aria-label={editing ? copy.codexGoalSave : copy.codexGoalEdit}
          onClick={editing ? saveGoal : () => setEditing(true)}
        >
          {editing ? <CheckGlyph /> : <PencilIcon />}
        </button>
        {editing ? (
          <button
            type="button"
            className="code-codex-goal-icon-button"
            data-testid="code-codex-goal-cancel"
            disabled={saving}
            title={copy.cancel}
            aria-label={copy.cancel}
            onClick={() => {
              setObjective(goal?.objective || '')
              setEditing(false)
              setError('')
            }}
          >
            <CloseGlyph />
          </button>
        ) : null}
        <button
          type="button"
          className="code-codex-goal-icon-button"
          data-testid="code-codex-goal-toggle"
          disabled={disabled || (!goal && !objective.trim())}
          title={running ? copy.codexGoalStop : copy.codexGoalStart}
          aria-label={running ? copy.codexGoalStop : copy.codexGoalStart}
          onClick={toggleGoal}
        >
          {running ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          className="code-codex-goal-icon-button danger"
          data-testid="code-codex-goal-delete"
          disabled={disabled || !goal}
          title={copy.codexGoalDelete}
          aria-label={copy.codexGoalDelete}
          onClick={clearGoal}
        >
          <TrashIcon />
        </button>
      </div>
      {error ? <div className="code-codex-goal-error">{error}</div> : null}
    </section>
  )
}
