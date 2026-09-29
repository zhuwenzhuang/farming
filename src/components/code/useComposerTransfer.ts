import { useEffect, useRef, useState, type RefObject } from 'react'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import type { ComposerContextReference } from './composer-message'

export const WORKSPACE_REFERENCE_MIME = 'application/x-farming-workspace-reference'
let focusedComposer: HTMLTextAreaElement | null = null
/** Global routing only accepts files and yields to every other editor/modal. */
export function useComposerTransfer({ active, agentId, workspace, textareaRef, composerRef, onAddReference }: {
  active: boolean; agentId: string; workspace: string
  textareaRef: RefObject<HTMLTextAreaElement | null>; composerRef: RefObject<HTMLElement | null>
  onAddReference?: (reference: Omit<ComposerContextReference, 'id'>) => void
}) {
  const [error, setError] = useState('')
  const addReference = useRef(onAddReference)
  useEffect(() => { addReference.current = onAddReference }, [onAddReference])
  useEffect(() => {
    const textarea = textareaRef.current; const surface = composerRef.current
    if (!active || !textarea || !surface) return
    let alive = true
    let nativeSequence = 0
    const focus = () => { focusedComposer = textarea }
    const transfer = (data: DataTransfer) => textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    const globalPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || focusedComposer !== textarea || !textarea.getClientRects().length || textarea.disabled || !event.clipboardData?.files.length) return
      const target = event.target
      if (target instanceof Element && target.closest('input,textarea,[contenteditable="true"],[role="dialog"],[role="menu"],.xterm')) return
      if (document.querySelector('[aria-modal="true"]')) return
      event.preventDefault(); textarea.focus(); transfer(event.clipboardData)
    }
    const paste = (event: ClipboardEvent) => {
      const sequence = ++nativeSequence
      const data = event.clipboardData
      if (data?.files.length || data?.getData('text/plain') || data?.getData('text/uri-list') || !window.farmingDesktop?.readClipboardImage || !event.isTrusted) return
      event.preventDefault()
      void window.farmingDesktop.readClipboardImage().then(bytes => {
        if (!alive || sequence !== nativeSequence || !bytes) return
        const transferData = new DataTransfer()
        transferData.items.add(new File([new Uint8Array(bytes)], 'Pasted image.png', { type: 'image/png' }))
        transfer(transferData)
      }).catch(caught => { if (alive) setError(caught instanceof Error ? caught.message : 'Clipboard image unavailable.') })
    }
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') textarea.dataset.plainPaste = String(event.shiftKey)
    }
    const keyup = () => { delete textarea.dataset.plainPaste }
    const dragover = (event: DragEvent) => {
      if (event.dataTransfer && (event.dataTransfer.types.includes('Files') || event.dataTransfer.types.includes(WORKSPACE_REFERENCE_MIME))) {
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; surface.dataset.dragOver = 'true'
      }
    }
    const dragleave = (event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !surface.contains(event.relatedTarget)) delete surface.dataset.dragOver }
    const drop = (event: DragEvent) => {
      delete surface.dataset.dragOver
      const data = event.dataTransfer
      if (!data) return
      if (data.types.includes(WORKSPACE_REFERENCE_MIME)) {
        event.preventDefault(); event.stopPropagation()
        try {
          const item = JSON.parse(data.getData(WORKSPACE_REFERENCE_MIME)) as Record<string, unknown>
          if (item.owner !== agentId && item.owner !== projectFilesWorkspaceId(workspace)) throw new Error('Drop a file from this workspace.')
          if (typeof item.path !== 'string' || !item.path || item.path.startsWith('/') || item.path.split('/').includes('..') || !['file', 'directory'].includes(String(item.kind))) throw new Error('Invalid workspace reference.')
          addReference.current?.({ kind: item.kind as 'file' | 'directory', path: item.path, label: item.path.split('/').pop() || item.path, rootId: projectFilesWorkspaceId(workspace), workspace })
          setError(''); textarea.focus()
        } catch (caught) { setError(caught instanceof Error ? caught.message : 'Invalid workspace reference.') }
      } else if (data.files.length) {
        event.preventDefault(); event.stopPropagation(); setError(''); textarea.focus(); transfer(data)
      }
    }
    surface.addEventListener('focusin', focus)
    textarea.addEventListener('paste', paste, true)
    textarea.addEventListener('keydown', keydown, true)
    textarea.addEventListener('keyup', keyup)
    surface.addEventListener('dragover', dragover); surface.addEventListener('dragleave', dragleave); surface.addEventListener('drop', drop)
    document.addEventListener('paste', globalPaste)
    return () => {
      alive = false
      if (focusedComposer === textarea) focusedComposer = null
      surface.removeEventListener('focusin', focus); textarea.removeEventListener('paste', paste, true)
      textarea.removeEventListener('keydown', keydown, true); textarea.removeEventListener('keyup', keyup)
      surface.removeEventListener('dragover', dragover); surface.removeEventListener('dragleave', dragleave); surface.removeEventListener('drop', drop)
      document.removeEventListener('paste', globalPaste)
    }
  }, [active, agentId, workspace, textareaRef, composerRef])
  return error
}
