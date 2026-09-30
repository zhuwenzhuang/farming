import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { appPath } from '@/lib/base-path'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import { useModalFocusScope } from '@/hooks/useModalFocusScope'
import type { CodeCopy } from './copy'

type ProjectTarget = { workspace: string; name: string }
type Preview = { branch: string; workspace: string; sourceBranch: string; sourceHead: string }
type Creation = ProjectTarget & {
  requestId: string; date: string; branch: string; startedAt: number;
  state: 'pending' | 'confirming' | 'unknown' | 'failed' | 'succeeded';
  phase?: 'checkout' | 'register'; error?: string; resultWorkspace?: string;
}
type Operation = {
  id: string; state: Creation['state'] | 'blocked'; phase?: Creation['phase']; error: string;
  request: { branch: string }; result?: { workspace: string; branch: string };
}
const STORAGE_KEY = appPath('/worktree-creation-intents-v1')
const OBSERVATION_DEADLINE_MS = 120_000

function readCreations(): Record<string, Creation> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    const result: Record<string, Creation> = {}
    for (const [workspace, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      if (record.workspace === workspace && typeof record.requestId === 'string'
        && /^[A-Za-z0-9._:-]{1,160}$/.test(record.requestId)
        && typeof record.startedAt === 'number' && Number.isFinite(record.startedAt)
        && typeof record.name === 'string' && typeof record.branch === 'string'
        && typeof record.date === 'string' && typeof record.state === 'string'
        && ['pending', 'confirming', 'unknown', 'failed', 'succeeded'].includes(record.state)) {
        result[workspace] = { ...record as Creation,
          ...(['pending', 'confirming', 'unknown'].includes(record.state) ? { state: 'confirming' as const } : {}),
        }
      }
    }
    return result
  } catch { return {} }
}

