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
  onRevealDirectoryPath: (directoryPath: string) => Promise<unknown>
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
  onRevealDirectoryPath,
}: UseWorkspaceFileSearchControllerOptions) {
  const activeOptionId = workspaceFileSearchActiveOptionId({
    active: fileSearch.active,
    activeMatchIndex: fileSearch.activeMatchIndex,
    jumpTarget: fileSearch.jumpTarget,
    listboxId,
  })

  const openFileSearchMatch = useCallback((match: WorkspaceFileSearchMatch) => {
    if (match.kind === 'path' && match.entryType === 'directory') {
      void onRevealDirectoryPath(match.path)
      fileSearch.clear()
      return
    }
    const request = openRequestForWorkspaceFileSearchMatch(match)
    void onOpenFilePath(request.path, request.target)
    fileSearch.clear()
  }, [fileSearch, onOpenFilePath, onRevealDirectoryPath])

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
    const results = fileSearchResultsRef.current
    const activeResult = results?.querySelector<HTMLElement>('.code-file-search-result.active')
    if (!results || !activeResult) return
    const resultTop = activeResult.offsetTop
    const resultBottom = resultTop + activeResult.offsetHeight
    if (resultTop < results.scrollTop) {
      results.scrollTop = resultTop
    } else if (resultBottom > results.scrollTop + results.clientHeight) {
      results.scrollTop = resultBottom - results.clientHeight
    }
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
