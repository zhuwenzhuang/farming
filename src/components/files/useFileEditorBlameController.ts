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
export type BlameCapability = 'unknown' | 'checking' | 'available' | 'unavailable' | 'error'

interface BlameDetailState {
  line: FileEditorBlameLine
}

interface UseFileEditorBlameControllerOptions {
  openFile: OpenWorkspaceFile
  disabled: boolean
  mismatchMessage: string
  onRevealLine: (lineNumber: number, options?: { focusEditor?: boolean }) => void
  snapshot?: { revision?: string; content: string }
}

function isPermanentBlameFailure(error: unknown) {
  return error instanceof WorkspaceFileApiError && isPermanentWorkspaceBlameFailureStatus(error.status)
}

export function useFileEditorBlameController({
  openFile,
  disabled,
  mismatchMessage,
  onRevealLine,
  snapshot,
}: UseFileEditorBlameControllerOptions) {
  const currentOpenFileKey = `${openFile.agentId}\u0000${openFileKey(openFile)}\u0000${snapshot?.revision ?? ''}`
  const snapshotKey = `${currentOpenFileKey}\u0000${openFile.file.sha1 ?? ''}`
  const blameRequestFenceRef = useRef(new RequestOwnershipFence(snapshotKey))
  const blameCapabilityRequestFenceRef = useRef(new RequestOwnershipFence(currentOpenFileKey))
  const blameAbortRef = useRef<AbortController | null>(null)
  const [blameOpen, setBlameOpen] = useState(false)
  const [blameLoading, setBlameLoading] = useState(false)
  const cache = useRef(new Map<string, WorkspaceFileBlame>())
  const [loaded, setLoaded] = useState<{ key: string; result: WorkspaceFileBlame } | null>(null)
  const blame = blameOpen && !disabled && !openFile.dirty
    ? (loaded?.key === snapshotKey ? loaded.result : cache.current.get(snapshotKey)) ?? null : null
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
    blameAbortRef.current?.abort()
    const controller = new AbortController()
    blameAbortRef.current = controller
    const previous = cache.current.get(snapshotKey)
    setBlameDetail(null)
    setBlameLoading(!previous)
    setBlameError(null)
    try {
      const nextBlame = await fetchWorkspaceBlame(openFile.agentId, openFile.file.path, snapshot?.revision, controller.signal, previous)
      if (!lease.isCurrent()) return null
      if (nextBlame !== previous && nextBlame.isGitRepo) {
        const content = snapshot?.content ?? openFile.file.content
        const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n')
        if (lines.length !== nextBlame.lines.length || nextBlame.lines.some((line, index) => (
          line.lineNumber !== index + 1 || line.content.replace(/\r$/, '') !== lines[index]?.replace(/\r$/, '')
        ))) throw new Error(mismatchMessage)
      }
      if (nextBlame.snapshotId && nextBlame.snapshotBytes && nextBlame.isGitRepo && !snapshot) {
        const entries = cache.current
        entries.delete(snapshotKey)
        entries.set(snapshotKey, nextBlame)
        let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.snapshotBytes ?? 0), 0)
        for (const [key, entry] of entries) {
          if (entries.size <= 8 && bytes <= 32 * 1024 * 1024) break
          bytes -= entry.snapshotBytes ?? 0
          entries.delete(key)
        }
      }
      if (nextBlame !== previous) setBlameDetail(null)
      setLoaded({ key: snapshotKey, result: nextBlame })
      setBlameCapability(nextBlame.isGitRepo && nextBlame.lines.length > 0 ? 'available' : 'unavailable')
      return nextBlame
    } catch (error) {
      if (!lease.isCurrent()) return null
      cache.current.delete(snapshotKey)
      setLoaded(null)
      setBlameDetail(null)
      setBlameError(error instanceof Error ? error.message : 'Failed to load blame')
      setBlameCapability(isPermanentBlameFailure(error) ? 'unavailable' : 'unknown')
      return null
    } finally {
      if (lease.isCurrent()) setBlameLoading(false)
    }
  }, [openFile.agentId, openFile.file.path, openFile.file.content, snapshotKey, snapshot, mismatchMessage])

  const checkBlameCapability = useCallback(async (): Promise<BlameCapability | null> => {
    if (disabled) {
      setBlameCapability('unavailable')
      return 'unavailable'
    }
    const lease = blameCapabilityRequestFenceRef.current.begin()
    setBlameCapability('checking')
    try {
      const capability = await fetchWorkspaceBlameCapability(openFile.agentId, openFile.file.path, snapshot?.revision)
      if (!lease.isCurrent()) return null
      const nextCapability = capability.available ? 'available' : 'unavailable'
      setBlameCapability(nextCapability)
      return nextCapability
    } catch {
      if (!lease.isCurrent()) return null
      setBlameCapability('error')
      return 'error'
    }
  }, [disabled, openFile.agentId, openFile.file.path, snapshot?.revision])

  const toggleBlame = useCallback(async () => {
    if (disabled) return
    if (blameOpen) {
      blameRequestFenceRef.current.invalidate()
      cache.current.clear()
      setLoaded(null)
      setBlameOpen(false)
      setBlameLoading(false)
      setBlameDetail(null)
      return
    }

    const capability = blameCapability === 'unknown' || blameCapability === 'error'
      ? await checkBlameCapability()
      : blameCapability
    if (
      capability === 'available'
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
    setBlameLoading(false)
    setBlameError(null)
    setBlameCapability(disabled ? 'unavailable' : 'unknown')
  }, [currentOpenFileKey, disabled])

  useEffect(() => {
    if (!disabled) return
    setBlameOpen(false)
    cache.current.clear()
    setLoaded(null)
    setBlameError(null)
    setBlameCapability('unavailable')
  }, [disabled, openFile.agentId, openFile.file.path])

  useEffect(() => () => { blameAbortRef.current?.abort() }, [snapshotKey, disabled, blameOpen, openFile.dirty])

  useEffect(() => {
    if (!blameOpen) return
    if (openFile.dirty) {
      setLoaded(null)
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