function localDate() {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

export function useWorktreeCreation(onCreated: (workspace: string, open: boolean) => void, readOnly = false) {
  const [creations, setCreations] = useState(readCreations)
  const creationsRef = useRef(creations)
  const [target, setTarget] = useState<ProjectTarget | null>(null)
  const targetRef = useRef(target)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const onCreatedRef = useRef(onCreated)
  const mountedRef = useRef(true)
  const observationDeadlinesRef = useRef(new Map(Object.values(creations).map(creation => [creation.requestId, Date.now() + OBSERVATION_DEADLINE_MS])))
  onCreatedRef.current = onCreated
  targetRef.current = target
  const observationKey = Object.values(creations).filter(creation => ['pending', 'confirming'].includes(creation.state))
    .map(creation => `${creation.requestId}:${creation.state}`).join(',')
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  const forget = useCallback((workspace: string) => {
    const records = { ...creationsRef.current }
    delete records[workspace]
    creationsRef.current = records
    setCreations(records)
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records)) } catch { /* Settled operation only. */ }
  }, [])
  const update = useCallback((workspace: string, requestId: string, patch: Partial<Creation>) => {
    const previous = creationsRef.current[workspace]
    if (!previous || previous.requestId !== requestId || (['succeeded', 'failed'].includes(previous.state) && patch.state && patch.state !== previous.state)) return
    const next = { ...previous, ...patch }
    const records = { ...creationsRef.current, [workspace]: next }
    creationsRef.current = records
    setCreations(records)
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records)) } catch { /* Existing in-memory intent remains available. */ }
    if (mountedRef.current && next.state === 'succeeded' && previous.state !== 'succeeded' && next.resultWorkspace) {
      const open = targetRef.current?.workspace === workspace
      if (open) setTarget(null)
      onCreatedRef.current(next.resultWorkspace, open)
      if (open) forget(workspace)
    }
  }, [forget])
  const check = useCallback(async (creation: Creation, signal: AbortSignal) => {
    const query = new URLSearchParams({ rootId: projectFilesWorkspaceId(creation.workspace), requestId: creation.requestId })
    const response = await fetch(appPath(`/api/projects/worktree-operation?${query}`), { signal })
    if (!response.ok) throw new Error('Operation outcome has not been observed')
    const operation = await response.json() as Operation
    if (operation.id !== creation.requestId) throw new Error('Operation identity did not match')
    update(creation.workspace, creation.requestId, {
      state: operation.state === 'blocked' ? 'failed' : operation.state,
      phase: operation.phase, branch: operation.request.branch || creation.branch,
      error: operation.error, resultWorkspace: operation.result?.workspace,
    })
  }, [update])
  useEffect(() => {
    if (!observationKey || readOnly) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const observe = async () => {
      await Promise.all(Object.values(creationsRef.current).filter(creation => ['pending', 'confirming'].includes(creation.state)).map(async creation => {
        const deadline = observationDeadlinesRef.current.get(creation.requestId) || creation.startedAt + OBSERVATION_DEADLINE_MS
        if (Date.now() > deadline) {
          update(creation.workspace, creation.requestId, { state: 'unknown' })
          return
        }
        try { await check(creation, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])) }
        catch { /* A missing or disconnected read does not prove the mutation failed. */ }
      }))
      if (!controller.signal.aborted) timer = setTimeout(observe, 1000)
    }
    timer = setTimeout(observe, 0)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [check, update, observationKey, readOnly])
  const start = useCallback(async (project: ProjectTarget, preview: Preview, date: string, custom: boolean, storageError: string) => {
    const current = creationsRef.current[project.workspace]
    if (current && ['pending', 'confirming', 'unknown'].includes(current.state)) return
    const creation: Creation = {
      ...project, requestId: crypto.randomUUID(), date, branch: preview.branch, state: 'pending', startedAt: Date.now(),
    }
    const records = { ...creationsRef.current, [project.workspace]: creation }
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records)) }
    catch { throw new Error(storageError) }
    creationsRef.current = records
    setCreations(records)
    try {
      const response = await fetch(appPath('/api/projects/create-worktree'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(OBSERVATION_DEADLINE_MS),
        body: JSON.stringify({ rootId: projectFilesWorkspaceId(project.workspace), requestId: creation.requestId,
          date, expectedHead: preview.sourceHead, ...(custom ? { branch: preview.branch } : {}),
        }),
      })
      const result = await response.json() as { workspace?: string; branch?: string; error?: string; uncertain?: boolean; retryable?: boolean }
      if (response.ok && result.workspace) {
        update(project.workspace, creation.requestId, { state: 'succeeded', resultWorkspace: result.workspace, branch: result.branch || preview.branch })
      } else {
        update(project.workspace, creation.requestId, { state: result.uncertain ? 'unknown'
          : response.ok || result.retryable || response.status >= 500 ? 'confirming' : 'failed', error: result.error })
      }
    } catch { update(project.workspace, creation.requestId, { state: 'confirming' }) }
  }, [update])
  const open = useCallback((project: ProjectTarget) => {
    if (creationsRef.current[project.workspace]?.state === 'succeeded') forget(project.workspace)
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    targetRef.current = project
    setTarget(project)
  }, [forget])
  const reopen = useCallback((workspace: string) => {
    const creation = creationsRef.current[workspace]
    if (creation) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      targetRef.current = creation
      setTarget(creation)
    }
  }, [])
  const checkNow = useCallback(async (workspace: string) => {
    const creation = creationsRef.current[workspace]
    if (!creation) return
    observationDeadlinesRef.current.set(creation.requestId, Date.now() + OBSERVATION_DEADLINE_MS)
    try { await check(creation, AbortSignal.timeout(10_000)) }
    catch { update(workspace, creation.requestId, { state: 'unknown' }) }
  }, [check, update])
  const close = useCallback(() => {
    const workspace = targetRef.current?.workspace
    if (workspace && ['succeeded', 'failed'].includes(creationsRef.current[workspace]?.state || '')) forget(workspace)
    targetRef.current = null
    setTarget(null)
  }, [forget])
  return { creations, target, returnFocusRef, open, reopen, start, checkNow, close }
}

export function WorktreeCreationDialog({ controller, copy, onOpenProject }: {
  controller: ReturnType<typeof useWorktreeCreation>; copy: CodeCopy; onOpenProject: (workspace: string) => void;
}) {
  const project = controller.target
  if (!project) return null
  return <WorktreeCreationForm key={project.workspace} project={project} controller={controller} copy={copy} onOpenProject={onOpenProject} />
}

