import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  ArrowUpGlyph,
  ChevronDownGlyph,
  ChevronRightGlyph,
  FolderGlyph,
} from '@/components/IconGlyphs'
import type { CodeCopy } from '@/components/code/copy'
import { appPath } from '@/lib/base-path'
import { formatWorkspaceForDisplay, normalizeWorkspaceValue } from '@/lib/workspace-options'

type WorkspaceDirectoryEntry = {
  name: string
  path: string
}

type WorkspaceDirectoryBrowseResult = {
  status?: string
  workspace?: string
  parent?: string | null
  directories?: WorkspaceDirectoryEntry[]
  truncated?: boolean
}

type WorkspaceDirectoryState = {
  parent: string | null
  directories: WorkspaceDirectoryEntry[]
  loading: boolean
  error: boolean
  truncated: boolean
}

interface WorkspaceDirectoryBrowserProps {
  copy: CodeCopy
  initialPath: string
  onCancel: () => void
  onSelect: (workspace: string) => void
}

async function fetchWorkspaceDirectory(requestedPath: string, signal: AbortSignal) {
  const target = normalizeWorkspaceValue(requestedPath) || '~'
  const params = new URLSearchParams({ path: target, limit: '500' })
  const response = await fetch(appPath(`/api/workspaces/browse?${params.toString()}`), {
    cache: 'no-store',
    signal,
  })
  const result = await response.json().catch(() => null) as WorkspaceDirectoryBrowseResult | null
  if (!response.ok || result?.status !== 'ready' || !result.workspace) {
    throw new Error('workspace directory browse failed')
  }
  return {
    workspace: result.workspace,
    parent: result.parent || null,
    directories: Array.isArray(result.directories) ? result.directories : [],
    truncated: result.truncated === true,
  }
}

