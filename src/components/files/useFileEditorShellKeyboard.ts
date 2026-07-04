import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { workspaceEditorModelKey as openFileKey } from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'

interface UseFileEditorShellKeyboardOptions {
  openFile: OpenWorkspaceFile
  openFiles: OpenWorkspaceFile[]
  onCloseEditorTab: (index: number) => void
  onFocusEditorTab: (index: number) => void
  onFocusFilesSearch: (agentId: string) => void
  onSaveFile: (overwrite?: boolean) => void
}

export function useFileEditorShellKeyboard({
  openFile,
  openFiles,
  onCloseEditorTab,
  onFocusEditorTab,
  onFocusFilesSearch,
  onSaveFile,
}: UseFileEditorShellKeyboardOptions) {
  const queueFilesSearchFocus = useCallback((agentId: string) => {
    onFocusFilesSearch(agentId)
    window.requestAnimationFrame(() => onFocusFilesSearch(agentId))
    window.setTimeout(() => onFocusFilesSearch(agentId), 120)
  }, [onFocusFilesSearch])

  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || !(event.ctrlKey || event.metaKey)) return

    if (event.key.toLowerCase() === 'p') {
      event.preventDefault()
      event.stopPropagation()
      queueFilesSearchFocus(openFile.agentId)
      return
    }

    if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      event.stopPropagation()
      onSaveFile(false)
      return
    }

    const activeIndex = openFiles.findIndex(file => openFileKey(file) === openFileKey(openFile))
    if (activeIndex === -1) return

    if (event.key === 'PageUp') {
      event.preventDefault()
      event.stopPropagation()
      onFocusEditorTab((activeIndex - 1 + openFiles.length) % openFiles.length)
      return
    }

    if (event.key === 'PageDown') {
      event.preventDefault()
      event.stopPropagation()
      onFocusEditorTab((activeIndex + 1) % openFiles.length)
      return
    }

    if (event.key.toLowerCase() === 'w') {
      event.preventDefault()
      event.stopPropagation()
      onCloseEditorTab(activeIndex)
    }
  }, [onCloseEditorTab, onFocusEditorTab, onSaveFile, openFile, openFiles, queueFilesSearchFocus])
}
