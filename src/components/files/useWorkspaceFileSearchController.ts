import { useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import {
  openRequestForWorkspaceFileJumpQuery,
  openRequestForWorkspaceFileSearchMatch,
  workspaceFileSearchActiveOptionId,
  type WorkspaceFileOpenTarget,
} from '@/lib/workspace-file-search'
import type { WorkspaceFileSearchMatch } from '@/lib/workspace-files'
import type { WorkspaceFileSearchState } from './useWorkspaceFileSearch'

interface UseWorkspaceFileSearchControllerOptions {
  fileMenuOpen: boolean
  fileOperationActive: boolean
  fileSearch: WorkspaceFileSearchState
  fileSearchResultsRef: RefObject<HTMLDivElement | null>
  filesCollapsed: boolean
  focusFileTreeFromSearch: () => void
  listboxId: string
  onOpenFilePath: (filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void>
}

export function useWorkspaceFileSearchController({
  fileMenuOpen,
  fileOperationActive,
  fileSearch,
  fileSearchResultsRef,
  filesCollapsed,
  focusFileTreeFromSearch,
  listboxId,
  onOpenFilePath,
}: UseWorkspaceFileSearchControllerOptions) {
  const activeOptionId = workspaceFileSearchActiveOptionId({
    active: fileSearch.active,
    activeMatchIndex: fileSearch.activeMatchIndex,
    jumpTarget: fileSearch.jumpTarget,
    listboxId,
  })

  const openFileSearchMatch = useCallback((match: WorkspaceFileSearchMatch) => {
    const request = openRequestForWorkspaceFileSearchMatch(match)
    void onOpenFilePath(request.path, request.target)
    fileSearch.clear()
  }, [fileSearch, onOpenFilePath])

  const openFileJumpQuery = useCallback((query: string) => {
    const request = openRequestForWorkspaceFileJumpQuery(query)
    if (!request) return false
    void onOpenFilePath(request.path, request.target)
    fileSearch.clear()
    return true
  }, [fileSearch, onOpenFilePath])

  const handleFileSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      fileSearch.clear()
      focusFileTreeFromSearch()
      return
    }

    if (event.key === 'ArrowDown') {
      if (fileSearch.matches.length === 0) return
      event.preventDefault()
      fileSearch.selectNext()
      return
    }

    if (event.key === 'ArrowUp') {
      if (fileSearch.matches.length === 0) return
      event.preventDefault()
      fileSearch.selectPrevious()
      return
    }

    if (event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    if (openFileJumpQuery(event.currentTarget.value)) return
    const selectedMatch = fileSearch.selectedMatch ?? fileSearch.matches[0]
    if (selectedMatch) openFileSearchMatch(selectedMatch)
  }, [fileSearch, focusFileTreeFromSearch, openFileJumpQuery, openFileSearchMatch])

  useEffect(() => {
    if (!fileSearch.active || fileSearch.matches.length === 0) return
    const activeResult = fileSearchResultsRef.current?.querySelector<HTMLElement>('.code-file-search-result.active')
    activeResult?.scrollIntoView({ block: 'nearest' })
  }, [fileSearch.active, fileSearch.activeMatchIndex, fileSearch.matches.length, fileSearchResultsRef])

  useEffect(() => {
    if (filesCollapsed || !fileSearch.active || fileMenuOpen || fileOperationActive) return undefined

    const closeFileSearchOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      fileSearch.clear()
      focusFileTreeFromSearch()
    }

    document.addEventListener('keydown', closeFileSearchOnEscape, true)
    return () => {
      document.removeEventListener('keydown', closeFileSearchOnEscape, true)
    }
  }, [fileMenuOpen, fileOperationActive, fileSearch, filesCollapsed, focusFileTreeFromSearch])

  return {
    activeOptionId,
    handleFileSearchKeyDown,
    openFileJumpQuery,
    openFileSearchMatch,
  }
}