function WorkspaceDirectoryTree({
  copy,
  parentPath,
  depth,
  selectedPath,
  directoryStates,
  expandedPaths,
  onToggle,
}: {
  copy: CodeCopy
  parentPath: string
  depth: number
  selectedPath: string
  directoryStates: Record<string, WorkspaceDirectoryState>
  expandedPaths: ReadonlySet<string>
  onToggle: (directory: WorkspaceDirectoryEntry, parentPath: string) => void
}) {
  const state = directoryStates[parentPath]
  if (!state) return null

  return (
    <>
      {state.directories.map(directory => {
        const expanded = expandedPaths.has(directory.path)
        const childState = directoryStates[directory.path]
        const depthStyle = { '--workspace-directory-depth': `${depth * 16}px` } as CSSProperties
        const childDepthStyle = { '--workspace-directory-depth': `${(depth + 1) * 16}px` } as CSSProperties
        return (
          <div key={directory.path} className="workspace-directory-browser-node" role="none">
            <button
              type="button"
              className={`workspace-directory-browser-row ${selectedPath === directory.path ? 'selected' : ''}`}
              data-testid="workspace-directory-browser-row"
              data-directory-path={directory.path}
              role="treeitem"
              aria-expanded={expanded}
              aria-selected={selectedPath === directory.path}
              aria-level={depth + 1}
              title={directory.path}
              style={depthStyle}
              onClick={() => onToggle(directory, parentPath)}
            >
              {expanded ? <ChevronDownGlyph /> : <ChevronRightGlyph />}
              <FolderGlyph />
              <span>{directory.name}</span>
            </button>
            {expanded && (
              <div className="workspace-directory-browser-group" role="group">
                {childState?.loading ? (
                  <div className="workspace-directory-browser-inline-status" style={childDepthStyle}>
                    {copy.loading}
                  </div>
                ) : childState?.error ? (
                  <div
                    className="workspace-directory-browser-inline-status error"
                    role="alert"
                    style={childDepthStyle}
                  >
                    {copy.workspaceDirectoryBrowserFailed}
                  </div>
                ) : childState ? (
                  <>
                    {childState.directories.length === 0 ? (
                      <div className="workspace-directory-browser-inline-status" style={childDepthStyle}>
                        {copy.workspaceDirectoryBrowserEmpty}
                      </div>
                    ) : (
                      <WorkspaceDirectoryTree
                        copy={copy}
                        parentPath={directory.path}
                        depth={depth + 1}
                        selectedPath={selectedPath}
                        directoryStates={directoryStates}
                        expandedPaths={expandedPaths}
                        onToggle={onToggle}
                      />
                    )}
                    {childState.truncated && (
                      <div
                        className="workspace-directory-browser-inline-status truncated"
                        style={childDepthStyle}
                      >
                        {copy.workspaceDirectoryBrowserTruncated}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

export function WorkspaceDirectoryBrowser({
  copy,
  initialPath,
  onCancel,
  onSelect,
}: WorkspaceDirectoryBrowserProps) {
  const [location, setLocation] = useState(normalizeWorkspaceValue(initialPath) || '~')
  const [rootDirectory, setRootDirectory] = useState('')
  const [currentDirectory, setCurrentDirectory] = useState('')
  const [parentDirectory, setParentDirectory] = useState<string | null>(null)
  const [directoryStates, setDirectoryStates] = useState<Record<string, WorkspaceDirectoryState>>({})
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const requestGenerationRef = useRef(0)
  const rootRequestRef = useRef<AbortController | null>(null)
  const expansionRequestsRef = useRef(new Map<string, AbortController>())
  const locationInputRef = useRef<HTMLInputElement>(null)

  const browse = useCallback(async (requestedPath: string) => {
    const target = normalizeWorkspaceValue(requestedPath) || '~'
    const generation = requestGenerationRef.current += 1
    rootRequestRef.current?.abort()
    const controller = new AbortController()
    rootRequestRef.current = controller
    expansionRequestsRef.current.forEach(request => request.abort())
    expansionRequestsRef.current.clear()
    setLoading(true)
    setError(false)
    try {
      const result = await fetchWorkspaceDirectory(target, controller.signal)
      if (generation !== requestGenerationRef.current) return
      setRootDirectory(result.workspace)
      setCurrentDirectory(result.workspace)
      setParentDirectory(result.parent)
      setDirectoryStates({
        [result.workspace]: {
          parent: result.parent,
          directories: result.directories,
          loading: false,
          error: false,
          truncated: result.truncated,
        },
      })
      setExpandedPaths(new Set())
      setLocation(result.workspace)
    } catch {
      if (generation === requestGenerationRef.current && !controller.signal.aborted) setError(true)
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false)
    }
  }, [])

  const toggleDirectory = useCallback((directory: WorkspaceDirectoryEntry, directoryParent: string) => {
    setCurrentDirectory(directory.path)
    setParentDirectory(directoryParent)
    setLocation(directory.path)
    setError(false)

    if (expandedPaths.has(directory.path)) {
      setExpandedPaths(current => {
        const next = new Set(current)
        next.delete(directory.path)
        return next
      })
      return
    }

    setExpandedPaths(current => new Set(current).add(directory.path))
    const existing = directoryStates[directory.path]
    if (existing && !existing.error) return

    expansionRequestsRef.current.get(directory.path)?.abort()
    const controller = new AbortController()
    expansionRequestsRef.current.set(directory.path, controller)
    setDirectoryStates(current => ({
      ...current,
      [directory.path]: {
        parent: directoryParent,
        directories: existing?.directories ?? [],
        loading: true,
        error: false,
        truncated: false,
      },
    }))
    void fetchWorkspaceDirectory(directory.path, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return
        setDirectoryStates(current => ({
          ...current,
          [directory.path]: {
            parent: result.parent,
            directories: result.directories,
            loading: false,
            error: false,
            truncated: result.truncated,
          },
        }))
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setDirectoryStates(current => ({
          ...current,
          [directory.path]: {
            parent: directoryParent,
            directories: [],
            loading: false,
            error: true,
            truncated: false,
          },
        }))
      })
      .finally(() => {
        if (expansionRequestsRef.current.get(directory.path) === controller) {
          expansionRequestsRef.current.delete(directory.path)
        }
      })
  }, [directoryStates, expandedPaths])

  useEffect(() => {
    void browse(initialPath)
    const frame = requestAnimationFrame(() => {
      locationInputRef.current?.focus()
      locationInputRef.current?.select()
    })
    return () => {
      cancelAnimationFrame(frame)
      requestGenerationRef.current += 1
      rootRequestRef.current?.abort()
      expansionRequestsRef.current.forEach(request => request.abort())
      expansionRequestsRef.current.clear()
    }
  }, [browse, initialPath])

  const submitLocation = (event: FormEvent) => {
    event.preventDefault()
    void browse(location)
  }

  const locationMatchesCurrentDirectory = normalizeWorkspaceValue(location) === currentDirectory
  const rootState = directoryStates[rootDirectory]

  const selectParentDirectory = () => {
    if (!parentDirectory) return
    if (currentDirectory === rootDirectory) {
      void browse(parentDirectory)
      return
    }
    const nextDirectory = parentDirectory
    const nextState = directoryStates[nextDirectory]
    setCurrentDirectory(nextDirectory)
    setParentDirectory(nextState?.parent ?? null)
    setLocation(nextDirectory)
    setError(false)
  }

  return (
    <div className="workspace-directory-browser" data-testid="workspace-directory-browser">
      <div className="workspace-directory-browser-heading">
        <div>
          <h4>{copy.chooseWorkspaceDirectory}</h4>
          <p>{copy.workspaceDirectoryBrowserHostHint}</p>
        </div>
        <button
          type="button"
          className="workspace-directory-browser-close"
          aria-label={copy.back}
          onClick={onCancel}
        >
          <ArrowLeftGlyph />
        </button>
      </div>

      <form className="workspace-directory-browser-location" onSubmit={submitLocation}>
        <button
          type="button"
          className="workspace-directory-browser-parent"
          data-testid="workspace-directory-browser-parent"
          aria-label={copy.workspaceDirectoryBrowserParent}
          title={copy.workspaceDirectoryBrowserParent}
          disabled={!parentDirectory || loading}
          onClick={selectParentDirectory}
        >
          <ArrowUpGlyph />
        </button>
        <input
          ref={locationInputRef}
          data-testid="workspace-directory-browser-path"
          value={location}
          aria-label={copy.workspace}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={event => {
            setLocation(event.target.value)
            setError(false)
          }}
        />
        <button
          type="submit"
          className="workspace-directory-browser-go"
          aria-label={copy.workspaceDirectoryBrowserGo}
          title={copy.workspaceDirectoryBrowserGo}
          disabled={loading}
        >
          <ArrowRightGlyph />
        </button>
      </form>

      <div
        className="workspace-directory-browser-list"
        data-testid="workspace-directory-browser-list"
        aria-busy={loading}
        role="tree"
        aria-label={copy.chooseWorkspaceDirectory}
      >
        {loading ? (
          <div className="workspace-directory-browser-status">{copy.loading}</div>
        ) : error ? (
          <div className="workspace-directory-browser-status error" role="alert">
            {copy.workspaceDirectoryBrowserFailed}
          </div>
        ) : !rootState || rootState.directories.length === 0 ? (
          <div className="workspace-directory-browser-status">{copy.workspaceDirectoryBrowserEmpty}</div>
        ) : (
          <WorkspaceDirectoryTree
            copy={copy}
            parentPath={rootDirectory}
            depth={0}
            selectedPath={currentDirectory}
            directoryStates={directoryStates}
            expandedPaths={expandedPaths}
            onToggle={toggleDirectory}
          />
        )}
      </div>

      {rootState?.truncated && (
        <p className="workspace-directory-browser-truncated" role="status">
          {copy.workspaceDirectoryBrowserTruncated}
        </p>
      )}

      <div className="workspace-directory-browser-actions">
        <span title={currentDirectory}>{formatWorkspaceForDisplay(currentDirectory)}</span>
        <button
          type="button"
          className="secondary"
          data-testid="workspace-directory-browser-cancel"
          onClick={onCancel}
        >
          {copy.back}
        </button>
        <button
          type="button"
          data-testid="workspace-directory-browser-select"
          disabled={!currentDirectory || !locationMatchesCurrentDirectory || loading || error}
          onClick={() => onSelect(currentDirectory)}
        >
          {copy.workspaceDirectoryBrowserSelect}
        </button>
      </div>
    </div>
  )
}
