import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { RequestOwnershipFence } from '@/lib/request-ownership'

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
  const currentOpenFileKey = openFileKey(openFile)
  const snapshotKey = `${currentOpenFileKey}\u0000${openFile.file.sha1 ?? ''}`
  const blameRequestFenceRef = useRef(new RequestOwnershipFence(snapshotKey))
  const blameCapabilityRequestFenceRef = useRef(new RequestOwnershipFence(currentOpenFileKey))
  const [blameOpen, setBlameOpen] = useState(false)
  const [blameLoading, setBlameLoading] = useState(false)
  const [blame, setBlame] = useState<WorkspaceFileBlame | null>(null)
  const [blameError, setBlameError] = useState<string | null>(null)
  const [blameCapability, setBlameCapability] = useState<BlameCapability>('unknown')
  const [blameDetail, setBlameDetail] = useState<BlameDetailState | null>(null)
  blameRequestFenceRef.current.setScope(snapshotKey)
  blameRequestFenceRef.current.setActive(!disabled && blameOpen && !openFile.dirty)
  blameCapabilityRequestFenceRef.current.setScope(currentOpenFileKey)
  blameCapabilityRequestFenceRef.current.setActive(!disabled)

  useLayoutEffect(() => {
    const fences = [blameRequestFenceRef.current, blameCapabilityRequestFenceRef.current]
    fences.forEach(fence => fence.setMounted(true))
    return () => fences.forEach(fence => fence.setMounted(false))
  }, [])

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
    if (!blameRequestFenceRef.current.available) return null
    const lease = blameRequestFenceRef.current.begin()
    setBlame(null)
    setBlameDetail(null)
    setBlameLoading(true)
    setBlameError(null)
    try {
      const nextBlame = await fetchWorkspaceBlame(openFile.agentId, openFile.file.path)
      if (!lease.isCurrent()) return null
      setBlame(nextBlame)
      setBlameCapability(nextBlame.isGitRepo && nextBlame.lines.length > 0 ? 'available' : 'unavailable')
      return nextBlame
    } catch (error) {
      if (!lease.isCurrent()) return null
      setBlame(null)
      setBlameError(error instanceof Error ? error.message : 'Failed to load blame')
      setBlameCapability(isPermanentBlameFailure(error) ? 'unavailable' : 'unknown')
      return null
    } finally {
      if (lease.isCurrent()) setBlameLoading(false)
    }
  }, [openFile.agentId, openFile.file.path])

  const checkBlameCapability = useCallback(async (): Promise<BlameCapability | null> => {
    if (disabled) {
      setBlameCapability('unavailable')
      return 'unavailable'
    }
    const lease = blameCapabilityRequestFenceRef.current.begin()
    try {
      const capability = await fetchWorkspaceBlameCapability(openFile.agentId, openFile.file.path)
      if (!lease.isCurrent()) return null
      const nextCapability = capability.available ? 'available' : 'unavailable'
      setBlameCapability(nextCapability)
      return nextCapability
    } catch {
      if (!lease.isCurrent()) return null
      setBlameCapability('unavailable')
      return 'unavailable'
    }
  }, [disabled, openFile.agentId, openFile.file.path])

  const toggleBlame = useCallback(async () => {
    if (disabled) return
    if (blameOpen) {
      blameRequestFenceRef.current.invalidate()
      setBlameOpen(false)
      setBlameLoading(false)
      setBlameDetail(null)
      return
    }

    const capability = blameCapability === 'unknown'
      ? await checkBlameCapability()
      : blameCapability
    if (
      capability !== null
      && capability !== 'unavailable'
      && !disabled
    ) {
      setBlameOpen(true)
    }
  }, [blameCapability, blameOpen, checkBlameCapability, disabled])

  const showBlameDetail = useCallback((line: FileEditorBlameLine) => {
    onRevealLine(line.lineNumber, { focusEditor: false })
    setBlameDetail({ line })
  }, [onRevealLine])

  useEffect(() => {
    setBlame(null)
    setBlameLoading(false)
    setBlameError(null)
    setBlameCapability(disabled ? 'unavailable' : 'unknown')
  }, [currentOpenFileKey, disabled])

  useEffect(() => {
    if (!disabled) return
    setBlameOpen(false)
    setBlame(null)
    setBlameError(null)
    setBlameCapability('unavailable')
  }, [disabled, openFile.agentId, openFile.file.path])

  useEffect(() => {
    if (!blameOpen) return
    if (openFile.dirty) {
      setBlame(null)
      setBlameDetail(null)
      setBlameLoading(false)
      return
    }
    void loadBlame()
    // `openFile.file.sha1` re-runs the load after a save so open blame never shows stale lines.
  }, [blameOpen, disabled, loadBlame, currentOpenFileKey, openFile.file.sha1, openFile.dirty])

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
    retryBlame: loadBlame,
    showBlameDetail,
    clearBlameDetail,
  }
}
