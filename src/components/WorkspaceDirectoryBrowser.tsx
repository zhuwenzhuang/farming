import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeftGlyph, ArrowRightGlyph, ArrowUpGlyph, FolderGlyph } from '@/components/IconGlyphs'
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

interface WorkspaceDirectoryBrowserProps {
  copy: CodeCopy
  initialPath: string
  onCancel: () => void
  onSelect: (workspace: string) => void
}

export function WorkspaceDirectoryBrowser({
  copy,
  initialPath,
  onCancel,
  onSelect,
}: WorkspaceDirectoryBrowserProps) {
  const [location, setLocation] = useState(normalizeWorkspaceValue(initialPath) || '~')
  const [currentDirectory, setCurrentDirectory] = useState('')
  const [parentDirectory, setParentDirectory] = useState<string | null>(null)
  const [directories, setDirectories] = useState<WorkspaceDirectoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const requestGenerationRef = useRef(0)
  const locationInputRef = useRef<HTMLInputElement>(null)

  const browse = useCallback(async (requestedPath: string) => {
    const target = normalizeWorkspaceValue(requestedPath) || '~'
    const generation = requestGenerationRef.current += 1
    setLoading(true)
    setError(false)
    setDirectories([])
    setTruncated(false)
    try {
      const params = new URLSearchParams({ path: target, limit: '500' })
      const response = await fetch(appPath(`/api/workspaces/browse?${params.toString()}`), { cache: 'no-store' })
      const result = await response.json().catch(() => null) as WorkspaceDirectoryBrowseResult | null
      if (generation !== requestGenerationRef.current) return
      if (!response.ok || result?.status !== 'ready' || !result.workspace) {
        throw new Error('workspace directory browse failed')
      }
      setCurrentDirectory(result.workspace)
      setParentDirectory(result.parent || null)
      setDirectories(Array.isArray(result.directories) ? result.directories : [])
      setTruncated(result.truncated === true)
      setLocation(result.workspace)
    } catch {
      if (generation === requestGenerationRef.current) setError(true)
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void browse(initialPath)
    const frame = requestAnimationFrame(() => {
      locationInputRef.current?.focus()
      locationInputRef.current?.select()
    })
    return () => {
      cancelAnimationFrame(frame)
      requestGenerationRef.current += 1
    }
  }, [browse, initialPath])

  const submitLocation = (event: FormEvent) => {
    event.preventDefault()
    void browse(location)
  }

  const locationMatchesCurrentDirectory = normalizeWorkspaceValue(location) === currentDirectory

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
          onClick={() => parentDirectory && void browse(parentDirectory)}
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
      >
        {loading ? (
          <div className="workspace-directory-browser-status">{copy.loading}</div>
        ) : error ? (
          <div className="workspace-directory-browser-status error" role="alert">
            {copy.workspaceDirectoryBrowserFailed}
          </div>
        ) : directories.length === 0 ? (
          <div className="workspace-directory-browser-status">{copy.workspaceDirectoryBrowserEmpty}</div>
        ) : (
          directories.map(directory => (
            <button
              key={directory.path}
              type="button"
              className="workspace-directory-browser-row"
              data-testid="workspace-directory-browser-row"
              title={directory.path}
              onClick={() => void browse(directory.path)}
            >
              <FolderGlyph />
              <span>{directory.name}</span>
              <ArrowRightGlyph className="workspace-directory-browser-row-arrow" />
            </button>
          ))
        )}
      </div>

      {truncated && (
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