function WorktreeCreationForm({ project, controller, copy, onOpenProject }: {
  project: ProjectTarget; controller: ReturnType<typeof useWorktreeCreation>; copy: CodeCopy; onOpenProject: (workspace: string) => void;
}) {
  const text = copy.worktreeCreation
  const creation = controller.creations[project.workspace]
  const busy = creation?.state === 'pending' || creation?.state === 'confirming' || creation?.state === 'unknown'
  const [date] = useState(localDate)
  const [name, setName] = useState(creation?.state === 'failed' ? creation.branch : `farming/worktree-${date}`)
  const [custom, setCustom] = useState(creation?.state === 'failed')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(true)
  const [now, setNow] = useState(Date.now)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const customName = custom ? name : undefined
  const inputRef = useRef<HTMLInputElement>(null)
  const dismissRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useModalFocusScope<HTMLFormElement>({ open: true,
    initialFocusRef: busy || creation?.state === 'succeeded' ? dismissRef : inputRef, returnFocusRef: controller.returnFocusRef,
    onEscape: controller.close, escapeEnabled: !busy, dismissOnPointerOutside: !busy,
  })
  useEffect(() => {
    if (busy || creation?.state === 'succeeded') return
    const abort = new AbortController()
    setChecking(true)
    setPreview(null)
    const timer = setTimeout(async () => {
      try {
        const query = new URLSearchParams({ rootId: projectFilesWorkspaceId(project.workspace), date,
          ...(customName !== undefined ? { branch: customName } : {}),
        })
        const response = await fetch(appPath(`/api/projects/worktree-preview?${query}`), {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        })
        const result = await response.json() as Preview & { error?: string }
        if (!response.ok) throw new Error(result.error || text.previewFailed)
        if (abort.signal.aborted) return
        setPreview(result)
        setError('')
        if (!custom) {
          setName(result.branch)
          if (document.activeElement === inputRef.current) inputRef.current?.select()
        }
      } catch (caught) {
        if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : text.previewFailed)
      } finally { if (!abort.signal.aborted) setChecking(false) }
    }, 250)
    return () => { abort.abort(); clearTimeout(timer) }
  // Automatic naming updates the field from the preview without issuing another preview.
  }, [project.workspace, date, custom, customName, busy, creation?.state, text.previewFailed])
  useEffect(() => {
    if (!busy || creation?.state === 'unknown') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy, creation?.state])
  const stage = creation?.state === 'unknown' ? text.unconfirmed : creation?.state === 'confirming' ? text.verifying
    : creation?.phase === 'register' ? text.register : creation?.phase === 'checkout' ? text.checkout : text.checking
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || !preview || checking || error) return
    try { await controller.start(project, preview, date, custom, text.storageFailed) }
    catch (caught) { setError(caught instanceof Error ? caught.message : text.storageFailed) }
  }
  return createPortal(<div className="code-brand-backdrop" role="presentation">
    <form ref={dialogRef} className="code-brand-dialog code-instance-name-dialog code-worktree-create-dialog"
      role="dialog" aria-modal="true" aria-labelledby="worktree-create-title" data-testid="code-worktree-create-dialog" onSubmit={submit}>
      <h2 id="worktree-create-title">{text.title}</h2>
      <p className="code-worktree-create-detail">{project.name}</p>
      {busy || creation?.state === 'succeeded' ? <>
        <strong className="code-worktree-create-branch">{creation.branch}</strong>
        <p role="status" aria-live="polite" data-testid="code-worktree-create-status">
          {((busy && creation.state !== 'unknown') || checkingStatus) && <span className="code-worktree-create-spinner" aria-hidden="true" />}
          {creation.state === 'succeeded' ? text.created : stage}
        </p>
        {busy && <p className="code-worktree-create-detail">{Math.max(0, Math.floor((now - creation.startedAt) / 1000))} {text.elapsed}</p>}
        {creation.error && <p className="code-instance-name-error" role="alert">{creation.error}</p>}
      </> : <>
        <label htmlFor="worktree-create-name">{text.branch}</label>
        <input id="worktree-create-name" ref={inputRef} value={name} maxLength={160} autoComplete="off" spellCheck={false}
          aria-describedby="worktree-create-error" onChange={event => { setCustom(true); setName(event.target.value); setPreview(null); setChecking(true) }} />
        {preview && <dl className="code-worktree-create-preview">
          <dt>{text.source}</dt><dd>{preview.sourceBranch || 'HEAD'} · {preview.sourceHead.slice(0, 8)}</dd>
          <dt>{text.directory}</dt><dd>{preview.workspace}</dd>
        </dl>}
        {checking && <p role="status">{text.checking}…</p>}
        <p id="worktree-create-error" className="code-instance-name-error" role={error || creation?.error ? 'alert' : undefined}>{error || creation?.error}</p>
        {custom && <button type="button" className="code-worktree-create-default" onClick={() => { setCustom(false); setError('') }}>{text.useDefault}</button>}
      </>}
      <div className="code-instance-name-actions">
        <button ref={dismissRef} type="button" onClick={controller.close}>{busy ? text.minimize : copy.cancel}</button>
        {creation?.state === 'unknown' ? <button type="button" disabled={checkingStatus} onClick={async () => {
          if (checkingStatus) return
          setCheckingStatus(true)
          try { await controller.checkNow(project.workspace) } finally { setCheckingStatus(false) }
        }}>{text.checkStatus}</button>
          : creation?.state === 'succeeded' && creation.resultWorkspace ? <button type="button" className="primary" onClick={() => { if (creation.resultWorkspace) onOpenProject(creation.resultWorkspace); controller.close() }}>{text.open}</button>
            : <button type="submit" className="primary" disabled={busy || checking || !preview || Boolean(error)}>{busy ? text.creating : text.create}</button>}
      </div>
    </form>
  </div>, document.body)
}
