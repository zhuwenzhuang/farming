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
  const blameCapabilityRequestRef = useRef(0)
  const openFileKeyRef = useRef(openFileKey(openFile))
  const [blameOpen, setBlameOpen] = useState(false)
  const [blameLoading, setBlameLoading] = useState(false)
  const [blame, setBlame] = useState<WorkspaceFileBlame | null>(null)
  const [blameError, setBlameError] = useState<string | null>(null)
  const [blameCapability, setBlameCapability] = useState<BlameCapability>('unknown')
  const [blameDetail, setBlameDetail] = useState<BlameDetailState | null>(null)
  openFileKeyRef.current = openFileKey(openFile)

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
    setBlameLoading(true)
    setBlameError(null)
    try {
      const nextBlame = await fetchWorkspaceBlame(openFile.agentId, openFile.file.path)
      setBlame(nextBlame)
      setBlameCapability(nextBlame.isGitRepo && nextBlame.lines.length > 0 ? 'available' : 'unavailable')
      return nextBlame
    } catch (error) {
      setBlame(null)
      setBlameError(error instanceof Error ? error.message : 'Failed to load blame')
      setBlameCapability(isPermanentBlameFailure(error) ? 'unavailable' : 'unknown')
      return null
    } finally {
      setBlameLoading(false)
    }
  }, [disabled, openFile.agentId, openFile.file.path, openFile.file.sha1])

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

    const capability = blameCapability === 'unknown'
      ? await checkBlameCapability()
      : blameCapability
    if (capability !== 'unavailable') {
      setBlameOpen(true)
    }
  }, [blameCapability, blameOpen, checkBlameCapability, disabled])

  const showBlameDetail = useCallback((line: FileEditorBlameLine) => {
    onRevealLine(line.lineNumber, { focusEditor: false })
    setBlameDetail({ line })
  }, [onRevealLine])

  useEffect(() => {
    setBlame(null)
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
  }, [blameOpen, loadBlame])

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
