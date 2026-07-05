import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  createWorkspaceEditorCloseIntent,
  workspaceEditorFilesForTabAction,
  workspaceEditorNextFocusAfterClosingFiles,
  workspaceEditorNextFocusAfterClosingTab,
  workspaceEditorPendingCloseNextFocus,
  type WorkspaceEditorPendingCloseState as PendingCloseState,
  type WorkspaceEditorTabContextAction,
} from '@/lib/workspace-editor-tabs'
import {
  workspaceEditorBasename as basename,
  workspaceEditorModelKey as openFileKey,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile, WorkspaceFileOpenTarget, WorkspaceOpenFileTarget } from '@/lib/workspace-open-files'

export interface FileEditorTabContextMenuState {
  x: number
  y: number
  index: number
}

interface UseFileEditorTabsControllerOptions {
  openFile: OpenWorkspaceFile
  openFiles: OpenWorkspaceFile[]
  filesLabel: string
  onSelectOpenFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onCloseOpenFile: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onCloseOpenFiles: (targets: WorkspaceOpenFileTarget[]) => void
  onDismissEditorContextMenu: () => void
  onSaveOpenFile: (file: OpenWorkspaceFile, overwrite?: boolean) => Promise<boolean>
}

export function useFileEditorTabsController({
  openFile,
  openFiles,
  filesLabel,
  onSelectOpenFile,
  onCloseOpenFile,
  onCloseOpenFiles,
  onDismissEditorContextMenu,
  onSaveOpenFile,
}: UseFileEditorTabsControllerOptions) {
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const pendingTabFocusRef = useRef<string | null>(null)
  const [tabContextMenu, setTabContextMenu] = useState<FileEditorTabContextMenuState | null>(null)
  const [pendingClose, setPendingClose] = useState<PendingCloseState | null>(null)
  const [pendingCloseSaving, setPendingCloseSaving] = useState(false)

  const closeTabContextMenu = useCallback(() => {
    setTabContextMenu(null)
  }, [])

  const setTabRef = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element) {
      tabRefs.current.set(key, element)
    } else {
      tabRefs.current.delete(key)
    }
  }, [])

  const focusEditorTab = useCallback((index: number) => {
    const nextFile = openFiles[index]
    if (!nextFile) return
    pendingTabFocusRef.current = openFileKey(nextFile)
    onSelectOpenFile(nextFile.agentId, nextFile.file.path)
  }, [onSelectOpenFile, openFiles])

  const completeCloseFiles = useCallback((files: OpenWorkspaceFile[], nextFocusFile: OpenWorkspaceFile | null) => {
    if (files.length === 0) return
    const targets = files.map(file => ({ agentId: file.agentId, filePath: file.file.path, workspaceRoot: file.workspaceRoot }))
    pendingTabFocusRef.current = nextFocusFile ? openFileKey(nextFocusFile) : null
    if (targets.length === 1) {
      const target = targets[0]
      if (target) onCloseOpenFile(target.agentId, target.filePath, target.workspaceRoot)
      return
    }
    onCloseOpenFiles(targets)
  }, [onCloseOpenFile, onCloseOpenFiles])

  const requestCloseFiles = useCallback((files: OpenWorkspaceFile[], nextFocusFile: OpenWorkspaceFile | null) => {
    const closeIntent = createWorkspaceEditorCloseIntent(files, nextFocusFile)
    const closeFiles = closeIntent.closeFiles
    if (closeFiles.length === 0) return
    if (closeIntent.pendingClose) {
      setPendingClose(closeIntent.pendingClose)
      setPendingCloseSaving(false)
      return
    }
    completeCloseFiles(closeFiles, closeIntent.nextFocusFile)
  }, [completeCloseFiles])

  const closeEditorTab = useCallback((index: number) => {
    const file = openFiles[index]
    if (!file) return
    requestCloseFiles([file], workspaceEditorNextFocusAfterClosingTab(openFiles, openFile, index))
  }, [openFile, openFiles, requestCloseFiles])

  const closeEditorTabs = useCallback((files: OpenWorkspaceFile[]) => {
    requestCloseFiles(files, workspaceEditorNextFocusAfterClosingFiles(openFiles, openFile, files))
  }, [openFile, openFiles, requestCloseFiles])

  const openEditorTabContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>, index: number) => {
    event.preventDefault()
    event.stopPropagation()
    const file = openFiles[index]
    if (file) onSelectOpenFile(file.agentId, file.file.path)
    onDismissEditorContextMenu()
    setTabContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 190)),
      index,
    })
  }, [onDismissEditorContextMenu, onSelectOpenFile, openFiles])

  const runTabContextAction = useCallback((action: WorkspaceEditorTabContextAction) => {
    if (!tabContextMenu) return
    const index = tabContextMenu.index
    setTabContextMenu(null)
    if (action === 'close') {
      closeEditorTab(index)
      return
    }
    closeEditorTabs(workspaceEditorFilesForTabAction(action, openFiles, index))
  }, [closeEditorTab, closeEditorTabs, openFiles, tabContextMenu])

  const handleEditorTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusEditorTab((index - 1 + openFiles.length) % openFiles.length)
      return
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusEditorTab((index + 1) % openFiles.length)
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      focusEditorTab(0)
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      focusEditorTab(openFiles.length - 1)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      focusEditorTab(index)
      return
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      closeEditorTab(index)
    }
  }, [closeEditorTab, focusEditorTab, openFiles.length])

  const handleEditorTabAuxClick = useCallback((event: ReactMouseEvent<HTMLDivElement>, index: number) => {
    if (event.button !== 1) return
    event.preventDefault()
    event.stopPropagation()
    closeEditorTab(index)
  }, [closeEditorTab])

  const confirmSaveAndClose = useCallback(async () => {
    if (!pendingClose || pendingCloseSaving) return
    setPendingCloseSaving(true)
    for (const file of pendingClose.files) {
      const ok = await onSaveOpenFile(file, false)
      if (!ok) {
        setPendingCloseSaving(false)
        return
      }
    }
    const nextFocusFile = workspaceEditorPendingCloseNextFocus(pendingClose)
    const closeFiles = pendingClose.closeFiles
    setPendingClose(null)
    setPendingCloseSaving(false)
    completeCloseFiles(closeFiles, nextFocusFile)
  }, [completeCloseFiles, onSaveOpenFile, pendingClose, pendingCloseSaving])

  const discardAndClose = useCallback(() => {
    if (!pendingClose) return
    const nextFocusFile = workspaceEditorPendingCloseNextFocus(pendingClose)
    const closeFiles = pendingClose.closeFiles
    setPendingClose(null)
    setPendingCloseSaving(false)
    completeCloseFiles(closeFiles, nextFocusFile)
  }, [completeCloseFiles, pendingClose])

  const cancelPendingClose = useCallback(() => {
    setPendingClose(null)
    setPendingCloseSaving(false)
  }, [])

  const pendingCloseLabel = useMemo(() => {
    if (!pendingClose) return ''
    return pendingClose.files.length === 1
      ? basename(pendingClose.files[0]?.file.path ?? '')
      : `${pendingClose.files.length} ${filesLabel}`
  }, [filesLabel, pendingClose])

  useEffect(() => {
    const fileHandle = openFileKey(openFile)
    const tab = tabRefs.current.get(fileHandle)
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })

    if (pendingTabFocusRef.current === fileHandle) {
      tab?.focus()
      pendingTabFocusRef.current = null
    }
  }, [openFile, openFiles.length])

  return {
    tabContextMenu,
    pendingClose,
    pendingCloseSaving,
    pendingCloseLabel,
    closeTabContextMenu,
    setTabRef,
    focusEditorTab,
    closeEditorTab,
    openEditorTabContextMenu,
    runTabContextAction,
    handleEditorTabKeyDown,
    handleEditorTabAuxClick,
    confirmSaveAndClose,
    discardAndClose,
    cancelPendingClose,
  }
}
