import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  estimateWorkspaceBlameLabelWidth as estimateBlameLabelWidth,
  isPermanentWorkspaceBlameFailureStatus,
  workspaceEditorModelKey as openFileKey,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import {
  fetchWorkspaceBlame,
  fetchWorkspaceBlameCapability,
  WorkspaceFileApiError,
  type WorkspaceFileBlame,
} from '@/lib/workspace-files'

export type FileEditorBlameLine = WorkspaceFileBlame['lines'][number]
type BlameCapability = 'unknown' | 'available' | 'unavailable'

interface BlameDetailState {
  line: FileEditorBlameLine
}

interface UseFileEditorBlameControllerOptions {
  openFile: OpenWorkspaceFile
  disabled: boolean
  onRevealLine: (lineNumber: number, options?: { focusEditor?: boolean }) => void
}

function isPermanentBlameFailure(error: unknown) {
  return error instanceof WorkspaceFileApiError && isPermanentWorkspaceBlameFailureStatus(error.status)
}

export function useFileEditorBlameController({
  openFile,
  disabled,
  onRevealLine,
}: UseFileEditorBlameControllerOptions) {
  const blameRequestRef = useRef(0)
  const blameCapabilityRequestRef = useRef(0)
  const currentOpenFileKey = openFileKey(openFile)
  const openFileKeyRef = useRef(currentOpenFileKey)
  const disabledRef = useRef(disabled)
  const [blameOpen, setBlameOpen] = useState(false)
  const [blameLoading, setBlameLoading] = useState(false)
  const [blame, setBlame] = useState<WorkspaceFileBlame | null>(null)
  const [blameError, setBlameError] = useState<string | null>(null)
  const [blameCapability, setBlameCapability] = useState<BlameCapability>('unknown')
  const [blameDetail, setBlameDetail] = useState<BlameDetailState | null>(null)
  openFileKeyRef.current = currentOpenFileKey
  disabledRef.current = disabled

  const blameLabelWidths = useMemo(() => {
    const lines = blame?.lines ?? []
    return {
      compact: estimateBlameLabelWidth(lines, true),
      regular: estimateBlameLabelWidth(lines, false),
    }
  }, [blame])

  const clearBlameDetail = useCallback(() => {
    setBlameDetail(null)
  }, [])

  const loadBlame = useCallback(async () => {
    if (disabled) {
      setBlameCapability('unavailable')
      return null
    }
    const requestedFileKey = currentOpenFileKey
    const requestId = blameRequestRef.current + 1
    blameRequestRef.current = requestId
    setBlameLoading(true)
    setBlameError(null)
    try {
      const nextBlame = await fetchWorkspaceBlame(openFile.agentId, openFile.file.path)
      if (
        blameRequestRef.current !== requestId
        || openFileKeyRef.current !== requestedFileKey
        || disabledRef.current
      ) return null
      setBlame(nextBlame)
      setBlameCapability(nextBlame.isGitRepo && nextBlame.lines.length > 0 ? 'available' : 'unavailable')
      return nextBlame
    } catch (error) {
      if (
        blameRequestRef.current !== requestId
        || openFileKeyRef.current !== requestedFileKey
        || disabledRef.current
      ) return null
      setBlame(null)
      setBlameError(error instanceof Error ? error.message : 'Failed to load blame')
      setBlameCapability(isPermanentBlameFailure(error) ? 'unavailable' : 'unknown')
      return null
    } finally {
      if (
        blameRequestRef.current === requestId
        && openFileKeyRef.current === requestedFileKey
        && !disabledRef.current
      ) setBlameLoading(false)
    }
  }, [currentOpenFileKey, disabled, openFile.agentId, openFile.file.path])

  const checkBlameCapability = useCallback(async (): Promise<BlameCapability | null> => {
    if (disabled) {
      setBlameCapability('unavailable')
      return 'unavailable'
    }
    const checkedFileKey = openFileKey(openFile)
    const requestId = blameCapabilityRequestRef.current + 1
    blameCapabilityRequestRef.current = requestId
    try {
      const capability = await fetchWorkspaceBlameCapability(openFile.agentId, openFile.file.path)
      if (blameCapabilityRequestRef.current !== requestId || openFileKeyRef.current !== checkedFileKey) return null
      const nextCapability = capability.available ? 'available' : 'unavailable'
      setBlameCapability(nextCapability)
      return nextCapability
    } catch {
      if (blameCapabilityRequestRef.current !== requestId || openFileKeyRef.current !== checkedFileKey) return null
      setBlameCapability('unavailable')
      return 'unavailable'
    }
  }, [disabled, openFile])

  const toggleBlame = useCallback(async () => {
    if (disabled) return
    if (blameOpen) {
      setBlameOpen(false)
      setBlameDetail(null)
      return
    }

    const requestedFileKey = openFileKey(openFile)
    const capability = blameCapability === 'unknown'
      ? await checkBlameCapability()
      : blameCapability
    if (
      capability !== null
      && capability !== 'unavailable'
      && openFileKeyRef.current === requestedFileKey
      && !disabledRef.current
    ) {
      setBlameOpen(true)
    }
  }, [blameCapability, blameOpen, checkBlameCapability, disabled, openFile])

  const showBlameDetail = useCallback((line: FileEditorBlameLine) => {
    onRevealLine(line.lineNumber, { focusEditor: false })
    setBlameDetail({ line })
  }, [onRevealLine])

  useEffect(() => {
    setBlame(null)
    setBlameLoading(false)
    setBlameError(null)
    setBlameCapability(disabled ? 'unavailable' : 'unknown')
  }, [disabled, openFile.agentId, openFile.file])

  useEffect(() => {
    if (!disabled) return
    setBlameOpen(false)
    setBlame(null)
    setBlameError(null)
    setBlameCapability('unavailable')
  }, [disabled, openFile.agentId, openFile.file.path])

  useEffect(() => {
    if (!blameOpen) return
    let cancelled = false
    void loadBlame().then(nextBlame => {
      if (cancelled) return
      if (!nextBlame?.isGitRepo || nextBlame.lines.length === 0) {
        setBlameOpen(false)
        setBlameDetail(null)
      }
    })
    return () => {
      cancelled = true
    }
    // `openFile.file.sha1` re-runs the load after a save so open blame never shows stale lines.
  }, [blameOpen, loadBlame, openFile.file.sha1])

  useEffect(() => {
    setBlameDetail(null)
  }, [blameOpen, openFile.agentId, openFile.file.path])

  return {
    blameOpen,
    blameLoading,
    blame,
    blameError,
    blameCapability,
    blameDetail,
    blameLabelWidths,
    checkBlameCapability,
    toggleBlame,
    showBlameDetail,
    clearBlameDetail,
  }
}
